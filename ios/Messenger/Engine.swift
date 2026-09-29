import DotrinoNative
import Foundation

/// What the engine needs from the transport: the sealed session of dotrino-native. A protocol so
/// the engine is tested with two engines wired to each other. Same as `Ports.kt`.
protocol Transport: AnyObject {
    func sendSealed(toToken token: String, _ payload: JSON, recipientEncPubs: [String]) async throws
    func sendSealed(toPubkey pubkey: String, _ payload: JSON, recipientEncPubs: [String], quiet: Bool) async throws
    func encPubOf(_ publickey: String) async throws -> String
    func whoIs(_ token: String) async throws -> String?
    func requestPairingCode() async throws -> ProxyConnection.PairingCode
    func redeemPairingCode(_ code: String) async throws -> String
    var isOnline: Bool { get }
    func onMessage(_ l: @escaping (SealedSession.Message) -> Void) -> () -> Void
    func onOnline(_ l: @escaping () -> Void) -> () -> Void
    func onPeerGone(_ l: @escaping (String) -> Void) -> () -> Void
}

extension SealedSession: Transport {
    func sendSealed(toToken token: String, _ payload: JSON, recipientEncPubs: [String]) async throws {
        try await sendSealed(toToken: token, payload, recipientEncPubs: recipientEncPubs)
    }
    func whoIs(_ token: String) async throws -> String? { try await whoIs(token, timeout: 10) }
    func requestPairingCode() async throws -> ProxyConnection.PairingCode { try await requestPairingCode(ttlMs: nil) }
    func onPeerGone(_ l: @escaping (String) -> Void) -> () -> Void {
        onEvent { e in if case .peerGone(let t, _) = e { l(t) } }
    }
}

/// THE HISTORY: one thread per contact, entries `{ id, dir, text, ts, pending?, _read? }` — the
/// PWA's shape. Same as `Threads` in Kotlin.
protocol Threads: AnyObject {
    func list(_ pubkey: String) -> [JSON]
    func threads() -> [String]
    func put(_ pubkey: String, _ entry: JSON)
}

final class MessengerThreads: Threads {
    private let store: DotrinoStore
    private let index = "messenger.threads"
    init(_ store: DotrinoStore) { self.store = store }
    func list(_ pubkey: String) -> [JSON] { (try? store.listThread(pubkey)) ?? [] }
    func threads() -> [String] { ((try? store.listThread(index)) ?? []).compactMap { $0["id"]?.string } }
    func put(_ pubkey: String, _ entry: JSON) {
        try? store.appendMessage(pubkey, entry)
        if !threads().contains(pubkey) { try? store.appendMessage(index, ["id": .string(pubkey)]) }
    }
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

/// Small per-account values (nickname, requests).
protocol Kv: AnyObject {
    func get(_ key: String) -> String?
    func set(_ key: String, _ value: String?)
}

final class MemoryKv: Kv {
    private var m: [String: String] = [:]
    func get(_ key: String) -> String? { m[key] }
    func set(_ key: String, _ value: String?) { m[key] = value }
}

final class DefaultsKv: Kv {
    private let d: UserDefaults
    private let prefix: String
    init(account: String) { d = .standard; prefix = "messenger.\(account)." }
    func get(_ key: String) -> String? { d.string(forKey: prefix + key) }
    func set(_ key: String, _ value: String?) { if let value { d.set(value, forKey: prefix + key) } else { d.removeObject(forKey: prefix + key) } }
}

/// THE MESSENGER, without a screen: the same port of the PWA's `threadsStore` (protocol 2) as
/// `MessengerEngine.kt`. Everything sealed; who wrote it is the key that sealed it; a request is
/// control, never chat; a stranger's message goes nowhere. An actor: one thing at a time.
actor MessengerEngine {
    static let protocolVersion = 2
    static let requestTTL: Int64 = 24 * 60 * 60 * 1000

    struct Request: Equatable, Sendable {
        let pubkey: String, dir: String, nickname: String, token: String?, encryptionPubkey: String?, ts: Int64
        var vouched = false
    }
    struct Notice: Sendable { let kind: String, id: String, fromPubkey: String, fromNickname: String, text: String; var vouched = false }
    struct EngineError: Error, CustomStringConvertible { let description: String; let code: String }

    nonisolated static func sanitizeNickname(_ s: String?) -> String {
        (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines).filter { !"<>\"'`".contains($0) }
    }
    nonisolated static func sanitizeMessage(_ s: String?) -> String {
        String((s ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(1000))
    }

    private let transport: Transport
    private let profile: Profile
    private let peers: PeerBook
    private let threads: Threads
    private let kv: Kv
    private let reputation: Reputation?
    nonisolated let mine: Compat.Declaration
    private var online: [String: String] = [:]
    private var greeted = Set<String>()
    private var outbox: [JSON] = []
    private var offs: [() -> Void] = []
    private var codeTask: Task<Void, Never>?

    private(set) var peerCompat: [String: String] = [:]
    private(set) var pairingCode: String?
    var active: String?

    private var onChange: @Sendable () -> Void = {}
    private var onNotice: @Sendable (Notice) -> Void = { _ in }

    init(transport: Transport, profile: Profile, peers: PeerBook, threads: Threads, kv: Kv, version: String, reputation: Reputation? = nil) {
        self.transport = transport; self.profile = profile; self.peers = peers; self.threads = threads; self.kv = kv; self.reputation = reputation
        mine = Compat.declare(product: "messenger", version: version, protocolVersion: Self.protocolVersion)
    }

    func setHandlers(onChange: @escaping @Sendable () -> Void, onNotice: @escaping @Sendable (Notice) -> Void) {
        self.onChange = onChange; self.onNotice = onNotice
    }
    func setActive(_ pk: String?) { active = pk }

    func start() {
        offs.append(transport.onMessage { [weak self] m in Task { await self?.handle(m) } })
        offs.append(transport.onOnline { [weak self] in Task { await self?.whenOnline() } })
        offs.append(transport.onPeerGone { [weak self] t in Task { await self?.peerGone(t) } })
        if transport.isOnline { Task { await whenOnline() } }
    }

    private func peerGone(_ t: String) { online = online.filter { $0.value != t }; greeted.remove(t); onChange() }

    private func whenOnline() async {
        await refreshPairingCode()
        for c in (try? peers.contacts()) ?? [] { if let pk = c["publickey"]?.string { await sendHello(to: pk) } }
        await flushOutbox()
        onChange()
    }

    // MARK: account values

    var nickname: String { kv.get("nickname") ?? "" }
    func setNickname(_ v: String) { kv.set("nickname", String(Self.sanitizeNickname(v).prefix(40))); onChange() }
    var hasNickname: Bool { !nickname.isEmpty }

    // MARK: what the screen reads

    func contacts() -> [JSON] { (try? peers.contacts()) ?? [] }
    func isOnline(_ pk: String) -> Bool { online[pk] != nil }
    func thread(_ pk: String) -> [JSON] { threads.list(pk).sorted { ($0["ts"]?.int ?? 0) < ($1["ts"]?.int ?? 0) } }
    func unread(_ pk: String) -> Int { threads.list(pk).filter { $0["dir"]?.string == "in" && $0["_read"]?.bool != true }.count }
    func requests() -> [Request] { loadRequests() }

    // MARK: the short code

    func refreshPairingCode() async {
        codeTask?.cancel(); codeTask = nil
        do {
            let c = try await transport.requestPairingCode()
            pairingCode = c.code
            let left = c.expiresAt - nowMs()
            if left > 10_000 {
                codeTask = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(left - 5_000) * 1_000_000)
                    if !Task.isCancelled { await self?.renewalFired() }
                }
            }
        } catch { pairingCode = nil }
        onChange()
    }

    /// The renewal timer fired: it forgets itself FIRST, so the refresh does not cancel the task
    /// it is running in (that left the code empty on Android).
    private func renewalFired() async { codeTask = nil; await refreshPairingCode() }

    /// Redeem someone's code and send a CONTACT REQUEST. Throws `own`, `offline` or `invalid`.
    func addByCode(_ code: String, alias: String) async throws {
        if code == pairingCode { throw EngineError(description: "that is your own code", code: "own") }
        if !transport.isOnline { throw EngineError(description: "not connected", code: "offline") }
        let token: String
        do { token = try await transport.redeemPairingCode(code) } catch {
            let c = (error as? ProxyError)?.code ?? (error as? SealedSession.SessionError)?.code
            throw EngineError(description: "\(error)", code: c == "disconnected" || c == "timeout" ? "offline" : "invalid")
        }
        guard let pubkey = try await transport.whoIs(token) else { throw EngineError(description: "the other side did not say who it is", code: "offline") }
        try await sendContactRequest(token: token, pubkey: pubkey, alias: alias)
    }

    private func whoAmI(_ type: String) -> JSON {
        var o: [String: JSON] = ["type": .string(type), "nickname": .string(nickname), "v": mine.json]
        if let card = profile.card { o["card"] = card }
        return .object(o)
    }

    private func sendContactRequest(token: String?, pubkey: String, alias: String) async throws {
        if loadRequests().contains(where: { $0.pubkey == pubkey && $0.dir == "in" }) { await acceptRequest(pubkey); return }
        let payload = whoAmI("CONTACT_REQUEST")
        if let token { try await transport.sendSealed(toToken: token, payload, recipientEncPubs: []) }
        else { try await transport.sendSealed(toPubkey: pubkey, payload, recipientEncPubs: [], quiet: false) }
        upsertRequest(Request(pubkey: pubkey, dir: "out", nickname: Self.sanitizeNickname(alias), token: token, encryptionPubkey: nil, ts: nowMs()))
        onChange()
    }

    // MARK: requests

    private func loadRequests() -> [Request] {
        guard let raw = kv.get("requests"), let arr = (try? JSON.parse(raw))?.array else { return [] }
        let now = nowMs()
        return arr.compactMap { o -> Request? in
            guard let pk = o["pubkey"]?.string else { return nil }
            return Request(pubkey: pk, dir: o["dir"]?.string ?? "in", nickname: o["nickname"]?.string ?? "", token: o["token"]?.string,
                           encryptionPubkey: o["encryptionPubkey"]?.string, ts: o["ts"]?.int ?? 0, vouched: o["vouched"]?.bool ?? false)
        }.filter { now - $0.ts < Self.requestTTL }
    }

    private func saveRequests(_ l: [Request]) {
        kv.set("requests", JSON.array(l.map { r in
            var o: [String: JSON] = ["pubkey": .string(r.pubkey), "dir": .string(r.dir), "nickname": .string(r.nickname), "ts": .int(r.ts), "vouched": .bool(r.vouched)]
            if let t = r.token { o["token"] = .string(t) }
            if let e = r.encryptionPubkey { o["encryptionPubkey"] = .string(e) }
            return .object(o)
        }).text)
    }

    private func upsertRequest(_ r: Request) {
        var l = loadRequests()
        if let i = l.firstIndex(where: { $0.pubkey == r.pubkey && $0.dir == r.dir }) {
            var n = r; n = Request(pubkey: r.pubkey, dir: r.dir, nickname: r.nickname, token: r.token, encryptionPubkey: r.encryptionPubkey, ts: l[i].ts, vouched: r.vouched); l[i] = n
        } else { l.insert(r, at: 0) }
        saveRequests(l)
    }

    private func removeRequests(_ pubkey: String, dir: String? = nil) {
        saveRequests(loadRequests().filter { !($0.pubkey == pubkey && (dir == nil || $0.dir == dir)) })
    }

    /// Accept a request: now we are contacts on both sides. No message enters any chat.
    func acceptRequest(_ pubkey: String) async {
        guard let r = loadRequests().first(where: { $0.pubkey == pubkey && $0.dir == "in" }) else { return }
        await becomeContacts(pubkey, nickname: r.nickname, token: r.token, encPub: r.encryptionPubkey)
        if let t = r.token { online[pubkey] = t }
        await replyAccept(pubkey)
        onChange()
    }

    /// Dismiss an incoming request, or cancel one I sent. The other side is not told.
    func dismissRequest(_ pubkey: String, dir: String) { removeRequests(pubkey, dir: dir); onChange() }

    private func becomeContacts(_ pubkey: String, nickname: String, token: String?, encPub: String?) async {
        let existing = try? peers.get(pubkey)
        let nick = existing?["nickname"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? (nickname.isEmpty ? String(pubkey.prefix(8)) : nickname)
        _ = try? peers.addContact(pubkey, nickname: nick, encryptionPubkey: encPub ?? existing?["encryptionPubkey"]?.string, lastToken: token)
        removeRequests(pubkey)
        await flushOutbox()
    }

    private func replyAccept(_ pubkey: String) async { try? await sendToContact(pubkey, whoAmI("CONTACT_ACCEPT")) }

    // MARK: sending

    /// Sealed to EVERY key I know of the contact; by token if online, by pubkey if not.
    private func sendToContact(_ pubkey: String, _ payload: JSON, quiet: Bool = false) async throws {
        let keys = (try? peers.encPubsOf(pubkey)) ?? []
        if let token = online[pubkey] { try await transport.sendSealed(toToken: token, payload, recipientEncPubs: keys) }
        else { try await transport.sendSealed(toPubkey: pubkey, payload, recipientEncPubs: keys, quiet: quiet) }
    }

    func sendDM(_ pubkey: String, _ text: String) async throws {
        let t = Self.sanitizeMessage(text)
        if t.isEmpty { return }
        guard (try? peers.get(pubkey))?["isContact"]?.bool == true else { throw EngineError(description: "not a contact", code: "not-contact") }
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
    func sendHello(to pk: String) async { try? await sendToContact(pk, whoAmI("HELLO"), quiet: true) }

    // MARK: receiving

    private func same(_ a: String?, _ b: String?) -> Bool { Delegation.samePubkey(a, b) }

    private func findBySender(_ pk: String) -> JSON? {
        let cs = contacts()
        if let c = cs.first(where: { same($0["publickey"]?.string, pk) }) { return c }
        return cs.first { c in ((try? peers.cardOf(c["publickey"]?.string ?? ""))??["keys"]?.array ?? []).contains { same($0["pub"]?.string, pk) } }
    }

    private struct Who { let pubkey: String; let contact: JSON?; let encPub: String }

    private func authenticate(_ m: SealedSession.Message) async -> Who? {
        guard let claimed = m.fromPubkey else { return nil }
        let contact = findBySender(claimed)
        if let c = contact, let pk = c["publickey"]?.string, ((try? peers.encPubsOf(pk)) ?? []).contains(where: { same($0, m.senderEncPub) }) {
            return Who(pubkey: pk, contact: c, encPub: m.senderEncPub)
        }
        guard let announced = try? await transport.encPubOf(claimed), same(announced, m.senderEncPub) else { return nil }
        return Who(pubkey: contact?["publickey"]?.string ?? claimed, contact: contact, encPub: m.senderEncPub)
    }

    private func handle(_ m: SealedSession.Message) async {
        guard let type = m.payload["type"]?.string, let who = await authenticate(m) else { return }
        switch type {
        case "CONTACT_REQUEST": await onContactRequest(m, who); return
        case "CONTACT_ACCEPT": await onContactAccept(m, who); return
        default: break
        }
        guard let c = who.contact else { return }   // a stranger's message goes nowhere
        switch type {
        case "HELLO": await onHello(m, c)
        case "DM": await onDM(m, c)
        case "DM_ACK": if let id = m.payload["id"]?.string { for pk in threads.threads() { update(pk, id) { $0["pending"] = false } } }
        case "RATING_QUERY": await onRatingQuery(m, c)
        case "RATING_REPLY": onRatingReply(m)
        default: break
        }
    }

    private func noteProfile(_ pk: String, _ payload: JSON) {
        let v = Compat.check(mine: mine, theirs: payload["v"])
        if v.compatible { peerCompat[pk] = nil } else { peerCompat[pk] = v.code == "undeclared" ? "unknown" : "incompatible" }
        if let card = payload["card"], card.object != nil { _ = try? peers.adoptPeerCard(card) }
    }

    private func onContactRequest(_ m: SealedSession.Message, _ who: Who) async {
        let nick = Self.sanitizeNickname(m.payload["nickname"]?.string)
        noteProfile(who.pubkey, m.payload)
        await refreshPairingCode()   // a code is SINGLE USE: the one on screen is burnt
        if let t = m.fromToken { online[who.pubkey] = t }
        if who.contact != nil || loadRequests().contains(where: { $0.pubkey == who.pubkey && $0.dir == "out" }) {
            await becomeContacts(who.pubkey, nickname: nick, token: m.fromToken, encPub: who.encPub)
            await replyAccept(who.pubkey)
            onChange(); return
        }
        let vouched = await isVouched(who.pubkey)
        upsertRequest(Request(pubkey: who.pubkey, dir: "in", nickname: nick, token: m.fromToken, encryptionPubkey: who.encPub, ts: nowMs(), vouched: vouched))
        onChange()
        onNotice(Notice(kind: "request", id: "request-\(who.pubkey)", fromPubkey: who.pubkey, fromNickname: nick.isEmpty ? String(who.pubkey.prefix(8)) : nick, text: "", vouched: vouched))
    }

    private func onContactAccept(_ m: SealedSession.Message, _ who: Who) async {
        let asked = loadRequests().first { $0.pubkey == who.pubkey && $0.dir == "out" }
        if asked == nil && who.contact == nil { return }   // nobody adds themselves
        noteProfile(who.pubkey, m.payload)
        let nick = (asked?.nickname).flatMap { $0.isEmpty ? nil : $0 } ?? Self.sanitizeNickname(m.payload["nickname"]?.string)
        await becomeContacts(who.pubkey, nickname: nick, token: m.fromToken, encPub: who.encPub)
        if let t = m.fromToken { online[who.pubkey] = t }
        onChange()
    }

    private func onHello(_ m: SealedSession.Message, _ c: JSON) async {
        guard let pk = c["publickey"]?.string else { return }
        noteProfile(pk, m.payload)
        var patch: [String: String?] = [:]
        if let t = m.fromToken { patch["lastToken"] = t }
        if (c["nickname"]?.string ?? "").isEmpty { let n = Self.sanitizeNickname(m.payload["nickname"]?.string); if !n.isEmpty { patch["nickname"] = n } }
        if !patch.isEmpty { _ = try? peers.updateContact(pk, patch) }
        if let t = m.fromToken {
            online[pk] = t
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
        if let t = m.fromToken { online[pk] = t }
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
        for c in contacts() {
            guard let pk = c["publickey"]?.string, pk != subject, online[pk] != nil else { continue }
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
