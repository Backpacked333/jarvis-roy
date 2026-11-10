import CoreGraphics
import Foundation

/// One exchange in the conversation: what you asked, what Jarvis said, and
/// the working material that turn produced.
struct AssistantThreadEntry: Identifiable {
    let turn: AssistantTurn
    /// Text presentations are Jarvis's reply and are read in place.
    let replies: [AssistantPresentation]
    /// Sources, tables, charts, code, drafts and the like open beside the conversation.
    let material: [AssistantPresentation]
    var id: String { turn.id }
    var hasReplyText: Bool { replies.contains { !($0.content.markdown ?? "").isEmpty } }
    /// Jarvis has accepted the turn and nothing has been written yet.
    var awaitingReply: Bool { !turn.isSettled && !hasReplyText }
    /// Text is still arriving as new revisions.
    var streaming: Bool { !turn.isSettled && hasReplyText }
}

enum AssistantSurfaceMode: Equatable {
    /// The session has produced nothing to work with; the conversation takes the full width.
    case hidden
    /// The newest result is the reply already shown in the conversation, so the
    /// surface lists the session's working material instead of repeating it.
    case overview
    /// One presentation at one revision, exactly as selected or followed.
    case detail
}

enum AssistantThread {
    static func entries(turns: [AssistantTurn], presentations: [AssistantPresentation]) -> [AssistantThreadEntry] {
        let grouped = Dictionary(grouping: presentations, by: \.turnId)
        return turns.map { turn in
            let own = grouped[turn.id] ?? []
            return AssistantThreadEntry(turn: turn, replies: own.filter { $0.content.kind == .text },
                                        material: own.filter { $0.content.kind != .text })
        }
    }

    static func material(_ presentations: [AssistantPresentation]) -> [AssistantPresentation] {
        presentations.filter { $0.content.kind != .text }
    }

    /// The surface never shows a presentation other than the selected one, so a
    /// visual reference always binds to the revision that is on screen.
    static func surfaceMode(selected: AssistantPresentation?, following: Bool, hasMaterial: Bool) -> AssistantSurfaceMode {
        if let selected, selected.content.kind != .text || !following { return .detail }
        return hasMaterial ? .overview : .hidden
    }

    static func statusLabel(_ entry: AssistantThreadEntry) -> String? {
        switch entry.turn.status {
        case "failed": return "This didn't finish"
        case "interrupted": return "Stopped before finishing"
        case "dispatching": return entry.hasReplyText ? nil : "Starting"
        case "running": return entry.hasReplyText ? nil : "Thinking"
        default: return nil
        }
    }
}

/// Keeps the newest reply in view while it arrives, and stops as soon as you
/// scroll back to read something earlier.
struct ThreadScrollFollow: Equatable {
    static let threshold: CGFloat = 56
    private(set) var following = true
    private var lastOffset: CGFloat?
    private var lastHeight: CGFloat = 0

    /// `offset` is the content's top edge relative to the viewport: zero at the
    /// top and negative once scrolled. Returns true when the viewport should
    /// move to the newest content.
    mutating func update(offset: CGFloat, contentHeight: CGFloat, viewportHeight: CGFloat) -> Bool {
        let distance = max(0, contentHeight + offset - viewportHeight)
        if let last = lastOffset {
            // Moving toward older messages is always the reader; content that
            // shrinks can also raise the offset and must not count as that.
            if offset > last + 0.5, contentHeight >= lastHeight - 0.5 { following = distance <= Self.threshold }
            else if offset < last - 0.5, distance <= Self.threshold { following = true }
        }
        lastOffset = offset; lastHeight = contentHeight
        return following && distance > 0.5
    }

    mutating func jumpToLatest() { following = true }
}

extension AssistantPresentationContent.Kind {
    var symbol: String {
        switch self {
        case .text: return "doc.text"
        case .sources: return "books.vertical"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .math: return "function"
        case .table: return "tablecells"
        case .chart: return "chart.xyaxis.line"
        case .artifact: return "doc.zipper"
        case .plan: return "list.bullet.rectangle"
        case .document: return "doc.text.magnifyingglass"
        case .draft: return "square.and.pencil"
        case .code_diff: return "arrow.triangle.branch"
        }
    }

    var label: String {
        switch self {
        case .text: return "Answer"
        case .sources: return "Sources"
        case .code: return "Code"
        case .math: return "Equation"
        case .table: return "Table"
        case .chart: return "Chart"
        case .artifact: return "File"
        case .plan: return "Plan"
        case .document: return "Document"
        case .draft: return "Draft"
        case .code_diff: return "Code changes"
        }
    }
}

extension AssistantPresentation {
    var displayTitle: String { title.isEmpty ? content.kind.label : title }

    /// A short factual line about what the presentation holds.
    var materialDetail: String {
        switch content.kind {
        case .sources:
            let count = content.sources?.count ?? 0
            return count == 1 ? "1 source" : "\(count) sources"
        case .table:
            let rows = content.rows?.count ?? 0
            return "\(rows == 1 ? "1 row" : "\(rows) rows") · \(content.columns?.count ?? 0) columns"
        case .chart: return content.series.map { $0.count == 1 ? "1 series" : "\($0.count) series" } ?? "Chart"
        case .code: return content.language ?? "Code"
        case .code_diff: return content.language.map { "\($0) changes" } ?? "Code changes"
        case .draft: return content.format == "email" ? "Email draft" : "Document draft"
        case .document:
            let count = content.passages?.count ?? 0
            return count == 1 ? "1 passage" : "\(count) passages"
        case .plan: return content.status?.capitalized ?? "Plan"
        case .artifact: return content.path ?? "File"
        case .math: return "Equation"
        case .text: return "Answer"
        }
    }
}
