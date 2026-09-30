package com.dotrino.messenger

import android.content.Context
import com.dotrino.messenger.engine.Kv
import com.dotrino.messenger.engine.MessengerEngine
import com.dotrino.messenger.engine.SessionTransport
import com.dotrino.messenger.engine.MessengerThreads
import com.dotrino.sdk.VaultBackup
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.launch
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
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var backupJob: Job? = null

    /** The backup's state, for the screen: null = not paired (nothing to say), else the last error. */
    @Volatile var backupError: String? = null; private set

    /** Why it could not start: `no-identity-app`, `no-profile`, `no-profile-keys`, or a message. */
    class BootError(message: String, val code: String) : Exception(message)

    // ONE boot at a time. `onCreate` and `onResume` both ask for it, and the first had not
    // finished when the second arrived: two sessions came up, each with its own token, and
    // what reached the one nobody listened to was lost.
    private val bootLock = kotlinx.coroutines.sync.Mutex()

    /** Starts (once). Throws [BootError] with a code the screen turns into words. */
    suspend fun boot(context: Context): MessengerEngine = bootLock.withLock { bootOnce(context) }

    private suspend fun bootOnce(context: Context): MessengerEngine {
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
        val store = DotrinoStore(ctx, "messenger-" + (p.pid ?: "default").lowercase().replace(Regex("[^a-z0-9-]"), "-"))
        // THE BACKUP IN THE VAULT (when this phone is paired): the history reaches the PWA of the
        // same account and back. Only the messenger's threads: the contacts' keys.
        val backup = p.vault?.let { VaultBackup(p, store) { k -> k.startsWith("{") } }
        // THE CONTACT BOOK too: the same contacts on every device of the profile (`identity.peers`).
        val peersBackup = p.vault?.let { com.dotrino.sdk.PeerBookBackup(p, peers) }
        var engineRef: MessengerEngine? = null
        fun syncSoon(wait: Long) {
            if (backup == null) return
            backupJob?.cancel()
            backupJob = scope.launch {
                delay(wait)
                try {
                    val r = backup.sync()
                    val contacts = peersBackup?.sync() ?: 0
                    backupError = null
                    if (r.changed.isNotEmpty() || contacts > 0) engineRef?.onChange?.invoke()
                } catch (e: Exception) { backupError = (e as? VaultBackup.BackupError)?.code ?: e.message; android.util.Log.w("messenger", "vault backup", e) }
            }
        }
        val e = MessengerEngine(
            SessionTransport(s), p, peers,
            MessengerThreads(store) { syncSoon(1_500) },
            kv, BuildConfig.VERSION_NAME, Reputation(p, peers),
        )
        engineRef = e
        // YOUR NAME IS THE PROFILE'S: without a nickname of its own yet, the messenger takes the
        // profile's name instead of asking for one (the person already said what to be called).
        if (!e.hasNickname) p.name?.let { e.nickname = it }
        if (backup != null) scope.launch { while (true) { syncSoon(0); delay(5 * 60_000) } }
        e.onWarn = { w, t -> android.util.Log.w("messenger", w, t) }
        e.start()
        s.start()
        profile = p; session = s; engine = e
        return e
    }
}
