import AppKit
import PDFKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct PresentationDraftEditor: View {
    let presentation: AssistantPresentation
    @ObservedObject var assistant: AssistantModel
    @State private var editing = false
    @State private var bodyText = ""
    @State private var saving = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(presentation.content.title ?? "Draft").font(.headline).textSelection(.enabled)
                Spacer()
                if !editing { Button("Edit draft") { bodyText = presentation.content.body ?? ""; editing = true } }
            }
            if editing {
                TextEditor(text: $bodyText).font(.body).frame(minHeight: 240)
                    .padding(8).background(.quaternary.opacity(0.2), in: RoundedRectangle(cornerRadius: 8))
                HStack {
                    Text("Editing revision \(presentation.revision). Saving creates a new revision.").font(.caption).foregroundStyle(.secondary)
                    Spacer(); Button("Discard edits") { editing = false }.disabled(saving)
                    Button(saving ? "Saving…" : "Save revision") {
                        saving = true
                        let captured = bodyText
                        Task { let saved = await assistant.saveDraft(presentation, body: captured); saving = false; if saved, captured == bodyText { editing = false } }
                    }.disabled(saving || bodyText.utf16.count > 32_000)
                }
            } else { Text(presentation.content.body ?? "").textSelection(.enabled) }
        }
    }
}

enum PresentationDiffLine {
    enum Kind { case addition, removal, header, unchanged }
    static func kind(_ line: String) -> Kind {
        if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("@@") || line.hasPrefix("diff ") { return .header }
        if line.hasPrefix("+") { return .addition }
        if line.hasPrefix("-") { return .removal }
        return .unchanged
    }
}

struct PresentationDiffView: View {
    let diff: String
    var body: some View {
        ScrollView(.horizontal) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) { index, line in
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(index + 1)").foregroundStyle(.secondary).frame(width: 36, alignment: .trailing)
                        Text(line.isEmpty ? " " : line).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }.font(.system(.callout, design: .monospaced)).padding(.vertical, 3).padding(.horizontal, 8)
                        .background(color(line).opacity(0.12))
                }
            }
        }
    }
    private func color(_ line: String) -> Color {
        switch PresentationDiffLine.kind(line) { case .addition: return .green; case .removal: return .red; case .header: return .blue; case .unchanged: return .clear }
    }
}

enum ArtifactPreviewPolicy {
    static let maximumBytes = 8 * 1_024 * 1_024
    static let maximumTextBytes = 1 * 1_024 * 1_024
    static func allowsInline(mediaType: String, bytes: Int) -> Bool {
        guard bytes >= 0, bytes <= maximumBytes else { return false }
        if mediaType == "application/pdf" || ["image/png", "image/jpeg", "image/webp"].contains(mediaType) { return true }
        return bytes <= maximumTextBytes && (mediaType.hasPrefix("text/") || ["application/json", "application/csv"].contains(mediaType))
    }
}

@MainActor
struct ArtifactInlineView: View {
    let presentation: AssistantPresentation
    @ObservedObject var rooms: RoomsModel
    @State private var data: Data?
    @State private var error: String?
    @State private var loading = false
    private var artifact: HarnessArtifact? {
        rooms.state?.artifacts.first { $0.id == presentation.content.artifactId && $0.roomId == presentation.content.roomId &&
            $0.runId == presentation.content.runId && $0.digest == presentation.content.digest }
    }
    private var file: HarnessArtifactFile? { artifact?.files.first { $0.path == presentation.content.path } }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let file {
                HStack {
                    Text("\(file.mediaType) · \(ByteCountFormatter.string(fromByteCount: Int64(file.bytes), countStyle: .file))").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if ArtifactPreviewPolicy.allowsInline(mediaType: file.mediaType, bytes: file.bytes) {
                        Button(loading ? "Loading…" : "Preview verified bytes") { Task { await load() } }.disabled(loading)
                    }
                    if let data { Button("Save a copy") { save(data, filename: file.path) } }
                }
                if let data {
                    if file.mediaType == "application/pdf" { ArtifactPDFPreview(data: data).frame(minHeight: 420) }
                    else if file.mediaType.hasPrefix("image/"), let image = NSImage(data: data) {
                        Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 520).accessibilityLabel("Generated artifact image")
                    } else if let text = String(data: data, encoding: .utf8) {
                        ScrollView(.horizontal) { Text(text).font(.system(.callout, design: .monospaced)).textSelection(.enabled) }
                    } else { Text("This file is not valid UTF-8 text. Save its original bytes to inspect it.").foregroundStyle(.secondary) }
                    Text("Manifest and file SHA-256 verified. Content verification: \(artifact?.verification ?? "unverified").").font(.caption).foregroundStyle(.secondary)
                } else if !ArtifactPreviewPolicy.allowsInline(mediaType: file.mediaType, bytes: file.bytes) {
                    Text("This format or size needs the artifact inspector in Rooms. Text previews are limited to 1 MiB; PDFs and images to 8 MiB.").font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Text("The exact artifact manifest is not available in the current room state.").font(.callout).foregroundStyle(.secondary)
                Button("Refresh manifests") { Task { await rooms.refresh() } }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.orange) }
        }
    }
    private func load() async {
        guard let artifact, let file, ArtifactPreviewPolicy.allowsInline(mediaType: file.mediaType, bytes: file.bytes) else { return }
        loading = true; data = nil; error = nil; defer { loading = false }
        do { data = try await rooms.loadArtifact(artifact, path: file.path) }
        catch { self.error = error.localizedDescription }
    }
    private func save(_ data: Data, filename: String) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = URL(fileURLWithPath: filename).lastPathComponent
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try data.write(to: url, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path) }
        catch { self.error = error.localizedDescription }
    }
}

private struct ArtifactPDFPreview: NSViewRepresentable {
    let data: Data
    func makeNSView(context: Context) -> PDFView { let view = PDFView(); view.autoScales = true; return view }
    func updateNSView(_ view: PDFView, context: Context) { if view.document?.dataRepresentation() != data { view.document = PDFDocument(data: data) } }
}
