import Foundation
import Security

struct PairedDeviceCredentials {
    private func identity(_ profileID: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "ai.backpacked.jarvisroy.paired-devices",
         kSecAttrAccount as String: profileID]
    }
    func read(profileID: String) throws -> String? {
        var query = identity(profileID); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else { throw CloudConnectionFailure.credentials }
        return value
    }
    func save(_ value: String, profileID: String) throws {
        guard CloudProfilePolicy.identifier(profileID), (32...8192).contains(value.utf8.count),
              !value.contains(where: { $0.isWhitespace || $0 == "\0" }) else { throw CloudConnectionFailure.credentials }
        let attributes = [kSecValueData as String: Data(value.utf8)]
        let status = SecItemUpdate(identity(profileID) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = identity(profileID); item[kSecValueData as String] = Data(value.utf8)
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw CloudConnectionFailure.credentials }
        } else if status != errSecSuccess { throw CloudConnectionFailure.credentials }
    }
    func remove(profileID: String) throws {
        let status = SecItemDelete(identity(profileID) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CloudConnectionFailure.credentials }
    }
}
