import DotrinoNative
import DotrinoNativeUI
import PhotosUI
import SwiftUI

/// The app: the nickname the first time; then the contacts (requests on top) and, from there,
/// a conversation. SwiftUI, no WebView (CONVENCIONES §16.2).
struct RootView: View {
    @StateObject private var m = AppModel()
    @ObservedObject private var lang = DotrinoLang.shared
    @Environment(\.scenePhase) private var scene
    @State private var addOpen = false
    @State private var incomingCode: String?
    @State private var incomingPeer: FriendLink?
    @State private var addTab: AddFriendSheet.Tab = .add
    /// Creating or adopting the first profile, inside the app (DotrinoWebSheet).
    @State private var profileWeb: URL?

    var body: some View {
        VStack(spacing: 0) {
            DotrinoTopbar(repo: "imdotrino/dotrino-messenger", brand: .init(name: "Messenger", image: Image("Brand")),
                          profile: m.topbarProfile, onProfileChanged: { Task { await m.reboot() } }) {
                if let code = m.code {
                    Button(code) { incomingCode = nil; addTab = .mine; addOpen = true }
                        .font(.system(.footnote, design: .monospaced).bold()).foregroundColor(Palette.text)
                        .padding(.horizontal, 10).padding(.vertical, 6).background(Capsule().fill(Palette.card2))
                        .accessibilityLabel(t("topbar.copyCode")).accessibilityIdentifier("my-code")
                }
            }
            if m.booted && m.status != "online" {
                Text(m.status == "connecting" ? t("native.connecting") : t("native.offline"))
                    .font(.footnote).foregroundColor(Palette.muted).frame(maxWidth: .infinity).padding(6).background(Palette.card2)
            }
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Palette.bg.ignoresSafeArea())
        .task { await m.boot() }
        // A system alert (the Bluetooth permission itself) makes the scene inactive: only the background turns it off.
        .onChange(of: scene) { phase in if phase == .active { m.sceneActive(true) } else if phase == .background { m.sceneActive(false) } }
        .onOpenURL { url in
            // The QR link (https://messenger.dotrino.com/#add=CODE) opens with the code in place.
            if let p = FriendLink.from(url.fragment) { incomingCode = nil; incomingPeer = p; addOpen = true }
            else if let f = url.fragment, let r = f.range(of: "add=") { incomingCode = Friends.normalizeCode(String(f[r.upperBound...])); addOpen = true }
        }
        .fullScreenCover(isPresented: Binding(get: { profileWeb != nil }, set: { if !$0 { profileWeb = nil } })) {
            if let u = profileWeb { DotrinoWebSheet(url: u) { profileWeb = nil; Task { await m.reboot() } } }
        }
        .sheet(isPresented: $addOpen, onDismiss: { addTab = .add; incomingPeer = nil }) {
            // La hoja de añadir es la del ecosistema (dotrino-native `AddFriendSheet`): código, mi código y «Cerca».
            if let e = m.engine {
                AddFriendSheet(friends: e.friends, nearby: m.nearby, me: m.profile?.publickey, shareBase: "https://messenger.dotrino.com/",
                               initialCode: incomingCode ?? "", tab: addTab, peer: incomingPeer,
                               prepareNearby: { await m.prepareBluetooth() })
                    .onDisappear { Task { await m.refresh() } }
            }
        }
        .id(lang.code)
    }

    @ViewBuilder private var content: some View {
        if let p = m.problem {
            VStack(spacing: 18) {
                Text(p).foregroundColor(Palette.muted).multilineTextAlignment(.center)
                if m.noProfile {
                    Button(t("native.createProfile")) { profileWeb = DotrinoTopbarURLs.create }.buttonStyle(Pill(filled: true))
                    Button(t("native.adoptProfile")) { profileWeb = DotrinoTopbarURLs.adopt }.buttonStyle(Pill(filled: false))
                }
                Button(t("store.retry")) { m.problem = nil; Task { await m.reboot() } }.buttonStyle(Pill(filled: !m.noProfile))
            }.padding(32)
        } else if !m.booted {
            ProgressView()
        } else if !m.hasNickname {
            NicknameView(m: m)
        } else if let pk = m.open {
            ConversationView(m: m, pk: pk)
        } else {
            ContactsView(m: m, add: { incomingCode = nil; incomingPeer = nil; addOpen = true })
        }
    }
}

/// A pill: the «Cool & Cozy» button. `filled` = the main action.
struct Pill: ButtonStyle {
    var filled = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.body.weight(.bold))
            .foregroundColor(filled ? Palette.onAccent : Palette.text)
            .padding(.horizontal, 20).padding(.vertical, 12)
            .background(Capsule().fill(filled ? Palette.accent : Palette.card))
            .overlay(Capsule().stroke(filled ? Color.clear : Palette.line2))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// A round avatar with the initial, coloured from the key.
struct Avatar: View {
    let name: String, key: String
    var size: CGFloat = 44
    private static let palette: [UInt32] = [0x00658C, 0x006B5C, 0x665590, 0x8C4A00, 0x3F6B00, 0x7A3E6B]
    var body: some View {
        let i = abs(key.unicodeScalars.reduce(0) { ($0 &* 31) &+ Int($1.value) }) % Self.palette.count
        Circle().fill(Color(hex: Self.palette[i])).frame(width: size, height: size)
            .overlay(Text(String(name.prefix(1)).uppercased()).font(.system(size: size * 0.4, weight: .bold)).foregroundColor(.white))
    }
}

func clock(_ ts: Int64) -> String {
    let d = Date(timeIntervalSince1970: Double(ts) / 1000)
    let f = DateFormatter()
    f.dateFormat = Calendar.current.isDateInToday(d) ? "HH:mm" : "dd/MM HH:mm"
    return f.string(from: d)
}

struct NicknameView: View {
    @ObservedObject var m: AppModel
    @State private var nick = ""
    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                Image("Brand").resizable().frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 16))
                Text("Messenger").font(.title.bold()).foregroundColor(Palette.text)
                Text(t("welcome.tagline")).foregroundColor(Palette.muted)
                VStack(alignment: .leading, spacing: 10) {
                    Text(t("welcome.intro")).foregroundColor(Palette.text)
                    Text(t("welcome.label")).font(.footnote.bold()).foregroundColor(Palette.muted)
                    TextField(t("welcome.placeholder"), text: $nick).textFieldStyle(.plain).padding(12)
                        .background(RoundedRectangle(cornerRadius: 16).stroke(Palette.line2)).accessibilityIdentifier("nickname-input")
                    Text(t("welcome.helper")).font(.footnote).foregroundColor(Palette.muted)
                    Button(t("welcome.submit")) { Task { await m.setNickname(nick) } }.buttonStyle(Pill(filled: true))
                        .frame(maxWidth: .infinity).disabled(MessengerEngine.sanitizeNickname(nick).isEmpty).accessibilityIdentifier("nickname-submit")
                    Text(t("native.welcomeInfo")).font(.footnote).foregroundColor(Palette.muted)
                }.padding(16).background(RoundedRectangle(cornerRadius: 16).fill(Palette.card)).padding(.top, 16)
            }.padding(24)
        }
    }
}

struct ContactsView: View {
    @ObservedObject var m: AppModel
    let add: () -> Void
    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if !m.requests.isEmpty { requestsBox }
                    Text(t("sidebar.title")).font(.title3.bold()).foregroundColor(Palette.text).padding(.top, 8)
                    if m.contacts.isEmpty {
                        Text("\(t("list.emptyBefore")) \(t("list.emptyPress")) + \(t("list.emptyAfter"))")
                            .foregroundColor(Palette.muted).multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.top, 32)
                    }
                    ForEach(m.contacts) { c in
                        Button { Task { await m.openConversation(c.id) } } label: { row(c) }.accessibilityIdentifier("contact-item")
                    }
                }.padding(12).padding(.bottom, 90)
            }
            Button(action: add) {
                Image(systemName: "plus").font(.title2.bold()).foregroundColor(.white).frame(width: 60, height: 60)
                    .background(Circle().fill(Palette.accent)).shadow(radius: 4)
            }.padding(24).accessibilityLabel(t("sidebar.add")).accessibilityIdentifier("add-contact")
        }
    }

    private var requestsBox: some View {
        let incoming = m.requests.filter { $0.dir == "in" }
        return VStack(alignment: .leading, spacing: 10) {
            Text(t("requests.title") + (incoming.isEmpty ? "" : " · \(incoming.count)")).font(.footnote.bold()).foregroundColor(Palette.muted)
            ForEach(m.requests, id: \.pubkey) { r in
                HStack(spacing: 10) {
                    let name = r.nickname.isEmpty ? String(r.pubkey.prefix(8)) + "…" : r.nickname
                    Avatar(name: name, key: r.pubkey, size: 36)
                    VStack(alignment: .leading) {
                        Text(name + (r.dir == "in" ? "  · " + (r.vouched ? t("requests.vouched") : t("requests.stranger")) : "")).bold().foregroundColor(Palette.text)
                        Text(r.dir == "in" ? t("requests.defaultMsg") : t("requests.waiting")).font(.footnote).foregroundColor(Palette.muted)
                    }
                    Spacer()
                    if r.dir == "in" {
                        Button("✓") { Task { await m.accept(r.pubkey) } }.foregroundColor(Palette.online)
                            .frame(width: 40, height: 40).background(Circle().stroke(Palette.line2))
                            .accessibilityLabel(t("requests.accept")).accessibilityIdentifier("accept-request")
                    }
                    Button("✕") { Task { await m.dismiss(r.pubkey, r.dir) } }.foregroundColor(Palette.danger)
                        .frame(width: 40, height: 40).background(Circle().stroke(Palette.line2))
                        .accessibilityLabel(r.dir == "in" ? t("requests.dismiss") : t("requests.cancel"))
                }
            }
        }.padding(16).background(RoundedRectangle(cornerRadius: 16).fill(Palette.card))
    }

    private func row(_ c: AppModel.Contact) -> some View {
        HStack(spacing: 12) {
            Avatar(name: c.name, key: c.id).overlay(alignment: .bottomTrailing) {
                if c.online { Circle().fill(Palette.online).frame(width: 14, height: 14).overlay(Circle().stroke(Palette.card, lineWidth: 2)) }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(c.name).bold().foregroundColor(Palette.text).lineLimit(1)
                if c.blocked { Text(t("list.blocked")).font(.caption.bold()).foregroundColor(Palette.danger).accessibilityIdentifier("contact-blocked") }
                Text(c.last ?? t("list.noMessages")).font(.subheadline).foregroundColor(Palette.muted).lineLimit(1)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                if c.last != nil { Text(clock(c.lastTs)).font(.caption).foregroundColor(Palette.muted) }
                if c.unread > 0 { Text("\(c.unread)").font(.caption.bold()).foregroundColor(.white).padding(.horizontal, 7).padding(.vertical, 1).background(Capsule().fill(Palette.accent)) }
            }
        }.padding(12).background(RoundedRectangle(cornerRadius: 16).fill(Palette.card))
    }
}

struct ConversationView: View {
    @ObservedObject var m: AppModel
    let pk: String
    @State private var draft = ""
    @State private var rateOpen = false
    @State private var error: String?
    /// An account with no known device (Dotrino before it writes): nobody to send to. The
    /// composer is there, off, with the reason.
    @State private var canWrite = true

    var body: some View {
        let c = m.contacts.first { $0.id == pk }
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button { Task { await m.openConversation(nil) } } label: { Image(systemName: "arrow.left").font(.title3) }
                    .foregroundColor(Palette.text).accessibilityLabel(t("conv.back"))
                Avatar(name: c?.name ?? "?", key: pk, size: 38)
                VStack(alignment: .leading) {
                    Text(c?.name ?? String(pk.prefix(8))).bold().foregroundColor(Palette.text)
                    Text(c?.online == true ? t("conv.online") : t("conv.offline")).font(.caption)
                        .foregroundColor(c?.online == true ? Palette.online : Palette.muted)
                }
                Spacer()
                Button("★") { rateOpen = true }.font(.title2).foregroundColor(Palette.gold).accessibilityLabel(t("conv.rate"))
            }.padding(12).background(Palette.card)
            if let mark = m.compat[pk] {
                Text(t("conv.compat.\(mark)")).font(.footnote).foregroundColor(Palette.text).padding(10).frame(maxWidth: .infinity).background(Palette.card2)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 6) {
                        if m.messages.isEmpty {
                            Text(t("conv.emptyBig")).font(.headline).padding(.top, 40)
                            Text(t("conv.emptySmall")).foregroundColor(Palette.muted)
                        }
                        ForEach(m.messages) { msg in bubble(msg).id(msg.id) }
                    }.padding(12)
                }.onChange(of: m.messages.count) { _ in if let last = m.messages.last { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
            if let error { Text(error).font(.footnote).foregroundColor(Palette.danger).padding(.horizontal) }
            if !canWrite {
                Text(t("conv.noDevices")).font(.footnote).foregroundColor(Palette.muted).padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading).background(Palette.card2).accessibilityIdentifier("no-devices")
            }
            HStack(spacing: 8) {
                TextField(t("conv.placeholder"), text: $draft, axis: .vertical).lineLimit(1...5).padding(12)
                    .background(RoundedRectangle(cornerRadius: 24).stroke(Palette.line2)).accessibilityIdentifier("composer-input")
                    .disabled(!canWrite)
                Button {
                    let text = draft; draft = ""
                    Task { do { try await m.send(text); error = nil } catch { self.error = t("native.sealFailed", ["reason": "\(error)"]) } }
                } label: { Image(systemName: "paperplane.fill").foregroundColor(.white).frame(width: 46, height: 46).background(Circle().fill(Palette.accent)) }
                    .accessibilityLabel(t("conv.send")).accessibilityIdentifier("send-message")
                    .disabled(!canWrite).opacity(canWrite ? 1 : 0.4)
            }.padding(12).background(Palette.card)
        }
        .task(id: m.messages.count) { canWrite = await m.canWrite(pk) }
        .sheet(isPresented: $rateOpen) { RateSheet(m: m, pk: pk, name: c?.name ?? "") }
    }

    private func bubble(_ msg: AppModel.Message) -> some View {
        HStack {
            if msg.mine { Spacer(minLength: 48) }
            VStack(alignment: .trailing, spacing: 2) {
                // Text as TEXT, never markup: what the other side wrote arrives letter by letter.
                Text(verbatim: msg.text).foregroundColor(msg.mine ? .white : Palette.text).textSelection(.enabled)
                Text(clock(msg.ts) + (msg.mine ? (msg.pending ? "  ⏱" : "  ✓") : "")).font(.caption2)
                    .foregroundColor(msg.mine ? .white.opacity(0.8) : Palette.muted)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(RoundedRectangle(cornerRadius: 18).fill(msg.mine ? Palette.accent : Palette.card))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(msg.mine ? Color.clear : Palette.line))
            .accessibilityIdentifier(msg.mine ? "msg-out" : "msg-in")
            if !msg.mine { Spacer(minLength: 48) }
        }
    }
}

/// Rate a contact: trust and affinity, 0–5; what I rated before comes back.
struct RateSheet: View {
    @ObservedObject var m: AppModel
    let pk: String, name: String
    @State private var values = ["confianza": 0, "afinidad": 0]
    @State private var note: String?
    @State private var blocked = false
    @State private var blocking = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(t("native.rateTitle", ["name": name])).font(.title3.bold())
            ForEach([("confianza", "native.rateTrust"), ("afinidad", "native.rateAffinity")], id: \.0) { axis, key in
                Text(t(key)).font(.footnote.bold()).foregroundColor(Palette.muted)
                HStack {
                    ForEach(1...5, id: \.self) { n in
                        Button("★") { values[axis] = values[axis] == n ? 0 : n }.font(.system(size: 34))
                            .foregroundColor(n <= (values[axis] ?? 0) ? Palette.gold : Palette.line2)
                    }
                }
            }
            // BLOCK: a flag apart from the stars, private, applied at once (not part of «Save»).
            // Dotrino, the fixed contact, cannot be blocked: the button is there, off, with the reason.
            let pinned = m.isPinned(pk)
            Text(t(pinned ? "native.pinnedNoBlock" : blocked ? "native.blockedHint" : "native.blockHint")).font(.footnote).foregroundColor(Palette.muted)
            Button(t(blocked ? "native.unblock" : "native.block")) {
                blocking = true
                Task {
                    do { try await m.setBlocked(pk, !blocked); blocked.toggle() }
                    catch { note = t("native.blockFailed", ["reason": "\(error)"]) }
                    blocking = false
                }
            }.disabled(blocking || pinned).opacity(pinned ? 0.4 : 1).foregroundColor(blocked ? Palette.text : Palette.danger).bold().accessibilityIdentifier("block-toggle")
            if let note { Text(note).font(.footnote).foregroundColor(Palette.muted) }
            Button(t("native.rateSave")) {
                Task {
                    do { try await m.rate(pk, values); dismiss() }
                    catch { note = t("native.rateFailed", ["reason": "\(error)"]) }
                }
            }.buttonStyle(Pill(filled: true)).frame(maxWidth: .infinity)
        }
        .padding(24)
        .presentationDetents([.medium, .large])
        .task {
            blocked = await m.isBlocked(pk)
            for (k, v) in await m.myIndicators(pk) where values[k] != nil { values[k] = Int(v) }
            await m.askRatings(pk)
        }
    }
}
