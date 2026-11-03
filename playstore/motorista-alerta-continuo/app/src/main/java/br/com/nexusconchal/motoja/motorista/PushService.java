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
            // A oferta é reconfirmada pela API antes de começar o loop.
            boolean handled = CallAlertService.received(this, message.getData());
            if ("removed".equals(message.getData().get("action"))) return;
            NativePush.received(message.getData().getOrDefault("title", "MotoJÁ"), message.getData().getOrDefault("body", ""));
            if (handled) return;
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
}
