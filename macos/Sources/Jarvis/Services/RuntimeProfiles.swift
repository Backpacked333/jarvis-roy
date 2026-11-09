import Combine
import Foundation

enum RuntimeProfileKind: String, Codable, CaseIterable, Identifiable {
    case local, cloud
    var id: String { rawValue }
}

struct PairedCloudProfile: Codable, Identifiable, Equatable {
    let version: Int
    let id: String, origin: String, deviceId: String, label: String
    let generation: Int, receiptPublicKey: String, pairedAt: String
    func advancing(to generation: Int) throws -> Self {
        guard generation > self.generation else { throw CloudConnectionFailure.protocolMismatch }
        return Self(version: version, id: id, origin: origin, deviceId: deviceId, label: label,
                    generation: generation, receiptPublicKey: receiptPublicKey, pairedAt: pairedAt)
    }
}

enum CloudProfilePolicy {
    static func origin(_ raw: String) throws -> URL {
        guard let parts = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", parts.port.map({ (1...65535).contains($0) }) ?? true,
              let url = parts.url else { throw CloudConnectionFailure.configuration }
        var clean = parts; clean.path = ""
        guard let normalized = clean.url, url.scheme == "https" else { throw CloudConnectionFailure.configuration }
        return normalized
    }
    static func identifier(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"#, options: .regularExpression) != nil
    }
    static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/JarvisRoy/PairedClouds", isDirectory: true)
    }
}

@MainActor
final class RuntimeProfiles: ObservableObject {
    static let shared = RuntimeProfiles()
    @Published private(set) var selected: RuntimeProfileKind
    @Published private(set) var cloudProfile: PairedCloudProfile?
    @Published private(set) var loadFailed = false
    private let defaults: UserDefaults
    private let directory: URL
    init(defaults: UserDefaults = .standard, directory: URL = CloudProfilePolicy.directory) {
        self.defaults = defaults; self.directory = directory
        selected = RuntimeProfileKind(rawValue: defaults.string(forKey: "Jarvis.runtimeProfile") ?? "local") ?? .local
        let file = directory.appendingPathComponent("profile.json")
        if FileManager.default.fileExists(atPath: file.path) {
            do {
                let data = try Data(contentsOf: file)
                guard data.count <= 16_384 else { throw CloudConnectionFailure.storage }
                let profile = try JSONDecoder().decode(PairedCloudProfile.self, from: data)
                guard profile.version == 1, profile.generation >= 0, CloudProfilePolicy.identifier(profile.id),
                      CloudProfilePolicy.identifier(profile.deviceId), profile.receiptPublicKey.utf8.count <= 2048,
                      try CloudProfilePolicy.origin(profile.origin).absoluteString == profile.origin else { throw CloudConnectionFailure.storage }
                cloudProfile = profile
            } catch { loadFailed = true }
        }
        if cloudProfile == nil { selected = .local }
    }
    func select(_ kind: RuntimeProfileKind) throws {
        if kind == .cloud {
            guard RuntimePreferences().environment(inherited: ProcessInfo.processInfo.environment)["JARVIS_ENABLE_CLOUD"] == "1",
                  cloudProfile != nil, !loadFailed else { throw CloudConnectionFailure.configuration }
        }
        selected = kind; defaults.set(kind.rawValue, forKey: "Jarvis.runtimeProfile")
        // RuntimeConnection stays local. Existing actions and history never change authority.
    }
    func save(_ profile: PairedCloudProfile) throws {
        guard profile.version == 1, CloudProfilePolicy.identifier(profile.id), CloudProfilePolicy.identifier(profile.deviceId) else { throw CloudConnectionFailure.configuration }
        try Self.writePrivate(try JSONEncoder().encode(profile), to: directory.appendingPathComponent("profile.json"))
        cloudProfile = profile; loadFailed = false
    }
    func remove() throws {
        let file = directory.appendingPathComponent("profile.json")
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        cloudProfile = nil; loadFailed = false; try select(.local)
        // Keep receipt journals: forgotten/repaired profiles must not replay old effects.
    }
    static func writePrivate(_ data: Data, to file: URL) throws {
        let parent = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = parent.appendingPathComponent(".write-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else { throw CloudConnectionFailure.storage }
        defer { try? FileManager.default.removeItem(at: temporary) }
        let handle = try FileHandle(forWritingTo: temporary); try handle.synchronize(); try handle.close()
        if FileManager.default.fileExists(atPath: file.path) { _ = try FileManager.default.replaceItemAt(file, withItemAt: temporary) }
        else { try FileManager.default.moveItem(at: temporary, to: file) }
        let directoryHandle = try FileHandle(forReadingFrom: parent); try directoryHandle.synchronize(); try directoryHandle.close()
    }
}

enum CloudConnectionFailure: LocalizedError {
    case configuration, transport, protocolMismatch, storage, credentials, disabled
    var errorDescription: String? {
        switch self {
        case .configuration: return "Choose an HTTPS cloud origin and complete explicit device pairing. Local history and pending actions stay on this Mac."
        case .transport: return "The paired cloud connection is unavailable. Check its certificate, server readiness and device enrollment. No command was replayed."
        case .protocolMismatch: return "The cloud response did not match this paired device, version or authority. Reconnect after checking the deployment."
        case .storage: return "Cloud profile or receipt storage could not be committed. No new command can execute until local storage is repaired."
        case .credentials: return "The paired-device credential is unavailable. Unlock Keychain or pair this device again."
        case .disabled: return "Enable the cloud companion in Settings before pairing or connecting."
        }
    }
}
