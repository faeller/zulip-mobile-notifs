package me.faeller.zulipnotifs;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.io.InputStream;
import java.io.OutputStream;
import android.app.NotificationChannel;
import android.app.NotificationManager;

@CapacitorPlugin(name = "ForegroundService")
public class ForegroundServicePlugin extends Plugin {

    // check settings to determine which service to use
    private Class<?> getServiceClass() {
        try {
            SharedPreferences prefs = getContext().getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
            String settingsJson = prefs.getString("settings", null);
            if (settingsJson != null) {
                JSONObject settings = new JSONObject(settingsJson);
                if (settings.optBoolean("useJSService", false)) {
                    Log.d("ForegroundService", "using JSPollingService");
                    return JSPollingService.class;
                }
            }
        } catch (Exception e) {
            Log.e("ForegroundService", "failed to read settings", e);
        }
        return ZulipPollingService.class;
    }

    private static final String SERVICE_CHANNEL_ID = "zulip_polling_channel";

    // ensure notification channel exists before starting service
    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getContext().getSystemService(NotificationManager.class);
            if (manager.getNotificationChannel(SERVICE_CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(
                    SERVICE_CHANNEL_ID,
                    "Zulip Polling Service",
                    NotificationManager.IMPORTANCE_LOW
                );
                channel.setDescription("Keeps the connection to Zulip alive");
                channel.setSound(null, null);
                manager.createNotificationChannel(channel);
                Log.d("ForegroundService", "created notification channel");
            }
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        // FIRST ensure notification channel exists
        ensureNotificationChannel();

        // stop both services first to ensure clean switch
        getContext().stopService(new Intent(getContext(), ZulipPollingService.class));
        getContext().stopService(new Intent(getContext(), JSPollingService.class));

        // small delay to let services fully stop before starting
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            Intent serviceIntent = new Intent(getContext(), getServiceClass());

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(serviceIntent);
            } else {
                getContext().startService(serviceIntent);
            }

            call.resolve();
        }, 100);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        // stop both services
        getContext().stopService(new Intent(getContext(), ZulipPollingService.class));
        getContext().stopService(new Intent(getContext(), JSPollingService.class));
        call.resolve();
    }

    @PluginMethod
    public void pickNotificationSound(PluginCall call) {
        Intent intent = new Intent(RingtoneManager.ACTION_RINGTONE_PICKER);
        intent.putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_NOTIFICATION);
        intent.putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "Select notification sound");
        intent.putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, true);
        intent.putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true);

        // get current sound if set
        String currentUri = call.getString("currentUri");
        if (currentUri != null && !currentUri.isEmpty()) {
            intent.putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, Uri.parse(currentUri));
        }

        startActivityForResult(call, intent, "ringtonePickerResult");
    }

    @ActivityCallback
    private void ringtonePickerResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            Uri uri = result.getData().getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI);
            JSObject ret = new JSObject();
            if (uri != null) {
                ret.put("uri", uri.toString());
                // get display name
                String title = RingtoneManager.getRingtone(getContext(), uri).getTitle(getContext());
                ret.put("title", title);
            } else {
                // silent was selected
                ret.put("uri", "");
                ret.put("title", "Silent");
            }
            call.resolve(ret);
        } else {
            // cancelled
            call.resolve(new JSObject());
        }
    }

    @PluginMethod
    public void pickSoundFile(PluginCall call) {
        // directly pick a sound file and return its content uri
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("audio/*");
        // take persistable permission so we can use it later
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickSoundFileResult");
    }

    @ActivityCallback
    private void pickSoundFileResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.resolve(new JSObject());
            return;
        }

        Uri uri = result.getData().getData();
        if (uri == null) {
            call.resolve(new JSObject());
            return;
        }

        try {
            // take persistable permission
            getContext().getContentResolver().takePersistableUriPermission(
                uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
            );

            String fileName = getFileName(uri);
            Log.d("ForegroundService", "picked sound: " + fileName + " -> " + uri);

            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            ret.put("title", fileName != null ? fileName : "Custom sound");
            call.resolve(ret);

        } catch (Exception e) {
            Log.e("ForegroundService", "failed to pick sound", e);
            call.reject("Failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void downloadAndSetSound(PluginCall call) {
        String url = call.getString("url");
        String fileName = call.getString("fileName", "hummus.mp3");

        if (url == null) {
            call.reject("No URL provided");
            return;
        }

        new Thread(() -> {
            try {
                // download file
                java.net.URL downloadUrl = new java.net.URL(url);
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) downloadUrl.openConnection();
                conn.setRequestMethod("GET");
                conn.connect();

                // save to MediaStore so system can access it
                ContentValues values = new ContentValues();
                values.put(MediaStore.Audio.Media.DISPLAY_NAME, fileName);
                values.put(MediaStore.Audio.Media.MIME_TYPE, "audio/mpeg");
                values.put(MediaStore.Audio.Media.IS_NOTIFICATION, 1);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    values.put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_NOTIFICATIONS);
                }

                Uri contentUri = getContext().getContentResolver().insert(
                    MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values
                );

                if (contentUri == null) {
                    call.reject("Failed to create media entry");
                    return;
                }

                try (InputStream in = conn.getInputStream();
                     OutputStream out = getContext().getContentResolver().openOutputStream(contentUri)) {
                    if (out == null) {
                        call.reject("Failed to open output stream");
                        return;
                    }
                    byte[] buffer = new byte[8192];
                    int len;
                    while ((len = in.read(buffer)) != -1) {
                        out.write(buffer, 0, len);
                    }
                }

                Log.d("ForegroundService", "downloaded sound to MediaStore: " + contentUri);

                // play the sound once
                try {
                    android.media.MediaPlayer player = new android.media.MediaPlayer();
                    player.setDataSource(getContext(), contentUri);
                    player.setOnCompletionListener(mp -> mp.release());
                    player.prepare();
                    player.start();
                } catch (Exception e) {
                    Log.w("ForegroundService", "couldn't play sound preview", e);
                }

                JSObject ret = new JSObject();
                ret.put("uri", contentUri.toString());
                ret.put("title", fileName.replace(".mp3", "").replace(".ogg", ""));
                call.resolve(ret);

            } catch (Exception e) {
                Log.e("ForegroundService", "failed to download sound", e);
                call.reject("Download failed: " + e.getMessage());
            }
        }).start();
    }

    private String getFileName(Uri uri) {
        String result = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor cursor = getContext().getContentResolver().query(
                    uri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (idx >= 0) {
                        result = cursor.getString(idx);
                    }
                }
            }
        }
        if (result == null) {
            result = uri.getLastPathSegment();
        }
        return result;
    }
}
