import Foundation
import XCTest
@testable import Jarvis

private extension MarkdownBlock {
    /// A compact, whitespace-insensitive description used to compare structure.
    var summary: String {
        func plain(_ text: AttributedString) -> String {
            MarkdownBlocks.plainText(text).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        switch self {
        case .heading(let level, let text): return "h\(level):\(plain(text))"
        case .paragraph(let text): return "p:\(plain(text))"
        case .list(let items):
            return "list:" + items.map { item in
                let marker: String
                switch item.marker { case .bullet: marker = "-"; case .number(let value): marker = "\(value)." }
                return "\(item.depth)\(marker)\(plain(item.text))"
            }.joined(separator: "|")
        case .quote(let text): return "quote:\(plain(text))"
        case .code(let language, let text): return "code[\(language ?? "")]:\(text)"
        case .table(let header, let rows):
            return "table:" + ([header] + rows).map { $0.map(plain).joined(separator: ",") }.joined(separator: "|")
        case .rule: return "rule"
        }
    }
}

final class MarkdownBlocksTests: XCTestCase {
    private func summaries(_ markdown: String) -> [String] { MarkdownBlocks.parse(markdown).map(\.summary) }

    func testHeadingsAndParagraphsAreSeparateBlocks() {
        XCTAssertEqual(summaries("# Title\n\nFirst **bold** paragraph.\n\nSecond paragraph.\n\n### Detail"),
                       ["h1:Title", "p:First bold paragraph.", "p:Second paragraph.", "h3:Detail"])
    }

    func testInlineStylingAndLinksSurviveInsideABlock() throws {
        let blocks = MarkdownBlocks.parse("Read the [guide](https://example.com/guide) and `run` it.")
        guard case .paragraph(let text) = try XCTUnwrap(blocks.first) else { return XCTFail("Expected a paragraph") }
        XCTAssertEqual(MarkdownBlocks.plainText(text), "Read the guide and run it.")
        XCTAssertTrue(text.runs.contains { $0.link == URL(string: "https://example.com/guide") })
        XCTAssertTrue(text.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        XCTAssertTrue(text.runs.allSatisfy { $0.presentationIntent == nil })
    }

    func testUnorderedAndOrderedListsKeepTheirMarkers() {
        XCTAssertEqual(summaries("- one\n- two\n\nBetween.\n\n1. first\n2. second\n3. third"),
                       ["list:0-one|0-two", "p:Between.", "list:01.first|02.second|03.third"])
    }

    func testNestedListItemsRecordTheirDepth() {
        XCTAssertEqual(summaries("- parent\n  - child\n  - sibling\n- next"),
                       ["list:0-parent|1-child|1-sibling|0-next"])
    }

    func testBlockQuoteBecomesOneQuote() {
        XCTAssertEqual(summaries("Before.\n\n> A careful note.\n\nAfter."), ["p:Before.", "quote:A careful note.", "p:After."])
    }

    func testFencedCodeKeepsLanguageAndExactText() {
        XCTAssertEqual(summaries("Run this:\n\n```sql\nPRAGMA journal_mode = WAL;\n  SELECT 1;\n```\n\nDone."),
                       ["p:Run this:", "code[sql]:PRAGMA journal_mode = WAL;\n  SELECT 1;", "p:Done."])
    }

    func testCodeIsNotInterpretedAsMarkdown() {
        XCTAssertEqual(summaries("```\n# not a heading\n- not a list\n```"), ["code[]:# not a heading\n- not a list"])
    }

    func testTableBecomesHeaderAndRows() {
        XCTAssertEqual(summaries("| Option | Setup |\n| --- | --- |\n| SQLite | None |\n| Postgres | A **server** |"),
                       ["table:Option,Setup|SQLite,None|Postgres,A server"])
    }

    func testEmptyTableCellsKeepTheirColumn() {
        XCTAssertEqual(summaries("| A | B | C |\n| --- | --- | --- |\n| 1 |  | 3 |"), ["table:A,B,C|1,,3"])
    }

    func testAnswerInProgressStillRenders() {
        // A reply is shown while it streams, so partial structure must not lose text.
        XCTAssertEqual(summaries("Two things:\n\n- First point\n- Second po"), ["p:Two things:", "list:0-First point|0-Second po"])
        XCTAssertEqual(summaries("```swift\nlet value = 1"), ["code[swift]:let value = 1"])
    }

    func testBlankAndPlainInputs() {
        XCTAssertEqual(summaries("  \n\n "), [])
        XCTAssertEqual(summaries("Just a sentence."), ["p:Just a sentence."])
    }

    func testOversizedTextIsShownVerbatimRatherThanDropped() {
        let text = String(repeating: "# heading\n", count: MarkdownBlocks.maximumLength / 10 + 1)
        let blocks = MarkdownBlocks.parse(text)
        XCTAssertEqual(blocks.count, 1)
        guard case .paragraph(let value) = blocks[0] else { return XCTFail("Expected verbatim text") }
        XCTAssertEqual(MarkdownBlocks.plainText(value), text)
    }

    func testFixtureAnswerCoversEveryBlockKind() {
        let kinds = MarkdownBlocks.parse(UISnapshotFixtures.answerMarkdown).map { block -> String in
            switch block {
            case .heading: return "heading"; case .paragraph: return "paragraph"; case .list: return "list"
            case .quote: return "quote"; case .code: return "code"; case .table: return "table"; case .rule: return "rule"
            }
        }
        XCTAssertEqual(kinds, ["heading", "paragraph", "heading", "list", "list", "quote", "table", "code", "paragraph"])
    }
}
