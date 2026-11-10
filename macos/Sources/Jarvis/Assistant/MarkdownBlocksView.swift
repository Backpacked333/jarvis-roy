import AppKit
import SwiftUI

/// Draws Markdown as real blocks: headings, lists, quotes, code with a copy
/// button, and tables. Links open only when they are plain https URLs.
struct MarkdownBlocksView: View, Equatable {
    let markdown: String
    var spacing: CGFloat = 12

    init(_ markdown: String, spacing: CGFloat = 12) {
        self.markdown = markdown; self.spacing = spacing
    }

    var body: some View {
        let blocks = MarkdownBlocks.parse(markdown)
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "https", url.user == nil, url.password == nil else { return .discarded }
            return .systemAction
        })
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(text).font(headingFont(level)).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.top, level <= 2 ? 4 : 0)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            Text(text).lineSpacing(3).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        case .list(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(marker(item.marker)).monospacedDigit().foregroundStyle(.secondary)
                            .frame(minWidth: 18, alignment: .trailing)
                        Text(item.text).lineSpacing(3).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(.leading, CGFloat(min(item.depth, 6)) * 20)
                }
            }
        case .quote(let text):
            HStack(alignment: .top, spacing: 12) {
                RoundedRectangle(cornerRadius: 2).fill(Color.accentColor.opacity(0.55)).frame(width: 3)
                Text(text).lineSpacing(3).foregroundStyle(.secondary).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.fixedSize(horizontal: false, vertical: true)
        case .code(let language, let text):
            MarkdownCodeBlock(language: language, text: text)
        case .table(let header, let rows):
            MarkdownTable(header: header, rows: rows)
        case .rule:
            Divider().padding(.vertical, 2)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title2.weight(.semibold)
        case 2: return .title3.weight(.semibold)
        case 3: return .headline
        default: return .subheadline.weight(.semibold)
        }
    }

    private func marker(_ marker: MarkdownListItem.Marker) -> String {
        switch marker { case .bullet: return "•"; case .number(let value): return "\(value)." }
    }
}

private struct MarkdownCodeBlock: View {
    let language: String?
    let text: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "code").font(.caption.monospaced()).foregroundStyle(.secondary)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc").font(.caption)
                }.buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Copy code")
            }.padding(.horizontal, 12).padding(.vertical, 7).background(Color.primary.opacity(0.05))
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text.isEmpty ? " " : text).font(.system(.callout, design: .monospaced)).lineSpacing(3)
                    .textSelection(.enabled).fixedSize(horizontal: true, vertical: true).padding(12)
            }
        }
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.09)))
    }
}

private struct MarkdownTable: View {
    let header: [AttributedString]
    let rows: [[AttributedString]]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                        self.cell(cell).fontWeight(.semibold)
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Divider().gridCellUnsizedAxes(.horizontal)
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in self.cell(cell) }
                    }
                }
            }
            .background(Color.primary.opacity(0.03))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.11)))
            .padding(1)
        }
    }

    private func cell(_ text: AttributedString) -> some View {
        Text(text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            .frame(minWidth: 60, maxWidth: 320, alignment: .leading)
            .padding(.horizontal, 12).padding(.vertical, 8)
    }
}
