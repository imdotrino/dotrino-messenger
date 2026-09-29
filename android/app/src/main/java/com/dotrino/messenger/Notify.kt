package com.dotrino.messenger

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.dotrino.messenger.engine.MessengerEngine

/**
 * The phone's notices for a message or a request. The text of a message stays on the phone:
 * it is shown here because it arrived sealed to this phone and was opened here.
 */
class Notify(private val ctx: Context) {
    companion object {
        const val CHANNEL = "messages"
        const val EXTRA_CONTACT = "contact"
    }

    private val nm = ctx.getSystemService(NotificationManager::class.java)

    init { nm.createNotificationChannel(NotificationChannel(CHANNEL, t("native.notifChannel"), NotificationManager.IMPORTANCE_HIGH)) }

    fun show(n: MessengerEngine.Notice) {
        val open = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (n.kind == "message") putExtra(EXTRA_CONTACT, n.fromPubkey)
        }
        val pi = PendingIntent.getActivity(ctx, n.fromPubkey.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val title = if (n.kind == "request") t("native.notifRequest", "name" to n.fromNickname) else n.fromNickname
        val text = if (n.kind == "request") t("requests.defaultMsg") else n.text
        runCatching {
            nm.notify(n.fromPubkey.hashCode(), Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.messenger_brand)
                .setContentTitle(title).setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true).setContentIntent(pi).build())
        }
    }

    fun clear(pubkey: String) = nm.cancel(pubkey.hashCode())
}
