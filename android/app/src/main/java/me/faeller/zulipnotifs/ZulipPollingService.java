package me.faeller.zulipnotifs;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

// foreground service that polls zulip for new messages
public class ZulipPollingService extends Service {
    private static final String TAG = "ZulipPollingService";
    private static final String SERVICE_CHANNEL_ID = "zulip_polling_channel";
    private static final String MESSAGE_CHANNEL_ID_PREFIX = "zulip_messages";
    private static final String MESSAGE_GROUP = "zulip_messages_group";
    private static final int SERVICE_NOTIFICATION_ID = 1;
    private static final int SUMMARY_NOTIFICATION_ID = 2;
    private static final int NOTIF_ID_BASE = 100;

    private String currentMessageChannelId = MESSAGE_CHANNEL_ID_PREFIX;
    private String lastSoundUri = null;

    private volatile boolean isRunning = false;
    private Thread pollingThread;
    private ZulipClient client;

    // track messages per conversation for stacking
    // key: conversation id (sender_id for PMs, stream::topic for mentions)
    private final Map<String, List<MessageInfo>> conversationMessages = new HashMap<>();
    private final Map<String, Integer> conversationNotifIds = new HashMap<>();
    private int nextNotifId = NOTIF_ID_BASE;

    // time gap (ms) after which a conversation bundle resets
    private static final long BUNDLE_TIME_GAP_MS = 5 * 60 * 1000; // 5 minutes

    // simple holder for message info
    private static class MessageInfo {
        String senderName;
        String body;
        long timestamp;

        MessageInfo(String senderName, String body) {
            this.senderName = senderName;
            this.body = body;
            this.timestamp = System.currentTimeMillis();
        }
    }

    // notification settings
    private static class NotifSettings {
        boolean soundEveryMessage = false;
        boolean groupByConversation = true;
        boolean vibrate = true;
        boolean openZulipApp = true;
        boolean showTimestamps = false;
        String notificationSound = null;
        // filters
        boolean notifyOnMention = true;
        boolean notifyOnPM = true;
        boolean notifyOnOther = false;
        boolean muteSelfMessages = true;
        String[] mutedStreams = new String[0];
        String[] mutedTopics = new String[0];
        // quiet hours
        boolean quietHoursEnabled = false;
        String quietHoursStart = "22:00";
        String quietHoursEnd = "07:00";
    }

    private NotifSettings settings = new NotifSettings();

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
        schedulePeriodicRestart();
        loadSettings();
    }

    // schedule workmanager to restart service every 15 min as backup
    private void schedulePeriodicRestart() {
        PeriodicWorkRequest workRequest = new PeriodicWorkRequest.Builder(
            ServiceRestartWorker.class, 15, TimeUnit.MINUTES
        ).build();

        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "zulip_service_restart",
            ExistingPeriodicWorkPolicy.KEEP,
            workRequest
        );
        Log.d(TAG, "scheduled periodic restart worker");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // create persistent notification
        Notification notification = createServiceNotification();
        startForeground(SERVICE_NOTIFICATION_ID, notification);

        // start polling if not already running
        if (!isRunning && (pollingThread == null || !pollingThread.isAlive())) {
            startPolling();
        } else {
            Log.d(TAG, "polling already running, skipping");
        }

        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        isRunning = false;
        if (pollingThread != null) {
            pollingThread.interrupt();
        }
        super.onDestroy();
    }

    private void startPolling() {
        isRunning = true;

        pollingThread = new Thread(() -> {
            Log.d(TAG, "polling thread started");

            while (isRunning) {
                try {
                    // load credentials from shared prefs
                    String[] creds = loadCredentials();
                    if (creds == null) {
                        Log.d(TAG, "no credentials, waiting...");
                        Thread.sleep(10000);
                        continue;
                    }

                    String serverUrl = creds[0];
                    String email = creds[1];
                    String apiKey = creds[2];

                    // create client if needed
                    if (client == null) {
                        client = new ZulipClient(serverUrl, email, apiKey);
                    }

                    // test connection
                    if (!client.testConnection()) {
                        Log.w(TAG, "connection test failed, retrying...");
                        client = null;
                        Thread.sleep(10000);
                        continue;
                    }

                    // register queue if needed
                    if (!client.isConnected()) {
                        if (!client.registerQueue()) {
                            Log.w(TAG, "queue registration failed, retrying...");
                            Thread.sleep(10000);
                            continue;
                        }
                    }

                    // poll for events (30 second timeout)
                    List<ZulipClient.ZulipMessage> messages = client.getEvents(30);

                    for (ZulipClient.ZulipMessage msg : messages) {
                        showMessageNotification(msg);
                    }

                    // small delay between polls
                    Thread.sleep(500);

                } catch (InterruptedException e) {
                    Log.d(TAG, "polling thread interrupted");
                    break;
                } catch (Exception e) {
                    Log.e(TAG, "polling error", e);
                    client = null;
                    try {
                        Thread.sleep(10000);
                    } catch (InterruptedException ie) {
                        break;
                    }
                }
            }

            Log.d(TAG, "polling thread stopped");
        });

        pollingThread.start();
    }

    // load credentials from capacitor preferences (shared prefs)
    private String[] loadCredentials() {
        try {
            SharedPreferences prefs = getSharedPreferences(
                "CapacitorStorage", Context.MODE_PRIVATE
            );

            // get last active account id (stored as plain string with server::email format)
            String lastActive = prefs.getString("lastActive", null);
            if (lastActive == null || lastActive.isEmpty()) return null;
            // capacitor stores strings with quotes, strip them
            lastActive = lastActive.replace("\"", "");

            // get accounts array
            String accountsJson = prefs.getString("accounts", null);
            if (accountsJson == null) return null;

            // parse accounts - capacitor stores as direct JSON array
            JSONArray accounts = new JSONArray(accountsJson);

            for (int i = 0; i < accounts.length(); i++) {
                JSONObject account = accounts.getJSONObject(i);
                String serverUrl = account.getString("serverUrl");
                String email = account.getString("email");
                String apiKey = account.getString("apiKey");

                // check if this is the active account (format: serverUrl::email)
                String accountId = serverUrl + "::" + email;
                if (accountId.equals(lastActive)) {
                    Log.d(TAG, "loaded credentials for active account");
                    return new String[] { serverUrl, email, apiKey };
                }
            }
            Log.w(TAG, "no matching account found");
        } catch (Exception e) {
            Log.e(TAG, "failed to load credentials", e);
        }
        return null;
    }

    // load notification settings from shared prefs
    private void loadSettings() {
        try {
            SharedPreferences prefs = getSharedPreferences(
                "CapacitorStorage", Context.MODE_PRIVATE
            );

            String settingsJson = prefs.getString("settings", null);
            if (settingsJson == null) return;

            JSONObject json = new JSONObject(settingsJson);
            settings.soundEveryMessage = json.optBoolean("soundEveryMessage", false);
            settings.groupByConversation = json.optBoolean("groupByConversation", true);
            settings.vibrate = json.optBoolean("vibrate", true);
            settings.openZulipApp = json.optBoolean("openZulipApp", true);
            settings.showTimestamps = json.optBoolean("showTimestamps", true);
            settings.notificationSound = json.optString("notificationSound", null);
            if ("null".equals(settings.notificationSound)) {
                settings.notificationSound = null;
            }
            // filters
            settings.notifyOnMention = json.optBoolean("notifyOnMention", true);
            settings.notifyOnPM = json.optBoolean("notifyOnPM", true);
            settings.notifyOnOther = json.optBoolean("notifyOnOther", false);
            settings.muteSelfMessages = json.optBoolean("muteSelfMessages", true);
            // muted streams/topics
            JSONArray mutedStreamsArr = json.optJSONArray("mutedStreams");
            if (mutedStreamsArr != null) {
                settings.mutedStreams = new String[mutedStreamsArr.length()];
                for (int i = 0; i < mutedStreamsArr.length(); i++) {
                    settings.mutedStreams[i] = mutedStreamsArr.optString(i);
                }
            }
            JSONArray mutedTopicsArr = json.optJSONArray("mutedTopics");
            if (mutedTopicsArr != null) {
                settings.mutedTopics = new String[mutedTopicsArr.length()];
                for (int i = 0; i < mutedTopicsArr.length(); i++) {
                    settings.mutedTopics[i] = mutedTopicsArr.optString(i);
                }
            }
            // quiet hours
            settings.quietHoursEnabled = json.optBoolean("quietHoursEnabled", false);
            settings.quietHoursStart = json.optString("quietHoursStart", "22:00");
            settings.quietHoursEnd = json.optString("quietHoursEnd", "07:00");
        } catch (Exception e) {
            Log.e(TAG, "failed to load settings", e);
        }
    }

    // check if notification should be shown based on filters
    private boolean shouldShowNotification(ZulipClient.ZulipMessage msg) {
        if (settings.muteSelfMessages && client != null && msg.senderId == client.getUserId()) return false;
        if (settings.quietHoursEnabled && isQuietHours()) return false;

        boolean isPM = "private".equals(msg.type);
        boolean isMention = msg.mentioned || msg.wildcardMentioned;

        if (isPM) return settings.notifyOnPM;

        // stream message
        if (isMention && !settings.notifyOnMention) return false;
        if (!isMention && !settings.notifyOnOther) return false;

        // check muted channels
        if (msg.stream != null) {
            for (String muted : settings.mutedStreams) {
                if (muted.equalsIgnoreCase(msg.stream)) return false;
            }
        }

        // check muted topics (regex)
        if (msg.subject != null) {
            for (String pattern : settings.mutedTopics) {
                try {
                    if (msg.subject.matches("(?i).*" + pattern + ".*")) return false;
                } catch (Exception e) {
                    if (msg.subject.toLowerCase().contains(pattern.toLowerCase())) return false;
                }
            }
        }

        return true;
    }

    // format timestamp as HH:mm
    private String formatTime(long timestamp) {
        java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault());
        return sdf.format(new java.util.Date(timestamp));
    }

    // format zulip markdown for notifications
    private CharSequence formatMarkdown(String text) {
        // [link text](url) -> link text
        text = text.replaceAll("\\[([^\\]]+)\\]\\([^)]+\\)", "$1");

        android.text.SpannableStringBuilder builder = new android.text.SpannableStringBuilder();

        // combined pattern: **bold**/@**mention**/#**channel** OR *italic* OR `code`
        java.util.regex.Pattern pattern = java.util.regex.Pattern.compile(
            "([@#]?)\\*\\*([^*]+)\\*\\*|(?<!\\*)\\*([^*]+)\\*(?!\\*)|`([^`]+)`");
        java.util.regex.Matcher matcher = pattern.matcher(text);

        int lastEnd = 0;
        while (matcher.find()) {
            builder.append(text.substring(lastEnd, matcher.start()));
            int start = builder.length();

            if (matcher.group(2) != null) {
                // bold match: group 1 = prefix (@/#), group 2 = content
                String prefix = matcher.group(1);
                String content = matcher.group(2);
                builder.append(prefix);
                builder.append(content);
                builder.setSpan(new android.text.style.StyleSpan(android.graphics.Typeface.BOLD),
                    start, builder.length(), android.text.Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
            } else if (matcher.group(3) != null) {
                // italic match: group 3 = content
                builder.append(matcher.group(3));
                builder.setSpan(new android.text.style.StyleSpan(android.graphics.Typeface.ITALIC),
                    start, builder.length(), android.text.Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
            } else if (matcher.group(4) != null) {
                // code match: group 4 = content
                builder.append(matcher.group(4));
                builder.setSpan(new android.text.style.TypefaceSpan("monospace"),
                    start, builder.length(), android.text.Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            lastEnd = matcher.end();
        }
        builder.append(text.substring(lastEnd));

        return builder;
    }

    // check if current time is within quiet hours
    private boolean isQuietHours() {
        try {
            java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat("HH:mm");
            java.util.Date now = sdf.parse(sdf.format(new java.util.Date()));
            java.util.Date start = sdf.parse(settings.quietHoursStart);
            java.util.Date end = sdf.parse(settings.quietHoursEnd);

            // handle overnight quiet hours (e.g., 22:00 to 07:00)
            if (start.after(end)) {
                // quiet hours span midnight
                return now.after(start) || now.before(end);
            } else {
                return now.after(start) && now.before(end);
            }
        } catch (Exception e) {
            return false;
        }
    }

    private void showMessageNotification(ZulipClient.ZulipMessage msg) {
        // reload settings each time in case they changed
        loadSettings();

        // apply filters
        if (!shouldShowNotification(msg)) {
            return;
        }

        String body = msg.getPlainContent();
        if (body.length() > 300) {
            body = body.substring(0, 300) + "...";
        }

        // conversation key: group by sender for PMs, by stream::topic for mentions
        String convKey;
        String convTitle;
        if ("private".equals(msg.type)) {
            convKey = "pm:" + msg.senderId;
            convTitle = null; // MessagingStyle uses sender name
        } else {
            convKey = "stream:" + msg.stream + "::" + msg.subject;
            convTitle = "#" + msg.stream + " > " + msg.subject;
        }

        int notifId;
        int msgCount = 1;

        if (settings.groupByConversation) {
            // add message to conversation history
            List<MessageInfo> messages = conversationMessages.get(convKey);
            if (messages == null) {
                messages = new ArrayList<>();
                conversationMessages.put(convKey, messages);
            }

            // reset bundle if last message was too long ago
            if (!messages.isEmpty()) {
                long lastMsgTime = messages.get(messages.size() - 1).timestamp;
                if (System.currentTimeMillis() - lastMsgTime > BUNDLE_TIME_GAP_MS) {
                    messages.clear();
                    Log.d(TAG, "cleared stale conversation bundle: " + convKey);
                }
            }

            messages.add(new MessageInfo(msg.senderName, body));
            msgCount = messages.size();

            // limit stored messages to avoid memory issues
            while (messages.size() > 10) {
                messages.remove(0);
            }

            // get or assign notification id for this conversation
            Integer existingId = conversationNotifIds.get(convKey);
            if (existingId == null) {
                existingId = nextNotifId++;
                conversationNotifIds.put(convKey, existingId);
            }
            notifId = existingId;
        } else {
            // separate notification for each message
            notifId = nextNotifId++;
        }

        // choose which app to open
        Intent intent = null;
        if (settings.openZulipApp) {
            intent = getPackageManager().getLaunchIntentForPackage("com.zulipmobile");
            if (intent == null) {
                // try explicit intent as fallback
                intent = new Intent();
                intent.setPackage("com.zulipmobile");
                intent.setAction(Intent.ACTION_MAIN);
                intent.addCategory(Intent.CATEGORY_LAUNCHER);
                if (getPackageManager().resolveActivity(intent, 0) == null) {
                    intent = null;
                }
            }
        }
        if (intent == null) {
            intent = new Intent(this, MainActivity.class);
        }
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, notifId, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        // build messaging style
        androidx.core.app.Person me = new androidx.core.app.Person.Builder()
            .setName("Me")
            .build();

        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me);
        if (convTitle != null) {
            style.setConversationTitle(convTitle);
        }

        if (settings.groupByConversation) {
            // add all messages in this conversation
            List<MessageInfo> messages = conversationMessages.get(convKey);
            if (messages != null) {
                for (MessageInfo mi : messages) {
                    androidx.core.app.Person sender = new androidx.core.app.Person.Builder()
                        .setName(mi.senderName)
                        .build();
                    String rawBody = settings.showTimestamps ? formatTime(mi.timestamp) + " | " + mi.body : mi.body;
                    style.addMessage(formatMarkdown(rawBody), mi.timestamp, sender);
                }
            }
        } else {
            // just this message
            androidx.core.app.Person sender = new androidx.core.app.Person.Builder()
                .setName(msg.senderName)
                .build();
            long now = System.currentTimeMillis();
            String rawBody = settings.showTimestamps ? formatTime(now) + " | " + body : body;
            style.addMessage(formatMarkdown(rawBody), now, sender);
        }

        // determine if should alert (sound/vibrate)
        // only alert on first message unless soundEveryMessage is enabled
        boolean shouldAlert = settings.soundEveryMessage || msgCount == 1;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, currentMessageChannelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setStyle(style)
            .setColor(0xFF6492FE) // zulip blue
            .setGroup(MESSAGE_GROUP)
            .setSilent(!shouldAlert);

        // vibration
        if (!settings.vibrate) {
            builder.setVibrate(new long[]{0});
        }

        // update channel with custom sound if needed (Android 8+)
        updateMessageChannel(settings.notificationSound);

        // rebuild with correct channel id
        builder.setChannelId(currentMessageChannelId);

        Notification notification = builder.build();

        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.notify(notifId, notification);

        // update summary notification for bundling
        updateSummaryNotification(manager);

        Log.d(TAG, "showed notification from: " + msg.senderName + " (conv: " + convKey + ", msgs: " + msgCount + ")");
    }

    // creates/updates summary notification that bundles individual messages
    private void updateSummaryNotification(NotificationManager manager) {
        Intent intent = getPackageManager().getLaunchIntentForPackage("com.zulipmobile");
        if (intent == null) {
            intent = new Intent(this, MainActivity.class);
        }
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        Notification summary = new NotificationCompat.Builder(this, currentMessageChannelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Zulip Messages")
            .setContentText("New messages")
            .setGroup(MESSAGE_GROUP)
            .setGroupSummary(true)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setColor(0xFF6492FE)
            .build();

        manager.notify(SUMMARY_NOTIFICATION_ID, summary);
    }

    private Notification createServiceNotification() {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent, PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, SERVICE_CHANNEL_ID)
            .setContentTitle("Zulip Notifications")
            .setContentText("Listening for messages...")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setAutoCancel(false)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);

            // service channel (silent)
            NotificationChannel serviceChannel = new NotificationChannel(
                SERVICE_CHANNEL_ID,
                "Zulip Polling Service",
                NotificationManager.IMPORTANCE_LOW
            );
            serviceChannel.setDescription("Keeps the connection to Zulip alive");
            serviceChannel.setSound(null, null);
            manager.createNotificationChannel(serviceChannel);

            // create default message channel
            updateMessageChannel(null);
        }
    }

    // create or update message channel with custom sound
    // android requires deleting and recreating channel to change sound
    private void updateMessageChannel(String soundUri) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);

            // check if sound changed
            String newChannelId;
            if (soundUri == null || soundUri.isEmpty()) {
                newChannelId = MESSAGE_CHANNEL_ID_PREFIX;
            } else {
                // use hash of uri to create unique channel id
                newChannelId = MESSAGE_CHANNEL_ID_PREFIX + "_" + Math.abs(soundUri.hashCode());
            }

            // skip if channel already exists with same sound
            if (newChannelId.equals(currentMessageChannelId) &&
                ((soundUri == null && lastSoundUri == null) ||
                 (soundUri != null && soundUri.equals(lastSoundUri)))) {
                return;
            }

            // delete old custom channel if different
            if (!currentMessageChannelId.equals(MESSAGE_CHANNEL_ID_PREFIX)) {
                manager.deleteNotificationChannel(currentMessageChannelId);
            }

            // create new channel
            NotificationChannel messageChannel = new NotificationChannel(
                newChannelId,
                soundUri != null ? "Zulip Messages (Custom)" : "Zulip Messages",
                NotificationManager.IMPORTANCE_HIGH
            );
            messageChannel.setDescription("New message notifications");

            if (soundUri != null && !soundUri.isEmpty()) {
                try {
                    android.media.AudioAttributes audioAttr = new android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build();
                    messageChannel.setSound(android.net.Uri.parse(soundUri), audioAttr);
                    Log.d(TAG, "created channel with custom sound: " + soundUri);
                } catch (Exception e) {
                    Log.e(TAG, "failed to set channel sound", e);
                }
            }

            manager.createNotificationChannel(messageChannel);
            currentMessageChannelId = newChannelId;
            lastSoundUri = soundUri;
        }
    }
}
