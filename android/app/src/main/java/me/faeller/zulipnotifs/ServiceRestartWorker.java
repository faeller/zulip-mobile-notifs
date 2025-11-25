package me.faeller.zulipnotifs;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

// periodic worker to ensure polling service stays alive
public class ServiceRestartWorker extends Worker {
    private static final String TAG = "ServiceRestartWorker";

    public ServiceRestartWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Log.d(TAG, "checking if service needs restart");

        Context context = getApplicationContext();
        Intent serviceIntent = new Intent(context, ZulipPollingService.class);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
            Log.d(TAG, "service start requested");
        } catch (Exception e) {
            Log.e(TAG, "failed to start service", e);
        }

        return Result.success();
    }
}
