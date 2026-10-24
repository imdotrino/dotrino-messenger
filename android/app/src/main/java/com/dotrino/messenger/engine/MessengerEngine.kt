package com.dotrino.messenger.engine

import com.dotrino.sdk.Compat
import com.dotrino.sdk.Friends
import com.dotrino.sdk.FriendsTransport
import com.dotrino.sdk.Kv
import com.dotrino.sdk.PeerBook
import com.dotrino.sdk.Profile
import com.dotrino.sdk.Reputation
import com.dotrino.sdk.SealedSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * THE MESSENGER, without a screen: the port of the PWA's `threadsStore` (protocol 2,
 * `src/stores/threadsStore.js`). Same wire, same rules:
 *
 *  - EVERYTHING GOES SEALED (the transport requires it both ways);
 *  - FRIENDS — who wrote it, contact requests, the inbox, the code, writing to every device of
 *    an account — are dotrino-native's [Friends] (the port of `@dotrino/profile/friends`);
 *  - what a non-contact sends goes nowhere.
 *
 * Everything runs on ONE thread ([engine]): transport callbacks come from several.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MessengerEngine(
    private val transport: FriendsTransport,
    private val profile: Profile,
    private val peers: PeerBook,
    private val threads: Threads,
    private val kv: Kv,
    private val version: String,
    private val reputation: Reputation? = null,
    private val now: () -> Long = System::currentTimeMillis,
    /** The fixed contact: [DOTRINO_ACCOUNT] (another key only in tests). */
    private val pinnedAccount: String = DOTRINO_ACCOUNT,
) {
    companion object {
        const val PROTOCOL = 2
        const val MAX_THREAD = 1000

        /**
         * THE DOTRINO ACCOUNT: a fixed contact of every messenger, like the PWA's
         * (`DOTRINO_ACCOUNT` in `src/stores/contactsStore.js`). Dotrino answers there what is asked
         * by email, so it cannot be removed or blocked: if it is missing, it comes back. It is the
         * key of the PROFILE: any of its devices writes, recognised by a card signed by this key.
         */
        const val DOTRINO_ACCOUNT = "{\"key_ops\":[\"verify\"],\"ext\":true,\"kty\":\"EC\",\"x\":\"McyhKieRw_Jcl3TY9EvLovL-ALzGoWqMOrfnFjT7XpA\",\"y\":\"V7tfpDWN37tPnhXnIFUlMaTepcTzzxPWTj_72PkpKPw\",\"crv\":\"P-256\"}"
        /** `sanitizeNickname` of the PWA: trimmed, without the characters that make it ambiguous. */
        fun sanitizeNickname(s: String?): String = (s ?: "").trim().replace(Regex("[<>\"'`]"), "")
        /** `sanitizeMessage` of the PWA: trimmed and at most 1000 characters; nothing escaped. */
        fun sanitizeMessage(s: String?): String = (s ?: "").trim().take(1000)
    }

    /** What deserves a notice: a message from a contact, or a request. */
    data class Notice(val kind: String, val id: String, val fromPubkey: String, val fromNickname: String, val text: String, val vouched: Boolean = false)

    class EngineError(message: String, val code: String) : Exception(message)

    val mine: Compat.Declaration = Compat.declare("messenger", version, PROTOCOL, listOf(PROTOCOL))

    private val engine = Dispatchers.IO.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + engine)
    private val greeted = HashSet<String>()                  // tokens already greeted back
    private val outbox = mutableListOf<JsonObject>()         // { pubkey, entryId, text, ts }
    private val offs = mutableListOf<() -> Unit>()

    /**
     * THE FRIENDS of the ecosystem: requests, the inbox, the code, who wrote it and writing to every
     * device of a contact. The messenger only adds what is its own through the hooks (below).
     */
    val friends = Friends(transport, profile, peers, kv, { nickname }, mine, listOf(pinnedAccount), now)

    /** pubkey -> `incompatible` | `unknown`: what their greeting said about their version (§14). */
    @Volatile var peerCompat: Map<String, String> = emptyMap(); private set
    val pairingCode: String? get() = friends.code
    /** The contact whose conversation is on screen: what arrives there is born read. */
    @Volatile var active: String? = null

    var onChange: () -> Unit = {}
    var onNotice: (Notice) -> Unit = {}
    var onWarn: (String, Throwable?) -> Unit = { _, _ -> }

    private fun changed() = runCatching { onChange() }

    init {
        // What the messenger does when the friends say something.
        friends.onChange = { changed() }
        friends.onWarn = { w, t -> onWarn(w, t) }
        friends.onRequest = { r -> onNotice(Notice("request", "request-${r.pubkey}", r.pubkey, r.nickname.ifEmpty { r.pubkey.take(8) }, "", r.vouched)) }
        friends.onFriend = { scope.launch { flushOutbox() } }
        friends.isVouched = { pk -> isVouched(pk) }
        // A contact kept by a device key moved to its account: its thread goes with it.
        friends.onMoved = { old, account ->
            for (e in threads.list(old)) threads.put(account, e)
            if (active == old) active = account
        }
        // Their version (§14): noted, not blocking — talking to a version that does not understand looks like silence.
        friends.onProfile = { pubkey, payload ->
            val v = Compat.check(mine, payload["v"] as? JsonObject)
            val mark = when { v.compatible -> null; v.code == "undeclared" -> "unknown"; else -> "incompatible" }
            peerCompat = if (mark == null) peerCompat - pubkey else peerCompat + (pubkey to mark)
        }
    }

    fun start() {
        offs += transport.onMessage { m -> scope.launch { runCatching { handle(m) }.onFailure { onWarn("handling a message", it) } } }
        offs += transport.onOnline { scope.launch { whenOnline() } }
        offs += transport.onPeerGone { t -> scope.launch { friends.markOffline(t); greeted.remove(t); changed() } }
        if (transport.isOnline) scope.launch { whenOnline() }
    }

    fun close() { offs.forEach { it() }; offs.clear(); scope.cancel(); friends.close() }

    private suspend fun whenOnline() {
        friends.refreshCode()
        for (c in peers.contacts()) sendHelloTo(str(c, "publickey") ?: continue)
        flushOutbox()
        changed()
    }

    // ---------- account values ----------

    var nickname: String
        get() = kv.get("nickname") ?: ""
        set(v) { kv.set("nickname", sanitizeNickname(v).take(40)); changed() }

    val hasNickname get() = nickname.isNotEmpty()

    // ---------- what the screen reads ----------

    suspend fun contacts(): List<JsonObject> { ensurePinned(); return peers.contacts() }

    /** Is it the Dotrino account (the fixed contact)? */
    fun isPinned(pubkey: String?) = friends.isPinned(pubkey)

    /**
     * Dotrino is always among the contacts. If it was removed (here, or in another app that shares
     * the book), it comes back — kept under the key its card brings, if it already arrived, so that
     * contact and card are the same record.
     */
    private suspend fun ensurePinned() {
        if (peers.contacts().any { isPinned(str(it, "publickey")) }) return
        val key = peers.all().values.mapNotNull { it["card"] as? JsonObject }.firstOrNull { isPinned(str(it, "profileId")) }?.let { str(it, "profileId") } ?: pinnedAccount
        peers.addContact(key, nickname = "Dotrino")
    }

    /** Block or unblock someone: private, in the address book (travels to the vault), never published. Not Dotrino. */
    suspend fun setBlocked(pubkey: String, blocked: Boolean) {
        if (isPinned(pubkey)) throw EngineError("the Dotrino account cannot be blocked", "pinned-contact")
        withContext(engine) { friends.setBlocked(pubkey, blocked) }
    }
    suspend fun isBlocked(pubkey: String): Boolean = friends.isBlocked(pubkey)

    /** Whether there is any device to write to (Dotrino has none until it writes first). */
    suspend fun canWrite(pubkey: String): Boolean = friends.recipientsOf(pubkey).isNotEmpty()

    fun isOnline(pubkey: String) = friends.isOnline(pubkey)

    fun thread(pubkey: String): List<JsonObject> = threads.list(pubkey).sortedBy { long(it, "ts") ?: 0 }

    fun unread(pubkey: String) = threads.list(pubkey).count { str(it, "dir") == "in" && (it["_read"] as? JsonPrimitive)?.content != "true" }

    /** The friend requests, both ways (the inbox of [Friends]). */
    fun requests(): List<Friends.Request> = friends.requests()

    /** Asks the proxy for a code; renews it before it expires ([Friends.refreshCode]). */
    suspend fun refreshPairingCode() = friends.refreshCode()

    /** Accept a request: now we are contacts on both sides. No message enters any chat. */
    suspend fun acceptRequest(pubkey: String) = friends.accept(pubkey)

    /** Dismiss an incoming request, or cancel one I sent. The other side is not told. */
    suspend fun dismissRequest(pubkey: String, dir: String) = friends.dismiss(pubkey, dir)

    // ---------- sending ----------

    /** Seal to a contact, to every device of their account ([Friends.send]). */
    private suspend fun sendToContact(pubkey: String, payload: JsonObject, quiet: Boolean = false) = friends.send(pubkey, payload, quiet)

    suspend fun sendDM(pubkey: String, text: String): Unit = withContext(engine) {
        val t = sanitizeMessage(text)
        if (t.isEmpty()) return@withContext
        if (peers.get(pubkey)?.let { (it["isContact"] as? JsonPrimitive)?.content == "true" } != true) throw EngineError("not a contact", "not-contact")
        if (friends.recipientsOf(pubkey).isEmpty()) throw EngineError("no device of this account is known yet", "no-devices")
        val entry = buildJsonObject { put("id", UUID.randomUUID().toString()); put("dir", "out"); put("text", t); put("ts", now()); put("pending", true) }
        threads.put(pubkey, entry)
        changed()
        deliver(buildJsonObject { put("pubkey", pubkey); put("entryId", str(entry, "id")!!); put("text", t); put("ts", long(entry, "ts")!!) })
    }

    private suspend fun deliver(item: JsonObject): Boolean {
        val pubkey = str(item, "pubkey")!!; val id = str(item, "entryId")!!
        return try {
            sendToContact(pubkey, buildJsonObject { put("type", "DM"); put("text", str(item, "text")!!); put("ts", long(item, "ts")!!); put("mid", id) })
            update(pubkey, id) { it + ("pending" to JsonPrimitive(false)) }
            true
        } catch (e: Exception) {
            onWarn("DM could not be sent, will retry", e)
            if (outbox.none { str(it, "entryId") == id }) outbox.add(item)
            false
        }
    }

    private suspend fun flushOutbox() {
        if (outbox.isEmpty()) return
        val pending = outbox.toList(); outbox.clear()
        for (item in pending) deliver(item)
    }

    private fun update(pubkey: String, id: String, f: (JsonObject) -> Map<String, JsonElement>) {
        val e = threads.list(pubkey).firstOrNull { str(it, "id") == id } ?: return
        threads.put(pubkey, JsonObject(f(e)))
        changed()
    }

    /** Marks what I received from [pubkey] as read. */
    suspend fun markRead(pubkey: String): Unit = withContext(engine) {
        for (e in threads.list(pubkey)) if (str(e, "dir") == "in" && (e["_read"] as? JsonPrimitive)?.content != "true") {
            threads.put(pubkey, JsonObject(e + ("_read" to JsonPrimitive(true))))
        }
        changed()
    }

    /** Say hello to a contact: presence (token, nickname, card). Queued quietly if offline. */
    suspend fun sendHelloTo(pubkey: String) {
        // An account with no known device (Dotrino before it writes) has nobody to greet.
        if (friends.recipientsOf(pubkey).isEmpty()) return
        runCatching { sendToContact(pubkey, JsonObject(friends.me() + ("type" to JsonPrimitive("HELLO"))), quiet = true) }
            .onFailure { onWarn("hello", it) }
    }

    private fun markOnline(pubkey: String, token: String) = friends.markOnline(pubkey, token)

    // ---------- receiving ----------

    private suspend fun handle(m: SealedSession.Message) {
        val type = str(m.payload, "type") ?: return
        ensurePinned()   // Dotrino has to be a contact BEFORE its first message is judged
        // Sealed, authenticated, nobody blocked, and the friend requests: [Friends].
        val r = friends.receive(m) ?: return
        if (r.handled) return
        // From here on, only contacts. A stranger's message goes nowhere.
        val c = r.who.contact ?: return
        when (type) {
            "HELLO" -> onHello(m, r.who)
            "DM" -> onDM(m, c)
            "DM_ACK" -> str(m.payload, "id")?.let { id -> threads.threads().forEach { pk -> update(pk, id) { e -> e + ("pending" to JsonPrimitive(false)) } } }
            "RATING_QUERY" -> onRatingQuery(m, c)
            "RATING_REPLY" -> onRatingReply(m)
        }
    }

    private suspend fun onHello(m: SealedSession.Message, who: Friends.Who) {
        friends.noteProfile(who.pubkey, m.payload)
        val c = friends.upgradeToAccount(who, m.payload) ?: return
        val pk = str(c, "publickey")!!
        val patch = mutableMapOf<String, String?>()
        m.fromToken?.let { patch["lastToken"] = it }
        if (str(c, "nickname").isNullOrEmpty()) sanitizeNickname(str(m.payload, "nickname")).takeIf { it.isNotEmpty() }?.let { patch["nickname"] = it }
        if (patch.isNotEmpty()) peers.updateContact(pk, patch)
        m.fromToken?.let { t ->
            markOnline(pk, t)
            flushOutbox()
            if (greeted.add(t)) sendHelloTo(pk)   // reply ONCE per token (anti-storm)
        }
        changed()
    }

    private suspend fun onDM(m: SealedSession.Message, c: JsonObject) {
        val text = str(m.payload, "text") ?: return
        val pk = str(c, "publickey")!!
        val clean = sanitizeMessage(text)
        val mid = str(m.payload, "mid") ?: UUID.randomUUID().toString()
        val ts = long(m.payload, "ts") ?: now()
        // The same message can arrive twice (offline queue + live): once is enough.
        if (threads.list(pk).none { str(it, "id") == mid }) {
            threads.put(pk, buildJsonObject {
                put("id", mid); put("dir", "in"); put("text", clean); put("ts", ts); put("queued", m.queued)
                m.queuedAt?.let { put("queuedAt", it) }
                if (active == pk) put("_read", true)
            })
            changed()
            if (active != pk) onNotice(Notice("message", mid, pk, str(c, "nickname") ?: pk.take(8), clean))
        }
        m.fromToken?.let { markOnline(pk, it) }
        runCatching { sendToContact(pk, buildJsonObject { put("type", "DM_ACK"); put("id", mid) }, quiet = true) }.onFailure { onWarn("ack", it) }
    }

    // ---------- ratings ----------

    private suspend fun isVouched(pubkey: String) = runCatching { (reputation?.aggregateTrust(pubkey)?.trustedCount ?: 0) > 0 }.getOrDefault(false)

    /** My rating of a contact: signed and published per axis; `confianza` also in my web of trust. */
    suspend fun rate(pubkey: String, indicators: Map<String, Int>): Unit = withContext(engine) {
        val r = reputation ?: throw EngineError("no reputation registry", "no-reputation")
        r.rate(pubkey, indicators)
        changed()
    }

    /** What I rated [pubkey] before, merged per axis (empty = nothing, or no registry). */
    suspend fun myIndicatorsFor(pubkey: String): Map<String, Double> = reputation?.myIndicatorsFor(pubkey) ?: emptyMap()

    /** Ask my online contacts what they know of [subject] (sealed: it reveals my network). */
    suspend fun askRatingsAbout(subject: String): Unit = withContext(engine) {
        val qid = UUID.randomUUID().toString()
        for (c in peers.contacts()) {
            val pk = str(c, "publickey") ?: continue
            if (pk == subject || !isOnline(pk)) continue
            runCatching { sendToContact(pk, buildJsonObject { put("type", "RATING_QUERY"); put("queryId", qid); put("subject", subject) }) }
        }
    }

    private suspend fun onRatingQuery(m: SealedSession.Message, c: JsonObject) {
        val subject = str(m.payload, "subject") ?: return
        val qid = str(m.payload, "queryId") ?: return
        val pk = str(c, "publickey")!!
        peers.recordQuery(pk, subject)
        val (mine, endorsements) = peers.ratingsFor(subject)
        sendToContact(pk, buildJsonObject {
            put("type", "RATING_REPLY"); put("queryId", qid); put("subject", subject)
            put("mine", mine ?: kotlinx.serialization.json.JsonNull); put("endorsements", JsonArray(endorsements))
        })
    }

    private suspend fun onRatingReply(m: SealedSession.Message) {
        val subject = str(m.payload, "subject") ?: return
        val list = mutableListOf<JsonObject>()
        (m.payload["mine"] as? JsonObject)?.let(list::add)
        (m.payload["endorsements"] as? JsonArray).orEmpty().mapNotNullTo(list) { it as? JsonObject }
        if (list.isNotEmpty()) peers.mergeEndorsements(subject, list)
        changed()
    }

    // ---------- json ----------

    private fun str(o: JsonObject?, k: String) = (o?.get(k) as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun long(o: JsonObject?, k: String) = (o?.get(k) as? JsonPrimitive)?.longOrNull
}
