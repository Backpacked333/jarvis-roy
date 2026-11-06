import Foundation
import XCTest
@testable import Jarvis

@MainActor
final class RoomsModelTests: XCTestCase {
    private func make() throws -> (RoomsModel, RoomsTestService) {
        let service = RoomsTestService(try RoomsFixture.load())
        return (RoomsModel(client: service, now: { RoomsFixture.now }, selectionStore: nil), service)
    }

    func testRefreshLoadsRealStateAndRetainsSelectionAcrossUpdates() async throws {
        let (model, service) = try make()
        await model.refresh()
        XCTAssertTrue(model.isConnected)
        XCTAssertEqual(model.selectedRoomId, service.snapshot.rooms[0].id)
        var another = service.snapshot.rooms[0]; another.id = "room_two"; another.title = "Second room"
        service.snapshot.rooms.append(another); service.snapshot.sequence += 1
        await model.refresh()
        model.selectedRoomId = another.id
        await model.refresh()
        XCTAssertEqual(model.selectedRoomId, another.id)
        XCTAssertTrue(model.plans.isEmpty)
        XCTAssertTrue(model.artifacts.isEmpty)
    }

    func testSelectedRoomSurvivesModelRecreationWithoutPersistingTaskStateLocally() async throws {
        let service = RoomsTestService(try RoomsFixture.load())
        var room = service.snapshot.rooms[0]; room.id = "room_two"
        service.snapshot.rooms.append(room)
        let suite = "RoomsTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = RoomsModel(client: service, now: { RoomsFixture.now }, selectionStore: defaults)
        await first.refresh(); first.selectedRoomId = room.id
        let second = RoomsModel(client: service, now: { RoomsFixture.now }, selectionStore: defaults)
        XCTAssertNil(second.state)
        await second.refresh()
        XCTAssertEqual(second.selectedRoomId, room.id)
    }

    func testOlderSnapshotNeverReplacesNewerState() async throws {
        let (model, service) = try make()
        await model.refresh()
        let original = model.state
        service.snapshot.sequence -= 1
        service.snapshot.rooms[0].title = "Stale"
        await model.refresh()
        XCTAssertEqual(model.state, original)
        XCTAssertFalse(model.isConnected)
        XCTAssertTrue(model.error?.contains("older") == true)
    }

    func testLateConcurrentRefreshCannotOverwriteNewerRequest() async throws {
        let (model, service) = try make()
        var continuation: CheckedContinuation<HarnessState, Error>?
        let old = service.snapshot
        service.stateHandler = { try await withCheckedThrowingContinuation { continuation = $0 } }
        let slow = Task { await model.refresh() }
        while continuation == nil { await Task.yield() }
        service.stateHandler = nil
        service.snapshot.sequence += 1; service.snapshot.rooms[0].title = "Newer"
        await model.refresh()
        continuation?.resume(returning: old)
        await slow.value
        XCTAssertEqual(model.selectedRoom?.title, "Newer")
        XCTAssertFalse(model.isRefreshing)
    }

    func testProjectedApprovalsRefreshWithoutKernelEventsAndCompactionResetsCursor() async throws {
        let (model, service) = try make()
        await model.refresh()
        service.batch.nextSequence = service.snapshot.sequence
        service.batch.events = []
        await model.pollOnce()
        XCTAssertEqual(service.stateCalls, 2)
        service.snapshot.sequence += 1
        service.batch.nextSequence = service.snapshot.sequence
        service.batch.events = []
        await model.pollOnce()
        XCTAssertEqual(service.stateCalls, 3)
        await model.pollOnce()
        XCTAssertEqual(service.stateCalls, 4)
        service.batch.resetRequired = true
        service.snapshot.sequence = 1
        await model.pollOnce()
        XCTAssertEqual(model.state?.sequence, 1)
    }

    func testCapturedQuestionTargetsOriginalRoomAfterSelectionSwitch() async throws {
        let (model, service) = try make()
        var another = service.snapshot.rooms[0]; another.id = "room_two"
        service.snapshot.rooms.append(another)
        await model.refresh()
        let question = service.snapshot.questions[0]
        model.focus(question)
        let context = model.voiceContext
        model.selectedRoomId = another.id
        await model.handleUtterance(.init(text: "Dark", context: context, sessionId: "session_one", generation: 1))
        XCTAssertEqual(service.voiceAnswers.count, 1)
        XCTAssertEqual(service.voiceAnswers[0].binding, question.binding)
        XCTAssertTrue(service.authored.isEmpty)
        XCTAssertEqual(model.selectedRoomId, another.id)
    }

    func testVoiceGoalUsesCapturedRoomAndNeverStartsOrAccepts() async throws {
        let (model, service) = try make()
        var another = service.snapshot.rooms[0]; another.id = "room_two"
        service.snapshot.rooms.append(another)
        await model.refresh()
        let context = model.voiceContext
        model.selectedRoomId = another.id
        let utterance = HarnessVoiceUtterance(text: "Build a page", context: context, sessionId: "session", generation: 3)
        await model.handleUtterance(utterance)
        await model.handleUtterance(utterance)
        XCTAssertEqual(service.authored.count, 1)
        XCTAssertEqual(service.authored[0].0, context.roomId)
        XCTAssertEqual(service.authored[0].1.goal, "Build a page")
        XCTAssertEqual(service.acceptCalls, 0)
        XCTAssertTrue(service.starts.isEmpty)
    }

    func testStaleVoiceBindingCannotRetargetAnotherQuestionOrApproval() async throws {
        let (model, service) = try make()
        await model.refresh()
        var binding = service.snapshot.questions[0].binding
        binding.revision += 1
        await model.handleUtterance(.init(text: "yes", context: .init(roomId: binding.target.roomId, conversationId: nil, question: binding), sessionId: "session", generation: 1))
        XCTAssertTrue(service.voiceAnswers.isEmpty)
        XCTAssertTrue(service.authored.isEmpty)
        XCTAssertEqual(model.approvals.count, service.snapshot.approvals.count)
        XCTAssertTrue(model.error?.contains("not redirected") == true)
    }

    func testQuestionFromAnotherCaptureRoomIsRejected() async throws {
        let (model, service) = try make()
        await model.refresh()
        let binding = service.snapshot.questions[0].binding
        await model.handleUtterance(.init(text: "Dark", context: .init(roomId: "wrong_room", conversationId: nil, question: binding), sessionId: "session", generation: 1))
        XCTAssertTrue(service.voiceAnswers.isEmpty)
        XCTAssertTrue(model.error?.contains("context") == true)
    }

    func testExpiredQuestionIsNeverSent() async throws {
        let (model, service) = try make()
        service.snapshot.questions[0].expiresAt = "2026-11-06T17:00:00Z"
        await model.refresh()
        let binding = service.snapshot.questions[0].binding
        let success = await model.answer(binding, choiceId: "dark")
        XCTAssertFalse(success)
        XCTAssertTrue(service.textAnswers.isEmpty)
        XCTAssertTrue(model.questions.isEmpty)
    }

    func testNoRoomVoiceIsNotRedirectedToSelectedRoom() async throws {
        let (model, service) = try make()
        await model.refresh()
        await model.handleUtterance(.init(text: "yes", context: .init(roomId: nil, conversationId: "conversation", question: nil), sessionId: "session", generation: 1))
        XCTAssertTrue(service.authored.isEmpty)
        XCTAssertTrue(service.voiceAnswers.isEmpty)
    }

    func testAnswerStaysPendingUntilServerConfirmsAndDuplicateSubmissionIsBlocked() async throws {
        let (model, service) = try make()
        await model.refresh()
        let question = service.snapshot.questions[0]
        var continuation: CheckedContinuation<HarnessQuestion, Error>?
        service.answerHandler = { _ in try await withCheckedThrowingContinuation { continuation = $0 } }
        let submission = Task { await model.answer(question.binding, choiceId: "dark") }
        while continuation == nil { await Task.yield() }
        XCTAssertEqual(model.questions.first?.status, "pending")
        XCTAssertTrue(model.pendingActions.contains("answer:\(question.id)"))
        let duplicate = await model.answer(question.binding, choiceId: "light")
        XCTAssertFalse(duplicate)
        let result = service.consume(question.binding, text: nil, choice: "dark")
        continuation?.resume(returning: result)
        let confirmed = await submission.value
        XCTAssertTrue(confirmed)
        XCTAssertTrue(model.questions.isEmpty)
        XCTAssertEqual(service.textAnswers.count, 1)
    }

    func testConflictKeepsQuestionPendingAndNeverRetriesAutomatically() async throws {
        let (model, service) = try make()
        await model.refresh()
        service.failure = RoomsError.conflict("Attempt changed")
        let ok = await model.answer(service.snapshot.questions[0].binding, choiceId: "dark")
        XCTAssertFalse(ok)
        XCTAssertEqual(service.textAnswers.count, 1)
        XCTAssertEqual(model.questions.count, 1)
        XCTAssertTrue(model.error?.contains("Attempt changed") == true)
    }

    func testAnswerRequiresAllowedModeAndExactChoice() async throws {
        let (model, service) = try make()
        await model.refresh()
        let binding = service.snapshot.questions[0].binding
        let invalidChoice = await model.answer(binding, choiceId: "unlisted")
        let textWhenChoiceOnly = await model.answer(binding, text: "yes")
        XCTAssertFalse(invalidChoice)
        XCTAssertFalse(textWhenChoiceOnly)
        XCTAssertTrue(service.textAnswers.isEmpty)
    }

    func testAttentionIsOptInOneAtATimeDeduplicatedAndQuietAware() async throws {
        let (model, service) = try make()
        let fixture = try RoomsFixture.load()
        service.snapshot.questions.append(fixture.authoringQuestion)
        await model.refresh()
        model.updateVoiceState(.idle)
        XCTAssertNil(model.nextSpokenQuestion())
        model.spokenAttentionEnabled = true
        model.updateVoiceState(.listening)
        XCTAssertNil(model.nextSpokenQuestion())
        model.updateVoiceState(.idle)
        let first = try XCTUnwrap(model.nextSpokenQuestion())
        XCTAssertNil(model.nextSpokenQuestion())
        await model.refresh()
        XCTAssertNil(model.nextSpokenQuestion())
        model.clearQuestionFocus()
        let second = try XCTUnwrap(model.nextSpokenQuestion())
        XCTAssertNotEqual(first.id, second.id)
        model.clearQuestionFocus()
        XCTAssertNil(model.nextSpokenQuestion())
        service.snapshot.rooms[0].policy.attention = "quiet"
        let quietModel = RoomsModel(client: service, now: { RoomsFixture.now }, selectionStore: nil)
        await quietModel.refresh(); quietModel.updateVoiceState(.idle); quietModel.spokenAttentionEnabled = true
        XCTAssertNil(quietModel.nextSpokenQuestion())
        XCTAssertEqual(quietModel.questions.count, 2)
    }

    func testAudioIsActualClampedBoundedAndDoesNotReviveOnStaleFrames() throws {
        let (model, _) = try make()
        model.updateVoiceState(.listening)
        model.updateAudioLevels(.init(inputRMS: 0.25, playbackRMS: 0, generation: 3))
        XCTAssertEqual(model.audioLevels.inputRMS, 0.25)
        model.updateAudioLevels(.init(inputRMS: 1, playbackRMS: 1, generation: 2))
        XCTAssertEqual(model.audioLevels.inputRMS, 0.25)
        for _ in 0..<70 { model.updateAudioLevels(.init(inputRMS: .nan, playbackRMS: 2, generation: 3)) }
        XCTAssertEqual(model.audioHistory.count, 48)
        XCTAssertEqual(model.audioLevels.inputRMS, 0)
        XCTAssertEqual(model.audioLevels.playbackRMS, 1)
        model.updateVoiceState(.interrupted)
        model.updateAudioLevels(.init(inputRMS: 1, playbackRMS: 1, generation: 3))
        XCTAssertEqual(model.audioLevels.playbackRMS, 0)
        model.updateVoiceState(.connecting)
        model.updateVoiceState(.listening)
        model.updateAudioLevels(.init(inputRMS: 0.3, playbackRMS: 0, generation: 1))
        XCTAssertEqual(model.audioLevels.inputRMS, 0.3)
    }

    func testStartIsSeparateAndUnavailableWorkerFailsClosed() async throws {
        let (model, service) = try make()
        await model.refresh()
        await model.start(service.snapshot.plans[0])
        XCTAssertTrue(service.starts.isEmpty)
        service.snapshot.worker.available = true
        await model.refresh()
        let draft = try RoomsFixture.load().draft
        await model.accept(draft)
        XCTAssertEqual(service.acceptCalls, 1)
        XCTAssertTrue(service.starts.isEmpty)
        await model.start(service.snapshot.plans[0])
        XCTAssertEqual(service.starts.count, 1)
        XCTAssertEqual(service.starts[0].1.planDigest, service.snapshot.plans[0].digest)
    }

    func testUncertainStartRetryUsesSameRequestIDAndControlsBindRevision() async throws {
        let (model, service) = try make()
        service.snapshot.worker.available = true
        await model.refresh()
        service.failure = URLError(.timedOut)
        let plan = service.snapshot.plans[0]
        await model.start(plan); await model.start(plan)
        XCTAssertEqual(service.starts.count, 2)
        XCTAssertEqual(service.starts[0].1.requestId, service.starts[1].1.requestId)
        service.failure = nil
        let run = service.snapshot.runs[0]
        await model.control(run, action: "cancel")
        XCTAssertEqual(service.controls[0].3, run.revision)
        XCTAssertFalse(model.runs[0].cancelConfirmed)
    }

    func testRetryCarriesPriorAttemptAndCannotRetryActiveNode() async throws {
        let (model, service) = try make()
        await model.refresh()
        var node = service.snapshot.runs[0].nodes[0]
        node.status = "running"
        await model.retry(node, run: service.snapshot.runs[0])
        XCTAssertTrue(service.retries.isEmpty)
        node.status = "interrupted"
        await model.retry(node, run: service.snapshot.runs[0])
        XCTAssertEqual(service.retries.first?.3.previousAttemptId, node.attemptId)
    }
}
