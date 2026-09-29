import CryptoKit
import DotrinoNative
import XCTest
@testable import Messenger

/// The messenger's rules with REAL engines and REAL sealing over an in-memory proxy. The same
/// cases as `EngineTest.kt`.
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
        let profile = Profile.of(SoftKeys())
        lazy var sealing = IdentitySealing(profile: profile, app: "messenger")
        var listeners: [UUID: (SealedSession.Message) -> Void] = [:]
        init(_ net: Net, _ name: String) { self.net = net; self.name = name; token = "T-\(name)"; net.phones[token] = self }

        func deliver(to: Phone, _ payload: JSON, _ keys: [String]) throws {
            let env = try sealing.seal(payload, to: keys.isEmpty ? [to.profile.encPub] : keys)
            guard let o = try? to.sealing.open(env) else { return }
            let m = SealedSession.Message(fromToken: token, fromPubkey: profile.publickey, payload: o.payload, senderEncPub: o.senderEncPub, queued: false, queuedAt: nil)
            to.listeners.values.forEach { $0(m) }
        }
        func sendSealed(toToken token: String, _ payload: JSON, recipientEncPubs: [String]) async throws { try deliver(to: net.phones[token]!, payload, recipientEncPubs) }
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
        let phone: Phone, engine: MessengerEngine, threads = MemoryThreads()
        init(_ net: Net, _ name: String) async {
            phone = Phone(net, name)
            engine = MessengerEngine(transport: phone, profile: phone.profile, peers: PeerBook(storage: PeerBook.MemoryStorage(), profile: phone.profile),
                                     threads: threads, kv: MemoryKv(), version: "0.3.0")
            await engine.setNickname(name)
            await engine.start()
        }
        var pubkey: String { phone.profile.publickey }
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
        let none = await ana.engine.contacts()
        XCTAssertTrue(none.isEmpty)
        await ana.engine.acceptRequest(beto.pubkey)
        await until("beto has ana") { await !beto.engine.contacts().isEmpty }
        let bc = await beto.engine.contacts()
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
}
