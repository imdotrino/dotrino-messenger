import DotrinoNative
import Foundation

/// The transport is `FriendsTransport` (dotrino-native): the sealed session, or two engines wired
/// to each other in the tests.
typealias Transport = FriendsTransport
/// Small per-account values (nickname, requests): `KeyValueStore` of dotrino-native.
typealias Kv = KeyValueStore
typealias MemoryKv = MemoryKeyValueStore

/// THE HISTORY: one thread per contact, entries `{ id, dir, text, ts, pending?, _read? }` — the
/// PWA's shape. Same as `Threads` in Kotlin.
protocol Threads: AnyObject {
    func list(_ pubkey: String) -> [JSON]
    func threads() -> [String]
    func put(_ pubkey: String, _ entry: JSON)
}

/// The history in the app's store; thread keys are the contacts' keys, like the PWA's, so the
/// vault backup reconciles them. [onWrite]: something was written (the backup uploads it soon).
final class MessengerThreads: Threads {
    private let store: DotrinoStore
    private let onWrite: () -> Void
    init(_ store: DotrinoStore, onWrite: @escaping () -> Void = {}) { self.store = store; self.onWrite = onWrite }
    func list(_ pubkey: String) -> [JSON] { (try? store.listThread(pubkey)) ?? [] }
    func threads() -> [String] { (try? store.threadKeys()) ?? [] }
    func put(_ pubkey: String, _ entry: JSON) { try? store.appendMessage(pubkey, entry); onWrite() }
}

final class MemoryThreads: Threads {
    private var m: [String: [JSON]] = [:]
    private var order: [String] = []
    func list(_ pubkey: String) -> [JSON] { m[pubkey] ?? [] }
    func threads() -> [String] { order }
    func put(_ pubkey: String, _ entry: JSON) {
        if m[pubkey] == nil { order.append(pubkey) }
        var l = m[pubkey] ?? []
        if let i = l.firstIndex(where: { $0["id"] == entry["id"] }) { l[i] = entry } else { l.append(entry) }
        m[pubkey] = l
    }
}

final class DefaultsKv: KeyValueStore {
    private let d: UserDefaults
    private let prefix: String
    init(account: String) { d = .standard; prefix = "messenger.\(account)." }
    func get(_ key: String) -> String? { d.string(forKey: prefix + key) }
    func set(_ key: String, _ value: String?) { if let value { d.set(value, forKey: prefix + key) } else { d.removeObject(forKey: prefix + key) } }
}

/// THE MESSENGER, without a screen: the same port of the PWA's `threadsStore` (protocol 2) as
/// `MessengerEngine.kt`. Friends — requests, who wrote it, writing to every device of an account —
/// are `Friends` of dotrino-native (the port of `@dotrino/profile/friends`); this keeps the
/// conversations: threads, DM, HELLO, ratings, and the fixed Dotrino contact. An actor.
actor MessengerEngine {
    static let protocolVersion = 2
    /// THE DOTRINO ACCOUNT: a fixed contact of every messenger, like the PWA's (`DOTRINO_ACCOUNT` in
    /// `src/services/friends.js`) and `MessengerEngine.kt`. Dotrino answers there what is asked by
    /// email, so it cannot be removed or blocked: if it is missing, it comes back. It is the key of
    /// the PROFILE: any of its devices writes, recognised by a card signed by this key.
    static let dotrinoAccount = #"{"key_ops":["verify"],"ext":true,"kty":"EC","x":"McyhKieRw_Jcl3TY9EvLovL-ALzGoWqMOrfnFjT7XpA","y":"V7tfpDWN37tPnhXnIFUlMaTepcTzzxPWTj_72PkpKPw","crv":"P-256"}"#

    typealias Request = Friends.Request
    struct Notice: Sendable { let kind: String, id: String, fromPubkey: String, fromNickname: String, text: String; var vouched = false }
    struct EngineError: Error, CustomStringConvertible { let description: String; let code: String }

    nonisolated static func sanitizeNickname(_ s: String?) -> String { Friends.sanitizeNickname(s) }
    nonisolated static func sanitizeMessage(_ s: String?) -> String {
        String((s ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(1000))
    }

    private let transport: Transport
    private let peers: PeerBook
    private let threads: Threads
    private let kv: Kv
    private let reputation: Reputation?
    /// The friends of the ecosystem: the inbox, the code and the sending live there.
    nonisolated let friends: Friends
    nonisolated let mine: Compat.Declaration
    /// The fixed contact: `dotrinoAccount` (another key only in tests).
    nonisolated let pinnedAccount: String
    private var greeted = Set<String>()
    private var outbox: [JSON] = []
    private var offs: [() -> Void] = []

    private(set) var peerCompat: [String: String] = [:]
    var active: String?

    private var onChange: @Sendable () -> Void = {}
    private var onNotice: @Sendable (Notice) -> Void = { _ in }

    init(transport: Transport, profile: Profile, peers: PeerBook, threads: Threads, kv: Kv, version: String, reputation: Reputation? = nil, pinnedAccount: String = MessengerEngine.dotrinoAccount) {
        self.transport = transport; self.peers = peers; self.threads = threads; self.kv = kv; self.reputation = reputation
        self.pinnedAccount = pinnedAccount
        let mine = Compat.declare(product: "messenger", version: version, protocolVersion: Self.protocolVersion)
        self.mine = mine
        let nick: @Sendable () -> String = { [kv] in kv.get("nickname") ?? "" }
        friends = Friends(transport: transport, profile: profile, peers: peers, kv: kv, nickname: nick, version: mine.json,
                          pinned: [.init(publickey: pinnedAccount, nickname: "Dotrino")])
    }

    func setHandlers(onChange: @escaping @Sendable () -> Void, onNotice: @escaping @Sendable (Notice) -> Void) {
        self.onChange = onChange; self.onNotice = onNotice
    }
    private func changed() { onChange() }
    private func notice(_ n: Notice) { onNotice(n) }

    /// What Friends says, the messenger turns into its own: a notice, the outbox, the thread that moves, the version.
    private func installHooks() async {
        var h = Friends.Hooks()
        h.onChange = { [weak self] in Task { await self?.changed() } }
        h.onRequest = { [weak self] r in await self?.notice(Notice(kind: "request", id: "request-\(r.pubkey)", fromPubkey: r.pubkey, fromNickname: r.nickname.isEmpty ? String(r.pubkey.prefix(8)) : r.nickname, text: "", vouched: r.vouched)) }
        h.onFriend = { [weak self] _ in await self?.flushOutbox() }
        h.onMoved = { [weak self] from, to in await self?.moveThread(from, to) }
        h.onProfile = { [weak self] pk, payload in await self?.noteVersion(pk, payload) }
        h.isVouched = { [weak self] pk in await self?.isVouched(pk) ?? false }
        await friends.setHooks(h)
    }
    func setActive(_ pk: String?) { active = pk }

    /** Stops listening and renewing the code (the app is starting again with another profile). */
    func stop() async {
        offs.forEach { $0() }; offs.removeAll()
        await friends.stop()
    }

    func start() async {
        await installHooks()
        offs.append(transport.onMessage { [weak self] m in Task { await self?.handle(m) } })
        offs.append(transport.onOnline { [weak self] in Task { await self?.whenOnline() } })
        offs.append(transport.onPeerGone { [weak self] t in Task { await self?.peerGone(t) } })
        if transport.isOnline { Task { await whenOnline() } }
    }

    private func peerGone(_ t: String) async { greeted.remove(t); await friends.markOffline(t) }

    private func whenOnline() async {
        await friends.refreshCode()
        for c in await friends.contacts() { if let pk = c["publickey"]?.string { await sendHello(to: pk) } }
        await flushOutbox()
        onChange()
    }

    // MARK: account values

    var nickname: String { kv.get("nickname") ?? "" }
    func setNickname(_ v: String) { kv.set("nickname", String(Self.sanitizeNickname(v).prefix(40))); onChange() }
    var hasNickname: Bool { !nickname.isEmpty }

    // MARK: what the screen reads

    func contacts() async -> [JSON] { await friends.contacts() }

    /// Is it the Dotrino account (the fixed contact)?
    nonisolated func isPinned(_ pk: String?) -> Bool { friends.isPinned(pk) }

    /// Block or unblock someone: private, in the address book (travels to the vault), never published. Not Dotrino.
    func setBlocked(_ pk: String, _ blocked: Bool) throws {
        if isPinned(pk) { throw EngineError(description: "the Dotrino account cannot be blocked", code: "pinned-contact") }
        try peers.setBlocked(pk, blocked); onChange()
    }
    func isBlocked(_ pk: String) async -> Bool { await friends.isBlocked(pk) }
    /// Whether there is any device to write to (Dotrino has none until it writes first).
    func canWrite(_ pk: String) async -> Bool { await !friends.recipientsOf(pk).isEmpty }
    func isOnline(_ pk: String) async -> Bool { await friends.isOnline(pk) }
    func thread(_ pk: String) -> [JSON] { threads.list(pk).sorted { ($0["ts"]?.int ?? 0) < ($1["ts"]?.int ?? 0) } }
    func unread(_ pk: String) -> Int { threads.list(pk).filter { $0["dir"]?.string == "in" && $0["_read"]?.bool != true }.count }
    func requests() async -> [Request] { await friends.requests }
    var pairingCode: String? { get async { await friends.code } }

    // MARK: friends (dotrino-native `Friends`)

    /// Redeem someone's code and send a CONTACT REQUEST. Throws `own`, `offline` or `invalid` (`Friends.FriendsError`).
    func addByCode(_ code: String, alias: String) async throws { try await friends.requestByCode(code, alias: alias) }
    /// A contact request to the key of a LINK (`#to=…`): with their card it goes to every device of the account.
    func addByLink(pubkey: String, alias: String, card: JSON?) async throws { try await friends.request(pubkey: pubkey, alias: alias, card: card) }
    func acceptRequest(_ pubkey: String) async { await friends.accept(pubkey) }
    func dismissRequest(_ pubkey: String, dir: String) async { await friends.dismiss(pubkey, dir: dir) }

    // MARK: sending

    private func sendToContact(_ pubkey: String, _ payload: JSON, quiet: Bool = false) async throws {
        try await friends.send(pubkey, payload, quiet: quiet)
    }

    func sendDM(_ pubkey: String, _ text: String) async throws {
        let t = Self.sanitizeMessage(text)
        if t.isEmpty { return }
        guard (try? peers.get(pubkey))?["isContact"]?.bool == true else { throw EngineError(description: "not a contact", code: "not-contact") }
        if await friends.recipientsOf(pubkey).isEmpty { throw EngineError(description: "no device of this account is known yet", code: "no-devices") }
        let id = UUID().uuidString.lowercased(), ts = nowMs()
        threads.put(pubkey, ["id": .string(id), "dir": "out", "text": .string(t), "ts": .int(ts), "pending": true])
        onChange()
        _ = await deliver(["pubkey": .string(pubkey), "entryId": .string(id), "text": .string(t), "ts": .int(ts)])
    }

    private func deliver(_ item: JSON) async -> Bool {
        guard let pk = item["pubkey"]?.string, let id = item["entryId"]?.string else { return false }
        do {
            try await sendToContact(pk, ["type": "DM", "text": item["text"]!, "ts": item["ts"]!, "mid": .string(id)])
            update(pk, id) { $0["pending"] = false }
            return true
        } catch {
            if !outbox.contains(where: { $0["entryId"]?.string == id }) { outbox.append(item) }
            return false
        }
    }

    private func flushOutbox() async {
        if outbox.isEmpty { return }
        let pending = outbox; outbox = []
        for item in pending { _ = await deliver(item) }
    }

    private func update(_ pk: String, _ id: String, _ f: (inout [String: JSON]) -> Void) {
        guard var e = threads.list(pk).first(where: { $0["id"]?.string == id })?.object else { return }
        f(&e); threads.put(pk, .object(e)); onChange()
    }

    func markRead(_ pk: String) {
        for e in threads.list(pk) where e["dir"]?.string == "in" && e["_read"]?.bool != true {
            var o = e.object!; o["_read"] = true; threads.put(pk, .object(o))
        }
        onChange()
    }

    /// Presence: token, nickname and card. Queued quietly if they are offline.
    func sendHello(to pk: String) async {
        // An account with no known device (Dotrino before it writes) has nobody to greet.
        if await friends.recipientsOf(pk).isEmpty { return }
        try? await sendToContact(pk, await friends.me("HELLO"), quiet: true)
    }

    // MARK: receiving

    private func handle(_ m: SealedSession.Message) async {
        // Sealed, authenticated, not blocked, and the friend requests: `Friends`.
        guard let r = await friends.receive(m), !r.handled else { return }
        guard let c = r.who.contact else { return }   // a stranger's message goes nowhere
        switch m.payload["type"]?.string {
        case "HELLO": await onHello(m, r.who)
        case "DM": await onDM(m, c)
        case "DM_ACK": if let id = m.payload["id"]?.string { for pk in threads.threads() { update(pk, id) { $0["pending"] = false } } }
        case "RATING_QUERY": await onRatingQuery(m, c)
        case "RATING_REPLY": onRatingReply(m)
        default: break
        }
    }

    /// Their version (§14): noted, not blocking — talking to a version that does not understand looks like silence.
    private func noteVersion(_ pk: String, _ payload: JSON) {
        let v = Compat.check(mine: mine, theirs: payload["v"])
        if v.compatible { peerCompat[pk] = nil } else { peerCompat[pk] = v.code == "undeclared" ? "unknown" : "incompatible" }
    }

    /// A contact kept by a device key moved to its account (`Friends.upgradeToAccount`): its thread goes with it.
    private func moveThread(_ from: String, _ to: String) {
        for e in threads.list(from) { threads.put(to, e) }
        if active == from { active = to }
    }

    private func onHello(_ m: SealedSession.Message, _ who: Friends.Who) async {
        await friends.noteProfile(who.pubkey, m.payload)
        guard let c = await friends.upgradeToAccount(who, m.payload), let pk = c["publickey"]?.string else { return }
        var patch: [String: String?] = [:]
        if let t = m.fromToken { patch["lastToken"] = t }
        if (c["nickname"]?.string ?? "").isEmpty { let n = Self.sanitizeNickname(m.payload["nickname"]?.string); if !n.isEmpty { patch["nickname"] = n } }
        if !patch.isEmpty { _ = try? peers.updateContact(pk, patch) }
        if let t = m.fromToken {
            await friends.markOnline(pk, t)
            await flushOutbox()
            if greeted.insert(t).inserted { await sendHello(to: pk) }
        }
        onChange()
    }

    private func onDM(_ m: SealedSession.Message, _ c: JSON) async {
        guard let text = m.payload["text"]?.string, let pk = c["publickey"]?.string else { return }
        let clean = Self.sanitizeMessage(text)
        let mid = m.payload["mid"]?.string ?? UUID().uuidString.lowercased()
        let ts = m.payload["ts"]?.int ?? nowMs()
        if !threads.list(pk).contains(where: { $0["id"]?.string == mid }) {
            var e: [String: JSON] = ["id": .string(mid), "dir": "in", "text": .string(clean), "ts": .int(ts), "queued": .bool(m.queued)]
            if let q = m.queuedAt { e["queuedAt"] = .int(q) }
            if active == pk { e["_read"] = true }
            threads.put(pk, .object(e))
            onChange()
            if active != pk { onNotice(Notice(kind: "message", id: mid, fromPubkey: pk, fromNickname: c["nickname"]?.string ?? String(pk.prefix(8)), text: clean)) }
        }
        if let t = m.fromToken { await friends.markOnline(pk, t) }
        try? await sendToContact(pk, ["type": "DM_ACK", "id": .string(mid)], quiet: true)
    }

    // MARK: ratings

    private func isVouched(_ pk: String) async -> Bool { ((await reputation?.aggregateTrust(pk))?.trustedCount ?? 0) > 0 }

    func rate(_ pk: String, _ indicators: [String: Int]) async throws {
        guard let r = reputation else { throw EngineError(description: "no reputation registry", code: "no-reputation") }
        try await r.rate(pk, indicators)
        onChange()
    }

    func myIndicatorsFor(_ pk: String) async -> [String: Double] { (try? await reputation?.myIndicatorsFor(pk)) ?? [:] }

    func askRatingsAbout(_ subject: String) async {
        let qid = UUID().uuidString.lowercased()
        for c in await contacts() {
            guard let pk = c["publickey"]?.string, pk != subject, await friends.isOnline(pk) else { continue }
            try? await sendToContact(pk, ["type": "RATING_QUERY", "queryId": .string(qid), "subject": .string(subject)])
        }
    }

    private func onRatingQuery(_ m: SealedSession.Message, _ c: JSON) async {
        guard let subject = m.payload["subject"]?.string, let qid = m.payload["queryId"]?.string, let pk = c["publickey"]?.string else { return }
        try? peers.recordQuery(asker: pk, subject: subject)
        let r: (mine: JSON?, endorsements: [JSON]) = (try? peers.ratingsFor(subject)) ?? (nil, [])
        try? await sendToContact(pk, ["type": "RATING_REPLY", "queryId": .string(qid), "subject": .string(subject), "mine": r.mine ?? .null, "endorsements": .array(r.endorsements)])
    }

    private func onRatingReply(_ m: SealedSession.Message) {
        guard let subject = m.payload["subject"]?.string else { return }
        var list: [JSON] = []
        if let mine = m.payload["mine"], mine.object != nil { list.append(mine) }
        list += (m.payload["endorsements"]?.array ?? []).filter { $0.object != nil }
        if !list.isEmpty { _ = try? peers.mergeEndorsements(subject, list) }
        onChange()
    }
}
