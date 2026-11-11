import AppKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class MemoryWorkspaceModel: ObservableObject {
    @Published var scope: MemoryWorkspaceScope
    @Published var filter = "active"
    @Published var query = ""
    @Published var selectedID: String?
    @Published private(set) var entries: [AssistantMemoryRecord] = []
    @Published private(set) var busy = false
    @Published var error: String?
    @Published var notice: String?
    let projectID: String?, client: AssistantClient
    private var refreshID = UUID()
    init(projectID: String?, client: AssistantClient) {
        self.projectID = projectID; self.client = client; scope = projectID == nil ? .personal : .project
    }
    var selected: AssistantMemoryRecord? { entries.first { $0.id == selectedID && scope.contains($0, projectID: projectID) } }
    var selectedScope: AssistantMemoryScope { scope == .project && projectID != nil ? .project(projectID!) : .personal }
    var visible: [AssistantMemoryRecord] {
        entries.filter { entry in
            scope.contains(entry, projectID: projectID) && (filter == "all" || entry.status.rawValue == filter) &&
                (query.isEmpty || entry.text.localizedCaseInsensitiveContains(query) || entry.kind.rawValue.localizedCaseInsensitiveContains(query))
        }.sorted { a, b in a.pinned != b.pinned ? a.pinned : a.updatedAt > b.updatedAt }
    }
    private func listPath(for requestedScope: MemoryWorkspaceScope) -> String {
        guard requestedScope == .project, let projectID else { return "/v1/memory/entries" }
        return "/v1/memory/entries?projectId=\(projectID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
    }
    func refresh() async {
        let ticket = UUID(), requestedScope = scope
        refreshID = ticket
        guard AssistantFeatures.memory else { entries = []; selectedID = nil; return }
        do {
            struct Reply: Decodable { let entries: [AssistantMemoryRecord] }
            let reply = try await client.value(Reply.self, path: listPath(for: requestedScope))
            guard refreshID == ticket, scope == requestedScope, AssistantFeatures.memory else { return }
            // Project listings include personal preferences; this view keeps its
            // explicitly selected scopes separate while context may use both.
            entries = reply.entries.filter { requestedScope.contains($0, projectID: projectID) }
            if !entries.contains(where: { $0.id == selectedID }) { selectedID = nil }
            error = nil
        } catch { if refreshID == ticket, scope == requestedScope { self.error = error.localizedDescription } }
    }
    func changeScope() async { refreshID = UUID(); entries = []; selectedID = nil; query = ""; await refresh() }
    func save(_ input: AssistantMemoryInput, editing original: AssistantMemoryRecord?) async -> Bool {
        guard AssistantFeatures.memory, !busy, input.scope == selectedScope else { return false }
        busy = true; error = nil; defer { busy = false }
        do {
            let path = original.map { "/v1/memory/entries/\($0.id)" } ?? "/v1/memory/entries"
            let content = try input.assistantJSONObject()
            let body: [String: Any] = original.map { ["expectedRevision": $0.revision, "input": content] } ?? content
            let saved = try await client.value(AssistantMemoryRecord.self, path: path, method: original == nil ? "POST" : "PATCH", body: body)
            guard saved.scope == input.scope, original == nil || saved.id == original?.id else { throw AssistantClientError.invalidResponse }
            notice = saved.status == .active ? "Saved for recall. You can change its content and cloud permission by reviewing an edit." : "Changes are proposed. Review the exact memory before it can be recalled."
            await refresh()
            if scope.contains(saved, projectID: projectID) { selectedID = saved.id; filter = saved.status.rawValue }
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func approve(_ captured: AssistantMemoryRecord) async -> Bool {
        guard AssistantFeatures.memory, !busy, let current = entries.first(where: { $0.id == captured.id }), current.matchesReview(captured) else {
            error = "This memory changed. Refresh and review its latest revision."; return false
        }
        busy = true; defer { busy = false }
        do {
            let approved = try await client.value(AssistantMemoryRecord.self, path: "/v1/memory/entries/\(captured.id)/approve", method: "POST",
                body: ["expectedRevision": captured.revision, "digest": captured.digest])
            guard approved.id == captured.id, approved.scope == captured.scope, approved.status == .active else { throw AssistantClientError.invalidResponse }
            notice = "Approved this exact memory. Its cloud permission remains as reviewed."
            await refresh(); filter = "active"; selectedID = approved.id
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func archive(_ captured: AssistantMemoryRecord) async { await revise(captured, action: "archive") }
    func forget(_ captured: AssistantMemoryRecord) async { await revise(captured, action: "forget") }
    private func revise(_ captured: AssistantMemoryRecord, action: String) async {
        guard AssistantFeatures.memory, !busy else { return }
        busy = true; defer { busy = false }
        do {
            _ = try await client.data("/v1/memory/entries/\(captured.id)/\(action)", method: "POST", body: ["expectedRevision": captured.revision])
            notice = action == "forget" ? "Removed this saved memory." : "Archived. This memory is excluded from recall."
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func export() async {
        let requestedScope = scope
        let panel = NSSavePanel(); panel.nameFieldStringValue = "Jarvis-memories.json"; panel.allowedContentTypes = [.json]
        panel.message = "This export contains private saved memories and their provenance."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let path = listPath(for: requestedScope).replacingOccurrences(of: "/entries", with: "/export")
            struct Export: Codable { let version: Int, exportedAt: String, entries: [AssistantMemoryRecord] }
            let value = try await client.value(Export.self, path: path)
            guard value.version == 1 else { throw AssistantClientError.invalidResponse }
            let selected = Export(version: 1, exportedAt: value.exportedAt,
                entries: value.entries.filter { requestedScope.contains($0, projectID: projectID) })
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(selected).write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            notice = "Exported memories and provenance."
        } catch { self.error = error.localizedDescription }
    }
}

@MainActor
struct MemoryWorkspaceView: View {
    @StateObject private var model: MemoryWorkspaceModel
    @AppStorage("Jarvis.memoryEnabled") private var memoryPreference = false
    @State private var creating = false
    @State private var editing: AssistantMemoryRecord?
    @State private var reviewing: AssistantMemoryRecord?
    @State private var archiving: AssistantMemoryRecord?
    @State private var forgetting: AssistantMemoryRecord?
    init(projectID: String?, client: AssistantClient, reviewInbox: Bool = false) {
        let model = MemoryWorkspaceModel(projectID: projectID, client: client)
        if reviewInbox { model.filter = "proposed" }
        _model = StateObject(wrappedValue: model)
    }
    private var enabled: Bool { ProcessInfo.processInfo.environment["JARVIS_ENABLE_MEMORY"].map { $0 == "1" } ?? memoryPreference }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Memory you control").font(.title2)
                    Text("Keep preferences and project knowledge with a clear origin. Proposed memories stay out of recall until you approve them.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Refresh") { Task { await model.refresh() } }.disabled(!enabled || model.busy)
                Button("New memory") { creating = true }.buttonStyle(.jarvisPrimary).disabled(!enabled || model.busy)
            }
            if enabled {
                HStack {
                    Picker("Scope", selection: $model.scope) {
                        Text("Personal").tag(MemoryWorkspaceScope.personal)
                        if model.projectID != nil { Text("This project").tag(MemoryWorkspaceScope.project) }
                    }.pickerStyle(.segmented).frame(width: 230).disabled(model.busy)
                    Picker("Show", selection: $model.filter) {
                        Text("Active").tag("active"); Text("For review").tag("proposed"); Text("Archived").tag("archived"); Text("All").tag("all")
                    }.frame(width: 165)
                    TextField("Search saved memories", text: $model.query)
                    Button("Export…") { Task { await model.export() } }.disabled(model.busy)
                }
                if let error = model.error { Text(error).foregroundStyle(.orange).font(.callout).textSelection(.enabled) }
                if let notice = model.notice { Text(notice).font(.caption).foregroundStyle(.secondary) }
                HSplitView {
                    List(selection: $model.selectedID) {
                        ForEach(model.visible) { entry in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(entry.text).lineLimit(3)
                                HStack {
                                    if entry.pinned { Image(systemName: "pin.fill") }
                                    Text(entry.kind.rawValue.capitalized)
                                    Text(entry.expired ? "Expired" : entry.status.rawValue.capitalized)
                                    Text(entry.cloudAllowed ? "Cloud allowed" : "Local only")
                                }.font(.caption2).foregroundStyle(.secondary)
                            }.padding(.vertical, 6).tag(entry.id)
                        }
                    }.frame(minWidth: 250, idealWidth: 310)
                    ScrollView {
                        if let entry = model.selected {
                            VStack(alignment: .leading, spacing: 18) {
                                MemoryRecordDetail(entry: entry)
                                HStack {
                                    if entry.status == .proposed { Button("Review and approve…") { reviewing = entry } }
                                    Button("Edit…") { editing = entry }.disabled(entry.status == .superseded)
                                    if entry.status != .archived { Button("Archive…") { archiving = entry } }
                                    Button("Forget…", role: .destructive) { forgetting = entry }
                                }.disabled(model.busy)
                            }.padding(22).frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            ContentUnavailableView(model.visible.isEmpty ? "No memories here yet" : "Choose a memory", systemImage: "brain",
                                description: Text("Save a useful preference or project fact, or review something Jarvis has proposed. Each scope stays separate."))
                        }
                    }.frame(minWidth: 360)
                }
            } else {
                ContentUnavailableView("Personal memory is off", systemImage: "brain",
                    description: Text("Enable Personal memory in Settings and restart local services to review and save memories."))
            }
        }.padding(20)
            .task { await model.refresh() }
            .onChange(of: model.scope) { _, _ in Task { await model.changeScope() } }
            .onChange(of: enabled) { _, _ in Task { await model.refresh() } }
            .sheet(isPresented: $creating) { MemoryEditorView(scope: model.selectedScope, original: nil, model: model) }
            .sheet(item: $editing) { entry in MemoryEditorView(scope: entry.scope, original: entry, model: model) }
            .sheet(item: $reviewing) { captured in
                VStack(alignment: .leading, spacing: 16) {
                    Text("Approve this exact memory").font(.title2)
                    ScrollView { MemoryRecordDetail(entry: captured).frame(maxWidth: .infinity, alignment: .leading) }
                    Text("Approval applies to revision \(captured.revision). An edit requires a new review.").font(.caption).foregroundStyle(.secondary)
                    if let error = model.error { Text(error).font(.caption).foregroundStyle(.orange) }
                    HStack { Button("Cancel") { reviewing = nil }; Spacer(); Button("Approve memory") { Task { if await model.approve(captured) { reviewing = nil } } }.buttonStyle(.jarvisPrimary).disabled(model.busy) }
                }.padding(24).frame(width: 580, height: 520)
            }
            .alert("Archive this memory?", isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil } })) {
                Button("Cancel", role: .cancel) { archiving = nil }
                Button("Archive") { if let captured = archiving { Task { await model.archive(captured) } }; archiving = nil }
            } message: { Text("It will remain inspectable and be excluded from future recall.") }
            .alert("Forget this saved memory?", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } })) {
                Button("Cancel", role: .cancel) { forgetting = nil }
                Button("Forget", role: .destructive) { if let captured = forgetting { Task { await model.forget(captured) } }; forgetting = nil }
            } message: { Text("Removes this saved memory. Its original documents and conversation history are managed separately.") }
    }
}

private struct MemoryRecordDetail: View {
    let entry: AssistantMemoryRecord
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(entry.scope.title, systemImage: entry.scope.kind == .global ? "person.crop.circle" : "folder")
                .font(.headline)
            Text(entry.text).font(.body).textSelection(.enabled)
            HStack {
                Text(entry.kind.rawValue.capitalized)
                Text(entry.expired ? "Expired" : entry.status.rawValue.capitalized)
                if entry.pinned { Label("Pinned for recall", systemImage: "pin.fill") }
            }.font(.caption).foregroundStyle(.secondary)
            Label(entry.cloudAllowed ? "Relevant memory text may enter cloud reasoning" : "Local only · excluded from cloud reasoning", systemImage: entry.cloudAllowed ? "cloud" : "lock")
                .font(.callout)
            if let assertion = entry.assertion {
                VStack(alignment: .leading, spacing: 5) {
                    Text("\(assertion.property): \(assertion.value)").font(.headline).textSelection(.enabled)
                    Text("Entity \(assertion.entityId)").font(.caption.monospaced()).foregroundStyle(.secondary)
                    Text("Valid from \(assertion.validFrom ?? "unspecified") until \(assertion.validTo ?? "open-ended")").font(.caption).foregroundStyle(.secondary)
                    Text("Observed \(assertion.observedAt)").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let expiry = entry.expiresAt { Text("Expires \(expiry)").font(.caption).foregroundStyle(.secondary) }
            Divider()
            Text("Why this was saved").font(.headline)
            Text(entry.provenance.origin == .explicit_user ? "Explicitly supplied by you" : "Inferred by Jarvis")
                .font(.callout)
            Text("Recorded confidence: \(Int(entry.confidence * 100))% · revision \(entry.revision)").font(.caption).foregroundStyle(.secondary)
            ForEach(Array(entry.provenance.references.enumerated()), id: \.offset) { _, reference in
                Text(reference.label).font(.caption.monospaced()).textSelection(.enabled)
            }
            if entry.provenance.references.isEmpty { Text("No source references were attached.").font(.caption).foregroundStyle(.secondary) }
            if let replacement = entry.supersededBy { Text("Replaced by memory \(replacement)").font(.caption.monospaced()).textSelection(.enabled) }
        }
    }
}

@MainActor
private struct MemoryEditorView: View {
    let scope: AssistantMemoryScope, original: AssistantMemoryRecord?
    @ObservedObject var model: MemoryWorkspaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var kind: AssistantMemoryKind
    @State private var cloudAllowed: Bool
    @State private var pinned: Bool
    @State private var expires: Bool
    @State private var expiry: Date
    init(scope: AssistantMemoryScope, original: AssistantMemoryRecord?, model: MemoryWorkspaceModel) {
        self.scope = scope; self.original = original; self.model = model
        _text = State(initialValue: original?.text ?? ""); _kind = State(initialValue: original?.kind ?? .preference)
        _cloudAllowed = State(initialValue: original?.cloudAllowed ?? false); _pinned = State(initialValue: original?.pinned ?? false)
        _expires = State(initialValue: original?.expiresAt != nil)
        _expiry = State(initialValue: (original?.expiresAt).flatMap(RoomsStateRules.date) ?? Date().addingTimeInterval(30 * 86_400))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(original == nil ? "Save a memory" : "Propose a memory edit").font(.title2)
            Text(scope.title).font(.headline)
            Text(original == nil ? "This is an explicit memory you are choosing to save." : "Changes become a proposal. Review its exact content and permissions before it is used again.")
                .font(.callout).foregroundStyle(.secondary)
            Picker("Kind", selection: $kind) { ForEach(AssistantMemoryKind.allCases) { Text($0.rawValue.capitalized).tag($0) } }
            TextEditor(text: $text).font(.body).frame(minHeight: 130).overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            Text("\(text.utf16.count) / 4,000 characters").font(.caption).foregroundStyle(text.utf16.count > 4_000 ? .orange : .secondary)
            Toggle("Pin for recall", isOn: $pinned)
            Toggle("Allow relevant memory text in cloud reasoning", isOn: $cloudAllowed)
            HStack { Toggle("Expires", isOn: $expires); if expires { DatePicker("Date", selection: $expiry, displayedComponents: [.date, .hourAndMinute]).labelsHidden() } }
            if let error = model.error { Text(error).font(.caption).foregroundStyle(.orange) }
            HStack {
                Button("Cancel") { dismiss() }.disabled(model.busy)
                Spacer()
                Button(original == nil ? "Save memory" : "Save proposal") {
                    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                    let input = AssistantMemoryInput(kind: kind, scope: scope, text: text.trimmingCharacters(in: .whitespacesAndNewlines),
                        provenance: original?.provenance ?? AssistantMemoryProvenance(origin: .explicit_user, references: []),
                        confidence: original?.confidence ?? 1, pinned: pinned, expiresAt: expires ? formatter.string(from: expiry) : nil, cloudAllowed: cloudAllowed, assertion: original?.assertion)
                    Task { if await model.save(input, editing: original) { dismiss() } }
                }.disabled(model.busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.utf16.count > 4_000 || (expires && expiry <= Date()))
            }
        }.padding(24).frame(width: 580)
    }
}
