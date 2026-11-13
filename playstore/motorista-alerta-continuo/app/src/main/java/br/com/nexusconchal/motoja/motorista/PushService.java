package br.com.nexusconchal.motoja.motorista;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

// Com o app fechado o Android mostra a notificacao sozinho no canal "chamadas".
// Com o app aberto o Firebase entrega aqui, entao a notificacao e montada na mao.
public class PushService extends FirebaseMessagingService {
    @Override
    public void onNewToken(@NonNull String token) {
        NativePush.tokenRefreshed(token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        if ("1".equals(message.getData().get("callAlertVersion"))) {
            java.util.Map<String, String> data = message.getData();
            String tag = "oferta_" + data.get("kind") + "_" + data.get("id");
            // A oferta é reconfirmada pela API antes de começar o loop.
            boolean handled = CallAlertService.received(this, data);
            if ("removed".equals(data.get("action"))) {
                // Alguém aceitou (ou expirou): para também o alarme de reserva.
                NotificationManager manager = getSystemService(NotificationManager.class);
                if (manager != null) manager.cancel(tag, 1);
                return;
            }
            String title = data.getOrDefault("title", "MotoJÁ");
            String body = data.getOrDefault("body", "");
            NativePush.received(title, body);
            if (handled) return;
            // O Android não deixou abrir o serviço do alerta (app fechado há muito tempo,
            // economia de bateria...): toca a voz no canal "chamadas" em modo insistente,
            // repetindo até alguém aceitar, a chamada expirar ou o motoboy abrir o app.
            showInsistent(tag, title, body, data.get("expiresAtMs"), message.getMessageId());
            return;
        }
        RemoteMessage.Notification n = message.getNotification();
        String title = n != null && n.getTitle() != null ? n.getTitle()
                : message.getData().getOrDefault("title", getString(R.string.appName));
        String body = n != null && n.getBody() != null ? n.getBody()
                : message.getData().getOrDefault("body", "");
        NativePush.ensureChannel(this);
        NativePush.received(title, body);

        Intent open = new Intent(this, LauncherActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("google.message_id", message.getMessageId());
        PendingIntent pending = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, NativePush.CHANNEL_ID) : new Notification.Builder(this);
        Notification notification = builder
                .setSmallIcon(R.drawable.ic_notification_icon)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_CALL)
                .setContentIntent(pending)
                .build();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            String tag = n != null && n.getTag() != null ? n.getTag() : "push";
            manager.notify(tag, 1, notification);
        }
    }

    private void showInsistent(String tag, String title, String body, String expiresAt, String messageId) {
        NativePush.ensureChannel(this);
        long remaining;
        try { remaining = Long.parseLong(expiresAt) - System.currentTimeMillis(); }
        catch (Exception e) { remaining = 10 * 60 * 1000L; }
        if (remaining <= 0) return;
        Intent open = new Intent(this, LauncherActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("google.message_id", messageId);
        PendingIntent pending = PendingIntent.getActivity(this, tag.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, NativePush.CHANNEL_ID) : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.ic_notification_icon)
                .setContentTitle(title)
                .setContentText(body.isEmpty() ? "Toque para abrir e aceitar." : body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_CALL)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setContentIntent(pending);
        if (Build.VERSION.SDK_INT >= 26) builder.setTimeoutAfter(Math.min(remaining, 20 * 60 * 1000L));
        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_INSISTENT;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(tag, 1, notification);
    }
}
