import DotrinoNative
import DotrinoNativeUI
import DotrinoNativeWebRTC
import Foundation
import UIKit
import UserNotifications

/// What the screens show, on the main thread: a snapshot of the engine, refreshed on every
/// change. The engine is an actor; the screens never touch it directly except through here.
@MainActor
final class AppModel: ObservableObject {
    static let proxies = ["wss://proxy.dotrino.com", "wss://proxy2.dotrino.com"]

    struct Contact: Identifiable, Equatable {
        let id: String   // pubkey
        let name: String
        let online: Bool
        let last: String?
        let lastTs: Int64
        let unread: Int
    }
    struct Message: Identifiable, Equatable { let id: String; let mine: Bool; let text: String; let ts: Int64; let pending: Bool }

    @Published var problem: String?
    /// There is no profile yet: it is made or adopted HERE (no other app is needed).
    @Published var noProfile = false
    @Published var booted = false
    @Published var hasNickname = false
    @Published var code: String?
    @Published var status = "connecting"
    @Published var contacts: [Contact] = []
    @Published var requests: [MessengerEngine.Request] = []
    @Published var open: String?
    @Published var messages: [Message] = []
    @Published var compat: [String: String] = [:]
    @Published var profileKey: String?
    /// The profile as the web topbar shows it: its name and its avatar (photo or identicon).
    @Published var topbarProfile: DotrinoTopbarProfile?
    @Published var nickname: String?

    /// The APNs token arrives at the app delegate, whenever Apple gives it: kept here and handed
    /// to the session that is running (or to the next one), which registers it with the proxy.
    private static weak var current: AppModel?
    private static var lastPush: SealedSession.PushToken?
    static func pushToken(_ t: SealedSession.PushToken) {
        lastPush = t
        current?.session?.setPushToken(t)
    }

    private(set) var engine: MessengerEngine?
    private var session: SealedSession?
    private var refreshQueued = false
    private var backup: VaultBackup?
    private var backupTask: Task<Void, Never>?
    private var backupLoop: Task<Void, Never>?
    private var peersBackup: PeerBookBackup?

    /// Reconcile with the vault in [delay] seconds (a moment after a write, or now).
    func syncSoon(_ delay: Double) {
        guard let backup else { return }
        backupTask?.cancel()
        backupTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if Task.isCancelled { return }
            do {
                let r = try await backup.sync()
                // THE CONTACT BOOK too: the same contacts on every device of the profile.
                let contacts = try await self?.peersBackup?.sync() ?? 0
                if !r.changed.isEmpty || contacts > 0 { await self?.refresh() }
            }
            catch { print("messenger: vault backup failed:", error) }
        }
    }

    /// ONE boot at a time: `boot` awaits inside, so a second call (the view's `.task` running
    /// again) could come in halfway and start a second session with its own token — and what
    /// reached the one nobody listened to was lost. Same fix as Android's `Messenger.boot`.
    private var booting = false

    func boot() async {
        if engine != nil || booting { return }
        booting = true
        defer { booting = false }
        do {
            let p = try Profile.fromPhone()
            let s = SealedSession(urls: Self.proxies, profile: p, app: "messenger")
            s.useDirect(WebRTCDirect())
            let peers = PeerBook(storage: PeerBook.PhoneStorage(profile: p), profile: p)
            let account = (p.pid ?? "default").lowercased().replacingOccurrences(of: "[^a-z0-9-]", with: "-", options: .regularExpression)
            let store = try DotrinoStore(app: "messenger-" + account)
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
            // THE BACKUP IN THE VAULT (when paired): the history reaches the PWA of the same
            // account and back. Only the messenger's threads: the contacts' keys.
            if p.vault != nil {
                backup = VaultBackup(profile: p, store: store, owns: { $0.hasPrefix("{") })
                peersBackup = PeerBookBackup(profile: p, book: peers)
                // A contact added, removed or renamed here goes to the vault right away.
                peers.onChange = { [weak self] in Task { @MainActor in self?.syncSoon(1.5) } }
            }
            let threads = MessengerThreads(store) { [weak self] in Task { @MainActor in self?.syncSoon(1.5) } }
            let e = MessengerEngine(transport: s, profile: p, peers: peers, threads: threads, kv: DefaultsKv(account: account),
                                    version: version, reputation: Reputation(profile: p, peers: peers))
            await e.setHandlers(onChange: { [weak self] in Task { @MainActor in self?.refreshSoon() } },
                                onNotice: { n in Task { @MainActor in AppModel.notify(n) } })
            _ = s.onStatus { [weak self] st in Task { @MainActor in self?.status = st.state } }
            // YOUR NAME IS THE PROFILE'S: without a nickname of its own yet, it takes the profile's name.
            if await !e.hasNickname, let n = p.name { await e.setNickname(n) }
            await e.start()
            s.start()
            engine = e; session = s; booted = true; profileKey = p.profileId
            topbarProfile = p.name == nil ? DotrinoTopbarProfile(name: await e.nickname, key: p.avatarSeed, avatar: p.avatar) : p.topbar
            if backup != nil {
                backupLoop = Task { [weak self] in while !Task.isCancelled { self?.syncSoon(0); try? await Task.sleep(nanoseconds: 300_000_000_000) } }
            }
            Self.current = self
            if let t = Self.lastPush { s.setPushToken(t) }
            DotrinoPush.register()
            await refresh()
        } catch let e as Profile.ProfileError {
            problem = t("native.noProfile") + (e.code == "no-profile" ? "" : " (\(e.code))")
            noProfile = true
        } catch { problem = "\(error)" }
    }

    /// ANOTHER PROFILE (switched, created, adopted, signed in from the bar's menu): everything
    /// starts again with it — changing profile is not reactive, as on the web.
    func reboot() async {
        await engine?.stop()
        session?.close()
        backupTask?.cancel(); backupLoop?.cancel()
        engine = nil; session = nil; backup = nil; peersBackup = nil; booted = false; noProfile = false
        contacts = []; requests = []; messages = []; open = nil; code = nil; problem = nil
        profileKey = nil; topbarProfile = nil; nickname = nil; hasNickname = false
        await boot()
    }

    func refreshSoon() {
        if refreshQueued { return }
        refreshQueued = true
        Task { try? await Task.sleep(nanoseconds: 60_000_000); refreshQueued = false; await refresh() }
    }

    func refresh() async {
        guard let e = engine else { return }
        hasNickname = await e.hasNickname
        nickname = await e.nickname
        code = await e.pairingCode
        requests = await e.requests()
        compat = await e.peerCompat
        var list: [Contact] = []
        for c in await e.contacts() {
            guard let pk = c["publickey"]?.string else { continue }
            let th = await e.thread(pk)
            let name = c["nickname"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? String(pk.prefix(8))
            list.append(Contact(id: pk, name: name, online: await e.isOnline(pk), last: th.last?["text"]?.string,
                                lastTs: th.last?["ts"]?.int ?? c["lastSeen"]?.int ?? 0, unread: await e.unread(pk)))
        }
        contacts = list.sorted { $0.lastTs > $1.lastTs }
        if let pk = open {
            messages = await e.thread(pk).map { m in
                Message(id: m["id"]?.string ?? UUID().uuidString, mine: m["dir"]?.string == "out", text: m["text"]?.string ?? "",
                        ts: m["ts"]?.int ?? 0, pending: m["pending"]?.bool ?? false)
            }
        }
    }

    func setNickname(_ n: String) async { await engine?.setNickname(n); await refresh() }

    func openConversation(_ pk: String?) async {
        open = pk
        await engine?.setActive(pk)
        if let pk { await engine?.markRead(pk); await engine?.sendHello(to: pk) }
        await refresh()
    }

    func send(_ text: String) async throws { guard let pk = open else { return }; try await engine?.sendDM(pk, text) }
    func addByCode(_ code: String, alias: String) async throws { try await engine?.addByCode(code, alias: alias) }
    func accept(_ pk: String) async { await engine?.acceptRequest(pk) }
    func dismiss(_ pk: String, _ dir: String) async { await engine?.dismissRequest(pk, dir: dir) }
    func rate(_ pk: String, _ v: [String: Int]) async throws { try await engine?.rate(pk, v) }
    func myIndicators(_ pk: String) async -> [String: Double] { await engine?.myIndicatorsFor(pk) ?? [:] }
    func askRatings(_ pk: String) async { await engine?.askRatingsAbout(pk) }

    /// The phone's notice for a message or a request (opened here: it arrived sealed to this phone).
    static func notify(_ n: MessengerEngine.Notice) {
        let c = UNMutableNotificationContent()
        c.title = n.kind == "request" ? t("native.notifRequest", ["name": n.fromNickname]) : n.fromNickname
        c.body = n.kind == "request" ? t("requests.defaultMsg") : n.text
        c.userInfo = ["contact": n.fromPubkey]
        // EL TRINO. Con la app a la vista iOS no enseña este aviso ni lo hace sonar: lo toca la
        // app. Si no, va en el aviso (uno al azar, instalados por DotrinoPush).
        if UIApplication.shared.applicationState == .active { DotrinoRing.play() }
        else { c.sound = UNNotificationSound(named: UNNotificationSoundName(DotrinoRing.soundName)) }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: n.id, content: c, trigger: nil))
    }
}
