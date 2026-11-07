import Foundation

enum StandaloneConfigError: LocalizedError, Equatable {
    case unsupportedVersion, unsafeFile, tooLarge

    var errorDescription: String? {
        switch self {
        case .unsupportedVersion: return "The saved Jarvis settings come from an unsupported version."
        case .unsafeFile: return "The saved Jarvis settings file is not a regular file."
        case .tooLarge: return "The saved Jarvis settings file is too large."
        }
    }
}

/// Non-secret app-mode settings, stored as `<data dir>/standalone-config.json` (0600, directory 0700).
/// Secrets never live here; they are in the Keychain (`CredentialStore`).
struct StandaloneConfig: Codable, Equatable, Sendable {
    static let currentVersion = 1
    static let defaultModel = "openai/gpt-4.1-mini"
    static let fileName = "standalone-config.json"
    static let maximumFileBytes = 64 * 1_024

    var version: Int = StandaloneConfig.currentVersion
    var model: String = StandaloneConfig.defaultModel
    var enableDesktop = false
    var enableTerminal = false
    var enableAppleServices = false
    var homeAssistantURL = ""
    var allowHomeAssistantHTTP = false
    var elevenLabsVoiceID = ""
    var workerImage = ""
    var workerPython = ""
    var dockerBinary = ""

    enum CodingKeys: String, CodingKey {
        case version, model, enableDesktop, enableTerminal, enableAppleServices, homeAssistantURL,
             allowHomeAssistantHTTP, elevenLabsVoiceID, workerImage, workerPython, dockerBinary
    }

    init() {}

    /// Tolerant of missing keys (defaults apply); strict about the version.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(Int.self, forKey: .version)
        guard version == Self.currentVersion else { throw StandaloneConfigError.unsupportedVersion }
        self.version = version
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? Self.defaultModel
        enableDesktop = try container.decodeIfPresent(Bool.self, forKey: .enableDesktop) ?? false
        enableTerminal = try container.decodeIfPresent(Bool.self, forKey: .enableTerminal) ?? false
        enableAppleServices = try container.decodeIfPresent(Bool.self, forKey: .enableAppleServices) ?? false
        homeAssistantURL = try container.decodeIfPresent(String.self, forKey: .homeAssistantURL) ?? ""
        allowHomeAssistantHTTP = try container.decodeIfPresent(Bool.self, forKey: .allowHomeAssistantHTTP) ?? false
        elevenLabsVoiceID = try container.decodeIfPresent(String.self, forKey: .elevenLabsVoiceID) ?? ""
        workerImage = try container.decodeIfPresent(String.self, forKey: .workerImage) ?? ""
        workerPython = try container.decodeIfPresent(String.self, forKey: .workerPython) ?? ""
        dockerBinary = try container.decodeIfPresent(String.self, forKey: .dockerBinary) ?? ""
    }

    // MARK: Locations

    /// App mode always uses `~/Library/Application Support/JarvisRoy`.
    static var defaultDataDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent("JarvisRoy", isDirectory: true)
            .standardizedFileURL
    }

    static func fileURL(in dataDirectory: URL) -> URL {
        dataDirectory.appendingPathComponent(fileName, isDirectory: false)
    }

    static func logsDirectory(in dataDirectory: URL) -> URL {
        dataDirectory.appendingPathComponent("logs", isDirectory: true)
    }

    // MARK: Persistence

    /// Missing file → defaults (first run). Symlinks, oversized files and unknown versions are refused.
    static func load(from url: URL) throws -> StandaloneConfig {
        let manager = FileManager.default
        guard manager.fileExists(atPath: url.path) else { return StandaloneConfig() }
        let attributes = try manager.attributesOfItem(atPath: url.path)
        guard (attributes[.type] as? FileAttributeType) == .typeRegular else { throw StandaloneConfigError.unsafeFile }
        if let size = attributes[.size] as? NSNumber, size.intValue > maximumFileBytes { throw StandaloneConfigError.tooLarge }
        let data = try Data(contentsOf: url)
        guard data.count <= maximumFileBytes else { throw StandaloneConfigError.tooLarge }
        return try decode(data)
    }

    static func decode(_ data: Data) throws -> StandaloneConfig {
        try JSONDecoder().decode(StandaloneConfig.self, from: data)
    }

    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    /// Atomic write, file 0600, parent directory 0700.
    func save(to url: URL) throws {
        let data = try encoded()
        try Self.ensurePrivateDirectory(url.deletingLastPathComponent())
        try data.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: Int16(0o600))], ofItemAtPath: url.path)
    }

    static func ensurePrivateDirectory(_ directory: URL) throws {
        let manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true,
                                    attributes: [.posixPermissions: NSNumber(value: Int16(0o700))])
        let attributes = try manager.attributesOfItem(atPath: directory.path)
        guard (attributes[.type] as? FileAttributeType) == .typeDirectory else { throw StandaloneConfigError.unsafeFile }
        try manager.setAttributes([.posixPermissions: NSNumber(value: Int16(0o700))], ofItemAtPath: directory.path)
    }

    // MARK: Validation

    /// The same values with surrounding whitespace removed, as the Settings UI saves them.
    func normalized() -> StandaloneConfig {
        var copy = self
        copy.model = model.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.homeAssistantURL = homeAssistantURL.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.elevenLabsVoiceID = elevenLabsVoiceID.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.workerImage = workerImage.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.workerPython = workerPython.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.dockerBinary = dockerBinary.trimmingCharacters(in: .whitespacesAndNewlines)
        return copy
    }

    /// Human-readable problems; empty when the configuration may be saved and launched.
    var validationErrors: [String] {
        var errors: [String] = []
        if version != Self.currentVersion { errors.append("Unsupported settings version.") }
        let trimmedModel = self.model.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedModel.isEmpty {
            errors.append("A model is required, for example \(Self.defaultModel).")
        } else if !Self.matches(trimmedModel, "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$") {
            errors.append("Model must look like provider/model using letters, digits, '.', '_', '-' or ':'.")
        }
        if let problem = Self.homeAssistantProblem(homeAssistantURL.trimmingCharacters(in: .whitespacesAndNewlines),
                                                   allowHTTP: allowHomeAssistantHTTP) {
            errors.append(problem)
        }
        let voice = elevenLabsVoiceID.trimmingCharacters(in: .whitespacesAndNewlines)
        if !voice.isEmpty, !Self.matches(voice, "^[A-Za-z0-9_-]{1,128}$") {
            errors.append("ElevenLabs voice ID may contain only letters, digits, '_' and '-'.")
        }
        let image = workerImage.trimmingCharacters(in: .whitespacesAndNewlines)
        if !image.isEmpty, image.count > 256 || !Self.matches(image, "^[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$") {
            errors.append("Worker image must be pinned by digest: name@sha256:<64 lowercase hex>.")
        }
        if !Self.isAbsolutePath(workerPython.trimmingCharacters(in: .whitespacesAndNewlines)) {
            errors.append("Worker Python must be an absolute path, or empty.")
        }
        if !Self.isAbsolutePath(dockerBinary.trimmingCharacters(in: .whitespacesAndNewlines)) {
            errors.append("Docker binary must be an absolute path, or empty.")
        }
        return errors
    }

    private static func homeAssistantProblem(_ value: String, allowHTTP: Bool) -> String? {
        guard !value.isEmpty else { return nil }
        let message = "Home Assistant URL must be an https:// (or http://) origin without credentials, path, query or fragment."
        guard value.count <= 2_048, !containsControlCharacters(value),
              let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.path.isEmpty || components.path == "/",
              components.query == nil, components.fragment == nil else { return message }
        if scheme == "http", !allowHTTP {
            return "Plain-HTTP Home Assistant URLs also require “Allow plain HTTP on the local network”, and only work with a private or loopback IP address."
        }
        return nil
    }

    private static func isAbsolutePath(_ value: String) -> Bool {
        value.isEmpty || (value.hasPrefix("/") && value.count <= 1_024 && !containsControlCharacters(value))
    }

    static func containsControlCharacters(_ value: String) -> Bool {
        value.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F }
    }

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }

    // MARK: Launch mapping

    /// Exactly the supervisor `config` map: only non-empty values, flags as "1" only when enabled.
    func launchConfig() -> [String: String] {
        let value = normalized()
        var result: [String: String] = [:]
        func put(_ key: String, _ text: String) { if !text.isEmpty { result[key] = text } }
        func flag(_ key: String, _ enabled: Bool) { if enabled { result[key] = "1" } }
        put("JARVIS_MODEL", value.model)
        flag("JARVIS_ENABLE_DESKTOP", value.enableDesktop)
        flag("JARVIS_ENABLE_TERMINAL", value.enableTerminal)
        flag("JARVIS_ENABLE_APPLE_SERVICES", value.enableAppleServices)
        put("HOME_ASSISTANT_URL", value.homeAssistantURL)
        flag("JARVIS_ALLOW_HOME_ASSISTANT_HTTP", value.allowHomeAssistantHTTP)
        put("ELEVENLABS_VOICE_ID", value.elevenLabsVoiceID)
        put("JARVIS_WORKER_IMAGE", value.workerImage)
        put("JARVIS_WORKER_PYTHON", value.workerPython)
        put("JARVIS_DOCKER_BINARY", value.dockerBinary)
        return result
    }
}
