import AppKit
import SwiftUI

@MainActor
final class CloudConversationModel: ObservableObject {
    let profileID: String, projectID: String
    @Published private(set) var conversations: [Conversation] = []
    @Published private(set) var selectedID: String?
    @Published private(set) var currentTask: AgentTask?
    @Published private(set) var busy = false
    @Published var error: String?
    @Published private var drafts = AssistantSessionDrafts()
    private var generation = 0
    private var taskIDs: [String: String] = [:]
    init(profileID: String, projectID: String) { self.profileID = profileID; self.projectID = projectID }
    var available: Bool { RuntimeProfiles.shared.cloudProfile?.id == profileID }
    var selected: Conversation? { conversations.first { $0.id == selectedID } }
    var draft: String {
        get { selectedID.map { drafts.text(for: $0) } ?? "" }
        set { if let id = selectedID { drafts.edit(newValue, for: id) } }
    }
    private func value<T: Decodable>(_ type: T.Type, path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        guard available else { throw CloudConnectionFailure.configuration }
        let data = try await PairedCloudConnection.shared.conversationData(path: path, method: method, body: body)
        guard available else { throw CloudConnectionFailure.configuration }
        return try JSONDecoder().decode(type, from: data)
    }
    func select(_ id: String) {
        guard conversations.contains(where: { $0.id == id }) else { return }
        generation += 1; selectedID = id; currentTask = nil
    }
    func refresh() async {
        guard available else { generation += 1; conversations = []; currentTask = nil; return }
        guard !busy else { return }
        generation += 1; let ticket = generation
        do {
            struct List: Decodable { let version: Int, conversations: [Conversation] }
            let result = try await value(List.self, path: "/v1/cloud/conversations?projectId=\(projectID)")
            guard ticket == generation, available else { return }
            guard result.version == 1 else { throw AssistantClientError.invalidResponse }
            conversations = result.conversations
            if selectedID == nil || !conversations.contains(where: { $0.id == selectedID }) { selectedID = conversations.first?.id }
            guard let selectedID else { error = nil; return }
            let conversation = try await value(Conversation.self, path: "/v1/cloud/conversations/\(selectedID)")
            guard ticket == generation, available, conversation.id == selectedID else { return }
            if let index = conversations.firstIndex(where: { $0.id == selectedID }) { conversations[index] = conversation }
            if let taskID = taskIDs[selectedID] ?? conversation.messages.last?.taskId, !taskID.isEmpty {
                let task = try await value(AgentTask.self, path: "/v1/cloud/tasks/\(taskID)")
                guard ticket == generation, available, task.id == taskID, task.conversationId == selectedID else { return }
                currentTask = task
            } else { currentTask = nil }
            error = nil
        } catch { if ticket == generation, available { self.error = error.localizedDescription } }
    }
    func create() async {
        guard !busy, available else { return }
        busy = true; generation += 1; let ticket = generation; defer { busy = false }
        do {
            let conversation = try await value(Conversation.self, path: "/v1/cloud/conversations", method: "POST",
                body: ["title": "Cloud conversation", "projectId": projectID])
            guard available else { return }
            if !conversations.contains(where: { $0.id == conversation.id }) { conversations.insert(conversation, at: 0) }
            if ticket == generation { select(conversation.id) }; error = nil
        } catch { if available { self.error = "Conversation creation was not confirmed. Refresh before creating another. \(error.localizedDescription)" } }
    }
    func send() async {
        guard let id = selectedID, !busy, available, currentTask?.canCancel != true else { return }
        let text = drafts.text(for: id).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= 16_000 else { return }
        let checkpoint = drafts.checkpoint(for: id)
        busy = true; generation += 1; error = nil; defer { busy = false }
        do {
            let task = try await value(AgentTask.self, path: "/v1/cloud/tasks", method: "POST",
                body: ["message": text, "conversationId": id, "projectId": projectID])
            guard task.conversationId == id else { throw AssistantClientError.invalidResponse }
            taskIDs[id] = task.id
            drafts.admitted(checkpoint.text, from: checkpoint)
            if selectedID == id { currentTask = task }
        } catch {
            if available, selectedID == id { self.error = "The request is unconfirmed and remains in this conversation's draft. Refresh before resending. \(error.localizedDescription)" }
        }
    }
    func respond(task: AgentTask, question: Approval, optionID: String? = nil, text: String? = nil) async -> Bool {
        guard !busy, available, question.kind == "question", let revision = question.revision,
              task.conversationId == selectedID, currentTask?.id == task.id,
              currentTask?.questions?.contains(where: { $0.id == question.id && $0.revision == revision && $0.kind == "question" }) == true else { return false }
        if let expiresAt = question.expiresAt, RoomsStateRules.date(expiresAt).map({ $0 > Date() }) != true { return false }
        if let optionID, !question.options.contains(where: { $0.id == optionID }) { return false }
        if let text, question.allowText != true || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.utf16.count > 4_000 { return false }
        guard optionID != nil || text != nil else { return false }
        busy = true; generation += 1; defer { busy = false }
        do {
            var body: [String: Any] = ["interactionId": question.id, "expectedRevision": revision]
            if let optionID { body["optionId"] = optionID }
            if let text { body["text"] = text }
            let result = try await value(AgentTask.self, path: "/v1/cloud/tasks/\(task.id)/respond", method: "POST", body: body)
            guard result.id == task.id, result.conversationId == task.conversationId else { throw AssistantClientError.invalidResponse }
            if selectedID == task.conversationId { currentTask = result; error = nil }
            return true
        } catch { if selectedID == task.conversationId, available { self.error = error.localizedDescription }; return false }
    }
    func openSecureReview() {
        guard let profile = RuntimeProfiles.shared.cloudProfile, profile.id == profileID,
              let origin = try? CloudProfilePolicy.origin(profile.origin),
              let url = URL(string: "/v1/cloud/review", relativeTo: origin)?.absoluteURL else { return }
        NSWorkspace.shared.open(url)
    }
}

@MainActor
struct CloudConversationView: View {
    @StateObject private var model: CloudConversationModel
    @ObservedObject private var profiles = RuntimeProfiles.shared
    @Environment(\.dismiss) private var dismiss
    init(profileID: String, projectID: String) {
        _model = StateObject(wrappedValue: CloudConversationModel(profileID: profileID, projectID: projectID))
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Label("Cloud conversation", systemImage: "cloud").font(.title2)
                    Text("\(profiles.cloudProfile?.label ?? "Disconnected profile") · separate from this Mac's conversation history").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(); Button("Refresh") { Task { await model.refresh() } }.disabled(model.busy)
                Button("Done") { dismiss() }
            }.padding(22)
            Divider()
            if !model.available {
                ContentUnavailableView("Cloud profile changed", systemImage: "cloud.slash", description: Text("Close this conversation and open the intended paired profile. Its private history is not transferred."))
            } else {
                HSplitView {
                    VStack(alignment: .leading, spacing: 12) {
                        Button("New cloud conversation") { Task { await model.create() } }.disabled(model.busy)
                        List(selection: Binding(get: { model.selectedID }, set: { if let id = $0 { model.select(id); Task { await model.refresh() } } })) {
                            ForEach(model.conversations) { conversation in Text(conversation.title).lineLimit(2).tag(conversation.id) }
                        }
                    }.padding(14).frame(minWidth: 200, idealWidth: 230, maxWidth: 300)
                    CloudConversationDetail(model: model).padding(20).frame(minWidth: 450)
                }
            }
        }.frame(width: 960, height: 700)
            .task {
                while !Task.isCancelled {
                    await model.refresh()
                    do { try await Task.sleep(for: .seconds(2)) } catch { return }
                }
            }
    }
}

@MainActor
private struct CloudConversationDetail: View {
    @ObservedObject var model: CloudConversationModel
    private var sendDisabled: Bool {
        model.busy || model.selectedID == nil || model.currentTask?.canCancel == true ||
            model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.draft.utf16.count > 16_000
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let error = model.error { Text(error).font(.callout).foregroundStyle(.orange).textSelection(.enabled) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(model.selected?.messages ?? []) { message in CloudMessageCard(message: message) }
                    if let task = model.currentTask { CloudTaskStatusView(task: task, model: model) }
                    if model.selected == nil {
                        ContentUnavailableView("Start a cloud conversation", systemImage: "cloud", description: Text("Ask a question, discuss project context, or prepare work on your paired cloud."))
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            Text("Typed cloud conversation · model use shares the $10 daily and $300 monthly estimate ceilings. This panel does not upload local files or use the Mac microphone.").font(.caption).foregroundStyle(.secondary)
            HStack(alignment: .bottom) {
                TextField("Ask your cloud assistant…", text: $model.draft, axis: .vertical).id(model.selectedID).lineLimit(2...5)
                    .textFieldStyle(.roundedBorder).disabled(model.selectedID == nil)
                Button("Send") { Task { await model.send() } }.buttonStyle(.jarvisPrimary).disabled(sendDisabled)
            }
        }
    }
}
private struct CloudMessageCard: View {
    let message: ConversationMessage
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(message.role == "user" ? "You" : "Jarvis").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(message.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        }.padding(14).jarvisSurface(.panel, radius: 12)
    }
}
@MainActor
private struct CloudTaskStatusView: View {
    let task: AgentTask
    @ObservedObject var model: CloudConversationModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { if task.isActive { ProgressView().controlSize(.small) }; Text(task.statusLabel).font(.caption).foregroundStyle(.secondary) }
            if let error = task.error { Text(error).font(.callout).foregroundStyle(.orange) }
            ForEach(task.approvals) { approval in
                VStack(alignment: .leading, spacing: 8) {
                    Text(approval.title).font(.headline)
                    Text(approval.detail).textSelection(.enabled)
                    Button("Review with owner passkey") { model.openSecureReview() }
                }.padding(14).jarvisSurface(.warning, radius: 12)
            }
            ForEach(task.questions ?? []) { question in
                CloudQuestionCard(task: task, question: question, model: model).id("\(question.id):\(question.revision ?? 0)")
            }
        }
    }
}

@MainActor
private struct CloudQuestionCard: View {
    let task: AgentTask, question: Approval
    @ObservedObject var model: CloudConversationModel
    @State private var text = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(question.title).font(.headline)
            Text(question.detail).textSelection(.enabled)
            if question.kind == "question", question.revision != nil {
                HStack {
                    ForEach(question.options) { option in
                        Button(option.label) { Task { _ = await model.respond(task: task, question: question, optionID: option.id) } }.disabled(model.busy)
                    }
                }
                if question.allowText == true {
                    HStack {
                        TextField("Answer this question", text: $text, axis: .vertical).lineLimit(1...4)
                        Button("Reply") {
                            let captured = text
                            Task { if await model.respond(task: task, question: question, text: captured), text == captured { text = "" } }
                        }.disabled(model.busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.utf16.count > 4_000)
                    }
                }
            } else { Text("Refresh to inspect this question's current revision.").font(.caption).foregroundStyle(.secondary) }
        }.padding(14).jarvisSurface(.panel, radius: 12)
    }
}
