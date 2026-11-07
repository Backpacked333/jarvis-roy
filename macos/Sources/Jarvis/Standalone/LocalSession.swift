import Foundation
import Security

/// The per-launch bearer token shared by the native clients and the local services.
///
/// Externally supervised (developer launcher): `scripts/run-macos.sh` exports
/// `JARVIS_LOCAL_TOKEN`, the app starts no services and uses that token.
/// App mode: no token in the environment, so a fresh one is generated and kept in memory only.
enum LocalSession {
    static let environmentVariable = "JARVIS_LOCAL_TOKEN"

    /// True when the app was started by an external launcher that owns the local services.
    static let isExternallySupervised: Bool = environmentToken != nil

    /// The token every native client sends. Empty only if secure random generation failed,
    /// which makes every client refuse to connect (fail closed).
    static let token: String = environmentToken ?? generateToken() ?? ""

    private static let environmentToken: String? = {
        guard let value = ProcessInfo.processInfo.environment[environmentVariable], !value.isEmpty else { return nil }
        return value
    }()

    /// 32 bytes from the system CSPRNG as 64 lowercase hex characters, or nil on failure.
    static func generateToken() -> String? {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = bytes.withUnsafeMutableBytes { buffer -> Int32 in
            guard let base = buffer.baseAddress else { return errSecAllocate }
            return SecRandomCopyBytes(kSecRandomDefault, buffer.count, base)
        }
        guard status == errSecSuccess else { return nil }
        let token = bytes.map { String(format: "%02x", $0) }.joined()
        for index in bytes.indices { bytes[index] = 0 }
        return isValidToken(token) ? token : nil
    }

    /// The exact format the bundled supervisor accepts.
    static func isValidToken(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}
