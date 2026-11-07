import Foundation
import Security

/// Secrets the bundled services may receive. Raw values are the exact supervisor `secrets` keys
/// and the Keychain account names.
enum CredentialKey: String, CaseIterable, Sendable {
    case aiGateway = "AI_GATEWAY_API_KEY"
    case tavily = "TAVILY_API_KEY"
    case homeAssistant = "HOME_ASSISTANT_TOKEN"
    case elevenLabs = "ELEVENLABS_API_KEY"

    var title: String {
        switch self {
        case .aiGateway: return "Vercel AI Gateway API key"
        case .tavily: return "Tavily research API key"
        case .homeAssistant: return "Home Assistant access token"
        case .elevenLabs: return "ElevenLabs API key"
        }
    }
}

enum CredentialError: LocalizedError, Equatable {
    case empty, invalidCharacters, tooLong, keychain(Int32)

    var errorDescription: String? {
        switch self {
        case .empty: return "Enter a value first."
        case .invalidCharacters: return "Keys must be a single line without control characters."
        case .tooLong: return "Keys may be at most \(CredentialValue.maximumLength) characters."
        case .keychain(let status): return "The macOS Keychain refused the request (status \(status))."
        }
    }
}

enum CredentialValue {
    static let maximumLength = 4_096

    /// Trims surrounding whitespace and rejects empty, multi-line, NUL-bearing or oversized values.
    static func validated(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw CredentialError.empty }
        guard !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F || $0 == "\u{2028}" || $0 == "\u{2029}" }) else {
            throw CredentialError.invalidCharacters
        }
        guard value.count <= maximumLength else { throw CredentialError.tooLong }
        return value
    }

    /// The validation message for a typed (not yet saved) value, or nil when it is empty or valid.
    static func problem(_ raw: String) -> String? {
        if raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        do { _ = try validated(raw); return nil } catch { return error.localizedDescription }
    }
}

/// Write/delete/presence only for the UI. `launchSecrets()` is called once, immediately before launch.
@MainActor
protocol CredentialStoring: AnyObject {
    func contains(_ key: CredentialKey) -> Bool
    func save(_ value: String, for key: CredentialKey) throws
    func delete(_ key: CredentialKey) throws
    func launchSecrets() throws -> [String: String]
}

/// macOS Keychain generic passwords: service `ai.backpacked.jarvisroy`, account = key name,
/// this device only, never synchronized.
@MainActor
final class KeychainCredentialStore: CredentialStoring {
    static let service = "ai.backpacked.jarvisroy"

    private func baseQuery(_ key: CredentialKey) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: Self.service,
         kSecAttrAccount as String: key.rawValue,
         kSecAttrSynchronizable as String: false]
    }

    func contains(_ key: CredentialKey) -> Bool {
        var query = baseQuery(key)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnAttributes as String] = false
        query[kSecReturnData as String] = false
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    func save(_ value: String, for key: CredentialKey) throws {
        let validated = try CredentialValue.validated(value)
        try delete(key)
        var item = baseQuery(key)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        item[kSecAttrLabel as String] = "Jarvis Roy \(key.rawValue)"
        item[kSecValueData as String] = Data(validated.utf8)
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw CredentialError.keychain(status) }
    }

    func delete(_ key: CredentialKey) throws {
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CredentialError.keychain(status) }
    }

    func launchSecrets() throws -> [String: String] {
        var secrets: [String: String] = [:]
        for key in CredentialKey.allCases {
            if let value = try read(key) { secrets[key.rawValue] = value }
        }
        return secrets
    }

    private func read(_ key: CredentialKey) throws -> String? {
        var query = baseQuery(key)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw CredentialError.keychain(status) }
        guard let data = result as? Data, let text = String(data: data, encoding: .utf8) else {
            throw CredentialError.invalidCharacters
        }
        return try CredentialValue.validated(text)
    }
}

/// Test double with the same validation and presence-only semantics.
@MainActor
final class InMemoryCredentialStore: CredentialStoring {
    private var values: [CredentialKey: String]
    var failure: CredentialError?

    init(_ values: [CredentialKey: String] = [:]) { self.values = values }

    func contains(_ key: CredentialKey) -> Bool { values[key] != nil }

    func save(_ value: String, for key: CredentialKey) throws {
        if let failure { throw failure }
        values[key] = try CredentialValue.validated(value)
    }

    func delete(_ key: CredentialKey) throws {
        if let failure { throw failure }
        values[key] = nil
    }

    func launchSecrets() throws -> [String: String] {
        if let failure { throw failure }
        var secrets: [String: String] = [:]
        for (key, value) in values { secrets[key.rawValue] = value }
        return secrets
    }
}
