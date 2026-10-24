import CryptoKit
import DotrinoNative
import XCTest
@testable import Messenger

/// The messenger's rules with REAL engines and REAL sealing over an in-memory proxy. The same
/// cases as `EngineTest.kt`. The friend requests on their own are tested in dotrino-native
/// (`FriendsTests`); here, the conversation around them.
final class EngineTests: XCTestCase {
    struct SoftKeys: DeviceKeys {
        let s = P256.Signing.PrivateKey(), e = P256.KeyAgreement.PrivateKey()
        var publickey: String { Crypto.jwk(raw: s.publicKey.rawRepresentation) }
        var encPub: String { Crypto.jwk(raw: e.publicKey.rawRepresentation) }
        func signBytes(_ bytes: Data) throws -> String { Crypto.b64(try s.signature(for: bytes).rawRepresentation) }
        func agree(_ peer: P256.KeyAgreement.PublicKey) throws -> Data { try e.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) } }
    }

    final class Net: @unchecked Sendable {
        var phones: [String: Phone] = [:]
        var codes: [String: String] = [:]
    }

    final class Phone: Transport, @unchecked Sendable {
        let net: Net, name: String, token: String
        let profile: Profile
        lazy var sealing = IdentitySealing(profile: profile, app: "messenger")
        var listeners: [UUID: (SealedSession.Message) -> Void] = [:]
        /// Every payload type that reached this device, whoever it was for.
        var got: [String] = []
        init(_ net: Net, _ name: String, keys: SoftKeys = SoftKeys(), acta: JSON? = nil) {
            self.net = net; self.name = name; token = "T-\(name)"; profile = Profile.of(keys, acta: acta); net.phones[token] = self
        }

        func deliver(to: Phone, _ payload: JSON, _ keys: [String]) throws {
            let env = try sealing.seal(payload, to: keys.isEmpty ? [to.profile.encPub] : keys)
            guard let o = try? to.sealing.open(env) else { return }
            to.got.append(o.payload["type"]?.string ?? "?")
            let m = SealedSession.Message(fromToken: token, fromPubkey: profile.publickey, payload: o.payload, senderEncPub: o.senderEncPub, queued: false, queuedAt: nil)
            to.listeners.values.forEach { $0(m) }
        }
        func sendSealed(toToken token: String, _ payload: JSON, recipientEncPubs: [String], peerPubkey: String?) async throws { try deliver(to: net.phones[token]!, payload, recipientEncPubs) }
        func sendSealed(toPubkey pubkey: String, _ payload: JSON, recipientEncPubs: [String], quiet: Bool) async throws {
            try deliver(to: net.phones.values.first { $0.profile.publickey == pubkey }!, payload, recipientEncPubs)
        }
        func encPubOf(_ publickey: String) async throws -> String { net.phones.values.first { $0.profile.publickey == publickey }!.profile.encPub }
        func whoIs(_ token: String) async throws -> String? { net.phones[token]?.profile.publickey }
        func requestPairingCode() async throws -> ProxyConnection.PairingCode {
            let c = "C" + String(name.uppercased().prefix(5)).padding(toLength: 5, withPad: "X", startingAt: 0)
            net.codes[c] = token
            return .init(code: c, expiresAt: nowMs() + 60_000)
        }
        func redeemPairingCode(_ code: String) async throws -> String {
            guard let t = net.codes.removeValue(forKey: code) else { throw ProxyError("bad code", code: "pair-invalid") }
            return t
        }
        var isOnline: Bool { true }
        func onMessage(_ l: @escaping (SealedSession.Message) -> Void) -> () -> Void { let k = UUID(); listeners[k] = l; return { [weak self] in self?.listeners[k] = nil } }
        func onOnline(_ l: @escaping () -> Void) -> () -> Void { {} }
        func onPeerGone(_ l: @escaping (String) -> Void) -> () -> Void { {} }
    }

    struct Person {
        let phone: Phone, engine: MessengerEngine, threads = MemoryThreads(), peers: PeerBook
        init(_ net: Net, _ name: String, keys: SoftKeys = SoftKeys(), acta: JSON? = nil, pinned: String = MessengerEngine.dotrinoAccount) async {
            phone = Phone(net, name, keys: keys, acta: acta)
            peers = PeerBook(storage: PeerBook.MemoryStorage(), profile: phone.profile)
            engine = MessengerEngine(transport: phone, profile: phone.profile, peers: peers,
                                     threads: threads, kv: MemoryKv(), version: "0.3.0", pinnedAccount: pinned)
            await engine.setNickname(name)
            await engine.start()
        }
        var pubkey: String { phone.profile.publickey }
        /// The contacts, without the fixed one (Dotrino).
        func people() async -> [JSON] { await engine.contacts().filter { !engine.isPinned($0["publickey"]?.string) } }
    }

    private func until(_ what: String, _ f: () async -> Bool) async {
        for _ in 0..<250 { if await f() { return }; try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTFail("timed out: \(what)")
    }

    func testARequestIsControlNotChatAndAcceptMakesContacts() async throws {
        let net = Net()
        let ana = await Person(net, "Ana"), beto = await Person(net, "Beto")
        await until("code") { await ana.engine.pairingCode != nil }
        try await beto.engine.addByCode(await ana.engine.pairingCode!, alias: "Anita")
        await until("request") { await ana.engine.requests().contains { $0.dir == "in" } }
        XCTAssertTrue(ana.threads.threads().isEmpty)
        let none = await ana.people()
        XCTAssertTrue(none.isEmpty)
        await ana.engine.acceptRequest(beto.pubkey)
        await until("beto has ana") { await !beto.people().isEmpty }
        let bc = await beto.people()
        XCTAssertEqual(bc.first?["nickname"]?.string, "Anita")
        try await beto.engine.sendDM(ana.pubkey, "hola & ñ <b>")
        await until("ana reads") { await ana.engine.thread(beto.pubkey).contains { $0["text"]?.string == "hola & ñ <b>" } }
        let th = await ana.engine.thread(beto.pubkey)
        XCTAssertEqual(th.count, 1)
    }

    func testAStrangersMessageGoesNowhere() async throws {
        let net = Net()
        let ana = await Person(net, "Ana"), carla = await Person(net, "Carla")
        try carla.phone.deliver(to: ana.phone, ["type": "DM", "text": "hola", "mid": "m1", "ts": 1], [])
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(ana.threads.threads().isEmpty)
        let reqs = await ana.engine.requests()
        XCTAssertTrue(reqs.isEmpty)
    }

    // MARK: by ACCOUNT, and the fixed Dotrino contact (PWA 0.5.0). The same cases as EngineTest.kt.

    /// An account with its own profile key `owner` and these devices: its card, signed by the owner.
    private func cardFor(_ owner: SoftKeys, _ devices: SoftKeys...) throws -> JSON {
        var body: [String: JSON] = ["v": 1, "profileId": .string(owner.publickey), "seq": 1, "sealedBy": .string(owner.publickey), "iat": 1]
        body["keys"] = .array(devices.map { .object(["pub": .string($0.publickey), "encPub": .string($0.encPub)]) })
        let text = try Canonical.stringify(.object(body))
        body["sig"] = .string(Crypto.b64(try owner.s.signature(for: Data(text.utf8)).rawRepresentation))
        return .object(body)
    }
    private func acta(_ card: JSON) -> JSON { .object(["card": card]) }
    private func keys(_ l: [JSON]) -> [String] { l.compactMap { $0["publickey"]?.string } }

    func testDotrinoIsAFixedContactThatCannotBeRemovedOrBlocked() async throws {
        let ana = await Person(Net(), "Ana")
        let dotrino = MessengerEngine.dotrinoAccount
        let cs = await ana.engine.contacts()
        XCTAssertTrue(cs.contains { ana.engine.isPinned($0["publickey"]?.string) })
        let can = await ana.engine.canWrite(dotrino)
        XCTAssertFalse(can, "no device of Dotrino is known before it writes")
        do { try await ana.engine.setBlocked(dotrino, true); XCTFail("blocked Dotrino") } catch let e as MessengerEngine.EngineError { XCTAssertEqual(e.code, "pinned-contact") }
        _ = try ana.peers.removeContact(dotrino)          // removed from another app sharing the book
        let back = await ana.engine.contacts()
        XCTAssertTrue(back.contains { ana.engine.isPinned($0["publickey"]?.string) }, "it comes back")
    }

    func testTheDotrinoAccountWritesFromAnyDeviceAndIsAcceptedAlone() async throws {
        let net = Net(), owner = SoftKeys(), d1 = SoftKeys()
        let ana = await Person(net, "Ana", pinned: owner.publickey)
        let dotrino = await Person(net, "Dotrino", keys: d1, acta: acta(try cardFor(owner, d1)))
        try await dotrino.engine.addByLink(pubkey: ana.pubkey, alias: "Ana", card: nil)
        await until("ana accepted it by herself") { await !dotrino.people().isEmpty }
        let reqs = await ana.engine.requests()
        XCTAssertTrue(reqs.isEmpty, "never in the inbox")
        try await dotrino.engine.sendDM(ana.pubkey, "respuesta")
        await until("ana reads it, under the Dotrino account") { await ana.engine.thread(owner.publickey).contains { $0["text"]?.string == "respuesta" } }
    }

    func testAContactIsTheirAccountAndEveryDeviceGetsTheMessage() async throws {
        let net = Net(), owner = SoftKeys(), k1 = SoftKeys(), k2 = SoftKeys()
        let card = try cardFor(owner, k1, k2)
        let ana = await Person(net, "Ana"), b1 = await Person(net, "Beto1", keys: k1, acta: acta(card)), b2 = await Person(net, "Beto2", keys: k2, acta: acta(card))
        await until("code") { await ana.engine.pairingCode != nil }
        try await b1.engine.addByCode(await ana.engine.pairingCode!, alias: "")
        await until("request") { await ana.engine.requests().contains { $0.dir == "in" } }
        let req = await ana.engine.requests()
        XCTAssertEqual(req.first?.pubkey, owner.publickey, "kept by the account, not the device")
        await ana.engine.acceptRequest(owner.publickey)
        await until("beto sees ana") { await !b1.people().isEmpty }
        let people = await ana.people()
        XCTAssertEqual(keys(people), [owner.publickey])
        try await ana.engine.sendDM(owner.publickey, "a los dos")
        await until("both devices got it") { b1.phone.got.contains("DM") && b2.phone.got.contains("DM") }
    }

    func testAContactKeptByADeviceMovesToItsAccountWithItsThread() async throws {
        let net = Net(), owner = SoftKeys(), k1 = SoftKeys()
        let ana = await Person(net, "Ana"), b1 = await Person(net, "Beto", keys: k1, acta: acta(try cardFor(owner, k1)))
        _ = try ana.peers.addContact(b1.pubkey, nickname: "Beto de antes")      // a contact from before 0.5.0
        ana.threads.put(b1.pubkey, ["id": "m1", "dir": "in", "text": "viejo", "ts": 1])
        _ = try b1.peers.addContact(ana.pubkey, nickname: "Ana")
        await b1.engine.sendHello(to: ana.pubkey)
        await until("moved to the account") { await self.keys(ana.people()) == [owner.publickey] }
        let p = await ana.people()
        XCTAssertEqual(p.first?["nickname"]?.string, "Beto de antes")
        let th = await ana.engine.thread(owner.publickey)
        XCTAssertEqual(th.map { $0["text"]?.string }, ["viejo"])
    }
}
