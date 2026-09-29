package com.dotrino.messenger.engine

import com.dotrino.sdk.DotrinoStore
import com.dotrino.sdk.ProxyConnection
import com.dotrino.sdk.SealedSession
import kotlinx.serialization.json.JsonObject

/**
 * What the engine needs from the transport: the sealed session of dotrino-native. An interface
 * so the engine is tested in the JVM with two engines wired to each other, without a proxy.
 */
interface Transport {
    /** Sealed by token (live; can go direct). Empty keys = the ones the identity announced. */
    suspend fun sendSealedTo(token: String, payload: JsonObject, recipientEncPubs: List<String> = emptyList())
    /** Sealed by pubkey (the offline queue). */
    suspend fun sendSealed(pubkey: String, payload: JsonObject, recipientEncPubs: List<String> = emptyList(), quiet: Boolean = false)
    suspend fun encPubOf(publickey: String): String
    fun pubkeyOfToken(token: String): String?
    suspend fun whoIs(token: String): String?
    suspend fun requestPairingCode(): ProxyConnection.PairingCode
    suspend fun redeemPairingCode(code: String): String
    val isOnline: Boolean
    fun onMessage(l: (SealedSession.Message) -> Unit): () -> Unit
    fun onOnline(l: () -> Unit): () -> Unit
    fun onPeerGone(l: (String) -> Unit): () -> Unit
}

/** The sealed session as the engine's transport. */
class SessionTransport(private val s: SealedSession) : Transport {
    override suspend fun sendSealedTo(token: String, payload: JsonObject, recipientEncPubs: List<String>) = s.sendSealedTo(token, payload, recipientEncPubs)
    override suspend fun sendSealed(pubkey: String, payload: JsonObject, recipientEncPubs: List<String>, quiet: Boolean) = s.sendSealed(pubkey, payload, recipientEncPubs, quiet)
    override suspend fun encPubOf(publickey: String) = s.encPubOf(publickey)
    override fun pubkeyOfToken(token: String) = s.pubkeyOfToken(token)
    override suspend fun whoIs(token: String) = s.whoIs(token)
    override suspend fun requestPairingCode() = s.requestPairingCode()
    override suspend fun redeemPairingCode(code: String) = s.redeemPairingCode(code)
    override val isOnline get() = s.isOnline
    override fun onMessage(l: (SealedSession.Message) -> Unit) = s.onMessage(l)
    override fun onOnline(l: () -> Unit) = s.onOnline(l)
    override fun onPeerGone(l: (String) -> Unit) = s.onEvent { e -> if (e is ProxyConnection.Event.PeerGone) l(e.token) }
}

/**
 * THE HISTORY: one thread per contact pubkey, entries `{ id, dir: 'in'|'out', text, ts,
 * pending?, _read? }` — the same shape the PWA keeps in `@dotrino/store`.
 */
interface Threads {
    fun list(pubkey: String): List<JsonObject>
    fun threads(): List<String>
    /** Adds or replaces (by `id`). */
    fun put(pubkey: String, entry: JsonObject)
}

class StoreThreads(private val store: DotrinoStore) : Threads {
    private val index = "messenger.threads"
    override fun list(pubkey: String) = store.listThread(pubkey)
    override fun threads(): List<String> = store.listThread(index).mapNotNull { (it["id"] as? kotlinx.serialization.json.JsonPrimitive)?.content }
    override fun put(pubkey: String, entry: JsonObject) {
        store.appendMessage(pubkey, entry)
        // The index of threads (the store has no «list threads»): one entry per contact.
        if (threads().none { it == pubkey }) store.appendMessage(index, JsonObject(mapOf("id" to kotlinx.serialization.json.JsonPrimitive(pubkey))))
    }
}

class MemoryThreads : Threads {
    private val m = linkedMapOf<String, MutableList<JsonObject>>()
    override fun list(pubkey: String) = m[pubkey]?.toList() ?: emptyList()
    override fun threads() = m.keys.toList()
    override fun put(pubkey: String, entry: JsonObject) {
        val l = m.getOrPut(pubkey) { mutableListOf() }
        val id = (entry["id"] as? kotlinx.serialization.json.JsonPrimitive)?.content
        val i = l.indexOfFirst { (it["id"] as? kotlinx.serialization.json.JsonPrimitive)?.content == id }
        if (i >= 0) l[i] = entry else l.add(entry)
    }
}

/** Small per-account values (nickname, requests): SharedPreferences in the app, a map in tests. */
interface Kv {
    fun get(key: String): String?
    fun set(key: String, value: String?)
}

class MemoryKv : Kv {
    private val m = HashMap<String, String>()
    override fun get(key: String) = m[key]
    override fun set(key: String, value: String?) { if (value == null) m.remove(key) else m[key] = value }
}
