package br.com.nexusconchal.motoja.motorista;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import java.lang.ref.WeakReference;

// Notificacao nativa (Firebase Cloud Messaging). O backend manda a chamada no canal
// "chamadas" com o som "chamada"; aqui o canal e criado e o token vai para o site.
final class NativePush {
    static final String CHANNEL_ID = "chamadas";

    private static WeakReference<LauncherActivity> activity = new WeakReference<>(null);

    private NativePush() {
    }

    static boolean available(Context context) {
        return !FirebaseApp.getApps(context).isEmpty();
    }

    static void attach(LauncherActivity a, WebView webView) {
        activity = new WeakReference<>(a);
        ensureChannel(a);
    }

    static void detach(WebView webView) {
        activity = new WeakReference<>(null);
    }

    static String permission(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            NotificationManager m = context.getSystemService(NotificationManager.class);
            return m != null && m.areNotificationsEnabled() ? "granted" : "denied";
        }
        return context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED ? "granted" : "prompt";
    }

    static void register(Context context) {
        if (!available(context)) {
            emit("registrationError", "{\"error\":\"firebase indisponivel\"}");
            return;
        }
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (task.isSuccessful() && task.getResult() != null) {
                emit("registration", "{\"value\":" + LauncherActivity.quote(task.getResult()) + "}");
            } else {
                emit("registrationError", "{\"error\":\"token\"}");
            }
        });
    }

    static void tokenRefreshed(String token) {
        emit("registration", "{\"value\":" + LauncherActivity.quote(token) + "}");
    }

    static void received(String title, String body) {
        emit("pushNotificationReceived", "{\"title\":" + LauncherActivity.quote(title)
                + ",\"body\":" + LauncherActivity.quote(body) + "}");
    }

    // Abriu o app tocando na notificacao: avisa o painel depois que a pagina carregar.
    static void handleTap(Intent intent) {
        if (intent == null || intent.getExtras() == null
                || !intent.getExtras().containsKey("google.message_id")) return;
        new Handler(Looper.getMainLooper()).postDelayed(() ->
                emit("pushNotificationActionPerformed", "{\"actionId\":\"tap\"}"), 4000);
    }

    private static void emit(String event, String json) {
        LauncherActivity a = activity.get();
        if (a != null) a.emit(event, json);
    }

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                "Chamadas de corrida e entrega", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Toca quando chega corrida ou entrega");
        int sound = context.getResources().getIdentifier("chamada", "raw", context.getPackageName());
        if (sound != 0) {
            Uri uri = Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://"
                    + context.getPackageName() + "/" + sound);
            channel.setSound(uri, new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
        }
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[] {0, 600, 300, 600, 300, 600});
        channel.enableLights(true);
        channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
    }
}
