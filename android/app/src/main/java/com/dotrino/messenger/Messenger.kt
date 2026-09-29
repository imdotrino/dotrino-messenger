package com.dotrino.messenger

import android.content.Context
import com.dotrino.messenger.engine.Kv
import com.dotrino.messenger.engine.MessengerEngine
import com.dotrino.messenger.engine.SessionTransport
import com.dotrino.messenger.engine.StoreThreads
import com.dotrino.sdk.DotrinoStore
import com.dotrino.sdk.PhoneIdentity
import com.dotrino.sdk.Profile
import com.dotrino.sdk.Reputation
import com.dotrino.sdk.SealedSession
import com.dotrino.sdk.webrtc.WebRtcDirect

/**
 * The messenger of this process: ONE per app, not per screen (turning the phone must not
 * reconnect). Built from the phone's profile (the identity app), the same address book as every
 * Dotrino app, and the history of THIS account (`messenger.<pid>`: another account on the same
 * phone has its own).
 */
object Messenger {
    /** Federated proxies: the home one first; the session moves to the next after failures. */
    val PROXIES = listOf("wss://proxy.dotrino.com", "wss://proxy2.dotrino.com")

    @Volatile var engine: MessengerEngine? = null; private set
    @Volatile var session: SealedSession? = null; private set
    @Volatile var profile: Profile? = null; private set
    private var identity: PhoneIdentity? = null

    /** Why it could not start: `no-identity-app`, `no-profile`, `no-profile-keys`, or a message. */
    class BootError(message: String, val code: String) : Exception(message)

    /** Starts (once). Throws [BootError] with a code the screen turns into words. */
    suspend fun boot(context: Context): MessengerEngine {
        engine?.let { return it }
        val ctx = context.applicationContext
        val id = identity ?: PhoneIdentity(ctx).also { identity = it }
        val p = try { id.profile() } catch (e: Profile.ProfileError) { throw BootError(e.message ?: e.code, e.code) }
        val s = SealedSession(PROXIES, p, "messenger")
        s.useDirect(WebRtcDirect(ctx).apply { onWarn = { w, e -> android.util.Log.w("messenger", "webrtc: $w", e) } })
        s.onWarn = { w, e -> android.util.Log.w("messenger", w, e) }
        val peers = id.peerBook(p)
        val prefs = ctx.getSharedPreferences("messenger." + (p.pid ?: "default"), Context.MODE_PRIVATE)
        val kv = object : Kv {
            override fun get(key: String) = prefs.getString(key, null)
            override fun set(key: String, value: String?) { prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply() }
        }
        val e = MessengerEngine(
            SessionTransport(s), p, peers,
            StoreThreads(DotrinoStore(ctx, "messenger-" + (p.pid ?: "default").lowercase().replace(Regex("[^a-z0-9-]"), "-"))),
            kv, BuildConfig.VERSION_NAME, Reputation(p, peers),
        )
        e.onWarn = { w, t -> android.util.Log.w("messenger", w, t) }
        e.start()
        s.start()
        profile = p; session = s; engine = e
        return e
    }
}
