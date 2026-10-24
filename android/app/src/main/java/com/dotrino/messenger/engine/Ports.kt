package com.dotrino.messenger.engine

import com.dotrino.sdk.DotrinoStore
import kotlinx.serialization.json.JsonObject

// The transport (`FriendsTransport`, `SessionTransport`) and the small per-account values (`Kv`,
// `MemoryKv`) are dotrino-native's: the friends of the ecosystem use them too.

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

/**
 * The history in the app's store. The thread keys are the contacts' keys, like the PWA's, so the
 * vault backup reconciles them with what the PWA of the same account wrote. [onWrite]: something
 * was written here (the backup uploads it a moment later).
 */
class MessengerThreads(private val store: DotrinoStore, private val onWrite: () -> Unit = {}) : Threads {
    override fun list(pubkey: String) = store.listThread(pubkey)
    override fun threads(): List<String> = store.threadKeys()
    override fun put(pubkey: String, entry: JsonObject) { store.appendMessage(pubkey, entry); onWrite() }
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
