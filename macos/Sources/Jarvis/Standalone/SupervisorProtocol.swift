import Foundation

enum SupervisorProtocolError: LocalizedError, Equatable {
    case invalidToken, missingModelCredential, invalidValue, tooLarge

    var errorDescription: String? {
        switch self {
        case .invalidToken: return "The local session token is invalid."
        case .missingModelCredential: return "A Vercel AI Gateway API key is required."
        case .invalidValue: return "A saved setting or key contains a forbidden character."
        case .tooLarge: return "The saved settings and keys are too large to launch."
        }
    }
}

/// The single stdin line sent to `scripts/supervisor.mjs`: `{version:1, token, secrets, config}`.
struct SupervisorPayload: Encodable {
    static let currentVersion = 1
    static let maximumBytes = 64 * 1_024
    static let secretKeys: [String] = CredentialKey.allCases.map(\.rawValue)
    static let configKeys: [String] = [
        "JARVIS_MODEL", "JARVIS_ENABLE_DESKTOP", "JARVIS_ENABLE_TERMINAL", "JARVIS_ENABLE_APPLE_SERVICES",
        "HOME_ASSISTANT_URL", "JARVIS_ALLOW_HOME_ASSISTANT_HTTP", "ELEVENLABS_VOICE_ID", "JARVIS_WORKER_IMAGE",
        "JARVIS_WORKER_PYTHON", "JARVIS_DOCKER_BINARY",
    ]

    let version: Int
    let token: String
    let secrets: [String: String]
    let config: [String: String]

    /// Keeps only allowlisted, non-empty entries and fails closed on anything the supervisor would refuse.
    init(token: String, secrets: [String: String], config: [String: String]) throws {
        guard LocalSession.isValidToken(token) else { throw SupervisorProtocolError.invalidToken }
        let secrets = try Self.filtered(secrets, allowed: Self.secretKeys)
        guard secrets[CredentialKey.aiGateway.rawValue]?.isEmpty == false else {
            throw SupervisorProtocolError.missingModelCredential
        }
        self.version = Self.currentVersion
        self.token = token
        self.secrets = secrets
        self.config = try Self.filtered(config, allowed: Self.configKeys)
    }

    private static func filtered(_ values: [String: String], allowed: [String]) throws -> [String: String] {
        var result: [String: String] = [:]
        for key in allowed {
            guard let value = values[key], !value.isEmpty else { continue }
            guard !value.unicodeScalars.contains(where: { $0 == "\0" || $0 == "\n" || $0 == "\r" }) else {
                throw SupervisorProtocolError.invalidValue
            }
            result[key] = value
        }
        return result
    }

    /// One compact JSON object followed by exactly one "\n". JSON string escaping guarantees
    /// the object itself contains no raw newline.
    func encodedLine() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(self)
        guard data.count < Self.maximumBytes, !data.contains(0x0A), !data.contains(0x0D) else {
            throw SupervisorProtocolError.tooLarge
        }
        data.append(0x0A)
        return data
    }
}

/// Events the supervisor writes to stdout, one JSON object per line.
enum SupervisorEvent: Equatable, Sendable {
    case starting, ready, failed(String), stopping, stopped(clean: Bool)

    static let maximumLineBytes = 8 * 1_024
    static let maximumReasonLength = 200
    static let fallbackReason = "Local services failed."

    private struct Wire: Decodable {
        let event: String
        let reason: String?
        let clean: Bool?
    }

    /// Nil for blank, oversized, malformed or unknown lines; they are ignored.
    init?(line: Data) {
        guard !line.isEmpty, line.count <= Self.maximumLineBytes,
              let wire = try? JSONDecoder().decode(Wire.self, from: line) else { return nil }
        switch wire.event {
        case "starting": self = .starting
        case "ready": self = .ready
        case "failed": self = .failed(Self.sanitize(wire.reason ?? ""))
        case "stopping": self = .stopping
        case "stopped": self = .stopped(clean: wire.clean == true)
        default: return nil
        }
    }

    init?(line: String) { self.init(line: Data(line.utf8)) }

    /// Short printable text; anything shaped like a credential or token is masked.
    static func sanitize(_ text: String) -> String {
        var printable = ""
        for scalar in text.unicodeScalars {
            if (0x20...0x7E).contains(scalar.value) || scalar == "…" { printable.unicodeScalars.append(scalar) } else { printable.append(" ") }
        }
        let collapsed = printable.split(whereSeparator: { $0 == " " }).joined(separator: " ")
        let masked = collapsed.replacingOccurrences(of: "[A-Za-z0-9_\\-+/=.:]{24,}", with: "[redacted]", options: .regularExpression)
        if masked.isEmpty { return fallbackReason }
        if masked.count > maximumReasonLength { return String(masked.prefix(maximumReasonLength - 1)) + "…" }
        return masked
    }
}

/// Splits stdout chunks into lines. A line that grows past the cap is discarded up to its newline.
struct SupervisorLineBuffer {
    private var pending = Data()
    private var discarding = false
    let limit: Int

    init(limit: Int = SupervisorEvent.maximumLineBytes) { self.limit = limit }

    mutating func append(_ chunk: Data) -> [Data] {
        var lines: [Data] = []
        for byte in chunk {
            if byte == 0x0A {
                if !discarding, !pending.isEmpty { lines.append(pending) }
                pending = Data()
                discarding = false
            } else if !discarding {
                pending.append(byte)
                if pending.count > limit { pending = Data(); discarding = true }
            }
        }
        return lines
    }

    mutating func reset() { pending = Data(); discarding = false }
}
