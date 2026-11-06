import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct RoomsArtifactsView: View {
    @ObservedObject var model: RoomsModel
    @State private var selected: RoomsArtifactSelection?
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Immutable artifact shelf").font(.system(size: 23, weight: .light))
            Text("Files are sealed snapshots, not live worker folders. Downloaded bytes are checked against their manifest hash. HTML is displayed only as source.")
                .font(.system(size: 12)).foregroundStyle(RoomsPalette.muted).lineSpacing(4)
            if model.artifacts.isEmpty {
                RoomsPanel(title: "") { RoomsEmptyState(icon: "shippingbox", title: "Nothing fabricated. Nothing here yet.", detail: "Completed worker output and inert checkpoints will appear here only after the runtime seals real files.") }
            }
            ForEach(model.artifacts) { artifact in
                RoomsPanel(title: artifact.nodeId, eyebrow: "SEALED OUTPUT · \(artifact.files.count) FILES") {
                    HStack { RoomsStatus(value: artifact.verification); Spacer(); Text(artifact.createdAt).font(.caption2).foregroundStyle(RoomsPalette.muted) }
                    Text(artifact.verificationSummary).font(.caption).textSelection(.enabled)
                    ForEach(artifact.files) { file in
                        Button { selected = .init(artifact: artifact, path: file.path) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "doc.text").foregroundStyle(RoomsPalette.cyan)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(file.path).font(.system(size: 12, weight: .medium, design: .monospaced))
                                    Text("\(file.mediaType) · \(file.bytes) bytes").font(.caption2).foregroundStyle(RoomsPalette.muted)
                                }
                                Spacer()
                                Image(systemName: "arrow.up.right").foregroundStyle(RoomsPalette.muted)
                            }.padding(12).background(RoomsPalette.elevated, in: RoundedRectangle(cornerRadius: 8))
                        }.buttonStyle(.plain).accessibilityLabel("Inspect source or download \(file.path)")
                    }
                    DisclosureGroup("Provenance & content hashes") {
                        VStack(alignment: .leading, spacing: 8) {
                            provenance("Run", artifact.runId)
                            provenance("Attempt", artifact.attemptId)
                            provenance("Accepted plan", artifact.planDigest)
                            provenance("Manifest", artifact.digest)
                            ForEach(artifact.inputDigests, id: \.self) { provenance("Upstream snapshot", $0) }
                            ForEach(artifact.files) { provenance($0.path, $0.sha256) }
                        }.padding(.top, 10)
                    }.font(.caption).foregroundStyle(RoomsPalette.muted)
                }
            }
        }.sheet(item: $selected) { selection in RoomsArtifactInspector(model: model, selection: selection) }
    }
    private func provenance(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) { Text(label); Text(value).font(.system(size: 10, design: .monospaced)).textSelection(.enabled) }
    }
}

private struct RoomsArtifactSelection: Identifiable {
    let artifact: HarnessArtifact
    let path: String
    var id: String { "\(artifact.id):\(artifact.digest):\(path)" }
}

private struct RoomsArtifactInspector: View {
    @ObservedObject var model: RoomsModel
    let selection: RoomsArtifactSelection
    @State private var data: Data?
    @State private var error: String?
    @State private var loading = true
    @State private var saved = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(selection.path).font(.headline).textSelection(.enabled)
                    Text("UNTRUSTED SOURCE · NEVER EXECUTED").font(.system(size: 9, weight: .semibold)).tracking(1.5).foregroundStyle(RoomsPalette.amber)
                }
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save a copy…") { save() }.disabled(data == nil)
            }
            if loading { ProgressView("Downloading and verifying bytes…").frame(maxWidth: .infinity, maxHeight: .infinity) }
            else if let error {
                RoomsEmptyState(icon: "exclamationmark.shield", title: "Could not verify this file", detail: error)
                Button("Retry download") { Task { await load() } }
                Spacer()
            } else if let data, let text = RoomsStateRules.safePreview(data) {
                ScrollView([.horizontal, .vertical]) {
                    Text(verbatim: text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .topLeading).padding(18)
                }.background(RoomsPalette.background, in: RoundedRectangle(cornerRadius: 12))
            } else {
                RoomsEmptyState(icon: "doc", title: "Verified download; no inline preview", detail: "Binary files and source files over 256 KiB are not rendered. Save a copy to inspect in a separate application.")
                Spacer()
            }
            if saved { Label("Copy saved. It was not opened or executed.", systemImage: "checkmark.shield").font(.caption).foregroundStyle(RoomsPalette.cyan) }
            Text("Saving a file does not verify its safety. Inspect generated code before executing it; keep execution isolated.")
                .font(.caption).foregroundStyle(RoomsPalette.muted)
        }.padding(24).frame(width: 800, height: 650).background(RoomsPalette.panel).preferredColorScheme(.dark)
            .task { await load() }
    }
    private func load() async {
        loading = true; error = nil; data = nil
        do { data = try await model.loadArtifact(selection.artifact, path: selection.path) }
        catch { self.error = error.localizedDescription }
        loading = false
    }
    private func save() {
        guard let data else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: selection.path).lastPathComponent
        panel.canCreateDirectories = true
        panel.message = "Save an untrusted generated file. Jarvis will not execute or open it."
        panel.begin { result in
            guard result == .OK, let url = panel.url else { return }
            do {
                try data.write(to: url, options: .atomic)
                saved = true
            } catch { self.error = error.localizedDescription }
        }
    }
}
