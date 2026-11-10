import Foundation

/// Follow the bundle's system/app language, with English source text as fallback.
func setupText(_ key: String, _ arguments: CVarArg...) -> String {
    let text = Bundle.main.localizedString(forKey: key, value: key, table: nil)
    return arguments.isEmpty ? text : String(format: text, locale: Locale.current, arguments: arguments)
}
