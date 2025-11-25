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
import java.util.List;
import java.util.concurrent.TimeUnit;

// foreground service that polls zulip for new messages
public class ZulipPollingService extends Service {
    private static final String TAG = "ZulipPollingService";
    private static final String SERVICE_CHANNEL_ID = "zulip_polling_channel";
    private static final String MESSAGE_CHANNEL_ID = "zulip_messages";
    private static final String MESSAGE_GROUP = "zulip_messages_group";
    private static final int SERVICE_NOTIFICATION_ID = 1;
    private static final int SUMMARY_NOTIFICATION_ID = 2;

    private volatile boolean isRunning = false;
    private Thread pollingThread;
    private ZulipClient client;
    private int messageNotificationId = 100;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
        schedulePeriodicRestart();
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
                        if (msg.shouldNotify(client.getUserId())) {
                            showMessageNotification(msg);
                        }
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

    private void showMessageNotification(ZulipClient.ZulipMessage msg) {
        String body = msg.getPlainContent();
        if (body.length() > 300) {
            body = body.substring(0, 300) + "...";
        }

        // try to open zulip mobile, fallback to our app
        Intent intent = getPackageManager().getLaunchIntentForPackage("com.zulipmobile");
        if (intent == null) {
            intent = new Intent(this, MainActivity.class);
        }
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, msg.id, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        // messaging style for chat-like appearance
        androidx.core.app.Person sender = new androidx.core.app.Person.Builder()
            .setName(msg.senderName)
            .build();

        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(sender)
            .addMessage(body, System.currentTimeMillis(), sender);

        // add conversation title for streams
        if (!"private".equals(msg.type) && msg.stream != null) {
            style.setConversationTitle("#" + msg.stream + " > " + msg.subject);
        }

        Notification notification = new NotificationCompat.Builder(this, MESSAGE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setStyle(style)
            .setColor(0xFF6492FE) // zulip blue
            .setGroup(MESSAGE_GROUP)
            .build();

        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.notify(messageNotificationId++, notification);

        Log.d(TAG, "showed notification from: " + msg.senderName);
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

            // message channel (with sound)
            NotificationChannel messageChannel = new NotificationChannel(
                MESSAGE_CHANNEL_ID,
                "Zulip Messages",
                NotificationManager.IMPORTANCE_HIGH
            );
            messageChannel.setDescription("New message notifications");
            manager.createNotificationChannel(messageChannel);
        }
    }
}
