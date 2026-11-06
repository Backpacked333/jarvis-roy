import Combine
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @Published var tab: WorkspaceTab = .rooms {
        didSet { if oldValue != tab { voiceStartGeneration += 1 } }
    }
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
    let rooms: RoomsModel
    private let client: any RuntimeServing
    private var spokenTasks: Set<String> = []
    private var didLoad = false
    private var isRefreshing = false
    private var voiceOwner: String?
    private var selectionRevision = 0
    private var transcriptSubscription: AnyCancellable?
    private var receivedUtterances: [String] = []
    private var observationTask: Task<Void, Never>?
    private var voiceStartGeneration = 0

    init(client: (any RuntimeServing)? = nil, harnessClient: (any HarnessServing)? = nil, voice injectedVoice: VoiceController? = nil) {
        self.client = client ?? RuntimeClient()
        self.voice = injectedVoice ?? VoiceController()
        self.rooms = RoomsModel(client: harnessClient ?? HarnessClient())
        voice.contextProvider = { [weak self] in self?.captureContext ?? HarnessVoiceContext() }
        voice.onUtterance = { [weak self] utterance in Task { await self?.handleUtterance(utterance) } }
        voice.onAudioLevels = { [weak self] levels in self?.rooms.updateAudioLevels(levels) }
        voice.onStateChange = { [weak self] state in self?.rooms.updateVoiceState(state) }
        rooms.onQuestionAttention = { [weak self] notice in
            guard let self, self.voice.cloudConsentGranted, self.rooms.canSpeak(notice),
                  self.voice.state == .idle else { return false }
            self.voice.speak(notice.question.question.prompt, context: notice.context)
            return self.voice.capturedContext == notice.context
        }
        rooms.onQuestionAttentionRevoked = { [weak self] binding in self?.voice.revokeQuestion(binding) }
        rooms.onAttentionNavigation = { [weak self] target in
            guard let self else { return }
            switch target {
            case .question: self.tab = .rooms
            case .approval(let approval): Task { await self.reviewApproval(approval) }
            }
        }
        rooms.updateVoiceState(voice.state)
        transcriptSubscription = voice.$transcript.sink { [weak self] text in
            guard let self, let owner = self.voiceOwner, !self.voice.wakeWordEnabled,
                  !self.voice.handsFreeEnabled, !text.isEmpty,
                  let context = self.voice.capturedContext, context.conversationId == owner,
                  context.roomId == nil, context.question == nil else { return }
            self.manualTranscripts[owner] = text
        }
    }

    var captureContext: HarnessVoiceContext {
        tab == .rooms ? rooms.voiceContext : HarnessVoiceContext(roomId: nil, conversationId: selectedConversationID, question: nil)
    }

    func handleUtterance(_ utterance: HarnessVoiceUtterance) async {
        let key = "\(utterance.sessionId):\(utterance.generation)"
        guard !receivedUtterances.contains(key) else { return }
        receivedUtterances.append(key)
        if receivedUtterances.count > 256 { receivedUtterances.removeFirst() }
        let text = utterance.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.lowercased().trimmingCharacters(in: .punctuationCharacters) == "stop all" { await stopAll(); return }
        if utterance.context.roomId != nil || utterance.context.question != nil {
            await rooms.handleUtterance(utterance)
            return
        }
        guard let owner = utterance.context.conversationId, conversations.contains(where: { $0.id == owner }) else {
            voiceNotice = "No captured conversation target. Nothing was sent."
            return
        }
        voiceOwner = owner
        if voice.wakeWordEnabled || voice.handsFreeEnabled { receiveVoiceCommand(text) }
        else {
            manualTranscripts[owner] = text
            voiceNotice = "Transcript retained in its original conversation for review. Use Add to draft, then Send."
        }
    }

    func speakQuestion(_ question: HarnessQuestion) {
        guard voice.cloudConsentGranted, [.idle, .interrupted].contains(voice.state) else { return }
        voice.speak(question.question.prompt, context: HarnessVoiceContext(roomId: question.target.roomId, conversationId: nil, question: question.binding))
    }

    func reviewApproval(_ approval: HarnessApproval) async {
        await refresh()
        guard let task = tasks.first(where: { $0.id == approval.taskId }),
              task.approvals.contains(where: { $0.id == approval.interactionId && $0.revision == approval.revision }) else {
            error = "That approval changed or expired. Refresh the exact task card; no action was authorized."
            return
        }
        selectConversation(task.conversationId)
        selectedTaskID = task.id
        tab = .workspace
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
        guard conversations.contains(where: { $0.id == id }), id != selectedConversationID || tab != .workspace else { return }
        voiceStartGeneration += 1
        if voiceOwner != nil {
            voiceNotice = "Microphone muted on thread switch. Captured text remains in its original thread for review; enable listening again here when ready."
        }
        voice.stopListening()
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

    func startObserving() {
        guard observationTask == nil else { return }
        rooms.startObserving()
        observationTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                do { try await Task.sleep(for: .seconds(self.rooms.isApplicationActive ? 1 : 15)) } catch { return }
            }
        }
    }

    func setApplicationActive(_ active: Bool) { rooms.setApplicationActive(active) }

    func shutdown() {
        voiceStartGeneration += 1
        observationTask?.cancel()
        observationTask = nil
        rooms.shutdown()
        voice.stopListening()
    }

    func muteVoice() {
        voiceStartGeneration += 1
        rooms.spokenAttentionEnabled = false
        voice.stopListening()
        voiceNotice = "Voice stopped. Read new questions aloud is off; re-enable it in Attention when ready. Notification preferences are unchanged."
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
                if let first = conversations.first {
                    let initialTab = tab
                    selectConversation(first.id)
                    tab = initialTab
                }
            }
            for task in tasks where task.status == "completed" && !spokenTasks.contains(task.id) {
                spokenTasks.insert(task.id)
                if speakReplies, tab == .workspace, voice.cloudConsentGranted,
                   [.idle, .interrupted].contains(voice.state), task.conversationId == selectedConversationID {
                    voice.speak(task.reply, context: HarnessVoiceContext(roomId: nil, conversationId: task.conversationId, question: nil))
                }
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
        if !fromVoice, voice.capturedContext != nil { voice.stopSpeaking() }
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
            voiceNotice = "Say Hey Jarvis, wait for Listening, then speak. Active commands upload to ElevenLabs. Spoken yes is never approval."
        }
        await voice.setWakeWordEnabled(enabled)
    }

    func startManualListening() async {
        guard !pendingActions.contains("voice-start"), !pendingActions.contains("stop-all") else { return }
        guard voice.cloudConsentGranted else {
            voiceNotice = "Allow cloud voice for this session before starting a microphone capture."
            return
        }
        pendingActions.insert("voice-start")
        defer { pendingActions.remove("voice-start") }
        voiceStartGeneration += 1
        let ticket = voiceStartGeneration
        if tab == .rooms {
            if rooms.selectedRoomId == nil {
                guard let policy = rooms.state?.defaultPolicy,
                      await rooms.createRoom(title: "Voice room", description: "A room created for a dictated goal. Rename it after planning.", policy: policy) else {
                    voiceNotice = "A room could not be confirmed for this capture. Nothing was recorded."
                    return
                }
                guard !Task.isCancelled, ticket == voiceStartGeneration, tab == .rooms else {
                    voiceNotice = "The new room was saved, but capture was cancelled. Start listening again explicitly when ready."
                    return
                }
            }
            voiceOwner = nil
            voiceNotice = "Finish sends this room goal for draft authoring, or answers the exact focused clarification. It never starts a run or approves host actions."
            await voice.startListening()
            return
        }
        guard prepareVoiceCapture() else { return }
        if let id = voiceOwner, let prior = manualTranscripts.removeValue(forKey: id), !prior.isEmpty {
            voiceReviews[id, default: []].append(prior)
        }
        voiceNotice = voice.handsFreeEnabled
            ? "Hands-free sends completed speech to this conversation when it is ready. Pending approvals and drafts still block submission."
            : "Manual transcript stays here for review. Use Add to draft, then Send."
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
        if tab == .rooms {
            voiceOwner = nil
            guard rooms.selectedRoomId != nil else { voiceNotice = "Select a room first."; return false }
            return true
        }
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
        muteVoice()
        selectionRevision += 1
        await act(key: "stop-all", path: "v1/stop")
        await rooms.refresh()
    }
}
