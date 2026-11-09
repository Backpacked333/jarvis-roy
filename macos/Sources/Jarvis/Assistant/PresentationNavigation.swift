import Foundation

/// Manual navigation freezes the actual displayed revision. Streaming updates
/// remain available without replacing the object the user is reading.
struct PresentationNavigation {
    private(set) var current: AssistantPresentation?
    private(set) var following = true
    private var history: [AssistantPresentation] = []
    var canGoBack: Bool { !history.isEmpty }
    mutating func reset() { current = nil; history = []; following = true }
    mutating func select(_ value: AssistantPresentation, automatic: Bool = false) {
        guard !automatic || following else { return }
        if !automatic { following = false }
        if let current, current.id != value.id {
            history.append(current); history = Array(history.suffix(50))
        }
        current = value
    }
    mutating func back() {
        guard let previous = history.popLast() else { return }
        following = false; current = previous
    }
    mutating func follow(_ latest: AssistantPresentation?) {
        following = true
        if let latest { select(latest, automatic: true) }
    }
}

struct AssistantVisualSelection: Codable, Equatable {
    enum Kind: String, Codable { case document_passage, table_cell, text_range }
    let kind: Kind
    var passageId: String?
    var row: Int?
    var column: Int?
    var start: Int?
    var end: Int?
    var label: String {
        switch kind {
        case .document_passage: return "Selected passage"
        case .table_cell: return "Row \((row ?? 0) + 1), column \((column ?? 0) + 1)"
        case .text_range: return "Selected text"
        }
    }
}
