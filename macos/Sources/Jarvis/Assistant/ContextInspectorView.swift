import SwiftUI

@MainActor
final class ContextInspectorModel: ObservableObject {
    @Published var query = ""
    @Published var cloudEligible = false
    @Published var maxTokens = 12_000
    @Published var maxItems = 12
    @Published private(set) var pins: Set<AssistantContextPin> = []
    @Published private(set) var packet: AssistantContextPacket?
    @Published private(set) var busy = false
    @Published var error: String?
    let projectID: String, conversationID: String?, client: AssistantClient
    private var requestID = UUID()
    init(projectID: String, conversationID: String?, client: AssistantClient) {
        self.projectID = projectID; self.conversationID = conversationID; self.client = client
    }
    func invalidate() { requestID = UUID(); packet = nil }
    func clearPins() { pins = []; invalidate() }
    func togglePin(_ selection: AssistantContextSelection) {
        let existing = pins.first { $0.kind == selection.kind && $0.id == selection.id }
        if let existing { pins.remove(existing) }
        else {
            guard pins.count < 16 else { error = "Pin up to 16 items in a context preview."; return }
            pins.insert(selection.pin)
        }
        requestID = UUID()
    }
    func pinned(_ selection: AssistantContextSelection) -> Bool { pins.contains { $0.kind == selection.kind && $0.id == selection.id } }
    func preview() async {
        guard !busy, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              query.utf16.count <= 1_000 else { return }
        let ticket = UUID(), purpose = cloudEligible ? "cloud" : "local", capturedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let capturedTokens = maxTokens, capturedItems = maxItems
        requestID = ticket; busy = true; error = nil; packet = nil
        defer { busy = false }
        do {
            let encodedPins = try pins.sorted { $0.id < $1.id }.map { try $0.assistantJSONObject() }
            var body: [String: Any] = ["version": 1, "projectId": projectID, "query": capturedQuery, "purpose": purpose,
                "maxTokens": capturedTokens, "maxItems": capturedItems, "pins": encodedPins]
            if let conversationID { body["conversationId"] = conversationID }
            let value = try await client.value(AssistantContextPacket.self, path: "/v1/context/assemble", method: "POST", body: body)
            guard requestID == ticket else { return }
            guard value.scope.projectId == projectID, value.scope.conversationId == conversationID, value.scope.taskId == nil,
                  value.purpose == purpose, value.query == capturedQuery, value.usage.maxTokens == capturedTokens,
                  value.selections.count <= capturedItems else { throw AssistantClientError.invalidResponse }
            packet = value
        } catch { if requestID == ticket { self.error = error.localizedDescription } }
    }
}

@MainActor
struct ContextInspectorView: View {
    @StateObject private var model: ContextInspectorModel
    @StateObject private var workingSet: WorkingSetModel
    init(projectID: String, conversationID: String? = nil, client: AssistantClient) {
        _model = StateObject(wrappedValue: ContextInspectorModel(projectID: projectID, conversationID: conversationID, client: client))
        _workingSet = StateObject(wrappedValue: WorkingSetModel(projectID: projectID, client: client))
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("See what goes into an answer").font(.title2)
                Text("Preview evidence, approved memories, and available history for this project. Each preview checks current permissions; it does not send a model request.")
                    .font(.callout).foregroundStyle(.secondary)
                WorkingSetView(model: workingSet)
                TextField("Question or topic to assemble context for", text: $model.query, axis: .vertical).lineLimit(2...4)
                HStack {
                    Toggle("Only cloud-eligible material", isOn: $model.cloudEligible)
                    Spacer()
                    Button(model.busy ? "Assembling…" : "Preview context") { Task { await model.preview() } }
                        .disabled(model.busy || model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.query.utf16.count > 1_000)
                }
                HStack {
                    Stepper("\(model.maxTokens.formatted()) token allowance", value: $model.maxTokens, in: 512...12_000, step: 512)
                    Stepper("Up to \(model.maxItems) items", value: $model.maxItems, in: 0...32)
                }.font(.callout)
                Text(model.cloudEligible ? "This preview excludes memories and source excerpts without cloud permission." : "Local preview can include material you have kept off cloud providers.")
                    .font(.caption).foregroundStyle(.secondary)
                if !model.pins.isEmpty {
                    HStack { Label("\(model.pins.count) pinned for this preview", systemImage: "pin.fill"); Button("Clear pins") { model.clearPins() } }
                        .font(.caption)
                    HStack {
                        Text("Pin changes apply when you preview again.").font(.caption).foregroundStyle(.secondary)
                        Button("Save pins for future turns") { Task { await workingSet.save(pins: Array(model.pins)) } }.disabled(workingSet.busy || workingSet.value == nil)
                    }
                }
                if let error = model.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
                if let packet = model.packet {
                    ContextBudgetView(packet: packet)
                    ForEach(Array(packet.retrieval.enumerated()), id: \.offset) { _, retrieval in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(retrieval.kind.rawValue.capitalized) retrieval: \(retrieval.mode == "hybrid" ? "text + semantic" : retrieval.mode == "lexical" ? "text" : retrieval.mode)")
                                .font(.caption).foregroundStyle(.secondary)
                            ForEach(Array(retrieval.warnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.caption).foregroundStyle(.orange) }
                        }
                    }
                    ForEach(packet.selections) { selection in
                        ContextSelectionView(selection: selection, pinned: model.pinned(selection)) { model.togglePin(selection) }
                    }
                    if packet.selections.isEmpty {
                        ContentUnavailableView("No matching context selected", systemImage: "text.magnifyingglass",
                            description: Text("Try a more specific topic, import project sources, or review proposed memories. Permission and budget omissions are shown above."))
                    }
                    if !packet.activeActions.isEmpty {
                        Divider()
                        Text("Work already in progress").font(.headline)
                        Text("These references preserve task context. Approval still happens on the original action.").font(.caption).foregroundStyle(.secondary)
                        ForEach(Array(packet.activeActions.enumerated()), id: \.offset) { _, action in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(action.summary).textSelection(.enabled)
                                Text("\(action.status.capitalized) · \(action.pendingApprovals) pending approvals").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    Text(packet.notice).font(.caption).foregroundStyle(.secondary)
                } else if !model.busy {
                    ContentUnavailableView("Your context, made visible", systemImage: "list.bullet.rectangle",
                        description: Text("Enter a question to see selected passages, recall reasons, and omissions. Pins preserve exact item revisions but never override grants or budgets."))
                }
            }.padding(22)
        }
        .onChange(of: model.query) { _, _ in model.invalidate() }
        .onChange(of: model.cloudEligible) { _, _ in model.invalidate() }
        .onChange(of: model.maxTokens) { _, _ in model.invalidate() }
        .onChange(of: model.maxItems) { _, _ in model.invalidate() }
    }
}

private struct ContextBudgetView: View {
    let packet: AssistantContextPacket
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Text("Selected context").font(.headline); Spacer(); Text("\(packet.selections.count) items").font(.caption) }
            ProgressView(value: Double(packet.usage.estimatedTokens), total: Double(packet.usage.maxTokens))
            Text("\(packet.usage.estimatedTokens.formatted()) / \(packet.usage.maxTokens.formatted()) estimated tokens · \(packet.usage.serializedBytes.formatted()) bytes")
                .font(.caption).foregroundStyle(.secondary)
            Text("Token estimates use a conservative byte bound. Existing provider conversation history is tracked separately.").font(.caption).foregroundStyle(.secondary)
            if packet.omitted.total > 0 {
                Text("Omitted from this preview").font(.subheadline)
                Text("Budget: \(packet.omitted.budget) · Permission: \(packet.omitted.permission) · Scope: \(packet.omitted.scope) · Duplicates: \(packet.omitted.duplicate)").font(.caption)
                Text("Beyond retrieval limit: \(packet.omitted.availableBeyondLimit) · Missing pins: \(packet.omitted.pinsMissing)").font(.caption)
            }
        }.padding(16).background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct ContextSelectionView: View {
    let selection: AssistantContextSelection, pinned: Bool, togglePin: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(selection.title).font(.headline)
                    Text("\(selection.kind.rawValue.capitalized) · revision \(selection.revision)").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button(action: togglePin) { Label(pinned ? "Unpin" : "Pin in preview", systemImage: pinned ? "pin.fill" : "pin") }
            }
            Text(selection.reasonText).font(.caption).foregroundStyle(.secondary)
            ForEach(Array((selection.retrievalReasons ?? []).enumerated()), id: \.offset) { _, reason in Text(reason).font(.caption).foregroundStyle(.secondary) }
            Text(selection.text).textSelection(.enabled)
            if selection.truncated { Text("Excerpt shortened to fit the allowance. \(selection.selectedBytes.formatted()) of \(selection.originalBytes.formatted()) bytes selected.").font(.caption).foregroundStyle(.orange) }
            DisclosureGroup("Provenance and citations") {
                VStack(alignment: .leading, spacing: 8) {
                    Text(selection.provenance.origin.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption)
                    if let scope = selection.provenance.memoryScope { Text("\(scope.capitalized) memory").font(.caption) }
                    Text("Reference \(selection.provenance.referenceId) · revision \(selection.provenance.revision)").font(.caption.monospaced()).textSelection(.enabled)
                    ForEach(Array(selection.citations.enumerated()), id: \.offset) { _, citation in
                        Text("Source \(citation.sourceVersionId) · passage \(citation.passageId)").font(.caption.monospaced()).textSelection(.enabled)
                        if let locator = citation.locator {
                            Text((locator.page.map { "Page \($0) · " } ?? "") + "lines \(locator.lineStart)–\(locator.lineEnd)").font(.caption)
                        }
                    }
                    Text("Selected as context; factual claims still require verification.").font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
            }
        }.padding(16).background(.quaternary.opacity(0.22), in: RoundedRectangle(cornerRadius: 10))
    }
}
