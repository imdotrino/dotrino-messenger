import DotrinoNativeUI
import Foundation

/// The app's texts: the SAME as the PWA (src/i18n.js), flattened by `scripts/native-i18n.mjs`
/// (`add.title`). A missing key or variable is an error, not a hole on screen.
enum I18n {
    static let dict: [String: [String: String]] = {
        guard let url = Bundle.main.url(forResource: "i18n", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let d = try? JSONDecoder().decode([String: [String: String]].self, from: data)
        else { preconditionFailure("i18n.json is missing or broken in the app bundle") }
        return d
    }()
}

func t(_ key: String, _ vars: [String: Any] = [:]) -> String {
    let lang = DotrinoLang.shared.code
    guard let s = I18n.dict[lang]?[key] else { preconditionFailure("missing i18n key: \(key) (\(lang))") }
    if vars.isEmpty { return s }
    var out = "", rest = Substring(s)
    while let open = rest.firstIndex(of: "{"), let close = rest[open...].firstIndex(of: "}") {
        out += rest[..<open]
        let name = String(rest[rest.index(after: open)..<close])
        guard let v = vars[name] else { preconditionFailure("missing i18n var \"\(name)\" for \(key)") }
        out += "\(v)"
        rest = rest[rest.index(after: close)...]
    }
    return out + rest
}
