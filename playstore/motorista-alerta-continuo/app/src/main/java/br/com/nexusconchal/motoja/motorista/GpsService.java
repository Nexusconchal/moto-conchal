package br.com.nexusconchal.motoja.motorista;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

// GPS da corrida/entrega com o app em segundo plano (Waze/Google Maps aberto, tela apagada ou
// app fechado): sem isso o Android para o GPS do site e o cliente/loja veem o motoboy parado.
// Com o app aberto quem manda a posicao continua sendo o site (igual antes); este servico so
// manda quando o app nao esta na tela. Acaba sozinho quando o servidor diz que o servico terminou.
public final class GpsService extends Service implements LocationListener {
    private static final String CHANNEL = "motoja_gps_corrida_v1";
    private static final int NOTIFICATION = 8422;
    private static final String PREFS = "motoja_gps";
    private static final String ALIAS = "motoja-gps-session-v1";
    private static final long MAX_DURATION_MS = 6L * 60 * 60 * 1000;
    private static final long MIN_ATTEMPT_MS = 8000;
    private static final long STILL_RESEND_MS = 20000;
    private static final float MIN_MOVE_M = 12f;

    // LauncherActivity marca quando o app esta na tela (o site manda o GPS nesse caso).
    static volatile boolean appVisible;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Runnable expiry = this::checkExpiry;
    private LocationManager locationManager;
    private JSONObject session;
    private final List<JSONObject> jobs = new ArrayList<>();
    private Location lastSent;
    private long lastSentAt, lastAttemptAt;
    private boolean sending, listening, alive;

    // ---------- Chamadas do site (via NexusNative) ----------

    static boolean start(Context c, String json) {
        try {
            JSONObject supplied = new JSONObject(json);
            String cpf = supplied.optString("driverCpf");
            String token = supplied.optString("driverToken");
            JSONArray list = supplied.optJSONArray("jobs");
            if (!cpf.matches("[0-9]{11}") || token.length() < 16 || token.length() > 4096 || list == null
                    || !CallAlertSession.BACKEND.equals(supplied.optString("backend"))) return false;
            JSONArray clean = new JSONArray();
            for (int i = 0; i < list.length() && clean.length() < 6; i++) {
                JSONObject job = list.optJSONObject(i);
                if (job == null) continue;
                String kind = job.optString("tipo");
                String id = job.optString("id");
                if (!("entrega".equals(kind) || "corrida".equals(kind)) || !id.matches("[A-Za-z0-9_-]{1,80}")) continue;
                clean.put(new JSONObject().put("tipo", kind).put("id", id));
            }
            if (clean.length() == 0) { stop(c); return true; }
            if (!hasLocation(c)) return false;
            JSONObject data = new JSONObject().put("driverCpf", cpf).put("driverToken", token).put("jobs", clean)
                    .put("until", System.currentTimeMillis() + MAX_DURATION_MS);
            if (!save(c, data)) return false;
            ContextCompat.startForegroundService(c, new Intent(c, GpsService.class));
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    static void stop(Context c) {
        prefs(c).edit().clear().apply();
        c.stopService(new Intent(c, GpsService.class));
    }

    static boolean hasLocation(Context c) {
        return ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    // ---------- Servico ----------

    @Override
    public void onCreate() {
        super.onCreate();
        alive = true;
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(NOTIFICATION, notification());
        } catch (RuntimeException notAllowed) {
            // Android nao deixou (sem permissao de localizacao ou app em segundo plano): o site segue com o GPS dele.
            finish();
            return START_NOT_STICKY;
        }
        JSONObject data = load(this);
        if (data == null || data.optLong("until") < System.currentTimeMillis()) { finish(); return START_NOT_STICKY; }
        session = data;
        jobs.clear();
        JSONArray list = data.optJSONArray("jobs");
        for (int i = 0; list != null && i < list.length(); i++) if (list.optJSONObject(i) != null) jobs.add(list.optJSONObject(i));
        if (jobs.isEmpty()) { finish(); return START_NOT_STICKY; }
        listen();
        handler.removeCallbacks(expiry);
        handler.postDelayed(expiry, 60000);
        return START_NOT_STICKY;
    }

    private void listen() {
        if (listening || locationManager == null) return;
        if (!hasLocation(this)) { finish(); return; }
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 4000, 0, this, Looper.getMainLooper());
            }
            // Rede como reserva (tunel, garagem); a precisao ruim e descartada abaixo.
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 10000, 0, this, Looper.getMainLooper());
            }
            listening = true;
        } catch (SecurityException | IllegalArgumentException ignored) {
            finish();
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        if (!alive || location == null || appVisible || sending || jobs.isEmpty()) return;
        long now = System.currentTimeMillis();
        long age = now - location.getTime();
        if (age > 25000 || age < -10000 || !location.hasAccuracy() || location.getAccuracy() > 100) return;
        if (now - lastAttemptAt < MIN_ATTEMPT_MS) return;
        if (lastSent != null && now - lastSentAt < STILL_RESEND_MS && location.distanceTo(lastSent) < MIN_MOVE_M) return;
        lastAttemptAt = now;
        sending = true;
        final JSONObject auth = session;
        final List<JSONObject> targets = new ArrayList<>(jobs);
        final Location fix = new Location(location);
        network.execute(() -> {
            final List<String> finished = new ArrayList<>();
            boolean anySent = false;
            boolean unauthorized = false;
            for (JSONObject job : targets) {
                int code = post(auth, job, fix);
                if (code >= 200 && code < 300) anySent = true;
                else if (code == 401 || code == 403) unauthorized = true;
                else if (code == 404 || code == 409) finished.add(job.optString("id"));
            }
            final boolean sent = anySent;
            final boolean denied = unauthorized;
            handler.post(() -> {
                sending = false;
                if (!alive) return;
                if (sent) { lastSent = fix; lastSentAt = System.currentTimeMillis(); }
                if (denied) { stop(this); return; }
                if (!finished.isEmpty()) {
                    jobs.removeIf(job -> finished.contains(job.optString("id")));
                    if (jobs.isEmpty()) { stop(this); return; }
                    persistJobs();
                }
            });
        });
    }

    // 409 = corrida/entrega nao esta mais em andamento (finalizada, cancelada ou de outro motoboy).
    private static int post(JSONObject auth, JSONObject job, Location fix) {
        HttpURLConnection connection = null;
        try {
            String path = "entrega".equals(job.optString("tipo")) ? "/api/deliveries/" : "/api/rides/";
            URL url = new URL(CallAlertSession.BACKEND + path + Uri.encode(job.optString("id")) + "/location");
            JSONObject body = new JSONObject()
                    .put("driverCpf", auth.optString("driverCpf"))
                    .put("driverToken", auth.optString("driverToken"))
                    .put("latitude", fix.getLatitude())
                    .put("longitude", fix.getLongitude())
                    .put("accuracy", fix.getAccuracy())
                    .put("timestamp", fix.getTime());
            if (fix.hasBearing()) body.put("heading", fix.getBearing());
            if (fix.hasSpeed()) body.put("speed", fix.getSpeed());
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            int code = connection.getResponseCode();
            try (InputStream in = code < 400 ? connection.getInputStream() : connection.getErrorStream()) {
                if (in != null) { byte[] chunk = new byte[1024]; int total = 0, n; while ((n = in.read(chunk)) != -1 && (total += n) < 16384) { } }
            }
            return code;
        } catch (Exception ignored) {
            return 0;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void persistJobs() {
        try {
            JSONArray list = new JSONArray();
            for (JSONObject job : jobs) list.put(job);
            session.put("jobs", list);
            save(this, session);
        } catch (Exception ignored) { }
    }

    private void checkExpiry() {
        if (!alive) return;
        JSONObject data = load(this);
        if (data == null || data.optLong("until") < System.currentTimeMillis()) { stop(this); return; }
        handler.postDelayed(expiry, 60000);
    }

    private void finish() {
        alive = false;
        stopSelf();
    }

    @Override
    public void onDestroy() {
        alive = false;
        handler.removeCallbacksAndMessages(null);
        if (locationManager != null && listening) {
            try { locationManager.removeUpdates(this); } catch (RuntimeException ignored) { }
        }
        listening = false;
        network.shutdownNow();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
    @Override public void onProviderEnabled(String provider) { }
    @Override public void onProviderDisabled(String provider) { }

    private Notification notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && manager != null && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "GPS da corrida em andamento", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        Intent open = new Intent(this, LauncherActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, NOTIFICATION, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return builder.setSmallIcon(R.drawable.ic_notification_icon)
                .setContentTitle("MotoJÁ: corrida em andamento")
                .setContentText("Enviando sua posição para o cliente e a loja acompanharem.")
                .setContentIntent(pending)
                .setOngoing(true)
                .build();
    }

    // ---------- Sessao cifrada com chave do Android Keystore (igual ao alerta de chamadas) ----------

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    private static synchronized boolean save(Context c, JSONObject data) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] encrypted = cipher.doFinal(data.toString().getBytes(StandardCharsets.UTF_8));
            prefs(c).edit().putString("cipher", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                    .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)).apply();
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static synchronized JSONObject load(Context c) {
        try {
            SharedPreferences p = prefs(c);
            if (!p.contains("cipher")) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(p.getString("iv", ""), Base64.NO_WRAP)));
            return new JSONObject(new String(cipher.doFinal(Base64.decode(p.getString("cipher", ""), Base64.NO_WRAP)), StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            return null;
        }
    }
}
