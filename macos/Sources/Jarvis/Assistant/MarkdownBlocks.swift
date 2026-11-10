import Foundation

struct MarkdownListItem: Equatable {
    enum Marker: Equatable { case bullet, number(Int) }
    var depth: Int
    var marker: Marker
    var text: AttributedString
}

/// One block of a Markdown document. Inline styling and links stay inside the
/// attributed text; the block structure is what SwiftUI's `Text` cannot draw.
enum MarkdownBlock: Equatable {
    case heading(level: Int, text: AttributedString)
    case paragraph(AttributedString)
    case list([MarkdownListItem])
    case quote(AttributedString)
    case code(language: String?, text: String)
    case table(header: [AttributedString], rows: [[AttributedString]])
    case rule
}

enum MarkdownBlocks {
    /// Larger than the 32,000 UTF-16 unit bound on assistant text; anything
    /// beyond it is shown verbatim instead of being parsed.
    static let maximumLength = 96_000

    /// Splits Markdown into blocks using Foundation's parser. Text that cannot
    /// be parsed is returned unchanged as a single paragraph, never dropped.
    static func parse(_ source: String) -> [MarkdownBlock] {
        guard !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        let options = AttributedString.MarkdownParsingOptions(allowsExtendedAttributes: false, interpretedSyntax: .full,
                                                              failurePolicy: .returnPartiallyParsedIfPossible)
        guard source.utf16.count <= maximumLength,
              let attributed = try? AttributedString(markdown: source, options: options) else {
            return [.paragraph(AttributedString(source))]
        }
        var builder = MarkdownBlockBuilder()
        for run in attributed.runs {
            var piece = AttributedString(attributed[run.range])
            piece.presentationIntent = nil
            builder.add(piece, placement: MarkdownPlacement(run.presentationIntent))
        }
        let blocks = builder.finish()
        return blocks.isEmpty ? [.paragraph(AttributedString(source))] : blocks
    }

    static func plainText(_ text: AttributedString) -> String { String(text.characters) }
}

/// Where a run of text sits in the document, read from its presentation intent.
/// Identities increase in document order, so the innermost container of a kind
/// is the one with the greatest identity.
private struct MarkdownPlacement {
    var paragraph: Int?
    var heading: (id: Int, level: Int)?
    var code: (id: Int, language: String?)?
    var quote: Int?
    var rule: Int?
    var table: (id: Int, columns: Int)?
    var row: (id: Int, header: Bool)?
    var column: Int?
    var lists: [(id: Int, ordered: Bool)] = []
    var item: (id: Int, ordinal: Int)?

    init(_ intent: PresentationIntent?) {
        for component in intent?.components ?? [] {
            let id = component.identity
            switch component.kind {
            case .paragraph: paragraph = id
            case .header(let level): heading = (id, level)
            case .codeBlock(let language): code = (id, language)
            case .blockQuote: if quote.map({ id < $0 }) ?? true { quote = id }
            case .thematicBreak: rule = id
            case .table(let columns): table = (id, columns.count)
            case .tableHeaderRow: row = (id, true)
            case .tableRow: row = (id, false)
            case .tableCell(let index): column = index
            case .orderedList: lists.append((id, true))
            case .unorderedList: lists.append((id, false))
            case .listItem(let ordinal): if item.map({ id > $0.id }) ?? true { item = (id, ordinal) }
            @unknown default: break
            }
        }
        lists.sort { $0.id < $1.id }
    }
}

private struct MarkdownBlockBuilder {
    private enum Kind: Equatable { case heading(Int), paragraph, quote, code, list, table, rule }
    private struct Pending {
        var kind: Kind
        var id: Int?
        var text = AttributedString()
        var code = ""
        var language: String?
        var lastParagraph: Int?
        var items: [MarkdownListItem] = []
        var lastItem: Int?
        var header: [AttributedString] = []
        var rows: [[AttributedString]] = []
        var lastRow: Int?
    }
    private var pending: Pending?
    private var blocks: [MarkdownBlock] = []

    mutating func add(_ piece: AttributedString, placement: MarkdownPlacement) {
        let kind: Kind, id: Int?
        if let code = placement.code { kind = .code; id = code.id }
        else if let table = placement.table { kind = .table; id = table.id }
        else if let list = placement.lists.first, placement.item != nil { kind = .list; id = list.id }
        else if let quote = placement.quote { kind = .quote; id = quote }
        else if let rule = placement.rule { kind = .rule; id = rule }
        else if let heading = placement.heading { kind = .heading(heading.level); id = heading.id }
        else { kind = .paragraph; id = placement.paragraph }
        if pending?.kind != kind || pending?.id != id {
            flush()
            pending = Pending(kind: kind, id: id, language: placement.code?.language)
            if let table = placement.table { pending?.header = Array(repeating: AttributedString(), count: table.columns) }
        }
        guard var current = pending else { return }
        switch kind {
        case .heading, .paragraph: current.text += piece
        case .quote:
            if let last = current.lastParagraph, let next = placement.paragraph, last != next { current.text += AttributedString("\n") }
            current.lastParagraph = placement.paragraph ?? current.lastParagraph
            current.text += piece
        case .code: current.code += String(piece.characters)
        case .list:
            guard let item = placement.item else { break }
            if current.lastItem == item.id, !current.items.isEmpty {
                let index = current.items.count - 1
                if let last = current.lastParagraph, let next = placement.paragraph, last != next { current.items[index].text += AttributedString("\n") }
                current.items[index].text += piece
            } else {
                let ordered = placement.lists.last?.ordered ?? false
                current.items.append(MarkdownListItem(depth: max(0, placement.lists.count - 1),
                    marker: ordered ? .number(item.ordinal) : .bullet, text: piece))
                current.lastItem = item.id
            }
            current.lastParagraph = placement.paragraph
        case .table:
            guard let row = placement.row, let column = placement.column, column >= 0, column < 64 else { break }
            if row.header {
                while current.header.count <= column { current.header.append(AttributedString()) }
                current.header[column] += piece
            } else {
                if current.lastRow != row.id {
                    current.rows.append(Array(repeating: AttributedString(), count: current.header.count))
                    current.lastRow = row.id
                }
                let index = current.rows.count - 1
                while current.rows[index].count <= column { current.rows[index].append(AttributedString()) }
                current.rows[index][column] += piece
            }
        case .rule: break
        }
        pending = current
    }

    mutating func finish() -> [MarkdownBlock] {
        flush()
        return blocks
    }

    private mutating func flush() {
        guard let current = pending else { return }
        pending = nil
        switch current.kind {
        case .heading(let level): if !isBlank(current.text) { blocks.append(.heading(level: level, text: current.text)) }
        case .paragraph: if !isBlank(current.text) { blocks.append(.paragraph(current.text)) }
        case .quote: if !isBlank(current.text) { blocks.append(.quote(current.text)) }
        case .code:
            var text = current.code
            while text.hasSuffix("\n") { text.removeLast() }
            let language = current.language?.trimmingCharacters(in: .whitespacesAndNewlines)
            blocks.append(.code(language: language?.isEmpty == false ? language : nil, text: text))
        case .list: if !current.items.isEmpty { blocks.append(.list(current.items)) }
        case .table:
            let width = max(current.header.count, current.rows.map(\.count).max() ?? 0)
            guard width > 0 else { return }
            func padded(_ row: [AttributedString]) -> [AttributedString] { row + Array(repeating: AttributedString(), count: width - row.count) }
            blocks.append(.table(header: padded(current.header), rows: current.rows.map(padded)))
        case .rule: blocks.append(.rule)
        }
    }

    private func isBlank(_ text: AttributedString) -> Bool {
        String(text.characters).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
