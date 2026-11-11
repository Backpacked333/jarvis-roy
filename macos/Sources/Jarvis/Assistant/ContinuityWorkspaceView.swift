import SwiftUI

struct AssistantWorkingSet: Decodable {
    let version: Int, projectId: String, revision: Int, pins: [AssistantContextPin], goal: String?, updatedAt: String?
}
struct AssistantUsageManifest: Decodable, Identifiable {
    struct Selection: Decodable, Identifiable {
        let kind: AssistantContextKind, id: String, revision: Int, originalSha256: String, reasons: [String]
        let citations: [AssistantContextCitation], available: Bool?
        var pin: AssistantContextPin { .init(kind: kind, id: id, revision: revision) }
    }
    let version: Int, id: String, packetId: String, projectId: String, conversationId: String?, taskId: String?, createdAt: String
    let usageAuthority: String, selections: [Selection]
    func isBound(projectID: String, taskID: String) -> Bool {
        version == 1 && projectId == projectID && taskId == taskID && usageAuthority == "supplied_context_not_claim_attribution"
    }
}

@MainActor
final class WorkingSetModel: ObservableObject {
    @Published private(set) var value: AssistantWorkingSet?
    @Published var goal = ""
    @Published private(set) var busy = false
    @Published var error: String?
    let projectID: String, client: AssistantClient
    init(projectID: String, client: AssistantClient) { self.projectID = projectID; self.client = client }
    private var path: String { "/v1/continuity/working-set?projectId=\(projectID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")" }
    func load() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        let originalGoal = goal
        do {
            let result = try await client.value(AssistantWorkingSet.self, path: path)
            guard result.version == 1, result.projectId == projectID, result.revision >= 0 else { throw AssistantClientError.invalidResponse }
            value = result; if goal == originalGoal { goal = result.goal ?? "" }; error = nil
        } catch { self.error = error.localizedDescription }
    }
    func save(pins: [AssistantContextPin]? = nil) async {
        guard !busy, let prior = value, goal.utf16.count <= 2_000 else { return }
        busy = true; defer { busy = false }
        let capturedGoal = goal
        do {
            let pins = pins ?? prior.pins
            guard pins.count <= 16 else { throw AssistantClientError.service("Keep up to 16 items in a project's working set.") }
            let result = try await client.value(AssistantWorkingSet.self, path: path, method: "PUT", body: [
                "expectedRevision": prior.revision, "pins": try pins.map { try $0.assistantJSONObject() },
                "goal": capturedGoal.isEmpty ? NSNull() : capturedGoal as Any])
            guard result.version == 1, result.projectId == projectID, result.revision > prior.revision else { throw AssistantClientError.invalidResponse }
            value = result; error = nil
        } catch { self.error = error.localizedDescription }
    }
    func add(_ pin: AssistantContextPin) async {
        if value == nil { await load() }
        guard let value else { return }
        var pins = value.pins.filter { !($0.kind == pin.kind && $0.id == pin.id) }; pins.append(pin)
        await save(pins: pins)
    }
}

@MainActor
struct WorkingSetView: View {
    @ObservedObject var model: WorkingSetModel
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("This project's working set", systemImage: "pin.circle").font(.headline)
            Text("Keep the goal and evidence that should be considered on future turns. Grants and context limits still apply.").font(.caption).foregroundStyle(.secondary)
            TextField("What should Jarvis keep in mind for this project?", text: $model.goal, axis: .vertical).lineLimit(1...4)
            ForEach(model.value?.pins ?? [], id: \.self) { pin in
                HStack {
                    Text("\(pin.kind.rawValue.capitalized) · \(pin.id)").font(.caption.monospaced()).lineLimit(1)
                    if let revision = pin.revision { Text("r\(revision)").font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    Button("Remove") { Task { await model.save(pins: (model.value?.pins ?? []).filter { $0 != pin }) } }.disabled(model.busy)
                }
            }
            HStack {
                Button("Save project goal") { Task { await model.save() } }.disabled(model.busy || model.value == nil || model.goal.utf16.count > 2_000)
                Button("Reload") { Task { await model.load() } }.disabled(model.busy)
                if model.busy { ProgressView().controlSize(.small) }
            }
            if let error = model.error { Text(error).font(.caption).foregroundStyle(.orange) }
        }.padding(16).jarvisSurface(.panel, radius: 12)
            .task { await model.load() }
    }
}

struct ContextUsedTarget: Identifiable { let id: String, projectID: String }

@MainActor
struct ContextUsedView: View {
    let projectID: String, taskID: String, client: AssistantClient
    @State private var manifests: [AssistantUsageManifest] = []
    @State private var error: String?
    @State private var busy = true
    @State private var evidence: KnowledgeMatch?
    @State private var evidenceRequest = UUID()
    @StateObject private var workingSet: WorkingSetModel
    init(projectID: String, taskID: String, client: AssistantClient) {
        self.projectID = projectID; self.taskID = taskID; self.client = client
        _workingSet = StateObject(wrappedValue: WorkingSetModel(projectID: projectID, client: client))
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Context supplied to this answer").font(.title2)
                Text("These are the records supplied to the model for this task. Their presence does not prove which claims used them. Availability is checked again when you inspect them.").font(.callout).foregroundStyle(.secondary)
                if busy { ProgressView() }
                if let error { Text(error).foregroundStyle(.orange) }
                ForEach(manifests) { manifest in
                    ForEach(manifest.selections) { selection in
                        ContextManifestSelectionView(selection: selection, busy: workingSet.busy,
                            pin: { Task { await workingSet.add(selection.pin) } },
                            inspect: { citation in Task { await inspect(citation) } })
                    }
                }
                if !busy && manifests.isEmpty { Text("No context manifest is available for this task. Earlier conversations may predate context recording.").foregroundStyle(.secondary) }
                if let evidence { ContextEvidenceView(evidence: evidence) }
                WorkingSetView(model: workingSet)
            }.padding(24)
        }.task { await load() }
    }
    private func load() async {
        do {
            struct List: Decodable { let version: Int, manifests: [AssistantUsageManifest] }
            let query = projectID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
            let list = try await client.value(List.self, path: "/v1/continuity/manifests?projectId=\(query)&taskId=\(taskID)")
            guard list.version == 1, list.manifests.allSatisfy({ $0.isBound(projectID: projectID, taskID: taskID) }) else { throw AssistantClientError.invalidResponse }
            var authorized: [AssistantUsageManifest] = []
            for item in list.manifests {
                let detail = try await client.value(AssistantUsageManifest.self, path: "/v1/continuity/manifests/\(item.id)?projectId=\(query)")
                guard detail.id == item.id, detail.isBound(projectID: projectID, taskID: taskID) else { throw AssistantClientError.invalidResponse }
                authorized.append(detail)
            }
            manifests = authorized; busy = false
        } catch { self.error = error.localizedDescription; busy = false }
    }
    private func inspect(_ citation: AssistantContextCitation) async {
        let request = UUID(); evidenceRequest = request; evidence = nil
        do {
            struct Source: Decodable { let source: KnowledgeSource, passages: [KnowledgePassage] }
            let query = projectID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
            let value = try await client.value(Source.self, path: "/v1/knowledge/sources/\(citation.sourceVersionId)?projectId=\(query)&purpose=local")
            guard value.source.version == 1, value.source.id == citation.sourceVersionId, value.source.projectId == projectID,
                  let passage = value.passages.first(where: { $0.id == citation.passageId && $0.sourceVersionId == citation.sourceVersionId && $0.projectId == projectID }) else { throw AssistantClientError.invalidResponse }
            if request == evidenceRequest { evidence = .init(source: value.source, passage: passage) }
        } catch { if request == evidenceRequest { self.error = error.localizedDescription } }
    }
}

private struct ContextManifestSelectionView: View {
    let selection: AssistantUsageManifest.Selection
    let busy: Bool
    let pin: () -> Void
    let inspect: (AssistantContextCitation) -> Void
    private var available: Bool { selection.available == true }
    private var reasonText: String { selection.reasons.map { $0.replacingOccurrences(of: "_", with: " ") }.joined(separator: " · ") }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("\(selection.kind.rawValue.capitalized) · revision \(selection.revision)").font(.headline)
                Spacer()
                Text(available ? "Available now" : "Unavailable or changed").font(.caption)
                    .foregroundStyle(available ? Color.secondary : Color.orange)
            }
            Text(reasonText).font(.caption).foregroundStyle(.secondary)
            Button("Keep in working set", action: pin).disabled(!available || busy)
            ForEach(Array(selection.citations.enumerated()), id: \.offset) { entry in
                Button("Inspect passage \(entry.element.passageId)") { inspect(entry.element) }.disabled(!available)
            }
            DisclosureGroup("Record identity") {
                Text("\(selection.id)\nSHA-256 \(selection.originalSha256)").font(.caption.monospaced()).textSelection(.enabled)
            }
        }.padding(16).jarvisSurface(.panel, radius: 12)
    }
}
private struct ContextEvidenceView: View {
    let evidence: KnowledgeMatch
    private var locator: String {
        let page = evidence.passage.locator.page.map { "Page \($0) · " } ?? ""
        return page + "lines \(evidence.passage.locator.lineStart)–\(evidence.passage.locator.lineEnd)"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(evidence.source.title).font(.headline)
            Text(locator).font(.caption).foregroundStyle(.secondary)
            Text(evidence.passage.text).textSelection(.enabled)
        }.padding(16).jarvisSurface(.accent, radius: 12)
    }
}
