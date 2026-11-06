import Foundation
import Combine

@MainActor
final class RoomsModel: ObservableObject {
    @Published var selectedRoomId: String? {
        didSet {
            if oldValue != selectedRoomId { focusedQuestion = nil }
            selectionStore?.set(selectedRoomId, forKey: "jarvis.rooms.selected")
        }
    }
    @Published private(set) var state: HarnessState?
    @Published private(set) var isRefreshing = false
    @Published private(set) var isConnected = false
    @Published private(set) var error: String?
    @Published private(set) var pendingActions = Set<String>()
    @Published private(set) var voiceState: HarnessVoiceState = .unavailable
    @Published private(set) var audioLevels = HarnessAudioLevels(inputRMS: 0, playbackRMS: 0, generation: 0)
    @Published private(set) var audioHistory: [Double] = []
    @Published private(set) var focusedQuestion: HarnessQuestionBinding?
    @Published var spokenAttentionEnabled = false { didSet { reconcileAttention() } }
    @Published var attentionMuted = false { didSet { reconcileAttention() } }
    @Published private(set) var isApplicationActive = true
    @Published private(set) var isObserving = false
    @Published private(set) var queuedQuestionAttention: [RoomsQuestionAttention] = []
    @Published private(set) var attentionNavigation: RoomsAttentionTarget?
    var onQuestionAttention: ((RoomsQuestionAttention) -> Bool)? { didSet { reconcileAttention() } }
    var onQuestionAttentionRevoked: ((HarnessQuestionBinding) -> Void)?
    var onAttentionNavigation: ((RoomsAttentionTarget) -> Void)?
    let notifications: RoomsNotifications
    @Published private(set) var lastVoiceGoal: String?
    @Published private(set) var lastUpdated: Date?

    private let client: any HarnessServing
    private let now: () -> Date
    private let selectionStore: UserDefaults?
    private var refreshGeneration = 0
    private var eventCursor = 0
    private var spoken = Set<String>()
    private var utterances: [String] = []
    private var requestIds: [String: String] = [:]
    private var activeSpokenQuestion: HarnessQuestionBinding?
    private var observationOwners = Set<RoomsObservationOwner>()
    private var observationTask: Task<Void, Never>?
    private var observationGeneration = 0
    private var observationFailures = 0
    private var reconcilingAttention = false
    private var attentionSuspended = false

    init(client: any HarnessServing, now: @escaping () -> Date = Date.init,
         selectionStore: UserDefaults? = .standard, notifications: RoomsNotifications? = nil) {
        self.client = client
        self.now = now
        self.selectionStore = selectionStore
        self.notifications = notifications ?? RoomsNotifications()
        selectedRoomId = selectionStore?.string(forKey: "jarvis.rooms.selected")
        self.notifications.onOpen = { [weak self] target in
            Task { await self?.openAttention(target) }
        }
    }

    var selectedRoom: HarnessRoom? { state?.rooms.first { $0.id == selectedRoomId } }
    var plans: [HarnessPlan] { (state?.plans ?? []).filter { $0.roomId == selectedRoomId }.sorted { $0.createdAt > $1.createdAt } }
    var runs: [HarnessRun] { (state?.runs ?? []).filter { $0.roomId == selectedRoomId }.sorted { $0.createdAt > $1.createdAt } }
    var authorings: [HarnessAuthoring] { (state?.authorings ?? []).filter { $0.roomId == selectedRoomId }.sorted { $0.createdAt > $1.createdAt } }
    var artifacts: [HarnessArtifact] { (state?.artifacts ?? []).filter { $0.roomId == selectedRoomId }.sorted { $0.createdAt > $1.createdAt } }
    var questions: [HarnessQuestion] {
        (state?.questions ?? []).filter { RoomsStateRules.pending($0, now: now()) && isLiveQuestion($0) }
            .sorted { $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt }
    }
    var approvals: [HarnessApproval] { (state?.approvals ?? []).filter { $0.kind == "approval" && $0.status == "pending" } }
    var canMutate: Bool { isConnected && state?.ready == true }
    var hasActiveWork: Bool {
        (state?.runs ?? []).contains { !RoomsStateRules.terminal($0.status) } ||
        (state?.authorings ?? []).contains { ["authoring", "waiting_question"].contains($0.status) }
    }
    var voiceContext: HarnessVoiceContext {
        HarnessVoiceContext(roomId: focusedQuestion?.target.roomId ?? selectedRoomId, conversationId: nil, question: focusedQuestion)
    }

    private func isLiveQuestion(_ question: HarnessQuestion) -> Bool {
        switch question.target {
        case .authoring(let room, let id):
            return state?.authorings.contains { $0.id == id && $0.roomId == room && $0.status == "waiting_question" } == true
        case .node(let room, let runID, let nodeID, let attempt):
            guard let run = state?.runs.first(where: { $0.id == runID && $0.roomId == room }),
                  !RoomsStateRules.terminal(run.status), run.status != "cancel_requested", run.status != "interrupted" else { return false }
            return run.nodes.contains { $0.nodeId == nodeID && $0.attemptId == attempt && $0.status == "waiting_question" }
        }
    }

    func refresh() async { await refresh(reset: false) }

    private func refresh(reset: Bool) async {
        refreshGeneration += 1
        let generation = refreshGeneration
        isRefreshing = true
        defer {
            if generation == refreshGeneration { isRefreshing = false; reconcileAttention() }
        }
        do {
            let snapshot = try await client.state()
            try Task.checkCancellation()
            guard generation == refreshGeneration else { return }
            try RoomsStateRules.validate(snapshot)
            guard reset || snapshot.sequence >= (state?.sequence ?? 0) else {
                throw RoomsError.invalid("An older state response was ignored. Reconnect before issuing new controls.")
            }
            state = snapshot
            eventCursor = snapshot.sequence
            isConnected = true
            lastUpdated = now()
            if !snapshot.rooms.contains(where: { $0.id == selectedRoomId }) {
                selectedRoomId = snapshot.rooms.first(where: { $0.status != "archived" })?.id ?? snapshot.rooms.first?.id
            }
            if let focusedQuestion, !questions.contains(where: { $0.binding == focusedQuestion }) { self.focusedQuestion = nil }
            let validSpeech = Set(questions.map { speechKey($0.binding) })
            spoken.formIntersection(validSpeech)
        } catch is CancellationError { }
        catch {
            guard generation == refreshGeneration else { return }
            isConnected = false
            self.error = error.localizedDescription
        }
    }

    func pollOnce() async {
        defer { reconcileAttention() }
        guard state != nil else { await refresh(); return }
        do {
            let cursor = eventCursor
            let batch = try await client.events(after: cursor, roomId: nil)
            try Task.checkCancellation()
            guard batch.version == 1, batch.events.count <= 1_000,
                  batch.events.allSatisfy({ $0.version == 1 && $0.sequence <= batch.nextSequence }) else {
                throw RoomsError.invalidResponse
            }
            if batch.resetRequired || batch.nextSequence < cursor { await refresh(reset: true); return }
            // Root Eve approval cards are projected outside the kernel event sequence.
            await refresh()
        } catch is CancellationError { }
        catch { isConnected = false; self.error = error.localizedDescription }
    }

    var observationInterval: Int {
        RoomsObservationSchedule.seconds(active: isApplicationActive, connected: isConnected,
                                         working: hasActiveWork, failures: observationFailures)
    }

    func startObserving(owner: RoomsObservationOwner = .application) {
        attentionSuspended = false
        observationOwners.insert(owner)
        guard observationTask == nil else { return }
        observationGeneration += 1
        let generation = observationGeneration
        isObserving = true
        observationTask = Task { [weak self] in
            await self?.refresh()
            while !Task.isCancelled {
                guard let seconds = self?.observationInterval else { return }
                do { try await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000) }
                catch { return }
                guard self?.observationGeneration == generation else { return }
                await self?.pollOnce()
                self?.recordObservationResult()
            }
        }
    }

    private func recordObservationResult() {
        observationFailures = isConnected ? 0 : min(4, observationFailures + 1)
    }

    func stopObserving(owner: RoomsObservationOwner = .application) {
        observationOwners.remove(owner)
        guard observationOwners.isEmpty else { return }
        observationGeneration += 1
        observationTask?.cancel()
        observationTask = nil
        isObserving = false
        attentionSuspended = true
        revokeSpokenQuestion()
        notifications.update([], suppressed: true)
    }

    func setApplicationActive(_ active: Bool) {
        guard isApplicationActive != active else { return }
        isApplicationActive = active
        if !active { audioLevels.inputRMS = 0; audioLevels.playbackRMS = 0; audioHistory = [] }
        if active { Task { [weak self] in await self?.refresh() } }
    }

    func shutdown() {
        observationOwners.removeAll()
        stopObserving()
        spokenAttentionEnabled = false
        notifications.disable()
    }

    func clearError() { error = nil }
    func report(_ error: Error) { self.error = error.localizedDescription }
    private func idempotencyKey(_ key: String) throws -> String {
        if let value = requestIds[key] { return value }
        guard requestIds.count < 128 else { throw RoomsError.invalid("Too many unconfirmed requests. Review saved runs and reconnect before creating more work.") }
        let value = UUID().uuidString
        requestIds[key] = value
        return value
    }

    @discardableResult
    private func perform(_ key: String, action: () async throws -> Void) async -> Bool {
        guard canMutate else { error = "The room service is not ready. Reconnect before changing work."; return false }
        guard !pendingActions.contains(key) else { return false }
        pendingActions.insert(key)
        defer { pendingActions.remove(key) }
        do {
            try await action()
            error = nil
            await refresh()
            return true
        } catch {
            self.error = error.localizedDescription
            await refresh()
            return false
        }
    }

    func createRoom(title: String, description: String, policy: HarnessRoomPolicy) async -> Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.count <= 120 else { error = "Give the room a name of 1–120 characters."; return false }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let key = "create:\(title):\(description):\(String(data: (try? encoder.encode(policy)) ?? Data(), encoding: .utf8) ?? "")"
        return await perform("create-room") {
            let room = try await client.createRoom(.init(requestId: idempotencyKey(key), title: title, description: description, policy: policy))
            selectedRoomId = room.id
            requestIds.removeValue(forKey: key)
        }
    }
    func updateRoom(_ room: HarnessRoom, title: String, description: String, status: String, policy: HarnessRoomPolicy) async -> Bool {
        await perform("room:\(room.id)") {
            _ = try await client.updateRoom(room.id, input: .init(expectedRevision: room.revision, title: title, description: description, status: status, policy: policy))
        }
    }
    func authorGoal(_ goal: String, roomId: String? = nil) async -> Bool {
        guard let room = state?.rooms.first(where: { $0.id == (roomId ?? selectedRoomId) }), room.status == "active" else {
            error = "Select an active room before planning."; return false
        }
        let goal = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !goal.isEmpty, goal.count <= 16_000 else { error = "Use a goal between 1 and 16,000 characters."; return false }
        let key = "author:\(room.id):\(room.revision):\(goal)"
        return await perform("author:\(room.id)") {
            _ = try await client.authorPlan(room.id, input: .init(requestId: idempotencyKey(key), expectedRoomRevision: room.revision, goal: goal))
            requestIds.removeValue(forKey: key)
        }
    }
    func cancelAuthoring(_ authoring: HarnessAuthoring) async {
        await perform("authoring:\(authoring.id)") {
            _ = try await client.cancelAuthoring(authoring.roomId, authoringId: authoring.id, revision: authoring.revision)
        }
    }
    func savePlan(_ plan: HarnessPlan, draft: HarnessPlanDraft) async -> Bool {
        await perform("plan:\(plan.id)") {
            guard plan.status == "draft" else { throw RoomsError.invalid("Accepted plans are immutable. Author a new plan.") }
            _ = try RoomsStateRules.layers(draft.nodes)
            _ = try await client.updatePlan(plan.roomId, planId: plan.id, input: .init(expectedRevision: plan.revision, draft: draft))
        }
    }
    func accept(_ plan: HarnessPlan) async {
        await perform("plan:\(plan.id)") {
            guard plan.status == "draft" else { throw RoomsError.invalid("Only a draft can be accepted.") }
            _ = try await client.acceptPlan(plan.roomId, planId: plan.id, revision: plan.revision)
        }
    }
    func start(_ plan: HarnessPlan) async {
        let key = "start:\(plan.id):\(plan.revision):\(plan.digest ?? "")"
        await perform("plan:\(plan.id)") {
            guard plan.status == "accepted", let digest = plan.digest, state?.worker.available == true else {
                throw RoomsError.invalid("Accept a plan and configure a real isolated worker before starting.")
            }
            _ = try await client.startRun(plan.roomId, input: .init(requestId: idempotencyKey(key), planId: plan.id, expectedPlanRevision: plan.revision, planDigest: digest))
            requestIds.removeValue(forKey: key)
        }
    }
    func control(_ run: HarnessRun, action: String) async {
        await perform("run:\(run.id)") {
            _ = try await client.controlRun(run.roomId, runId: run.id, action: action, revision: run.revision)
        }
    }
    func retry(_ node: HarnessNodeState, run: HarnessRun) async {
        await perform("run:\(run.id)") {
            guard let attempt = node.attemptId, ["failed", "interrupted", "cancelled"].contains(node.status) else {
                throw RoomsError.invalid("This node is not eligible for explicit retry.")
            }
            _ = try await client.retryNode(run.roomId, runId: run.id, nodeId: node.nodeId, input: .init(expectedRevision: run.revision, previousAttemptId: attempt))
        }
    }

    func focus(_ question: HarnessQuestion) {
        guard questions.contains(where: { $0.binding == question.binding }) else { error = "This question is no longer pending."; return }
        selectedRoomId = question.target.roomId
        focusedQuestion = question.binding
    }
    func clearQuestionFocus() { focusedQuestion = nil; revokeSpokenQuestion() }
    private func revokeSpokenQuestion() {
        guard let binding = activeSpokenQuestion else { return }
        activeSpokenQuestion = nil
        if focusedQuestion == binding { focusedQuestion = nil }
        onQuestionAttentionRevoked?(binding)
    }

    func isCurrent(_ attention: RoomsQuestionAttention) -> Bool {
        canMutate && questions.contains { $0 == attention.question }
    }

    func canSpeak(_ attention: RoomsQuestionAttention) -> Bool {
        isCurrent(attention) && spokenAttentionEnabled && !attentionMuted && !attentionSuspended && voiceState == .idle &&
        state?.rooms.contains(where: { $0.id == attention.binding.target.roomId && $0.policy.attention != "quiet" && $0.status != "archived" }) == true
    }

    func openAttention(_ target: RoomsAttentionTarget) async {
        await refresh()
        guard canMutate, !isRefreshing else { return }
        switch target {
        case .question(let binding):
            guard let question = questions.first(where: { $0.binding == binding }) else {
                error = "This notification's exact question expired or changed. Nothing was answered or redirected."
                return
            }
            focus(question)
        case .approval(let approval):
            guard approvals.contains(approval) else {
                error = "This notification's exact approval is no longer pending. Nothing was authorized."
                return
            }
        }
        attentionNavigation = target
        onAttentionNavigation?(target)
    }

    func clearAttentionNavigation() { attentionNavigation = nil }

    private func reconcileAttention() {
        guard !reconcilingAttention else { return }
        reconcilingAttention = true
        defer { reconcilingAttention = false }
        let quiet = Set((state?.rooms ?? []).filter { $0.policy.attention == "quiet" || $0.status == "archived" }.map(\.id))
        let eligible = questions.filter { !quiet.contains($0.target.roomId) }
        let queue = Array(eligible.filter { !spoken.contains(speechKey($0.binding)) }.prefix(256)).map { RoomsQuestionAttention(question: $0) }
        if queuedQuestionAttention != queue { queuedQuestionAttention = queue }
        if let binding = activeSpokenQuestion,
           !spokenAttentionEnabled || attentionMuted || !canMutate || !eligible.contains(where: { $0.binding == binding }) {
            revokeSpokenQuestion()
        }
        let targets = eligible.map { RoomsAttentionTarget.question($0.binding) } + approvals
            .filter { $0.roomId.map { !quiet.contains($0) } ?? true }.map { RoomsAttentionTarget.approval($0) }
        notifications.update(targets, suppressed: attentionMuted || attentionSuspended || !canMutate)
        guard let callback = onQuestionAttention, let question = nextSpokenQuestion() else { return }
        let attention = RoomsQuestionAttention(question: question)
        if !callback(attention) {
            spoken.remove(speechKey(attention.binding))
            revokeSpokenQuestion()
        }
    }
    private func speechKey(_ binding: HarnessQuestionBinding) -> String {
        let prefix = "\(binding.questionId):\(binding.revision):\(binding.target.roomId)"
        switch binding.target {
        case .authoring(_, let authoring): return "\(prefix):authoring:\(authoring)"
        case .node(_, let run, let node, let attempt): return "\(prefix):node:\(run):\(node):\(attempt)"
        }
    }
    func nextSpokenQuestion() -> HarnessQuestion? {
        guard spokenAttentionEnabled, !attentionMuted, !attentionSuspended, canMutate, activeSpokenQuestion == nil,
              voiceState == .idle else { return nil }
        let quiet = Set((state?.rooms ?? []).filter { $0.policy.attention == "quiet" || $0.status == "archived" }.map(\.id))
        guard let question = questions.first(where: { !quiet.contains($0.target.roomId) && !spoken.contains(speechKey($0.binding)) }) else { return nil }
        spoken.insert(speechKey(question.binding))
        queuedQuestionAttention.removeAll { $0.binding == question.binding }
        activeSpokenQuestion = question.binding
        focusedQuestion = question.binding
        return question
    }

    private func validateBinding(_ binding: HarnessQuestionBinding) throws -> HarnessQuestion {
        guard let question = questions.first(where: { $0.binding == binding }) else {
            throw RoomsError.conflict("That exact question expired, changed, or was answered. Your answer was not redirected.")
        }
        return question
    }
    private func confirmAnswer(_ answer: HarnessQuestion, binding: HarnessQuestionBinding) throws {
        guard answer.kind == "question", answer.id == binding.questionId, answer.target == binding.target,
              answer.revision >= binding.revision, answer.status == "answered", answer.answer != nil else {
            throw RoomsError.invalidResponse
        }
        if focusedQuestion == binding { focusedQuestion = nil }
        if activeSpokenQuestion == binding { revokeSpokenQuestion() }
    }
    func answer(_ binding: HarnessQuestionBinding, text: String? = nil, choiceId: String? = nil) async -> Bool {
        await perform("answer:\(binding.questionId)") {
            let question = try validateBinding(binding)
            guard (text != nil) != (choiceId != nil), text == nil || question.question.allowText,
                  choiceId == nil || question.question.choices.contains(where: { $0.id == choiceId }) else {
                throw RoomsError.invalid("Use one of this question’s allowed answer modes.")
            }
            if let text, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.count > 16_000 {
                throw RoomsError.invalid("Use an answer between 1 and 16,000 characters.")
            }
            let response = try await client.answerQuestion(.init(binding: binding, source: "text", text: text, choiceId: choiceId))
            try confirmAnswer(response, binding: binding)
        }
    }
    func handleUtterance(_ utterance: HarnessVoiceUtterance) async {
        let text = utterance.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 16_000 else { error = "Voice input was empty or too long."; return }
        let target = utterance.context.question.map { speechKey($0) } ?? utterance.context.roomId ?? utterance.context.conversationId ?? "none"
        let key = "\(utterance.sessionId):\(utterance.generation):\(target):\(text)"
        guard !utterances.contains(key) else { return }
        utterances.append(key)
        if utterances.count > 256 { utterances.removeFirst(utterances.count - 256) }
        if let binding = utterance.context.question {
            guard utterance.context.roomId == binding.target.roomId else { error = "Voice context does not match the captured question."; return }
            await perform("answer:\(binding.questionId)") {
                _ = try validateBinding(binding)
                let response = try await client.answerVoice(.init(binding: binding, transcript: text))
                try confirmAnswer(response, binding: binding)
            }
        } else if let room = utterance.context.roomId {
            lastVoiceGoal = text
            _ = await authorGoal(text, roomId: room)
        } else {
            error = "This utterance belongs to a conversation, not a room. It was not redirected."
        }
    }

    func updateAudioLevels(_ levels: HarnessAudioLevels) {
        guard isApplicationActive else { return }
        guard levels.generation >= audioLevels.generation else { return }
        func clamp(_ value: Double) -> Double { value.isFinite ? min(1, max(0, value)) : 0 }
        let active = [.listening, .speaking].contains(voiceState)
        audioLevels = .init(inputRMS: active ? clamp(levels.inputRMS) : 0,
                            playbackRMS: active ? clamp(levels.playbackRMS) : 0, generation: levels.generation)
        audioHistory.append(max(audioLevels.inputRMS, audioLevels.playbackRMS))
        if audioHistory.count > 48 { audioHistory.removeFirst(audioHistory.count - 48) }
    }
    func updateVoiceState(_ state: HarnessVoiceState) {
        voiceState = state
        if state == .connecting { audioLevels.generation = 0 }
        if ![.speaking, .listening].contains(state) {
            audioLevels.inputRMS = 0; audioLevels.playbackRMS = 0; audioHistory = []
        }
        reconcileAttention()
    }
    func loadArtifact(_ artifact: HarnessArtifact, path: String) async throws -> Data {
        guard let current = state?.artifacts.first(where: { $0.id == artifact.id }), current == artifact else {
            throw RoomsError.conflict("The artifact manifest is no longer available in this state.")
        }
        return try await client.artifactContent(artifact, path: path)
    }
}
