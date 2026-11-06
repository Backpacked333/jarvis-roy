import Combine
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @Published var tab: WorkspaceTab = .workspace
    @Published var tasks: [AgentTask] = []
    @Published var conversations: [Conversation] = []
    @Published var memories: [MemoryEntry] = []
    @Published private(set) var selectedConversationID: String?
    @Published var selectedTaskID: String?
    @Published private var drafts: [String: String] = [:]
    @Published private var voiceReviews: [String: [String]] = [:]
    @Published private var manualTranscripts: [String: String] = [:]
    @Published private(set) var voiceNotice: String?
    @Published var isConnected = false
    @Published private var submitting: Set<String> = []
    @Published var pendingActions: Set<String> = []
    @Published var error: String?
    @Published var connectionError: String?
    @Published var capabilityState: CapabilityState?
    @Published var capabilityError: String?
    @Published var modelName = "Connecting"
    @AppStorage("speakReplies") var speakReplies = true
    let voice: VoiceController
    private let client: any RuntimeServing
    private var spokenTasks: Set<String> = []
    private var didLoad = false
    private var isRefreshing = false
    private var voiceOwner: String?
    private var selectionRevision = 0
    private var transcriptSubscription: AnyCancellable?

    init(client: (any RuntimeServing)? = nil) {
        self.client = client ?? RuntimeClient()
        self.voice = VoiceController()
        voice.onCommand = { [weak self] text in self?.receiveVoiceCommand(text) }
        transcriptSubscription = voice.$transcript.sink { [weak self] text in
            guard let self, let owner = self.voiceOwner, !self.voice.wakeWordEnabled, !text.isEmpty else { return }
            self.manualTranscripts[owner] = text
        }
    }

    var draft: String {
        get { selectedConversationID.flatMap { drafts[$0] } ?? "" }
        set { if let id = selectedConversationID { drafts[id] = newValue } }
    }
    var voiceReview: String {
        guard let id = selectedConversationID else { return "" }
        return ((voiceReviews[id] ?? []) + [manualTranscripts[id] ?? ""]).filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
    var selectedConversation: Conversation? { conversations.first { $0.id == selectedConversationID } }
    var conversationTasks: [AgentTask] { tasks.filter { $0.conversationId == selectedConversationID } }
    var selectedTask: AgentTask? { conversationTasks.first { $0.id == selectedTaskID } }
    var activeCount: Int { tasks.filter(\.canCancel).count }
    var approvalCount: Int { tasks.reduce(0) { $0 + $1.approvals.count } }
    var isSubmitting: Bool { selectedConversationID.map { submitting.contains($0) } ?? false }
    var sendBlockReason: String? {
        guard let id = selectedConversationID else { return "Create or select a conversation first." }
        if !isConnected { return "The local agent is offline. Your draft stays here." }
        if submitting.contains(id) { return "Submitting this turn…" }
        if conversationTasks.contains(where: \.canCancel) {
            return "This thread has active or unconfirmed work. Resolve approvals or confirm cancellation before sending. Other threads remain available."
        }
        if activeCount >= 4 { return "Four threads have active or unconfirmed work. Finish or cancel one first." }
        return nil
    }
    var canSend: Bool { sendBlockReason == nil && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.count <= 8000 }

    func selectConversation(_ id: String) {
        guard conversations.contains(where: { $0.id == id }), id != selectedConversationID else { return }
        if voiceOwner != nil {
            voice.stopListening()
            voiceNotice = "Microphone muted on thread switch. Captured text remains in its original thread for review; enable listening again here when ready."
        }
        voice.stopSpeaking()
        voiceOwner = nil
        selectionRevision += 1
        selectedConversationID = id
        selectedTaskID = nil
        tab = .workspace
    }

    func newConversation() async {
        guard !pendingActions.contains("new-conversation") else { return }
        pendingActions.insert("new-conversation")
        defer { pendingActions.remove("new-conversation") }
        do {
            let data = try await client.request("v1/conversations", method: "POST", body: [:])
            let conversation = try JSONDecoder().decode(Conversation.self, from: data)
            conversations.insert(conversation, at: 0)
            selectConversation(conversation.id)
        } catch { self.error = error.localizedDescription }
    }

    func observe() async {
        while !Task.isCancelled {
            await refresh()
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
        }
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let state = try await client.state()
            guard !Task.isCancelled else { return }
            isConnected = state.ready
            connectionError = state.error
            modelName = state.model
            tasks = state.tasks.sorted { $0.createdAt > $1.createdAt }
            conversations = state.conversations.sorted { $0.updatedAt > $1.updatedAt }
            memories = state.memories
            if !didLoad {
                spokenTasks.formUnion(tasks.map(\.id))
                didLoad = true
                if let first = conversations.first { selectConversation(first.id) }
            }
            for task in tasks where task.status == "completed" && !spokenTasks.contains(task.id) {
                spokenTasks.insert(task.id)
                if speakReplies, task.conversationId == selectedConversationID { voice.speak(task.reply) }
            }
        } catch {
            guard !Task.isCancelled else { return }
            isConnected = false
            connectionError = error.localizedDescription
        }
        do {
            capabilityState = try await client.capabilities()
            capabilityError = nil
        } catch {
            capabilityState = nil
            capabilityError = error.localizedDescription
        }
    }

    func send() async {
        guard let id = selectedConversationID else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.lowercased().trimmingCharacters(in: .punctuationCharacters) == "stop all" {
            await stopAll()
            return
        }
        guard canSend else { return }
        await submit(text, conversationID: id, fromVoice: false)
    }

    private func submit(_ text: String, conversationID: String, fromVoice: Bool) async {
        guard !submitting.contains(conversationID) else { return }
        submitting.insert(conversationID)
        voice.stopSpeaking()
        defer { submitting.remove(conversationID) }
        do {
            let data = try await client.request("v1/tasks", method: "POST", body: ["message": text, "conversationId": conversationID])
            let task = try JSONDecoder().decode(AgentTask.self, from: data)
            if !tasks.contains(where: { $0.id == task.id }) { tasks.insert(task, at: 0) }
            if selectedConversationID == conversationID { selectedTaskID = task.id }
            if fromVoice {
                if voiceReviews[conversationID]?.first == text { voiceReviews[conversationID]?.removeFirst() }
            } else if drafts[conversationID]?.trimmingCharacters(in: .whitespacesAndNewlines) == text {
                drafts[conversationID] = nil
            }
            error = nil
            await refresh()
        } catch {
            self.error = "Turn was not confirmed. Text is retained in its original thread. Refresh and check Activity before retrying. \(error.localizedDescription)"
        }
    }

    func setWakeEnabled(_ enabled: Bool) async {
        if enabled {
            guard prepareVoiceCapture() else { return }
            voiceNotice = "Say Hey Jarvis at the start of an utterance. Commands send only when this thread is idle and the draft is empty. Spoken yes is never approval."
        }
        await voice.setWakeWordEnabled(enabled)
    }

    func startManualListening() async {
        guard prepareVoiceCapture() else { return }
        if let id = voiceOwner, let prior = manualTranscripts.removeValue(forKey: id), !prior.isEmpty {
            voiceReviews[id, default: []].append(prior)
        }
        voiceNotice = "Manual transcript stays here for review. Use Add to draft, then Send."
        await voice.startListening()
    }

    func receiveVoiceCommand(_ text: String) {
        guard let owner = voiceOwner, !text.isEmpty else { return }
        let hasReview = !(voiceReviews[owner] ?? []).isEmpty || !(manualTranscripts[owner] ?? "").isEmpty
        voiceReviews[owner, default: []].append(text)
        let revision = selectionRevision
        if text.lowercased().trimmingCharacters(in: .punctuationCharacters) == "stop all" {
            voice.stopListening()
            voice.stopSpeaking()
            selectionRevision += 1
            Task { await stopAll() }
            return
        }
        guard owner == selectedConversationID, sendBlockReason == nil, draft.isEmpty, !hasReview, text.count <= 8000 else {
            voiceNotice = "Voice text retained for review: \(sendBlockReason ?? "finish the existing draft first"). Nothing was sent."
            return
        }
        Task {
            guard revision == selectionRevision, owner == selectedConversationID,
                  sendBlockReason == nil, draft.isEmpty else {
                voiceNotice = "Voice text retained in its original thread because selection or readiness changed. Nothing was sent."
                return
            }
            if text.lowercased().trimmingCharacters(in: .punctuationCharacters) == "stop all" {
                await stopAll()
                return
            }
            await submit(text, conversationID: owner, fromVoice: true)
        }
    }

    func useVoiceReview() {
        guard let id = selectedConversationID, !voiceReview.isEmpty else { return }
        let text = voiceReview
        voice.stopListening()
        draft += draft.isEmpty ? text : "\n\(text)"
        voiceReviews[id] = nil
        manualTranscripts[id] = nil
    }

    func prepareVoiceCapture() -> Bool {
        guard let id = selectedConversationID else {
            voiceNotice = "Select a conversation before starting the microphone."
            return false
        }
        voiceOwner = id
        return true
    }

    func act(key: String, path: String, method: String = "POST", body: [String: String]? = nil) async {
        guard !pendingActions.contains(key) else { return }
        pendingActions.insert(key)
        defer { pendingActions.remove(key) }
        do {
            _ = try await client.request(path, method: method, body: body)
            error = nil
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    func stopAll() async {
        voice.stopListening()
        voice.stopSpeaking()
        selectionRevision += 1
        await act(key: "stop-all", path: "v1/stop")
    }
}
