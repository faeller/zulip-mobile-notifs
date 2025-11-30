package me.faeller.zulipnotifs;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import org.json.JSONArray;
import org.json.JSONObject;
import org.mozilla.javascript.Context as RhinoContext;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.Function;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Polling service that uses Rhino JS engine for shared business logic.
 * Java handles: service lifecycle, notifications, HTTP, preferences
 * JS handles: filtering, formatting, state management
 */
public class JSPollingService extends Service {
    private static final String TAG = "JSPollingService";
    private static final String SERVICE_CHANNEL_ID = "zulip_polling_channel";
    private static final String MESSAGE_CHANNEL_ID_PREFIX = "zulip_messages";
    private static final String MESSAGE_GROUP = "zulip_messages_group";
    private static final int SERVICE_NOTIFICATION_ID = 1;
    private static final int SUMMARY_NOTIFICATION_ID = 2;
    private static final int NOTIF_ID_BASE = 100;
    private static final long BUNDLE_TIME_GAP_MS = 5 * 60 * 1000;

    private String currentMessageChannelId = null;
    private String lastSoundUri = null;
    private boolean lastPlaySounds = true;

    private volatile boolean isRunning = false;
    private Thread pollingThread;
    private ZulipClient client;

    // rhino js engine
    private RhinoContext rhinoContext;
    private Scriptable scope;
    private boolean jsInitialized = false;

    // conversation tracking for bundling
    private final Map<String, List<MessageInfo>> conversationMessages = new HashMap<>();
    private final Map<String, Integer> conversationNotifIds = new HashMap<>();
    private int nextNotifId = NOTIF_ID_BASE;

    private static class MessageInfo {
        String senderName;
        String body;
        long timestamp;

        MessageInfo(String senderName, String body, long timestamp) {
            this.senderName = senderName;
            this.body = body;
            this.timestamp = timestamp;
        }
    }

    // cached settings for notification channel management
    private String cachedSoundUri = null;
    private boolean cachedPlaySounds = true;
    private boolean cachedGroupByConversation = true;
    private boolean cachedVibrate = true;
    private boolean cachedOpenZulipApp = true;
    private boolean cachedShowTimestamps = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
        schedulePeriodicRestart();
        initializeRhino();
    }

    @Override
    public void onDestroy() {
        isRunning = false;
        if (pollingThread != null) {
            pollingThread.interrupt();
        }
        cleanupRhino();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = createServiceNotification();
        startForeground(SERVICE_NOTIFICATION_ID, notification);

        if (!isRunning && (pollingThread == null || !pollingThread.isAlive())) {
            SharedPreferences prefs = getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
            boolean installTracked = prefs.getBoolean("installTrackedNative", false);
            if (!installTracked) {
                Analytics.trackEvent(this, "install", BuildConfig.APP_VERSION, null);
                prefs.edit().putBoolean("installTrackedNative", true).apply();
            }
            Analytics.trackEvent(this, "app_open", BuildConfig.APP_VERSION, null);
            startPolling();
        }

        return START_STICKY;
    }

    // ========================================================================
    // RHINO JS ENGINE
    // ========================================================================

    private void initializeRhino() {
        try {
            rhinoContext = RhinoContext.enter();
            rhinoContext.setOptimizationLevel(-1); // interpretive mode for android
            rhinoContext.setLanguageVersion(RhinoContext.VERSION_ES6);
            scope = rhinoContext.initStandardObjects();

            // load shared js from assets
            String jsCode = loadAsset("zulip-service.js");
            if (jsCode != null) {
                rhinoContext.evaluateString(scope, jsCode, "zulip-service.js", 1, null);
                jsInitialized = true;
                Log.d(TAG, "rhino initialized with zulip-service.js");
            } else {
                Log.e(TAG, "failed to load zulip-service.js from assets");
            }
        } catch (Exception e) {
            Log.e(TAG, "failed to initialize rhino", e);
        }
    }

    private void cleanupRhino() {
        if (rhinoContext != null) {
            try {
                RhinoContext.exit();
            } catch (Exception e) {
                Log.w(TAG, "error cleaning up rhino", e);
            }
            rhinoContext = null;
            scope = null;
            jsInitialized = false;
        }
    }

    private String loadAsset(String filename) {
        try {
            AssetManager assets = getAssets();
            InputStream is = assets.open(filename);
            BufferedReader reader = new BufferedReader(new InputStreamReader(is));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append("\n");
            }
            reader.close();
            return sb.toString();
        } catch (Exception e) {
            Log.e(TAG, "failed to load asset: " + filename, e);
            return null;
        }
    }

    private String callJsFunction(String funcName, Object... args) {
        if (!jsInitialized || scope == null) {
            Log.w(TAG, "js not initialized, can't call " + funcName);
            return null;
        }

        try {
            Object funcObj = scope.get(funcName, scope);
            if (funcObj instanceof Function) {
                Function func = (Function) funcObj;
                // re-enter context for this thread if needed
                RhinoContext ctx = RhinoContext.enter();
                try {
                    ctx.setOptimizationLevel(-1);
                    ctx.setLanguageVersion(RhinoContext.VERSION_ES6);
                    Object result = func.call(ctx, scope, scope, args);
                    return RhinoContext.toString(result);
                } finally {
                    RhinoContext.exit();
                }
            } else {
                Log.w(TAG, "js function not found: " + funcName);
            }
        } catch (Exception e) {
            Log.e(TAG, "error calling js function " + funcName, e);
        }
        return null;
    }

    // ========================================================================
    // POLLING
    // ========================================================================

    private void schedulePeriodicRestart() {
        PeriodicWorkRequest workRequest = new PeriodicWorkRequest.Builder(
            ServiceRestartWorker.class, 15, TimeUnit.MINUTES
        ).build();

        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "zulip_service_restart",
            ExistingPeriodicWorkPolicy.KEEP,
            workRequest
        );
    }

    private void startPolling() {
        isRunning = true;
        final Context context = this;

        pollingThread = new Thread(() -> {
            Log.d(TAG, "polling thread started");
            boolean hasTrackedConnect = false;

            while (isRunning) {
                try {
                    String[] creds = loadCredentials();
                    if (creds == null) {
                        Thread.sleep(10000);
                        continue;
                    }

                    String serverUrl = creds[0];
                    String email = creds[1];
                    String apiKey = creds[2];
                    String authMethod = creds.length > 3 ? creds[3] : "unknown";

                    if (client == null) {
                        client = new ZulipClient(serverUrl, email, apiKey);
                        hasTrackedConnect = false;
                    }

                    if (!client.testConnection()) {
                        Log.w(TAG, "connection test failed");
                        client = null;
                        Thread.sleep(10000);
                        continue;
                    }

                    if (!client.isConnected()) {
                        if (!client.registerQueue()) {
                            Thread.sleep(10000);
                            continue;
                        }
                        if (!hasTrackedConnect) {
                            Analytics.trackEvent(context, "connect", BuildConfig.APP_VERSION, authMethod);
                            hasTrackedConnect = true;
                        }
                        // initialize js service with user id and settings
                        initJsService();
                    }

                    List<ZulipClient.ZulipMessage> messages = client.getEvents(30);

                    for (ZulipClient.ZulipMessage msg : messages) {
                        handleMessage(msg);
                    }

                    Thread.sleep(500);

                } catch (InterruptedException e) {
                    break;
                } catch (Exception e) {
                    Log.e(TAG, "polling error", e);
                    client = null;
                    try { Thread.sleep(10000); } catch (InterruptedException ie) { break; }
                }
            }
            Log.d(TAG, "polling thread stopped");
        });

        pollingThread.start();
    }

    private void initJsService() {
        if (client == null) return;

        int userId = client.getUserId();
        String settingsJson = loadSettingsJson();

        String result = callJsFunction("initService", userId, settingsJson);
        Log.d(TAG, "initService result: " + result);
    }

    // ========================================================================
    // MESSAGE HANDLING
    // ========================================================================

    private void handleMessage(ZulipClient.ZulipMessage msg) {
        // reload settings and update js
        String settingsJson = loadSettingsJson();
        callJsFunction("updateSettings", settingsJson);
        parseSettingsForNotifications(settingsJson);

        // convert message to json
        String msgJson = messageToJson(msg);

        // call js to process message
        String resultJson = callJsFunction("processMessage", msgJson);
        if (resultJson == null || "null".equals(resultJson)) {
            Log.d(TAG, "js filtered out message from: " + msg.senderName);
            return;
        }

        try {
            JSONObject result = new JSONObject(resultJson);
            if (result.has("error")) {
                Log.w(TAG, "js error: " + result.optString("error"));
                return;
            }

            showNotification(msg, result);
        } catch (Exception e) {
            Log.e(TAG, "failed to parse js result", e);
        }
    }

    private String messageToJson(ZulipClient.ZulipMessage msg) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", msg.id);
            json.put("senderId", msg.senderId);
            json.put("senderName", msg.senderName);
            json.put("senderEmail", msg.senderEmail);
            json.put("type", msg.type);
            json.put("stream", msg.stream);
            json.put("subject", msg.subject);
            json.put("content", msg.content);
            json.put("timestamp", msg.timestamp);
            json.put("mentioned", msg.mentioned);
            json.put("wildcardMentioned", msg.wildcardMentioned);
            return json.toString();
        } catch (Exception e) {
            Log.e(TAG, "failed to convert message to json", e);
            return "{}";
        }
    }

    private void showNotification(ZulipClient.ZulipMessage msg, JSONObject notifData) {
        try {
            String title = notifData.optString("title", "New Message");
            String body = notifData.optString("body", "");
            String convKey = notifData.optString("conversationKey", "default");
            String convTitle = notifData.optString("conversationTitle", null);
            boolean silent = notifData.optBoolean("silent", false);
            long timestamp = notifData.optLong("timestamp", System.currentTimeMillis());

            int notifId;
            if (cachedGroupByConversation) {
                List<MessageInfo> messages = conversationMessages.get(convKey);
                if (messages == null) {
                    messages = new ArrayList<>();
                    conversationMessages.put(convKey, messages);
                }

                // reset bundle if stale
                if (!messages.isEmpty()) {
                    long lastTime = messages.get(messages.size() - 1).timestamp;
                    if (System.currentTimeMillis() - lastTime > BUNDLE_TIME_GAP_MS) {
                        messages.clear();
                    }
                }

                messages.add(new MessageInfo(msg.senderName, body, timestamp));
                while (messages.size() > 10) messages.remove(0);

                Integer existingId = conversationNotifIds.get(convKey);
                if (existingId == null) {
                    existingId = nextNotifId++;
                    conversationNotifIds.put(convKey, existingId);
                }
                notifId = existingId;
            } else {
                notifId = nextNotifId++;
            }

            // intent
            Intent intent = null;
            if (cachedOpenZulipApp) {
                intent = getPackageManager().getLaunchIntentForPackage("com.zulipmobile");
            }
            if (intent == null) {
                intent = new Intent(this, MainActivity.class);
            }
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

            PendingIntent pendingIntent = PendingIntent.getActivity(
                this, notifId, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            );

            // messaging style
            androidx.core.app.Person me = new androidx.core.app.Person.Builder().setName("Me").build();
            NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me);
            if (convTitle != null) {
                style.setConversationTitle(convTitle);
            }

            if (cachedGroupByConversation) {
                List<MessageInfo> messages = conversationMessages.get(convKey);
                if (messages != null) {
                    for (MessageInfo mi : messages) {
                        androidx.core.app.Person sender = new androidx.core.app.Person.Builder()
                            .setName(mi.senderName).build();
                        String msgBody = cachedShowTimestamps
                            ? formatTime(mi.timestamp) + " | " + mi.body
                            : mi.body;
                        style.addMessage(msgBody, mi.timestamp, sender);
                    }
                }
            } else {
                androidx.core.app.Person sender = new androidx.core.app.Person.Builder()
                    .setName(msg.senderName).build();
                String msgBody = cachedShowTimestamps
                    ? formatTime(timestamp) + " | " + body
                    : body;
                style.addMessage(msgBody, timestamp, sender);
            }

            updateMessageChannel(cachedSoundUri, cachedPlaySounds);

            NotificationCompat.Builder builder = new NotificationCompat.Builder(this, currentMessageChannelId)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setStyle(style)
                .setColor(0xFF6492FE)
                .setGroup(MESSAGE_GROUP)
                .setSilent(silent);

            if (!cachedVibrate) {
                builder.setVibrate(new long[]{0});
            }

            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.notify(notifId, builder.build());
            updateSummaryNotification(manager);

            Log.d(TAG, "showed notification: " + title);
        } catch (Exception e) {
            Log.e(TAG, "failed to show notification", e);
        }
    }

    private String formatTime(long timestamp) {
        // could call js formatTime but this is simpler
        java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault());
        return sdf.format(new java.util.Date(timestamp));
    }

    // ========================================================================
    // SETTINGS & CREDENTIALS
    // ========================================================================

    private String[] loadCredentials() {
        try {
            SharedPreferences prefs = getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
            String lastActive = prefs.getString("lastActive", null);
            if (lastActive == null || lastActive.isEmpty()) return null;
            lastActive = lastActive.replace("\"", "");

            String accountsJson = prefs.getString("accounts", null);
            if (accountsJson == null) return null;

            JSONArray accounts = new JSONArray(accountsJson);
            for (int i = 0; i < accounts.length(); i++) {
                JSONObject account = accounts.getJSONObject(i);
                String serverUrl = account.getString("serverUrl");
                String email = account.getString("email");
                String apiKey = account.getString("apiKey");
                String authMethod = account.optString("authMethod", "unknown");

                String accountId = serverUrl + "::" + email;
                if (accountId.equals(lastActive)) {
                    return new String[] { serverUrl, email, apiKey, authMethod };
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "failed to load credentials", e);
        }
        return null;
    }

    private String loadSettingsJson() {
        try {
            SharedPreferences prefs = getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
            String settingsJson = prefs.getString("settings", null);
            return settingsJson != null ? settingsJson : "{}";
        } catch (Exception e) {
            return "{}";
        }
    }

    private void parseSettingsForNotifications(String settingsJson) {
        try {
            JSONObject json = new JSONObject(settingsJson);
            cachedPlaySounds = json.optBoolean("playSounds", true);
            cachedGroupByConversation = json.optBoolean("groupByConversation", true);
            cachedVibrate = json.optBoolean("vibrate", true);
            cachedOpenZulipApp = json.optBoolean("openZulipApp", true);
            cachedShowTimestamps = json.optBoolean("showTimestamps", false);
            cachedSoundUri = json.optString("notificationSound", null);
            if ("null".equals(cachedSoundUri)) cachedSoundUri = null;
        } catch (Exception e) {
            Log.e(TAG, "failed to parse settings", e);
        }
    }

    // ========================================================================
    // NOTIFICATION CHANNELS
    // ========================================================================

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);

            NotificationChannel serviceChannel = new NotificationChannel(
                SERVICE_CHANNEL_ID, "Zulip Polling Service", NotificationManager.IMPORTANCE_LOW
            );
            serviceChannel.setSound(null, null);
            manager.createNotificationChannel(serviceChannel);

            updateMessageChannel(null, true);
        }
    }

    private void updateMessageChannel(String soundUri, boolean playSounds) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);

            String newChannelId;
            if (!playSounds) {
                newChannelId = MESSAGE_CHANNEL_ID_PREFIX + "_silent";
            } else if (soundUri == null || soundUri.isEmpty()) {
                newChannelId = MESSAGE_CHANNEL_ID_PREFIX;
            } else {
                newChannelId = MESSAGE_CHANNEL_ID_PREFIX + "_" + Math.abs(soundUri.hashCode());
            }

            if (newChannelId.equals(currentMessageChannelId)) return;

            if (currentMessageChannelId != null && !currentMessageChannelId.equals(MESSAGE_CHANNEL_ID_PREFIX)) {
                manager.deleteNotificationChannel(currentMessageChannelId);
            }

            String channelName = !playSounds ? "Zulip Messages (Silent)" :
                (soundUri != null ? "Zulip Messages (Custom)" : "Zulip Messages");

            NotificationChannel channel = new NotificationChannel(
                newChannelId, channelName, NotificationManager.IMPORTANCE_HIGH
            );

            if (!playSounds) {
                channel.setSound(null, null);
            } else if (soundUri != null && !soundUri.isEmpty()) {
                try {
                    android.media.AudioAttributes attr = new android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build();
                    channel.setSound(android.net.Uri.parse(soundUri), attr);
                } catch (Exception e) {
                    Log.e(TAG, "failed to set sound", e);
                }
            }

            manager.createNotificationChannel(channel);
            currentMessageChannelId = newChannelId;
        }
    }

    private Notification createServiceNotification() {
        Intent intent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, SERVICE_CHANNEL_ID)
            .setContentTitle("Zulip Notifications")
            .setContentText("Listening for messages...")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setSilent(true)
            .build();
    }

    private void updateSummaryNotification(NotificationManager manager) {
        Intent intent = getPackageManager().getLaunchIntentForPackage("com.zulipmobile");
        if (intent == null) intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        Notification summary = new NotificationCompat.Builder(this, currentMessageChannelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Zulip Messages")
            .setGroup(MESSAGE_GROUP)
            .setGroupSummary(true)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setColor(0xFF6492FE)
            .build();

        manager.notify(SUMMARY_NOTIFICATION_ID, summary);
    }
}
