import Foundation
import Security

enum ProviderCredential: String, CaseIterable, Identifiable {
    case gateway = "AI_GATEWAY_API_KEY"
    case voice = "ELEVENLABS_API_KEY"
    case research = "TAVILY_API_KEY"
    case home = "HOME_ASSISTANT_TOKEN"

    var id: String { rawValue }
    var title: String {
        switch self {
        case .gateway: return "Vercel AI Gateway"
        case .voice: return "ElevenLabs"
        case .research: return "Tavily research"
        case .home: return "Home Assistant"
        }
    }
}

struct ProviderCredentials {
    private let service = "ai.backpacked.jarvisroy.providers"

    enum Failure: LocalizedError {
        case operation(OSStatus), invalid
        var errorDescription: String? {
            switch self {
            case .operation(let status): return "Keychain operation failed (\(status)). Unlock your login Keychain and retry."
            case .invalid: return "Enter a nonempty credential without line breaks, up to 8,192 characters."
            }
        }
    }

    func read(_ credential: ProviderCredential) throws -> String? {
        var query = identity(credential)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure.operation(status) }
        guard let data = result as? Data, let text = String(data: data, encoding: .utf8) else { throw Failure.invalid }
        return text
    }

    func save(_ value: String, for credential: ProviderCredential) throws {
        guard !value.isEmpty, value.count <= 8_192, !value.contains("\n"), !value.contains("\r"), !value.contains("\0") else { throw Failure.invalid }
        let attributes: [String: Any] = [kSecValueData as String: Data(value.utf8)]
        let status = SecItemUpdate(identity(credential) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = identity(credential)
            item[kSecValueData as String] = Data(value.utf8)
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let created = SecItemAdd(item as CFDictionary, nil)
            guard created == errSecSuccess else { throw Failure.operation(created) }
        } else if status != errSecSuccess { throw Failure.operation(status) }
    }

    func remove(_ credential: ProviderCredential) throws {
        let status = SecItemDelete(identity(credential) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.operation(status) }
    }

    private func identity(_ credential: ProviderCredential) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: credential.rawValue]
    }
}
