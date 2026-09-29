import DotrinoNative
import DotrinoNativeWebRTC
import XCTest
@testable import Messenger

/// The iOS ENGINE against the production PWA, over the real proxy (sealed session + WebRTC):
/// redeem the web user's code (`TEST_RUNNER_PWA_CODE`), wait for the acceptance, write, and wait
/// for the web's reply. Driven from the other side by a Playwright script. Skipped without it.
final class LiveRoundTripTests: XCTestCase {
    func testRequestThenMessagesBothWays() async throws {
        guard let code = ProcessInfo.processInfo.environment["PWA_CODE"] else { throw XCTSkip("set TEST_RUNNER_PWA_CODE") }
        let p = Profile.of(EngineTests.SoftKeys())
        let s = SealedSession(urls: ["wss://proxy.dotrino.com"], profile: p, app: "messenger")
        s.useDirect(WebRTCDirect())
        let threads = MemoryThreads()
        let e = MessengerEngine(transport: s, profile: p, peers: PeerBook(storage: PeerBook.MemoryStorage(), profile: p),
                                threads: threads, kv: MemoryKv(), version: "0.3.0")
        await e.setNickname("Eva_iOS")
        await e.start(); s.start()
        defer { s.close() }
        let online = await s.awaitOnline()
        XCTAssertTrue(online)
        try await e.addByCode(code, alias: "")
        var web: String?
        for _ in 0..<600 where web == nil { web = await e.contacts().first?["publickey"]?.string; if web == nil { try await Task.sleep(nanoseconds: 200_000_000) } }
        let pk = try XCTUnwrap(web, "the web did not accept")
        try await e.sendDM(pk, "hola desde ios")
        var got = false
        for _ in 0..<600 where !got { got = await e.thread(pk).contains { $0["text"]?.string == "hola ios, te leo desde la web" }; if !got { try await Task.sleep(nanoseconds: 200_000_000) } }
        XCTAssertTrue(got, "the web reply did not arrive")
    }
}
