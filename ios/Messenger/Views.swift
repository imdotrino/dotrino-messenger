import DotrinoNative
import DotrinoNativeUI
import PhotosUI
import SwiftUI

/// The app: the nickname the first time; then the contacts (requests on top) and, from there,
/// a conversation. SwiftUI, no WebView (CONVENCIONES §16.2).
struct RootView: View {
    @StateObject private var m = AppModel()
    @ObservedObject private var lang = DotrinoLang.shared
    @State private var addOpen = false
    @State private var incomingCode: String?

    var body: some View {
        VStack(spacing: 0) {
            DotrinoTopbar(repo: "imdotrino/dotrino-messenger", brand: .init(name: "Messenger", image: Image("Brand")),
                          profile: m.profileKey.map { .init(name: m.nickname, key: $0) }) {
                if let code = m.code {
                    Button(code) { UIPasteboard.general.string = code }
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
        .onOpenURL { url in
            // The QR link (https://messenger.dotrino.com/#add=CODE) opens with the code in place.
            if let f = url.fragment, let r = f.range(of: "add=") { incomingCode = AddSheet.normalize(String(f[r.upperBound...])); addOpen = true }
        }
        .sheet(isPresented: $addOpen) { AddSheet(m: m, initial: incomingCode ?? "").environmentObject(lang) }
        .id(lang.code)
    }

    @ViewBuilder private var content: some View {
        if let p = m.problem {
            VStack(spacing: 18) {
                Text(p).foregroundColor(Palette.muted).multilineTextAlignment(.center)
                Button(t("store.retry")) { m.problem = nil; Task { await m.boot() } }.buttonStyle(Pill(filled: true))
            }.padding(32)
        } else if !m.booted {
            ProgressView()
        } else if !m.hasNickname {
            NicknameView(m: m)
        } else if let pk = m.open {
            ConversationView(m: m, pk: pk)
        } else {
            ContactsView(m: m, add: { incomingCode = nil; addOpen = true })
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
            HStack(spacing: 8) {
                TextField(t("conv.placeholder"), text: $draft, axis: .vertical).lineLimit(1...5).padding(12)
                    .background(RoundedRectangle(cornerRadius: 24).stroke(Palette.line2)).accessibilityIdentifier("composer-input")
                Button {
                    let text = draft; draft = ""
                    Task { do { try await m.send(text); error = nil } catch { self.error = t("native.sealFailed", ["reason": "\(error)"]) } }
                } label: { Image(systemName: "paperplane.fill").foregroundColor(.white).frame(width: 46, height: 46).background(Circle().fill(Palette.accent)) }
                    .accessibilityLabel(t("conv.send")).accessibilityIdentifier("send-message")
            }.padding(12).background(Palette.card)
        }
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

/// «Add contact»: by code (typed, pasted, scanned) → a REQUEST; my code and its QR.
struct AddSheet: View {
    @ObservedObject var m: AppModel
    @State var code: String
    @State private var alias = ""
    @State private var tab = "add"
    @State private var error: String?
    @State private var sending = false
    @State private var scanning = false
    @State private var photo: PhotosPickerItem?
    @Environment(\.dismiss) private var dismiss

    init(m: AppModel, initial: String) { self.m = m; _code = State(initialValue: initial) }

    private static let confusables: [Character: Character] = ["I": "1", "L": "1", "S": "5", "Z": "2", "B": "8", "G": "6", "0": "O"]
    static func normalize(_ raw: String) -> String {
        String(raw.uppercased().filter { $0 != " " && $0 != "-" && $0 != "_" }.map { confusables[$0] ?? $0 })
    }
    static func codeFrom(_ text: String) -> String {
        if let r = text.range(of: #"[#&?]add=([^&\s]+)"#, options: [.regularExpression, .caseInsensitive]) {
            return String(normalize(String(text[r].split(separator: "=", maxSplits: 1)[1])).prefix(6))
        }
        return String(normalize(text).prefix(6))
    }
    static let valid = #"^[1-9ACDEFHJKMNOPQRTUVWXY]{6}$"#

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Picker("", selection: $tab) {
                        Text(t("add.tabAdd")).tag("add")
                        Text(t("add.tabMine")).tag("mine")
                    }.pickerStyle(.segmented)
                    if tab == "add" { addTab } else { mineTab }
                }.padding(20)
            }
            .navigationTitle(t("add.title")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(t("add.cancel")) { dismiss() } } }
        }
        .fullScreenCover(isPresented: $scanning) {
            ZStack(alignment: .bottom) {
                DotrinoQRScanner(onResult: { text in scanning = false; scanned(text) },
                                 onError: { _ in scanning = false; error = t("native.cameraDenied") }).ignoresSafeArea()
                Button(t("add.close")) { scanning = false }.buttonStyle(Pill()).padding(.bottom, 40)
            }
        }
        .onChange(of: photo) { item in
            Task {
                guard let data = try? await item?.loadTransferable(type: Data.self), let img = UIImage(data: data) else { return }
                if let text = DotrinoQR.decode(img) { scanned(text) } else { error = t("add.errNoCode") }
            }
        }
    }

    private func scanned(_ text: String) {
        let c = Self.codeFrom(text)
        guard c.range(of: Self.valid, options: .regularExpression) != nil else { error = t("add.errNoCode"); return }
        code = c; submit()
    }

    @ViewBuilder private var addTab: some View {
        Text(t("add.info")).font(.subheadline).foregroundColor(Palette.muted)
        Text(t("add.fieldToken")).font(.footnote.bold()).foregroundColor(Palette.muted)
        HStack {
            TextField(t("add.phToken"), text: $code).font(.system(.title3, design: .monospaced)).multilineTextAlignment(.center)
                .textInputAutocapitalization(.characters).autocorrectionDisabled().padding(12)
                .background(RoundedRectangle(cornerRadius: 16).stroke(Palette.line2)).accessibilityIdentifier("code-input")
            Button(t("add.paste")) { if let s = UIPasteboard.general.string { code = Self.codeFrom(s) } }.buttonStyle(Pill())
        }
        HStack {
            Button(t("add.scan")) { scanning = true }.buttonStyle(Pill()).accessibilityIdentifier("scan-qr")
            PhotosPicker(selection: $photo, matching: .images) { Text(t("native.pickPhoto")) }.buttonStyle(Pill())
        }
        Text(t("add.fieldAlias")).font(.footnote.bold()).foregroundColor(Palette.muted)
        TextField(t("add.phAlias"), text: $alias).padding(12).background(RoundedRectangle(cornerRadius: 16).stroke(Palette.line2))
        if let error { Text(error).font(.subheadline).foregroundColor(Palette.danger) }
        Text(t("add.hint")).font(.footnote).foregroundColor(Palette.muted)
        Button(sending ? t("add.sending") : t("add.send")) { submit() }.buttonStyle(Pill(filled: true))
            .frame(maxWidth: .infinity).disabled(sending).accessibilityIdentifier("send-hello")
    }

    @ViewBuilder private var mineTab: some View {
        Text(t("add.mineInfo")).font(.subheadline).foregroundColor(Palette.muted)
        HStack {
            Text(m.code ?? "…").font(.system(size: 28, weight: .bold, design: .monospaced)).kerning(4).accessibilityIdentifier("my-pairing-code")
            Spacer()
            Button(t("add.copy")) { UIPasteboard.general.string = m.code }.buttonStyle(Pill()).disabled(m.code == nil)
        }
        if let c = m.code {
            DotrinoQRView("https://messenger.dotrino.com/#add=\(c)", size: 220).frame(maxWidth: .infinity).accessibilityIdentifier("my-qr")
            Text(t("add.qrHint")).font(.footnote).foregroundColor(Palette.muted).frame(maxWidth: .infinity)
        }
    }

    private func submit() {
        error = nil
        let c = Self.normalize(code)
        guard c.range(of: Self.valid, options: .regularExpression) != nil else { error = t("add.errInvalid"); return }
        sending = true
        Task {
            do { try await m.addByCode(c, alias: alias); dismiss() }
            catch let e as MessengerEngine.EngineError {
                // «Offline» and «not valid» are fixed differently: say which.
                error = t(["own": "add.errOwn", "offline": "add.errOffline", "invalid": "add.errInvalid"][e.code] ?? "add.errSend")
            } catch { self.error = t("add.errSend") }
            sending = false
        }
    }
}

/// Rate a contact: trust and affinity, 0–5; what I rated before comes back.
struct RateSheet: View {
    @ObservedObject var m: AppModel
    let pk: String, name: String
    @State private var values = ["confianza": 0, "afinidad": 0]
    @State private var note: String?
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
            if let note { Text(note).font(.footnote).foregroundColor(Palette.muted) }
            Button(t("native.rateSave")) {
                Task {
                    do { try await m.rate(pk, values); dismiss() }
                    catch { note = t("native.rateFailed", ["reason": "\(error)"]) }
                }
            }.buttonStyle(Pill(filled: true)).frame(maxWidth: .infinity)
        }
        .padding(24)
        .presentationDetents([.medium])
        .task {
            for (k, v) in await m.myIndicators(pk) where values[k] != nil { values[k] = Int(v) }
            await m.askRatings(pk)
        }
    }
}
