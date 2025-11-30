package me.faeller.zulipnotifs;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;
import org.json.JSONObject;

// starts the polling service after device boot
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) ||
            Intent.ACTION_USER_UNLOCKED.equals(action)) {
            Log.d(TAG, "boot/unlock received, starting polling service");

            Class<?> serviceClass = getServiceClass(context);
            Intent serviceIntent = new Intent(context, serviceClass);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
        }
    }

    // check settings to determine which service to use
    private Class<?> getServiceClass(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
            String settingsJson = prefs.getString("settings", null);
            if (settingsJson != null) {
                JSONObject settings = new JSONObject(settingsJson);
                if (settings.optBoolean("useJSService", false)) {
                    Log.d(TAG, "using JSPollingService");
                    return JSPollingService.class;
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "failed to read settings", e);
        }
        return ZulipPollingService.class;
    }
}
