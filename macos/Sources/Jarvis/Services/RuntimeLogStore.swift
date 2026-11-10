import Foundation

/// Removes credential-shaped text before a service's output is stored or shown.
enum RuntimeLogRedaction {
    static let maximumLineLength = 2_000
    static let marker = "[redacted]"

    private static let assignments = try? NSRegularExpression(
        pattern: #"(?i)\b(authorization|api[_-]?key|token|secret|password|credential)(["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',}]+"#)
    private static let bearer = try? NSRegularExpression(pattern: #"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}"#)
    /// Provider keys, loopback tokens and digests are long unbroken runs; paths and prose are not.
    private static let longRun = try? NSRegularExpression(pattern: #"[A-Za-z0-9_\-]{32,}"#)

    static func redact(_ line: String, secrets: [String] = []) -> String {
        var text = line
        for secret in secrets where secret.count >= 8 { text = text.replacingOccurrences(of: secret, with: marker) }
        text = replace(assignments, in: text, with: "$1$2\(marker)")
        text = replace(bearer, in: text, with: "Bearer \(marker)")
        text = replace(longRun, in: text, with: marker)
        // Control characters could forge extra lines or hide text when a log is displayed.
        text = String(text.unicodeScalars.map { scalar -> Character in
            (scalar.value < 0x20 && scalar != "\t") || scalar.value == 0x7F ? " " : Character(scalar)
        })
        if text.count > maximumLineLength { text = String(text.prefix(maximumLineLength)) + "…" }
        return text
    }

    private static func replace(_ expression: NSRegularExpression?, in text: String, with template: String) -> String {
        guard let expression else { return text }
        return expression.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }
}

/// Splits a byte stream into complete lines and never holds more than a bounded partial line.
struct RuntimeLogLineBuffer {
    static let maximumPartialBytes = 16 * 1_024
    private var partial = Data()

    mutating func append(_ data: Data) -> [String] {
        partial.append(data)
        var lines: [String] = []
        while let newline = partial.firstIndex(of: 0x0A) {
            lines.append(String(decoding: partial[partial.startIndex..<newline], as: UTF8.self))
            partial = Data(partial[partial.index(after: newline)...])
        }
        if partial.count > Self.maximumPartialBytes {
            lines.append(String(decoding: partial, as: UTF8.self))
            partial = Data()
        }
        return lines.map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }.filter { !$0.isEmpty }
    }

    mutating func flush() -> [String] {
        guard !partial.isEmpty else { return [] }
        let line = String(decoding: partial, as: UTF8.self)
        partial = Data()
        return line.isEmpty ? [] : [line]
    }
}

/// Keeps each local service's recent output in a private, size-capped file so a failed start can be explained.
/// Lines are redacted before they are written. Files live beside Jarvis's other private data and never leave the Mac.
final class RuntimeLogStore: @unchecked Sendable {
    static let maximumFileBytes = 512 * 1_024
    static let recentLineLimit = 40

    let directory: URL
    private let queue = DispatchQueue(label: "ai.backpacked.jarvisroy.runtime-logs")
    private var secrets: [String]
    private var buffers: [String: RuntimeLogLineBuffer] = [:]
    private var recent: [String: [String]] = [:]

    init(directory: URL, secrets: [String] = []) {
        self.directory = directory
        self.secrets = secrets.filter { !$0.isEmpty }
    }

    func fileURL(role: String) -> URL { directory.appendingPathComponent("\(role).log") }

    /// Safe to call from any thread, including a pipe's readability handler.
    func append(_ data: Data, role: String) {
        guard !data.isEmpty else { return }
        queue.async {
            var buffer = self.buffers[role] ?? RuntimeLogLineBuffer()
            let lines = buffer.append(data)
            self.buffers[role] = buffer
            self.store(lines, role: role)
        }
    }

    /// Records a line written by the app itself, such as "service started".
    func note(_ message: String, role: String) {
        queue.async { self.store([message], role: role) }
    }

    func finish(role: String) {
        queue.async {
            var buffer = self.buffers[role] ?? RuntimeLogLineBuffer()
            let lines = buffer.flush()
            self.buffers[role] = nil
            self.store(lines, role: role)
        }
    }

    func tail(role: String, lines count: Int = 12) -> [String] {
        queue.sync { Array((recent[role] ?? []).suffix(max(0, count))) }
    }

    private func store(_ lines: [String], role: String) {
        guard !lines.isEmpty else { return }
        let redacted = lines.map { RuntimeLogRedaction.redact($0, secrets: secrets) }
        var kept = (recent[role] ?? []) + redacted
        if kept.count > Self.recentLineLimit { kept.removeFirst(kept.count - Self.recentLineLimit) }
        recent[role] = kept
        let stamp = ISO8601DateFormatter().string(from: Date())
        write(Data(redacted.map { "\(stamp) \($0)\n" }.joined().utf8), role: role)
    }

    private func write(_ data: Data, role: String) {
        let manager = FileManager.default
        let url = fileURL(role: role)
        do {
            try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let size = (try? manager.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
            if size + data.count > Self.maximumFileBytes {
                let previous = directory.appendingPathComponent("\(role).previous.log")
                try? manager.removeItem(at: previous)
                try? manager.moveItem(at: url, to: previous)
            }
            if !manager.fileExists(atPath: url.path) {
                guard manager.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { return }
            }
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } catch {
            // A log that cannot be written must never stop a service from starting.
        }
    }
}
