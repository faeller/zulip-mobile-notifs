package me.faeller.zulipnotifs;

import android.util.Base64;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;

// native zulip api client for background polling
public class ZulipClient {
    private static final String TAG = "ZulipClient";

    private final String serverUrl;
    private final String email;
    private final String apiKey;
    private String queueId;
    private int lastEventId = -1;
    private int userId = -1;

    public ZulipClient(String serverUrl, String email, String apiKey) {
        this.serverUrl = serverUrl.replaceAll("/+$", "");
        this.email = email;
        this.apiKey = apiKey;
    }

    private String getAuthHeader() {
        String credentials = email + ":" + apiKey;
        return "Basic " + Base64.encodeToString(credentials.getBytes(), Base64.NO_WRAP);
    }

    // generic api request
    private String request(String endpoint, String method, String params) throws Exception {
        String urlStr = serverUrl + "/api/v1" + endpoint;
        if ("GET".equals(method) && params != null && !params.isEmpty()) {
            urlStr += "?" + params;
        }

        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod(method);
        conn.setRequestProperty("Authorization", getAuthHeader());
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(120000); // long timeout for polling

        if ("POST".equals(method) && params != null) {
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            conn.setDoOutput(true);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(params.getBytes());
            }
        }

        int code = conn.getResponseCode();
        BufferedReader reader;
        if (code >= 200 && code < 300) {
            reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
        } else {
            reader = new BufferedReader(new InputStreamReader(conn.getErrorStream()));
        }

        StringBuilder response = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            response.append(line);
        }
        reader.close();

        if (code < 200 || code >= 300) {
            throw new Exception("API error " + code + ": " + response);
        }

        return response.toString();
    }

    // test connection and get user info
    public boolean testConnection() {
        try {
            String response = request("/users/me", "GET", null);
            JSONObject json = new JSONObject(response);
            if ("success".equals(json.optString("result"))) {
                userId = json.getInt("user_id");
                Log.d(TAG, "authenticated as user_id: " + userId);
                return true;
            }
        } catch (Exception e) {
            Log.e(TAG, "testConnection failed", e);
        }
        return false;
    }

    // register event queue
    public boolean registerQueue() {
        try {
            String params = "event_types=" + URLEncoder.encode("[\"message\"]", "UTF-8") +
                           "&narrow=" + URLEncoder.encode("[]", "UTF-8") +
                           "&apply_markdown=false" +
                           "&client_gravatar=false";

            String response = request("/register", "POST", params);
            JSONObject json = new JSONObject(response);

            if ("success".equals(json.optString("result"))) {
                queueId = json.getString("queue_id");
                lastEventId = json.getInt("last_event_id");
                Log.d(TAG, "queue registered: " + queueId + ", lastEventId: " + lastEventId);
                return true;
            }
        } catch (Exception e) {
            Log.e(TAG, "registerQueue failed", e);
        }
        return false;
    }

    // long-poll for events
    public List<ZulipMessage> getEvents(int timeoutSec) {
        List<ZulipMessage> messages = new ArrayList<>();

        if (queueId == null) {
            Log.w(TAG, "no queue registered");
            return messages;
        }

        try {
            String params = "queue_id=" + URLEncoder.encode(queueId, "UTF-8") +
                           "&last_event_id=" + lastEventId +
                           "&blocking_timeout=" + timeoutSec;

            String response = request("/events", "GET", params);
            JSONObject json = new JSONObject(response);

            if ("success".equals(json.optString("result"))) {
                JSONArray events = json.getJSONArray("events");

                for (int i = 0; i < events.length(); i++) {
                    JSONObject event = events.getJSONObject(i);
                    lastEventId = event.getInt("id");

                    if ("message".equals(event.optString("type"))) {
                        JSONObject msg = event.getJSONObject("message");
                        JSONArray flags = event.optJSONArray("flags");

                        ZulipMessage message = new ZulipMessage();
                        message.id = msg.getInt("id");
                        message.type = msg.getString("type");
                        message.senderId = msg.getInt("sender_id");
                        message.senderName = msg.getString("sender_full_name");
                        message.content = msg.getString("content");
                        message.subject = msg.optString("subject", "");

                        // parse display_recipient
                        Object recipient = msg.get("display_recipient");
                        if (recipient instanceof String) {
                            message.stream = (String) recipient;
                        } else {
                            message.stream = null; // PM
                        }

                        // parse flags
                        message.mentioned = false;
                        message.wildcardMentioned = false;
                        if (flags != null) {
                            for (int j = 0; j < flags.length(); j++) {
                                String flag = flags.getString(j);
                                if ("mentioned".equals(flag)) message.mentioned = true;
                                if ("wildcard_mentioned".equals(flag)) message.wildcardMentioned = true;
                            }
                        }

                        messages.add(message);
                    }
                }
            }
        } catch (Exception e) {
            // check if queue expired
            if (e.getMessage() != null && e.getMessage().contains("BAD_EVENT_QUEUE_ID")) {
                Log.w(TAG, "queue expired, will re-register");
                queueId = null;
            } else {
                Log.e(TAG, "getEvents failed", e);
            }
        }

        return messages;
    }

    public boolean isConnected() {
        return queueId != null;
    }

    public int getUserId() {
        return userId;
    }

    // simple message data class
    public static class ZulipMessage {
        public int id;
        public String type;
        public int senderId;
        public String senderName;
        public String content;
        public String subject;
        public String stream;
        public boolean mentioned;
        public boolean wildcardMentioned;

        // format notification title
        public String getNotificationTitle() {
            if ("private".equals(type)) {
                return "PM from " + senderName;
            }
            return senderName + " in #" + stream + " > " + subject;
        }

        // strip html from content
        public String getPlainContent() {
            return content
                .replaceAll("<[^>]*>", "")
                .replaceAll("&nbsp;", " ")
                .replaceAll("&lt;", "<")
                .replaceAll("&gt;", ">")
                .replaceAll("&amp;", "&")
                .replaceAll("\\s+", " ")
                .trim();
        }
    }
}
