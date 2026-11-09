import AppKit
import Combine
import CoreGraphics
import CryptoKit
import Foundation

@MainActor
final class AssistantModel: ObservableObject {
    @Published private(set) var sessions: [AssistantSession] = []
    @Published private(set) var turns: [AssistantTurn] = []
    @Published private(set) var presentations: [AssistantPresentation] = []
    @Published private(set) var proposals: [AssistantProposal] = []
    @Published private(set) var selectedSessionID: String?
    @Published private var navigation = PresentationNavigation()
    @Published private(set) var visualSelection: AssistantVisualSelection?
    @Published private(set) var pinned: Set<String> = []
    @Published private(set) var connected = false
    @Published private(set) var submitting = false
    @Published var error: String?
    @Published private var sessionDrafts = AssistantSessionDrafts()
    @Published var notice: String?
    @Published var intent = "continue"
    private var foreground = false
    private var narrationMuted = false
    let client: AssistantClient
    private let voice: VoiceController
    private var eventTask: Task<Void, Never>?
    private var sequence = 0
    private var sentenceStreams: [String: AssistantSentenceStream] = [:]
    private var spokenTurns: Set<String> = []
    private var speechTurnID: String?
    private let nativeSessionID = UUID().uuidString
    private var activeReadback: String?
    private var challengeReadback: String?
    private var activeProposalID: String?
    private var activeSubmission: (text: String, checkpoint: AssistantDraftCheckpoint)?
    private var captureBindings: [String: CaptureBinding] = [:]
    private struct CaptureBinding {
        let sessionID: String, revision: Int, focus: AssistantFocus
        let presentationID: String?, presentationRevision: Int?
        let selection: AssistantVisualSelection?
        let proposalID: String?, startedAt: String
    }
    var enabled: Bool { AssistantFeatures.assistant }
    var draft: String {
        get { selectedSessionID.map { sessionDrafts.text(for: $0) } ?? "" }
        set { if let sessionID = selectedSessionID { sessionDrafts.edit(newValue, for: sessionID) } }
    }
    var selectedSession: AssistantSession? { sessions.first { $0.id == selectedSessionID } }
    var visiblePresentations: [AssistantPresentation] { presentations.filter { $0.sessionId == selectedSessionID } }
    var selectedPresentationID: String? { navigation.current?.id }
    var selectedPresentation: AssistantPresentation? { navigation.current }
    var followingPresentation: Bool { navigation.following }
    var hasPresentationUpdate: Bool {
        guard let selected = selectedPresentation else { return false }
        return visiblePresentations.contains { $0.id == selected.id && $0.revision > selected.revision }
    }
    var visibleTurns: [AssistantTurn] { turns.filter { $0.sessionId == selectedSessionID } }
    var visibleProposals: [AssistantProposal] { proposals.filter { $0.sessionId == selectedSessionID && !["completed", "invalidated"].contains($0.status) } }
    var canGoBack: Bool { navigation.canGoBack }

    init(voice: VoiceController, client: AssistantClient? = nil) {
        self.voice = voice; self.client = client ?? AssistantClient()
    }

    func start() {
        guard enabled, eventTask == nil else { return }
        voice.continuousConnectionEnabled = true
        eventTask = Task { [weak self] in
            var delay = 1
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    try await self.reload()
                    self.connected = true; self.error = nil; delay = 1
                    try await self.client.events(after: self.sequence) { [weak self] event in await self?.receive(event) }
                    self.connected = false
                } catch {
                    if Task.isCancelled { return }
                    self.connected = false; self.error = error.localizedDescription
                }
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                delay = min(15, delay * 2)
            }
        }
    }

    func setForeground(_ active: Bool) {
        if foreground, !active { muteNarration(); voice.stopSpeaking(); Task { await invalidateVoiceReview() } }
        foreground = active
    }

    func muteNarration() { narrationMuted = true }

    func stop() {
        eventTask?.cancel(); eventTask = nil; connected = false
        Task { await invalidateVoiceReview() }
    }

    func reload() async throws {
        let state = try await client.value(AssistantState.self, path: "/v1/assistant/state", maximum: 24 * 1_024 * 1_024)
        guard state.version == 1, state.sequence >= 0,
              state.sessions.allSatisfy({ $0.version == 1 }), state.turns.allSatisfy({ $0.version == 1 }),
              state.presentations.allSatisfy({ $0.version == 1 }), state.proposals.allSatisfy({ $0.version == 1 }) else { throw AssistantClientError.invalidResponse }
        sessions = state.sessions; turns = state.turns; presentations = state.presentations; proposals = state.proposals
        sequence = state.sequence
        // Reconnect never replays old speech or resumes an authorization window.
        spokenTurns.formUnion(state.turns.map(\.id))
        if selectedSessionID == nil { selectedSessionID = sessions.last?.id }
    }

    func open(focus: AssistantFocus, title: String) async {
        guard enabled else { error = AssistantClientError.disabled.localizedDescription; return }
        do {
            if let prior = sessions.last(where: { $0.focus == focus }) { selectSession(prior.id); return }
            let result = try await client.value(AssistantSession.self, path: "/v1/assistant/sessions", method: "POST",
                body: ["title": String(title.prefix(120)), "focus": try focus.assistantJSONObject()])
            guard result.version == 1 else { throw AssistantClientError.invalidResponse }
            upsert(result, in: &sessions); selectSession(result.id)
        } catch { self.error = error.localizedDescription }
    }

    func selectSession(_ id: String) {
        guard sessions.contains(where: { $0.id == id }) else { return }
        if selectedSessionID != id {
            voice.stopListening(); Task { await invalidateVoiceReview() }
            selectedSessionID = id; navigation.reset(); visualSelection = nil; speechTurnID = nil
        }
    }

    func selectPresentation(_ id: String) {
        guard let value = visiblePresentations.first(where: { $0.id == id }) else { return }
        navigation.select(value); visualSelection = nil
    }
    func goBack() { navigation.back(); visualSelection = nil }
    func followPresentations() { navigation.follow(visiblePresentations.last); visualSelection = nil }
    func showPresentationUpdate() { if let id = selectedPresentationID { selectPresentation(id) } }
    func selectVisual(_ selection: AssistantVisualSelection?) { visualSelection = selection }

    func saveDraft(_ presentation: AssistantPresentation, body: String) async -> Bool {
        guard presentation.content.kind == .draft, body.utf16.count <= 32_000 else { return false }
        do {
            let updated = try await client.value(AssistantPresentation.self,
                path: "/v1/assistant/presentations/\(presentation.id)", method: "PATCH",
                body: ["expectedRevision": presentation.revision, "body": body])
            guard updated.version == 1, updated.id == presentation.id, updated.sessionId == presentation.sessionId,
                  updated.revision > presentation.revision, updated.content.kind == .draft else { throw AssistantClientError.invalidResponse }
            upsert(updated, in: &presentations)
            if selectedPresentationID == presentation.id, selectedPresentation?.revision == presentation.revision {
                navigation.select(updated); visualSelection = nil
            }
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func togglePin(_ id: String) { if pinned.contains(id) { pinned.remove(id) } else { pinned.insert(id) } }

    func captureStarted(voiceSessionID: String, generation: Int) {
        guard let session = selectedSession else { return }
        if let prior = speechTurnID {
            spokenTurns.insert(prior); sentenceStreams.removeValue(forKey: prior); speechTurnID = nil
        }
        narrationMuted = false
        let proposal = proposals.first { $0.id == activeProposalID && $0.status == "awaiting_confirmation" }
        captureBindings["\(voiceSessionID):\(generation)"] = CaptureBinding(sessionID: session.id, revision: session.revision,
            focus: session.focus, presentationID: selectedPresentation?.id, presentationRevision: selectedPresentation?.revision, selection: visualSelection,
            proposalID: proposal?.id, startedAt: Self.timestamp())
        if captureBindings.count > 128 { captureBindings = [:]; notice = "Voice capture history reset. Start a fresh turn." }
    }

    func retainInterruptedDictation(_ utterance: HarnessVoiceUtterance) {
        guard let binding = captureBindings.removeValue(forKey: "\(utterance.sessionId):\(utterance.generation)"), binding.proposalID == nil else { return }
        sessionDrafts.retain(utterance.text, for: binding.sessionID)
        notice = "Completed dictation segments were retained in their original session's draft. The interrupted audio was not submitted."
    }

    func receiveUtterance(_ utterance: HarnessVoiceUtterance) async -> Bool {
        guard let binding = captureBindings.removeValue(forKey: "\(utterance.sessionId):\(utterance.generation)") else { return false }
        if let proposalID = binding.proposalID {
            await confirmCapturedSpeech(proposalID: proposalID, text: utterance.text, captureStartedAt: binding.startedAt)
            return true
        }
        let text = utterance.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let command = text.lowercased().trimmingCharacters(in: .punctuationCharacters)
        if ["i'm still thinking", "i’m still thinking", "im still thinking", "give me a moment"].contains(command) {
            guard selectedSessionID == binding.sessionID, selectedSession?.focus == binding.focus else {
                notice = "Selection changed. Start a fresh capture in the intended session."; return true
            }
            await voice.startListening(); voice.holdConversationPause(); return true
        }
        if ["stop talking", "stop speaking", "be quiet"].contains(command) {
            muteNarration(); voice.stopSpeaking(); notice = "Speech stopped. Background work continues."; return true
        }
        let route: String
        if ["cancel this task", "cancel that task", "stop this task"].contains(command) { route = "stop_work" }
        else if command.hasPrefix("change the goal") || command.hasPrefix("change the task") ||
                    (command.hasPrefix("i meant") && turns.contains(where: { $0.sessionId == binding.sessionID && !$0.isSettled })) { route = "redirect_work" }
        else if command.hasPrefix("keep working") || turns.contains(where: { $0.sessionId == binding.sessionID && !$0.isSettled }) { route = "side_question" }
        else { route = "continue" }
        _ = await submit(text, sessionID: binding.sessionID, revision: binding.revision, intent: route,
                     presentationID: binding.presentationID, presentationRevision: binding.presentationRevision, selection: binding.selection)
        return true
    }

    func sendDraft() async {
        guard let session = selectedSession else { return }
        let submitted = draft
        _ = await submit(submitted, sessionID: session.id, revision: session.revision, intent: intent,
                     presentationID: selectedPresentation?.id, presentationRevision: selectedPresentation?.revision, selection: visualSelection)
    }

    func prepareDailyBriefing(projectID: String) async -> Bool {
        guard enabled, AssistantFeatures.knowledge else { return false }
        do {
            struct Grants: Decodable { let grants: [KnowledgeGrant] }
            let project = projectID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
            let grants = try await client.value(Grants.self, path: "/v1/grants?projectId=\(project)").grants
            guard grants.contains(where: { grant in
                grant.projectId == projectID && grant.allowsCloudUse(at: Date())
            }) else { return false }
            let state = try await client.value(AssistantState.self, path: "/v1/assistant/state", maximum: 24 * 1_024 * 1_024)
            guard state.version == 1, let existing = state.sessions.last(where: { $0.focus.projectID == projectID }) else { return false }
            let session = try await client.value(AssistantSession.self, path: "/v1/assistant/sessions", method: "POST",
                body: ["title": "Daily brief", "focus": try existing.focus.assistantJSONObject()])
            let turn = try await client.value(AssistantTurn.self, path: "/v1/assistant/sessions/\(session.id)/turns", method: "POST", body: [
                "expectedRevision": session.revision, "intent": "continue",
                "text": "Prepare a concise daily briefing from this project's currently granted, cloud-allowed sources. Include upcoming events, selected inbox priorities, unresolved work, source references and clearly labeled suggestions. Do not request broader access, send messages, create events, execute commands or start workers. Prepare drafts and suggestions only. Report inaccessible or incomplete sources honestly.",
            ])
            upsert(session, in: &sessions); upsert(turn, in: &turns)
            return true
        } catch { notice = "Daily briefing was not confirmed. Inspect the session before retrying."; return false }
    }

    private func submit(_ text: String, sessionID: String, revision: Int, intent: String,
                        presentationID: String?, presentationRevision: Int?, selection: AssistantVisualSelection?) async -> AssistantSubmissionOutcome {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .ignored }
        guard !submitting else {
            let replaceable = activeSubmission.flatMap { $0.text == $0.checkpoint.text ? $0.checkpoint : nil }
            sessionDrafts.retain(text, for: sessionID, replacingSubmitted: replaceable)
            notice = selectedSessionID == sessionID ?
                "The previous request is still being admitted. Additional turns are separated in this session's draft; review before sending." :
                "The captured turn was retained in its original session's draft."
            return .retained
        }
        let checkpoint = sessionDrafts.checkpoint(for: sessionID)
        activeSubmission = (text, checkpoint)
        let feedbackStarted = ProcessInfo.processInfo.systemUptime
        submitting = true
        if selectedSessionID == sessionID { error = nil }
        RuntimeDiagnostics.shared.elapsed("session_local_feedback", role: "session", since: feedbackStarted)
        defer { submitting = false; activeSubmission = nil }
        do {
            var body: [String: Any] = ["text": text, "expectedRevision": revision, "intent": intent]
            if let id = presentationID, let revision = presentationRevision { body["presentationRef"] = ["presentationId": id, "revision": revision] }
            if let selection { body["selection"] = try selection.assistantJSONObject() }
            let turn = try await client.value(AssistantTurn.self, path: "/v1/assistant/sessions/\(sessionID)/turns", method: "POST", body: body)
            guard turn.version == 1, turn.sessionId == sessionID else { throw AssistantClientError.invalidResponse }
            upsert(turn, in: &turns)
            sessionDrafts.admitted(text, from: checkpoint)
            if selectedSessionID == sessionID, sessionDrafts.text(for: sessionID).isEmpty {
                notice = intent == "side_question" ? "Background work continues while Jarvis answers this question." : nil
            }
            return .admitted
        } catch {
            sessionDrafts.retain(text, for: sessionID)
            if selectedSessionID == sessionID {
                self.error = error.localizedDescription
                notice = "The unconfirmed request is retained in this session's draft, separated from newer text. Inspect the session before retrying."
            }
            return .retained
        }
    }

    private func receive(_ event: AssistantEvent) async {
        guard event.sequence > sequence else { return }
        guard event.sequence == sequence + 1 else {
            do { try await reload() } catch { self.error = error.localizedDescription }
            return
        }
        sequence = event.sequence
        let eventStarted = ProcessInfo.processInfo.systemUptime
        defer { RuntimeDiagnostics.shared.elapsed("session_event_applied", role: "session", since: eventStarted) }
        switch event {
        case .session(_, let value): upsert(value, in: &sessions)
        case .turn(_, let value):
            guard upsert(value, in: &turns) else { return }
            if value.status == "completed", let presentation = presentations.last(where: { $0.turnId == value.id && $0.content.kind == .text }) {
                updateSpeech(presentation, final: true)
            }
        case .presentation(_, let value):
            let oldRevision = presentations.first(where: { $0.id == value.id })?.revision ?? 0
            guard value.revision > oldRevision else { return }
            upsert(value, in: &presentations)
            if value.sessionId == selectedSessionID {
                navigation.select(value, automatic: true)
                if navigation.following { visualSelection = nil }
                updateSpeech(value, final: turns.first(where: { $0.id == value.turnId })?.status == "completed")
            }
        case .proposal(_, let value):
            guard upsert(value, in: &proposals) else { return }
            if value.id == activeProposalID, ["invalidated", "uncertain", "completed"].contains(value.status) {
                activeProposalID = nil; activeReadback = nil; challengeReadback = nil
            }
        }
    }

    private func updateSpeech(_ value: AssistantPresentation, final: Bool) {
        guard foreground, !narrationMuted, value.sessionId == selectedSessionID, value.content.kind == .text,
              voice.cloudConsentGranted, !voice.captureInProgress, !voice.dictationActive, activeProposalID == nil, !spokenTurns.contains(value.turnId),
              let text = value.content.markdown, !text.isEmpty else { return }
        var stream = sentenceStreams[value.turnId] ?? AssistantSentenceStream()
        let next = stream.append(text, final: final)
        sentenceStreams[value.turnId] = stream
        if stream.invalidated {
            if speechTurnID == value.turnId { voice.stopSpeaking() }
            spokenTurns.insert(value.turnId); notice = "The answer was revised. Read the updated version on screen."; return
        }
        if !next.isEmpty {
            if speechTurnID != value.turnId {
                if let previous = speechTurnID { spokenTurns.insert(previous) }
                speechTurnID = value.turnId
                voice.beginSpeechStream(value.turnId, context: value.capturedFocus.voiceContext)
            }
            voice.appendSpeechStream(value.turnId, text: next)
        }
        if final || stream.truncated, speechTurnID == value.turnId { voice.endSpeechStream(value.turnId); spokenTurns.insert(value.turnId) }
    }

    func createVoiceProposal(task: AgentTask, approval: Approval, option: ApprovalOption) async {
        guard AssistantFeatures.voiceApproval, let session = selectedSession,
              let turn = turns.last(where: { $0.taskId == task.id && $0.sessionId == session.id }), let revision = approval.revision else {
            error = "Voice review is available for actions created in this assistant session after enabling it in Settings. The exact action buttons remain available."; return
        }
        do {
            let proposal = try await client.value(AssistantProposal.self, path: "/v1/assistant/sessions/\(session.id)/proposals", method: "POST",
                body: ["turnId": turn.id, "action": ["taskId": task.id, "interactionId": approval.id, "revision": revision, "optionId": option.id]])
            upsert(proposal, in: &proposals)
        } catch { self.error = error.localizedDescription }
    }

    func createPlanVoiceProposal(_ presentation: AssistantPresentation) async {
        guard AssistantFeatures.voiceApproval, let session = selectedSession,
              let roomID = presentation.content.roomId, let planID = presentation.content.planId,
              let revision = presentation.content.planRevision,
              presentation.capturedFocus.kind == .room, presentation.capturedFocus.roomId == roomID,
              ["draft", "accepted"].contains(presentation.content.status ?? "") else {
            error = "Discuss the original room and review its current plan before accepting or starting by voice."; return
        }
        do {
            let proposal = try await client.value(AssistantProposal.self, path: "/v1/assistant/sessions/\(session.id)/proposals", method: "POST", body: [
                "turnId": presentation.turnId,
                "action": ["taskId": roomID, "interactionId": planID, "revision": revision,
                           "optionId": presentation.content.status == "draft" ? "accept_plan" : "start_plan"],
            ])
            upsert(proposal, in: &proposals)
        } catch { self.error = error.localizedDescription }
    }

    func readProposal(_ value: AssistantProposal) async {
        guard AssistantFeatures.voiceApproval, voice.cloudConsentGranted, localSessionAvailable(), value.action.voiceAllowed,
              value.action.reviewText.utf16.count <= 1_200 else {
            error = "Voice review requires an active unlocked session, cloud voice, and an exact review up to 1,200 characters. Longer reviews remain available through the complete on-screen action; nothing is truncated for approval."; return
        }
        await invalidateVoiceReview()
        do {
            activeProposalID = value.id
            let reviewed = try await nativeEvent(value, type: "review_displayed", fields: ["reviewDigest": Self.sha256(value.action.reviewText)])
            upsert(reviewed, in: &proposals)
            guard canContinueVoiceReview(reviewed, status: "reviewed") else { return }
            let receiptID = UUID().uuidString
            let reading = try await nativeEvent(reviewed, type: "readback_started", fields: ["readbackId": receiptID, "reviewDigest": Self.sha256(value.action.reviewText)])
            upsert(reading, in: &proposals)
            guard canContinueVoiceReview(reading, status: "reading") else { return }
            activeReadback = receiptID
            // Disable acoustic answer windows during review; the dedicated
            // confirmation capture opens only after actual native playback drain.
            voice.stopListening()
            voice.speakTracked(reading.action.reviewText, receiptID: receiptID, context: selectedSession?.focus.voiceContext ?? .init())
        } catch { self.error = error.localizedDescription; activeProposalID = nil; activeReadback = nil; challengeReadback = nil }
    }

    func speechDrained(_ receiptID: String) async {
        if receiptID == challengeReadback {
            challengeReadback = nil
            guard let proposal = proposals.first(where: { $0.id == activeProposalID }),
                  canContinueVoiceReview(proposal, status: "awaiting_confirmation") else { await invalidateVoiceReview(); return }
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard canContinueVoiceReview(proposal, status: "awaiting_confirmation"), activeReadback == proposal.readbackId,
                  let expiry = proposal.expiresAt.flatMap(RoomsStateRules.date), expiry > Date() else { return }
            await voice.startConfirmationListening()
            return
        }
        guard receiptID == activeReadback, let proposal = proposals.first(where: { $0.id == activeProposalID }),
              proposal.status == "reading", localSessionAvailable() else { return }
        do {
            let awaiting = try await nativeEvent(proposal, type: "readback_drained", fields: ["readbackId": receiptID])
            upsert(awaiting, in: &proposals)
            guard canContinueVoiceReview(awaiting, status: "awaiting_confirmation"), activeReadback == receiptID else { return }
            notice = "Say exactly: \(awaiting.challenge ?? ""). This confirmation expires shortly."
            let challengeReceipt = UUID().uuidString
            challengeReadback = challengeReceipt
            voice.speakTracked("To authorize this exact action, say: \(awaiting.challenge ?? "").", receiptID: challengeReceipt,
                               context: selectedSession?.focus.voiceContext ?? .init())
        } catch { self.error = error.localizedDescription; await invalidateVoiceReview() }
    }

    private func confirmCapturedSpeech(proposalID: String, text: String, captureStartedAt: String) async {
        guard let proposal = proposals.first(where: { $0.id == proposalID }), let readback = activeReadback else { return }
        do {
            let result = try await nativeEvent(proposal, type: "utterance", fields: ["readbackId": readback, "transcript": text, "captureStartedAt": captureStartedAt])
            upsert(result, in: &proposals); activeProposalID = nil; activeReadback = nil; challengeReadback = nil
            notice = result.status == "completed" ? "The exact reviewed action was submitted. Check its reported result." : "Execution is unconfirmed. Inspect the action before retrying."
        } catch { self.error = error.localizedDescription; await invalidateVoiceReview() }
    }

    func invalidateVoiceReview() async {
        guard let proposal = proposals.first(where: { $0.id == activeProposalID }) else { activeProposalID = nil; activeReadback = nil; challengeReadback = nil; return }
        activeProposalID = nil; activeReadback = nil; challengeReadback = nil
        do { let invalid = try await nativeEvent(proposal, type: "interrupted", fields: [:], requireAvailable: false); upsert(invalid, in: &proposals) }
        catch { notice = "Voice confirmation ended. Refresh before reviewing another action." }
    }

    private func nativeEvent(_ proposal: AssistantProposal, type: String, fields: [String: Any], requireAvailable: Bool = true) async throws -> AssistantProposal {
        let available = localSessionAvailable()
        guard !requireAvailable || available else { throw AssistantClientError.service("Voice authorization requires the active unlocked local session.") }
        var event: [String: Any] = ["type": type, "eventId": UUID().uuidString, "proposalId": proposal.id,
            "proposalRevision": proposal.revision, "digest": proposal.digest, "timestamp": Self.timestamp(), "nativeSessionId": nativeSessionID]
        event.merge(fields) { _, value in value }
        return try await client.value(AssistantProposal.self, path: "/v1/assistant/native-events", method: "POST",
            body: ["event": event, "appActive": NSApp.isActive, "sessionUnlocked": available])
    }
    private func canContinueVoiceReview(_ response: AssistantProposal, status: String) -> Bool {
        localSessionAvailable() && AssistantConfirmationPlayback.permits(response,
            current: proposals.first(where: { $0.id == response.id }), activeProposalID: activeProposalID,
            selectedSessionID: selectedSessionID, status: status)
    }
    private func localSessionAvailable() -> Bool {
        guard NSApp.isActive, let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              session["kCGSessionOnConsoleKey"] as? Bool == true else { return false }
        return session["CGSSessionScreenIsLocked"] as? Bool != true
    }
    private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
    private static func sha256(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
    @discardableResult
    private func upsert<T: AssistantRevisioned>(_ value: T, in values: inout [T]) -> Bool {
        AssistantRevisionMerge.upsert(value, in: &values)
    }
}
