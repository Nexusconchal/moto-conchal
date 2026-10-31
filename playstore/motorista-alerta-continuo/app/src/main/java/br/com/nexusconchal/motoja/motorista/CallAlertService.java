package br.com.nexusconchal.motoja.motorista;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import androidx.core.content.ContextCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// O loop dura enquanto houver uma oferta confirmada, sem limite de repetições.
public final class CallAlertService extends Service {
    private static final String CHANNEL = "motoja_chamados_continuos_v1";
    private static final int NOTIFICATION = 8421;
    private static volatile boolean running;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Map<String, JSONObject> offers = new LinkedHashMap<>();
    private MediaPlayer player;
    private Vibrator vibrator;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private PowerManager.WakeLock wakeLock;
    private boolean polling, confirmed, focused, requestedFocus, alive, vibrating;
    private int revision;
    private final Runnable poll = this::verify;
    private final AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
    private final AudioManager.OnAudioFocusChangeListener focusListener = value -> handler.post(() -> {
        focused = value == AudioManager.AUDIOFOCUS_GAIN;
        if (focused) play(); else pause();
    });

    static void update(Context c, String json) { command(c, "replace", json); }
    static boolean received(Context c, Map<String, String> data) {
        try {
            JSONObject offer = new JSONObject().put("id", data.get("id")).put("kind", data.get("kind"))
                    .put("expiresAtMs", Long.parseLong(data.getOrDefault("expiresAtMs", "0")));
            return command(c, "removed".equals(data.get("action")) ? "remove" : "add", offer.toString());
        } catch (Exception ignored) { return false; }
    }
    static void stop(Context c) {
        CallAlertSession.prefs(c).edit().remove("offers").apply();
        c.stopService(new Intent(c, CallAlertService.class));
    }
    private static boolean command(Context c, String action, String json) {
        if (!CallAlertSession.enabled(c)) return true;
        if (CallAlertSession.load(c) == null) return false;
        if (!running && ("remove".equals(action) || ("replace".equals(action) && "[]".equals(json)))) return true;
        Intent intent = new Intent(c, CallAlertService.class).putExtra("action", action).putExtra("offers", json);
        try { ContextCompat.startForegroundService(c, intent); return true; }
        catch (RuntimeException ignored) { return false; }
    }
    @Override public void onCreate() {
        super.onCreate(); running = true; alive = true;
        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        vibrator = Build.VERSION.SDK_INT >= 31 ? getSystemService(VibratorManager.class).getDefaultVibrator()
                : (Vibrator) getSystemService(VIBRATOR_SERVICE);
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (power != null) {
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":call-alert");
            wakeLock.acquire(20 * 60 * 1000L);
        }
        read(CallAlertSession.prefs(this).getString("offers", "[]"));
    }
    private void read(String json) {
        try {
            JSONArray array = new JSONArray(json); offers.clear();
            for (int i = 0; i < Math.min(30, array.length()); i++) add(array.getJSONObject(i));
        } catch (Exception ignored) { offers.clear(); }
    }
    private void add(JSONObject offer) {
        String kind = offer.optString("kind"), id = offer.optString("id");
        if (("rides".equals(kind) || "deliveries".equals(kind)) && id.matches("[a-zA-Z0-9_-]{1,120}")
                && offer.optLong("expiresAtMs") > System.currentTimeMillis()) offers.put(kind + ":" + id, offer);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (!canNotify() || !CallAlertSession.enabled(this) || CallAlertSession.load(this) == null) { finish(); return START_NOT_STICKY; }
        try {
            startForeground(NOTIFICATION, notification());
            if (intent != null) {
                String action = intent.getStringExtra("action"), json = intent.getStringExtra("offers");
                revision++;
                if ("replace".equals(action)) read(json);
                else if (json != null) {
                    JSONObject offer = new JSONObject(json);
                    if ("remove".equals(action)) offers.remove(offer.optString("kind") + ":" + offer.optString("id"));
                    else add(offer);
                }
            }
            persist();
            if (offers.isEmpty()) { finish(); return START_NOT_STICKY; }
            handler.removeCallbacks(poll); verify();
            return START_STICKY;
        } catch (Exception ignored) { finish(); return START_NOT_STICKY; }
    }
    private boolean canNotify() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null && Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
            if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        }
        return manager != null && manager.areNotificationsEnabled()
                && (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
    }
    private Notification notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Alerta contínuo de chamados", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("O som e a vibração param quando o chamado é aceito ou deixa de estar disponível.");
            channel.setSound(null, null); channel.enableVibration(false); manager.createNotificationChannel(channel);
        }
        Intent open = new Intent(this, LauncherActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, NOTIFICATION, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return builder.setSmallIcon(R.drawable.ic_notification_icon).setContentTitle("MotoJÁ — chamado aguardando aceite")
                .setContentText("Abra o app para ver a corrida ou entrega. O alerta para quando ela for aceita.")
                .setContentIntent(pending).setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_CALL).build();
    }
    private void persist() { CallAlertSession.prefs(this).edit().putString("offers", snapshot().toString()).apply(); }
    private JSONArray snapshot() { JSONArray a = new JSONArray(); for (JSONObject o : offers.values()) a.put(o); return a; }
    private void verify() {
        if (!alive) return;
        long now = System.currentTimeMillis();
        offers.entrySet().removeIf(entry -> entry.getValue().optLong("expiresAtMs") <= now);
        if (!CallAlertSession.enabled(this) || !canNotify() || offers.isEmpty()) { finish(); return; }
        if (polling) return;
        JSONObject session = CallAlertSession.load(this);
        if (session == null) { finish(); return; }
        polling = true;
        final int captured = revision;
        final JSONArray requested = snapshot();
        network.execute(() -> {
            JSONObject response = null; int status = 0; HttpURLConnection connection = null;
            try {
                URL url = new URL(CallAlertSession.BACKEND + "/api/drivers/" + session.getString("driverCpf") + "/call-alerts");
                connection = (HttpURLConnection) url.openConnection(); connection.setInstanceFollowRedirects(false);
                connection.setRequestMethod("POST"); connection.setConnectTimeout(6000); connection.setReadTimeout(6000);
                connection.setRequestProperty("Content-Type", "application/json"); connection.setDoOutput(true);
                byte[] bytes = new JSONObject(session.toString()).put("offers", requested).toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
                status = connection.getResponseCode();
                if (status == 200) try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                    byte[] chunk = new byte[2048]; int count;
                    while ((count = in.read(chunk)) != -1) { out.write(chunk, 0, count); if (out.size() > 65536) throw new Exception("response_limit"); }
                    response = new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
                }
            } catch (Exception ignored) {} finally { if (connection != null) connection.disconnect(); }
            final JSONObject result = response; final int code = status;
            handler.post(() -> {
                polling = false;
                if (!alive) return;
                if (captured != revision) { verify(); return; }
                if (code == 401 || code == 403) { CallAlertSession.clear(this); finish(); return; }
                if (result != null) {
                    if (!result.optBoolean("ok") || !result.optBoolean("available")) { finish(); return; }
                    read(result.optJSONArray("offers") == null ? "[]" : result.optJSONArray("offers").toString());
                    persist(); confirmed = !offers.isEmpty();
                    if (!confirmed) { finish(); return; }
                }
                if (confirmed) play();
                handler.removeCallbacks(poll); handler.postDelayed(poll, 3000);
            });
        });
    }
    private void play() {
        if (!confirmed || offers.isEmpty() || !alive || !canNotify()) return;
        if (!requestedFocus && audioManager != null) {
            requestedFocus = true;
            int result;
            if (Build.VERSION.SDK_INT >= 26) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                        .setAudioAttributes(attributes).setAcceptsDelayedFocusGain(true).setOnAudioFocusChangeListener(focusListener).build();
                result = audioManager.requestAudioFocus(focusRequest);
            } else result = audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_RING, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
            focused = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        }
        int mode = audioManager == null ? AudioManager.RINGER_MODE_NORMAL : audioManager.getRingerMode();
        if (!focused || mode == AudioManager.RINGER_MODE_SILENT) { pause(); return; }
        if (mode == AudioManager.RINGER_MODE_NORMAL) {
            if (player == null) {
                player = MediaPlayer.create(this, R.raw.motoja_bora_rodar, attributes, 0);
                if (player != null) {
                    player.setLooping(true); player.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK);
                    player.setOnErrorListener((failed, what, extra) -> { failed.release(); if (player == failed) player = null; return true; });
                }
            }
            if (player != null && !player.isPlaying()) player.start();
        } else if (player != null && player.isPlaying()) player.pause();
        if (!vibrating && vibrator != null && vibrator.hasVibrator()) {
            long[] pattern = new long[] {0, 500, 180, 500, 900};
            if (Build.VERSION.SDK_INT >= 26) vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0), attributes);
            else vibrator.vibrate(pattern, 0);
            vibrating = true;
        }
    }
    private void pause() { if (player != null && player.isPlaying()) player.pause(); if (vibrator != null) vibrator.cancel(); vibrating = false; }
    private void finish() { confirmed = false; offers.clear(); persist(); pause(); stopSelf(); }
    @Override public void onDestroy() {
        running = false; alive = false; revision++; handler.removeCallbacksAndMessages(null); network.shutdownNow();
        pause(); if (player != null) { player.release(); player = null; }
        if (audioManager != null && requestedFocus) {
            if (Build.VERSION.SDK_INT >= 26 && focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
            else audioManager.abandonAudioFocus(focusListener);
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        stopForeground(true); super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
