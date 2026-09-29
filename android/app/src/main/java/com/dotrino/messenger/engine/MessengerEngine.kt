package com.dotrino.messenger.engine

import com.dotrino.sdk.Compat
import com.dotrino.sdk.Delegation
import com.dotrino.sdk.PeerBook
import com.dotrino.sdk.Profile
import com.dotrino.sdk.Reputation
import com.dotrino.sdk.SealedSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.coroutineContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
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
 *  - WHO WROTE IT is said by the key that sealed it, checked against the contact's keys or the
 *    key that identity announced signed — the token says nothing;
 *  - a CONTACT REQUEST is a control message: it goes to the inbox, never to a chat, and nobody
 *    is a contact of anybody until the other side accepts;
 *  - what a non-contact sends goes nowhere.
 *
 * Everything runs on ONE thread ([engine]): transport callbacks come from several.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MessengerEngine(
    private val transport: Transport,
    private val profile: Profile,
    private val peers: PeerBook,
    private val threads: Threads,
    private val kv: Kv,
    private val version: String,
    private val reputation: Reputation? = null,
    private val now: () -> Long = System::currentTimeMillis,
) {
    companion object {
        const val PROTOCOL = 2
        const val MAX_THREAD = 1000
        private const val REQUEST_TTL = 24 * 60 * 60 * 1000L
        private val json = Json { ignoreUnknownKeys = true }

        /** `sanitizeNickname` of the PWA: trimmed, without the characters that make it ambiguous. */
        fun sanitizeNickname(s: String?): String = (s ?: "").trim().replace(Regex("[<>\"'`]"), "")
        /** `sanitizeMessage` of the PWA: trimmed and at most 1000 characters; nothing escaped. */
        fun sanitizeMessage(s: String?): String = (s ?: "").trim().take(1000)
    }

    /** A request, incoming (someone wants to add me) or outgoing (waiting for them). */
    data class Request(val pubkey: String, val dir: String, val nickname: String, val token: String?, val encryptionPubkey: String?, val ts: Long, val vouched: Boolean = false)

    /** What deserves a notice: a message from a contact, or a request. */
    data class Notice(val kind: String, val id: String, val fromPubkey: String, val fromNickname: String, val text: String, val vouched: Boolean = false)

    class EngineError(message: String, val code: String) : Exception(message)

    val mine: Compat.Declaration = Compat.declare("messenger", version, PROTOCOL, listOf(PROTOCOL))

    private val engine = Dispatchers.IO.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + engine)
    private val online = HashMap<String, String>()          // pubkey -> live token (this session)
    private val greeted = HashSet<String>()                  // tokens already greeted back
    private val outbox = mutableListOf<JsonObject>()         // { pubkey, entryId, text, ts }
    private val offs = mutableListOf<() -> Unit>()
    private var codeJob: Job? = null

    /** pubkey -> `incompatible` | `unknown`: what their greeting said about their version (§14). */
    @Volatile var peerCompat: Map<String, String> = emptyMap(); private set
    @Volatile var pairingCode: String? = null; private set
    /** The contact whose conversation is on screen: what arrives there is born read. */
    @Volatile var active: String? = null

    var onChange: () -> Unit = {}
    var onNotice: (Notice) -> Unit = {}
    var onWarn: (String, Throwable?) -> Unit = { _, _ -> }

    private fun changed() = runCatching { onChange() }

    fun start() {
        offs += transport.onMessage { m -> scope.launch { runCatching { handle(m) }.onFailure { onWarn("handling a message", it) } } }
        offs += transport.onOnline { scope.launch { whenOnline() } }
        offs += transport.onPeerGone { t -> scope.launch { online.entries.removeAll { it.value == t }; greeted.remove(t); changed() } }
        if (transport.isOnline) scope.launch { whenOnline() }
    }

    fun close() { offs.forEach { it() }; offs.clear(); scope.cancel() }

    private suspend fun whenOnline() {
        refreshPairingCode()
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

    suspend fun contacts(): List<JsonObject> = peers.contacts()

    fun isOnline(pubkey: String) = synchronized(online) { online.containsKey(pubkey) }

    fun thread(pubkey: String): List<JsonObject> = threads.list(pubkey).sortedBy { long(it, "ts") ?: 0 }

    fun unread(pubkey: String) = threads.list(pubkey).count { str(it, "dir") == "in" && (it["_read"] as? JsonPrimitive)?.content != "true" }

    fun requests(): List<Request> = loadRequests()

    // ---------- the short code ----------

    /** Asks the proxy for a code; renews it before it expires. */
    suspend fun refreshPairingCode(): Unit = withContext(engine) {
        // The renewal timer calls this from INSIDE its own job: cancelling it here cancelled the
        // very request that was renewing the code, and the chip was left empty.
        val prev = codeJob; codeJob = null
        if (prev != null && prev != coroutineContext[Job]) prev.cancel()
        try {
            val c = transport.requestPairingCode()
            pairingCode = c.code
            val left = c.expiresAt - now()
            if (left > 10_000) codeJob = scope.launch { delay(left - 5_000); refreshPairingCode() }
        } catch (e: kotlinx.coroutines.CancellationException) { throw e
        } catch (e: Exception) { pairingCode = null; onWarn("pairing code", e) }
        changed()
    }

    /**
     * Redeem someone's code and send them a CONTACT REQUEST. Throws `offline` (no network — wait)
     * or `invalid` (the code is not valid — ask for another): they are fixed differently.
     */
    suspend fun addByCode(code: String, alias: String): Unit = withContext(engine) {
        if (code == pairingCode) throw EngineError("that is your own code", "own")
        if (!transport.isOnline) throw EngineError("not connected", "offline")
        val token = try { transport.redeemPairingCode(code) } catch (e: Exception) {
            val c = (e as? com.dotrino.sdk.ProxyConnection.ProxyError)?.code ?: (e as? SealedSession.SessionError)?.code
            throw EngineError(e.message ?: "redeem failed", if (c == "disconnected" || c == "timeout") "offline" else "invalid")
        }
        val pubkey = transport.whoIs(token) ?: throw EngineError("the other side did not say who it is", "offline")
        sendContactRequest(token, pubkey, alias)
    }

    private suspend fun whoAmI(): JsonObject = buildJsonObject {
        put("nickname", nickname)
        put("v", mine.toJson())
        profile.card?.let { put("card", it) }
    }

    private suspend fun sendContactRequest(token: String?, pubkey: String, alias: String) {
        // If they already asked me, this is an acceptance: both sides want it.
        if (loadRequests().any { it.pubkey == pubkey && it.dir == "in" }) { acceptRequest(pubkey); return }
        val payload = JsonObject(whoAmI() + ("type" to JsonPrimitive("CONTACT_REQUEST")))
        if (token != null) transport.sendSealedTo(token, payload) else transport.sendSealed(pubkey, payload)
        upsertRequest(Request(pubkey, "out", sanitizeNickname(alias), token, null, now()))
        changed()
    }

    // ---------- requests ----------

    private fun loadRequests(): List<Request> {
        val raw = kv.get("requests") ?: return emptyList()
        val arr = runCatching { json.parseToJsonElement(raw) as? JsonArray }.getOrNull() ?: return emptyList()
        val t = now()
        return arr.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            Request(str(o, "pubkey") ?: return@mapNotNull null, str(o, "dir") ?: "in", str(o, "nickname") ?: "", str(o, "token"),
                str(o, "encryptionPubkey"), long(o, "ts") ?: 0, (o["vouched"] as? JsonPrimitive)?.content == "true")
        }.filter { t - it.ts < REQUEST_TTL }
    }

    private fun saveRequests(l: List<Request>) = kv.set("requests", buildJsonArray {
        l.forEach { r -> add(buildJsonObject {
            put("pubkey", r.pubkey); put("dir", r.dir); put("nickname", r.nickname); r.token?.let { put("token", it) }
            r.encryptionPubkey?.let { put("encryptionPubkey", it) }; put("ts", r.ts); put("vouched", r.vouched)
        }) }
    }.toString())

    private fun upsertRequest(r: Request) {
        val l = loadRequests().toMutableList()
        val i = l.indexOfFirst { it.pubkey == r.pubkey && it.dir == r.dir }
        if (i >= 0) l[i] = r.copy(ts = l[i].ts) else l.add(0, r)
        saveRequests(l)
    }

    private fun removeRequests(pubkey: String, dir: String? = null) =
        saveRequests(loadRequests().filterNot { it.pubkey == pubkey && (dir == null || it.dir == dir) })

    /** Accept a request: now we are contacts on both sides. No message enters any chat. */
    suspend fun acceptRequest(pubkey: String): Unit = withContext(engine) {
        val r = loadRequests().firstOrNull { it.pubkey == pubkey && it.dir == "in" } ?: return@withContext
        becomeContacts(pubkey, r.nickname, r.token, r.encryptionPubkey)
        r.token?.let { markOnline(pubkey, it) }
        replyAccept(pubkey)
        changed()
    }

    /** Dismiss an incoming request, or cancel one I sent. The other side is not told. */
    suspend fun dismissRequest(pubkey: String, dir: String): Unit = withContext(engine) { removeRequests(pubkey, dir); changed() }

    private suspend fun becomeContacts(pubkey: String, nickname: String, token: String?, encPub: String?) {
        val existing = peers.get(pubkey)
        peers.addContact(pubkey,
            nickname = str(existing, "nickname")?.takeIf { it.isNotEmpty() } ?: nickname.ifEmpty { pubkey.take(8) },
            encryptionPubkey = encPub ?: str(existing, "encryptionPubkey"),
            lastToken = token)
        removeRequests(pubkey)
        flushOutbox()
    }

    private suspend fun replyAccept(pubkey: String) =
        runCatching { sendToContact(pubkey, JsonObject(whoAmI() + ("type" to JsonPrimitive("CONTACT_ACCEPT")))) }
            .onFailure { onWarn("accept reply", it) }

    // ---------- sending ----------

    /**
     * Seal to a contact, to EVERY key I know of them (theirs + their card). With a live token it
     * goes by token (the road that can go direct); without one, by pubkey (the offline queue).
     */
    private suspend fun sendToContact(pubkey: String, payload: JsonObject, quiet: Boolean = false) {
        val keys = peers.encPubsOf(pubkey)
        val token = synchronized(online) { online[pubkey] }
        if (token != null) transport.sendSealedTo(token, payload, keys)
        else transport.sendSealed(pubkey, payload, keys, quiet)
    }

    suspend fun sendDM(pubkey: String, text: String): Unit = withContext(engine) {
        val t = sanitizeMessage(text)
        if (t.isEmpty()) return@withContext
        if (peers.get(pubkey)?.let { (it["isContact"] as? JsonPrimitive)?.content == "true" } != true) throw EngineError("not a contact", "not-contact")
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
        runCatching { sendToContact(pubkey, JsonObject(whoAmI() + ("type" to JsonPrimitive("HELLO"))), quiet = true) }
            .onFailure { onWarn("hello", it) }
    }

    private fun markOnline(pubkey: String, token: String) { synchronized(online) { online[pubkey] = token } }

    // ---------- receiving ----------

    private data class Who(val pubkey: String, val contact: JsonObject?, val encPub: String)

    private fun sameKey(a: String?, b: String?) = a != null && b != null && Delegation.samePubkey(a, b)

    /** The contact that writes, even from ANOTHER of their devices (their card says it is theirs). */
    private suspend fun findBySender(pubkey: String): JsonObject? {
        val cs = peers.contacts()
        cs.firstOrNull { sameKey(str(it, "publickey"), pubkey) }?.let { return it }
        return cs.firstOrNull { c -> (peers.cardOf(str(c, "publickey")!!)?.get("keys") as? JsonArray).orEmpty().any { sameKey(str(it as? JsonObject, "pub"), pubkey) } }
    }

    /**
     * WHO SENT THIS: trusted only if the key that sealed it belongs to the identity it claims —
     * one I know for that contact, or the one that identity announced signed.
     */
    private suspend fun authenticate(m: SealedSession.Message): Who? {
        val claimed = m.fromPubkey ?: return null
        val contact = findBySender(claimed)
        if (contact != null && peers.encPubsOf(str(contact, "publickey")!!).any { sameKey(it, m.senderEncPub) }) {
            return Who(str(contact, "publickey")!!, contact, m.senderEncPub)
        }
        val announced = try { transport.encPubOf(claimed) } catch (e: Exception) { onWarn("could not verify the sender key", e); return null }
        if (!sameKey(announced, m.senderEncPub)) { onWarn("message sealed with a key that is not the sender's — dropped", null); return null }
        return Who(str(contact, "publickey") ?: claimed, contact, m.senderEncPub)
    }

    private suspend fun handle(m: SealedSession.Message) {
        val type = str(m.payload, "type") ?: return
        val who = authenticate(m) ?: return
        when (type) {
            "CONTACT_REQUEST" -> return onContactRequest(m, who)
            "CONTACT_ACCEPT" -> return onContactAccept(m, who)
        }
        // From here on, only contacts. A stranger's message goes nowhere.
        val c = who.contact ?: return
        when (type) {
            "HELLO" -> onHello(m, c)
            "DM" -> onDM(m, c)
            "DM_ACK" -> str(m.payload, "id")?.let { id -> threads.threads().forEach { pk -> update(pk, id) { e -> e + ("pending" to JsonPrimitive(false)) } } }
            "RATING_QUERY" -> onRatingQuery(m, c)
            "RATING_REPLY" -> onRatingReply(m)
        }
    }

    /** Their version (§14) and their profile card, whatever message brings them. */
    private suspend fun noteProfile(pubkey: String, payload: JsonObject) {
        val v = Compat.check(mine, payload["v"] as? JsonObject)
        val mark = when { v.compatible -> null; v.code == "undeclared" -> "unknown"; else -> "incompatible" }
        peerCompat = if (mark == null) peerCompat - pubkey else peerCompat + (pubkey to mark)
        (payload["card"] as? JsonObject)?.let { card ->
            val r = runCatching { peers.adoptPeerCard(card) }.getOrNull()
            if (r != null && !r.adopted && r.reason == "master-cambiado") onWarn("the card of ${pubkey.take(24)} is signed by another device: not adopted silently", null)
        }
    }

    private suspend fun onContactRequest(m: SealedSession.Message, who: Who) {
        val nick = sanitizeNickname(str(m.payload, "nickname"))
        noteProfile(who.pubkey, m.payload)
        // Someone redeemed my code, and a code is SINGLE USE: ask for another one now.
        refreshPairingCode()
        m.fromToken?.let { markOnline(who.pubkey, it) }
        if (who.contact != null || loadRequests().any { it.pubkey == who.pubkey && it.dir == "out" }) {
            becomeContacts(who.pubkey, nick, m.fromToken, who.encPub)
            replyAccept(who.pubkey)
            changed(); return
        }
        val vouched = isVouched(who.pubkey)
        upsertRequest(Request(who.pubkey, "in", nick, m.fromToken, who.encPub, now(), vouched))
        changed()
        onNotice(Notice("request", "request-${who.pubkey}", who.pubkey, nick.ifEmpty { who.pubkey.take(8) }, "", vouched))
    }

    private suspend fun onContactAccept(m: SealedSession.Message, who: Who) {
        // Only counts if I asked. Nobody adds themselves to my contacts.
        val mine = loadRequests().firstOrNull { it.pubkey == who.pubkey && it.dir == "out" }
        if (mine == null && who.contact == null) return
        noteProfile(who.pubkey, m.payload)
        becomeContacts(who.pubkey, mine?.nickname?.takeIf { it.isNotEmpty() } ?: sanitizeNickname(str(m.payload, "nickname")), m.fromToken, who.encPub)
        m.fromToken?.let { markOnline(who.pubkey, it) }
        changed()
    }

    private suspend fun onHello(m: SealedSession.Message, c: JsonObject) {
        val pk = str(c, "publickey")!!
        noteProfile(pk, m.payload)
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
