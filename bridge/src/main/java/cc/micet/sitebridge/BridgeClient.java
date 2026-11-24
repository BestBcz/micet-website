package cc.micet.sitebridge;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonObject;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonParser;

final class BridgeClient {
    private final URI origin;
    private final String bridgeSecret;
    private final String siteToken;

    BridgeClient(String url, String bridgeSecret, String siteToken) {
        origin = URI.create(url);
        String path = origin.getPath();
        if (!"https".equals(origin.getScheme()) || origin.getHost() == null || origin.getUserInfo() != null
                || origin.getQuery() != null || origin.getFragment() != null || !(path.isEmpty() || path.equals("/"))) {
            throw new IllegalArgumentException("site-url must be the HTTPS origin of the private Site.");
        }
        if (bridgeSecret.length() < 32 || siteToken.isEmpty()) {
            throw new IllegalArgumentException("Configure the bridge secret and Site service token.");
        }
        this.bridgeSecret = bridgeSecret;
        this.siteToken = siteToken;
    }

    JsonObject post(String action, JsonObject body) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) origin.resolve("/api/bridge/" + action).toURL().openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(4_000);
        connection.setReadTimeout(7_000);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("X-Micet-Bridge", bridgeSecret);
        connection.setRequestProperty("OAI-Sites-Authorization", "Bearer " + siteToken);
        connection.setDoOutput(true);
        byte[] request = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(request.length);
        try {
            try (OutputStream out = connection.getOutputStream()) {
                out.write(request);
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new HttpError(status);
            try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                int size;
                while ((size = in.read(buffer)) != -1) {
                    if (out.size() + size > 200_000) throw new IOException("Site response exceeded size limit.");
                    out.write(buffer, 0, size);
                }
                return new JsonParser().parse(new String(out.toByteArray(), StandardCharsets.UTF_8)).getAsJsonObject();
            }
        } finally {
            connection.disconnect();
        }
    }

    static final class HttpError extends IOException {
        final int status;
        HttpError(int status) { super("Site returned HTTP " + status); this.status = status; }
    }
}
