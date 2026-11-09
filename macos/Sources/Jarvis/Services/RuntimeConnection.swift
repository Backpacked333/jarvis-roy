import Foundation
import Security

/// Process-local credentials. They are never persisted to preferences or the Keychain.
enum RuntimeConnection {
    static let baseURL = URL(string: "http://127.0.0.1:39202")!
    static let externallyManaged = !(ProcessInfo.processInfo.environment["JARVIS_LOCAL_TOKEN"] ?? "").isEmpty
    static let localToken = credential(named: "JARVIS_LOCAL_TOKEN")
    static let nativeToken = credential(named: "JARVIS_NATIVE_TOKEN")

    private static func credential(named name: String) -> String {
        configuredCredential(named: name, environment: ProcessInfo.processInfo.environment, generated: secureCredential())
    }

    static func configuredCredential(named name: String, environment: [String: String], generated: String) -> String {
        if let value = environment[name], !value.isEmpty { return value }
        if name == "JARVIS_NATIVE_TOKEN", !(environment["JARVIS_LOCAL_TOKEN"] ?? "").isEmpty {
            // An older/external launcher has no native authority. Inventing a local
            // token would never authenticate to its bridge; fail before transport.
            return ""
        }
        return generated
    }

    private static func secureCredential() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            // A missing secure entropy source must not produce a guessable local credential.
            return ""
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
