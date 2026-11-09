import Foundation

protocol AssistantRevisioned: Identifiable where ID == String {
    var version: Int { get }
    var revision: Int { get }
}

enum AssistantRevisionMerge {
    /// HTTP responses can arrive after newer SSE events for the same object.
    /// Revisions are authoritative across both transports, including terminal states.
    @discardableResult
    static func upsert<T: AssistantRevisioned>(_ value: T, in values: inout [T]) -> Bool {
        guard value.version == 1, value.revision > 0 else { return false }
        if let index = values.firstIndex(where: { $0.id == value.id }) {
            guard value.revision > values[index].revision else { return false }
            values[index] = value
        } else { values.append(value) }
        return true
    }
}

enum AssistantSubmissionOutcome: Equatable {
    case admitted, retained, ignored
}

struct AssistantDraftCheckpoint {
    let sessionID: String, text: String, revision: Int
}

/// Only immutable session IDs address drafts. An async response never uses the
/// selection at completion time, and a revision protects edits made in flight.
struct AssistantSessionDrafts {
    private struct Entry { let text: String, revision: Int }
    private var entries: [String: Entry] = [:]
    func text(for sessionID: String) -> String { entries[sessionID]?.text ?? "" }
    func checkpoint(for sessionID: String) -> AssistantDraftCheckpoint {
        AssistantDraftCheckpoint(sessionID: sessionID, text: text(for: sessionID), revision: entries[sessionID]?.revision ?? 0)
    }
    mutating func edit(_ text: String, for sessionID: String) {
        entries[sessionID] = Entry(text: text, revision: (entries[sessionID]?.revision ?? 0) + 1)
    }
    mutating func admitted(_ submitted: String, from checkpoint: AssistantDraftCheckpoint) {
        let current = self.checkpoint(for: checkpoint.sessionID)
        guard current.revision == checkpoint.revision, current.text == submitted else { return }
        edit("", for: checkpoint.sessionID)
    }
    mutating func retain(_ incoming: String, for sessionID: String, replacingSubmitted checkpoint: AssistantDraftCheckpoint? = nil) {
        guard !incoming.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let current = self.checkpoint(for: sessionID)
        guard current.text != incoming else { return }
        let replace = checkpoint.map { $0.sessionID == sessionID && $0.revision == current.revision && $0.text == current.text } ?? false
        if current.text.isEmpty || replace { edit(incoming, for: sessionID) }
        else { edit(current.text + "\n\n— Retained turn —\n" + incoming, for: sessionID) }
    }
}

enum AssistantConfirmationPlayback {
    static func permits(_ response: AssistantProposal, current: AssistantProposal?, activeProposalID: String?,
                        selectedSessionID: String?, status: String) -> Bool {
        guard let current else { return false }
        return response.version == 1 && current.version == 1 && response.id == activeProposalID &&
            response.sessionId == selectedSessionID && current.id == response.id &&
            current.revision == response.revision && current.digest == response.digest &&
            current.readbackId == response.readbackId && current.status == status && response.status == status
    }
}

struct AssistantFocus: Codable, Equatable {
    enum Kind: String, Codable { case none, conversation, room }
    var kind: Kind
    var conversationId: String?
    var roomId: String?
    static let none = AssistantFocus(kind: .none)
    var projectID: String? { roomId ?? conversationId }
    var voiceContext: HarnessVoiceContext {
        HarnessVoiceContext(roomId: kind == .room ? roomId : nil, conversationId: conversationId, question: nil)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        if kind == .conversation {
            try c.encode(conversationId, forKey: .conversationId)
            try c.encode(roomId, forKey: .roomId)
        } else if kind == .room { try c.encode(roomId, forKey: .roomId) }
    }
}

struct AssistantSession: Codable, AssistantRevisioned {
    let version: Int, id: String, title: String, revision: Int
    let focus: AssistantFocus
    let createdAt: String, updatedAt: String
}
struct AssistantTurn: Decodable, AssistantRevisioned {
    let version: Int, id: String, sessionId: String, revision: Int, text: String, intent: String
    let capturedFocus: AssistantFocus
    let sessionRevision: Int, status: String
    let taskId: String?, conversationId: String?, error: String?
    let createdAt: String, updatedAt: String
    var isSettled: Bool { ["completed", "failed", "interrupted"].contains(status) }
}
struct AssistantSourceCard: Decodable, Identifiable {
    let id: String, title: String, url: String, excerpt: String, retrievedAt: String, status: String
}
enum AssistantScalar: Codable, Equatable {
    case string(String), number(Double), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let value = try? c.decode(Double.self), value.isFinite { self = .number(value) }
        else { self = .string(try c.decode(String.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .string(let v): try c.encode(v); case .number(let v): try c.encode(v); case .null: try c.encodeNil() }
    }
    var display: String { switch self { case .string(let v): return v; case .number(let v): return v.formatted(); case .null: return "—" } }
    var numeric: Double? { if case .number(let value) = self { return value }; return nil }
}
struct AssistantChartSeries: Decodable {
    struct Point: Decodable { let x: AssistantScalar, y: Double }
    let name: String, points: [Point]
}
struct AssistantDocumentPassage: Decodable, Identifiable {
    struct Locator: Decodable {
        let page: Int?, lineStart: Int, lineEnd: Int
        var display: String {
            let lines = "Lines \(lineStart)–\(lineEnd)"
            return page.map { "Page \($0) · \(lines)" } ?? lines
        }
    }
    let id: String, text: String, locator: Locator
}
struct AssistantPresentationContent: Decodable {
    enum Kind: String, Decodable { case text, sources, code, math, table, chart, artifact, plan, document, draft, code_diff }
    let kind: Kind
    let markdown: String?, sources: [AssistantSourceCard]?
    let language: String?, code: String?, verification: String?
    let latex: String?, explanation: String?
    let columns: [String]?, rows: [[AssistantScalar]]?
    let chartType: String?, xLabel: String?, yLabel: String?, series: [AssistantChartSeries]?
    let roomId: String?, runId: String?, artifactId: String?, digest: String?, path: String?, mediaType: String?
    let planId: String?, planRevision: Int?, status: String?, summary: String?
    let sourceVersionId: String?, passages: [AssistantDocumentPassage]?
    let format: String?, title: String?, body: String?, diff: String?
}
struct AssistantPresentation: Decodable, AssistantRevisioned {
    let version: Int, id: String, sessionId: String, turnId: String, revision: Int, title: String
    let capturedFocus: AssistantFocus, content: AssistantPresentationContent
    let createdAt: String, updatedAt: String
}
struct AssistantAction: Codable {
    let taskId: String, interactionId: String, revision: Int, optionId: String
    let toolName: String, exactArguments: String, reviewText: String, voiceAllowed: Bool
}
struct AssistantProposal: Decodable, AssistantRevisioned {
    let version: Int, id: String, sessionId: String, turnId: String, revision: Int, digest: String
    let action: AssistantAction, status: String
    let challenge: String?, expiresAt: String?, nativeSessionId: String?, readbackId: String?
    let createdAt: String, updatedAt: String
}
struct AssistantState: Decodable {
    let version: Int, sequence: Int
    let sessions: [AssistantSession], turns: [AssistantTurn]
    let presentations: [AssistantPresentation], proposals: [AssistantProposal]
}
enum AssistantEvent {
    case session(Int, AssistantSession), turn(Int, AssistantTurn)
    case presentation(Int, AssistantPresentation), proposal(Int, AssistantProposal)
    var sequence: Int {
        switch self { case .session(let n, _), .turn(let n, _), .presentation(let n, _), .proposal(let n, _): return n }
    }
    static func decode(_ data: Data) throws -> AssistantEvent {
        struct Header: Decodable { let version: Int, type: String, sequence: Int }
        struct Envelope<T: Decodable>: Decodable { let data: T }
        let decoder = JSONDecoder(), h = try decoder.decode(Header.self, from: data)
        guard h.version == 1, h.sequence > 0 else { throw AssistantClientError.invalidResponse }
        switch h.type {
        case "session.updated":
            let value = try decoder.decode(Envelope<AssistantSession>.self, from: data).data
            guard value.version == 1 else { throw AssistantClientError.invalidResponse }; return .session(h.sequence, value)
        case "turn.updated":
            let value = try decoder.decode(Envelope<AssistantTurn>.self, from: data).data
            guard value.version == 1 else { throw AssistantClientError.invalidResponse }; return .turn(h.sequence, value)
        case "presentation.updated":
            let value = try decoder.decode(Envelope<AssistantPresentation>.self, from: data).data
            guard value.version == 1 else { throw AssistantClientError.invalidResponse }; return .presentation(h.sequence, value)
        case "confirmation.updated":
            let value = try decoder.decode(Envelope<AssistantProposal>.self, from: data).data
            guard value.version == 1 else { throw AssistantClientError.invalidResponse }; return .proposal(h.sequence, value)
        default: throw AssistantClientError.invalidResponse
        }
    }
}

/// Completed sentences are spoken once. Rewrites are kept on screen instead of
/// replaying a changed prefix as if it were new speech.
struct AssistantSentenceStream {
    private(set) var observed = ""
    private var consumed = 0
    private(set) var invalidated = false
    private(set) var truncated = false
    mutating func append(_ fullText: String, final: Bool) -> String {
        guard !truncated else { return "" }
        guard !invalidated, fullText.hasPrefix(observed), fullText.utf16.count <= 32_000 else {
            invalidated = true; return ""
        }
        observed = fullText
        let remaining = String(fullText.dropFirst(consumed))
        var boundary: String.Index?
        for index in remaining.indices {
            let character = remaining[index], next = remaining.index(after: index)
            if character == "\n" || (".!?".contains(character) && next < remaining.endIndex && remaining[next].isWhitespace) {
                boundary = next
            }
        }
        let end = final ? remaining.endIndex : boundary
        guard let end else { return "" }
        var output = String(remaining[..<end])
        if consumed + output.count > 2_400 {
            let candidate = String(output.prefix(max(0, 2_400 - consumed)))
            var safeEnd = candidate.startIndex
            for index in candidate.indices {
                let next = candidate.index(after: index)
                if candidate[index] == "\n" || (".!?".contains(candidate[index]) && next < candidate.endIndex && candidate[next].isWhitespace) { safeEnd = next }
            }
            output = String(candidate[..<safeEnd]) + " The complete result is on screen. Ask me to explain a section."
            truncated = true
        }
        consumed += output.count
        return output
    }
}

struct AssistantSSEParser {
    private var line = Data()
    private var event = Data()
    mutating func accept(_ byte: UInt8) throws -> Data? {
        guard line.count + event.count <= 524_288 else { throw AssistantClientError.invalidResponse }
        if byte != 10 { line.append(byte); return nil }
        let value = String(decoding: line, as: UTF8.self).trimmingCharacters(in: .newlines)
        line.removeAll(keepingCapacity: true)
        if value.isEmpty {
            guard !event.isEmpty else { return nil }
            let result = event; event.removeAll(keepingCapacity: true); return result
        }
        if value.hasPrefix("data:") {
            if !event.isEmpty { event.append(10) }
            event.append(contentsOf: value.dropFirst(5).drop(while: { $0 == " " }).utf8)
        }
        return nil
    }
}
