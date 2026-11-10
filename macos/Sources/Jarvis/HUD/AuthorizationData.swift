import CryptoKit
import Foundation

/// What the authorization lock shows about one decision, derived from the approval card exactly as the runtime
/// issued it. Nothing here can change, shorten or reorder what is being approved: the raw arguments are always
/// available beside the readable layout, and the fingerprint is computed over the unmodified card.
struct AuthorizationPayload: Equatable {
    struct Field: Equatable, Identifiable { let key: String; let value: String; var id: String { key } }

    /// The tool named on the card's first line, when the runtime wrote one.
    let tool: String?
    /// Short arguments, for the key/value grid.
    let fields: [Field]
    /// Long text arguments (a message body, a note), shown as prose.
    let bodies: [Field]
    /// The arguments exactly as issued, or the whole card when they could not be separated.
    let raw: String

    private static let argumentsMarker = "Exact arguments (JSON): "
    private static let order = ["account", "accountId", "serviceId", "calendarId", "from", "to", "recipient", "cc", "bcc", "subject", "title",
                                "start", "end", "location", "url", "bundleId", "executable", "args", "cwd", "action", "operation"]
    private static let proseKeys: Set<String> = ["body", "text", "content", "notes", "message", "markdown", "publicQuery", "goal"]

    init(detail: String) {
        var tool: String?
        if let first = detail.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first, first.hasPrefix("Tool: ") {
            let name = first.dropFirst("Tool: ".count).trimmingCharacters(in: .whitespaces)
            if !name.isEmpty { tool = name }
        }
        self.tool = tool
        guard let marker = detail.range(of: Self.argumentsMarker) else {
            fields = []; bodies = []; raw = detail; return
        }
        let json = String(detail[marker.upperBound...])
        raw = json
        guard let object = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else { fields = []; bodies = []; return }
        var short: [Field] = [], long: [Field] = []
        let keys = object.keys.sorted { left, right in
            let l = Self.order.firstIndex(of: left) ?? Int.max, r = Self.order.firstIndex(of: right) ?? Int.max
            return l == r ? left < right : l < r
        }
        for key in keys {
            let value = Self.display(object[key] as Any)
            if Self.proseKeys.contains(key) || value.contains("\n") || value.count > 120 { long.append(Field(key: key, value: value)) }
            else { short.append(Field(key: key, value: value)) }
        }
        fields = short; bodies = long
    }

    /// A value as text: strings as they are, lists joined, anything else as compact JSON. Never truncated.
    static func display(_ value: Any) -> String {
        switch value {
        case let text as String: return text
        case let number as NSNumber:
            // JSON true/false arrive as NSNumber; keep them as words.
            return CFGetTypeID(number) == CFBooleanGetTypeID() ? (number.boolValue ? "true" : "false") : number.stringValue
        case is NSNull: return "null"
        case let list as [Any] where list.allSatisfy({ $0 is String }): return (list as? [String] ?? []).joined(separator: ", ")
        default:
            guard JSONSerialization.isValidJSONObject(value),
                  let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
                  let text = String(data: data, encoding: .utf8) else { return String(describing: value) }
            return text
        }
    }
}

enum AuthorizationData {
    /// SHA-256 over the card's identity, revision and exact text. Any change to what is being approved changes it.
    static func fingerprint(id: String, revision: Int, detail: String) -> [UInt8] {
        Array(SHA256.hash(data: Data("\(id)\n\(revision)\n\(detail)".utf8)))
    }

    /// "a3f9 7c0e 1b5d 42a8 · c9e6 f03b 7d1a 5c21": the first sixteen bytes, grouped for reading aloud or comparing.
    static func grouped(_ digest: [UInt8]) -> String {
        let groups = stride(from: 0, to: min(16, digest.count), by: 2).map { index -> String in
            digest[index..<min(index + 2, digest.count)].map { String(format: "%02x", $0) }.joined()
        }
        guard groups.count > 4 else { return groups.joined(separator: " ") }
        return groups.prefix(4).joined(separator: " ") + " · " + groups.dropFirst(4).joined(separator: " ")
    }

    /// Thirty-two cells for the 8×4 grid, one per nibble of the first sixteen bytes: (0…15, is high nibble).
    static func cells(_ digest: [UInt8]) -> [Int] {
        digest.prefix(16).flatMap { [Int($0 >> 4), Int($0 & 0x0F)] }
    }

    /// Where the gauge's needle rests, 0 (contained) to 1 (irreversible), and the words under it.
    static func risk(_ impact: ApprovalImpact?) -> (position: Double, label: String, level: Level) {
        switch impact?.risk {
        case "contained": return (0.12, "CONTAINED", .low)
        case "changes_this_mac": return (0.42, "CHANGES THIS MAC", .medium)
        case "leaves_this_mac": return (0.62, "LEAVES THIS MAC", .medium)
        case "irreversible": return (0.9, "IRREVERSIBLE", .high)
        default: return (0.5, "UNCLASSIFIED", .medium)
        }
    }
    enum Level: Equatable { case low, medium, high }

    /// mm:ss until the card expires, or nil once it has (or when it carries no expiry).
    static func remaining(until expiresAt: String?, now: Date) -> String? {
        guard let expiresAt, let date = RoomsStateRules.date(expiresAt) else { return nil }
        let seconds = Int(date.timeIntervalSince(now).rounded(.down))
        guard seconds > 0 else { return nil }
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }

    /// Every approval awaiting a decision, oldest task first, with its task: the queue the lock steps through.
    static func queue(tasks: [AgentTask]) -> [(task: AgentTask, approval: Approval)] {
        tasks.sorted { $0.createdAt < $1.createdAt }.flatMap { task in
            task.approvals.filter { $0.kind == nil || $0.kind == "approval" }.map { (task: task, approval: $0) }
        }
    }
}
