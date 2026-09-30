package com.dotrino.messenger

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * THE RING. When a message is queued for this account while the app is closed, the proxy sends
 * an FCM ring WITHOUT content (the message is sealed and stays in the queue). Here only the
 * system notice is shown; opening the app reconnects and the queue arrives. Google sees that
 * this phone was rung, never who wrote nor what.
 */
class PushService : FirebaseMessagingService() {
    companion object {
        private const val PREFS = "push"
        private const val KEY = "fcmToken"

        /** Firebase is only there when the app was built with google-services.json. */
        fun available(ctx: Context) = FirebaseApp.getApps(ctx).isNotEmpty()

        /** Asks for this phone's token and hands it to the session (which signs it under the profile). */
        fun register(ctx: Context) {
            if (!available(ctx)) return
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)?.let { Messenger.session?.setPushToken(it) }
            FirebaseMessaging.getInstance().token.addOnSuccessListener { t -> save(ctx, t); Messenger.session?.setPushToken(t) }
        }

        private fun save(ctx: Context, t: String) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, t).apply()
    }

    override fun onNewToken(token: String) { save(this, token); Messenger.session?.setPushToken(token) }

    override fun onMessageReceived(m: RemoteMessage) {
        I18n.load(this)
        val open = PendingIntent.getActivity(this, 2, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        Notify(this)   // makes sure the channel exists
        runCatching {
            getSystemService(NotificationManager::class.java).notify(7, Notification.Builder(this, Notify.CHANNEL)
                .setSmallIcon(R.drawable.messenger_brand)
                .setContentTitle(t("native.pushTitle")).setContentText(t("native.pushBody"))
                .setAutoCancel(true).setContentIntent(open).build())
        }.onSuccess { com.dotrino.sdk.DotrinoRing.play(this) }
    }
}
