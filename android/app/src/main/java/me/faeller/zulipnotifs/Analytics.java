package me.faeller.zulipnotifs;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import org.json.JSONObject;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// simple analytics client - sends events to CF worker proxy
public class Analytics {
    private static final String TAG = "Analytics";
    private static final String ANALYTICS_URL = "https://stats.faeller.me";

    // check if analytics is enabled in settings
    private static boolean isEnabled(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
            String settingsJson = prefs.getString("settings", null);
            if (settingsJson == null) return true; // default enabled
            JSONObject json = new JSONObject(settingsJson);
            return json.optBoolean("analyticsEnabled", true);
        } catch (Exception e) {
            return true; // default enabled on error
        }
    }

    // track event in background thread
    public static void trackEvent(Context context, String event, String version, String authMethod) {
        if (!isEnabled(context)) {
            Log.d(TAG, "analytics disabled, skipping " + event);
            return;
        }

        new Thread(() -> {
            try {
                JSONObject payload = new JSONObject();
                payload.put("event", event);

                JSONObject meta = new JSONObject();
                meta.put("version", version);
                meta.put("platform", "android");
                if (authMethod != null) {
                    meta.put("auth", authMethod);
                }
                payload.put("meta", meta);

                URL url = new URL(ANALYTICS_URL);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                conn.setDoOutput(true);

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(payload.toString().getBytes());
                }

                int code = conn.getResponseCode();
                Log.d(TAG, "tracked " + event + " -> " + code);
            } catch (Exception e) {
                Log.d(TAG, "failed to track " + event + ": " + e.getMessage());
            }
        }).start();
    }
}
