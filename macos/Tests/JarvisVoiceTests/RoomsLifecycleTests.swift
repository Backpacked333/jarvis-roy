import Foundation
import XCTest
@testable import Jarvis

@MainActor
final class RoomsLifecycleTests: XCTestCase {
    private func make(now: @escaping () -> Date = { RoomsFixture.now }) throws -> (RoomsModel, RoomsTestService) {
        let service = RoomsTestService(try RoomsFixture.load())
        return (RoomsModel(client: service, now: now, selectionStore: nil), service)
    }

    func testMultipleOwnersShareOneLoopAndWorkspaceCannotStopApplicationOwner() async throws {
        let (model, service) = try make()
        model.startObserving(); model.startObserving(); model.startObserving(owner: .workspace)
        for _ in 0..<1_000 { if model.isConnected && !model.isRefreshing { break }; await Task.yield() }
        XCTAssertTrue(model.isConnected)
        XCTAssertEqual(service.stateCalls, 1)
        model.stopObserving(owner: .workspace)
        XCTAssertTrue(model.isObserving)
        model.setApplicationActive(false)
        XCTAssertEqual(model.observationInterval, 15)
        model.stopObserving()
        XCTAssertFalse(model.isObserving)
        model.shutdown()
    }

    func testBackgroundAttentionRequiresConsentAndIdleVoiceAndRetainsExactRoom() async throws {
        let (model, service) = try make()
        var other = service.snapshot.rooms[0]; other.id = "other_room"; service.snapshot.rooms.append(other)
        var spoken: [RoomsQuestionAttention] = []
        model.onQuestionAttention = { spoken.append($0); return true }
        await model.refresh()
        model.selectedRoomId = other.id
        model.setApplicationActive(false)
        model.updateVoiceState(.idle)
        XCTAssertTrue(spoken.isEmpty)
        model.updateVoiceState(.listening); model.spokenAttentionEnabled = true
        XCTAssertTrue(spoken.isEmpty)
        model.updateVoiceState(.speaking)
        XCTAssertTrue(spoken.isEmpty)
        model.updateVoiceState(.idle)
        XCTAssertEqual(spoken.count, 1)
        XCTAssertEqual(spoken.first?.binding, service.snapshot.questions[0].binding)
        XCTAssertEqual(model.selectedRoomId, other.id)
        await model.refresh()
        XCTAssertEqual(spoken.count, 1)
        model.updateAudioLevels(.init(inputRMS: 1, playbackRMS: 1, generation: 1))
        XCTAssertTrue(model.audioHistory.isEmpty)
        model.shutdown()
    }

    func testMuteAndConsentRevocationRevokeOnlyExactSpokenQuestion() async throws {
        let (model, _) = try make()
        var spoken: [RoomsQuestionAttention] = [], revoked: [HarnessQuestionBinding] = []
        model.onQuestionAttention = { spoken.append($0); return true }
        model.onQuestionAttentionRevoked = { revoked.append($0) }
        await model.refresh(); model.updateVoiceState(.idle); model.attentionMuted = true
        model.spokenAttentionEnabled = true
        XCTAssertTrue(spoken.isEmpty)
        model.attentionMuted = false
        let first = try XCTUnwrap(spoken.first)
        XCTAssertTrue(model.canSpeak(first))
        model.spokenAttentionEnabled = false
        XCTAssertEqual(revoked, [first.binding])
        XCTAssertFalse(model.canSpeak(first))
        model.spokenAttentionEnabled = true
        XCTAssertEqual(spoken.count, 1)
        model.shutdown()
    }

    func testExpiryWithoutNewEventRevokesBackgroundAttentionAndQuietRoomsStaySilent() async throws {
        var now = RoomsFixture.now
        let (model, service) = try make(now: { now })
        var spoken: [RoomsQuestionAttention] = [], revoked: [HarnessQuestionBinding] = []
        model.onQuestionAttention = { spoken.append($0); return true }
        model.onQuestionAttentionRevoked = { revoked.append($0) }
        service.snapshot.rooms[0].policy.attention = "quiet"
        await model.refresh(); model.updateVoiceState(.idle); model.spokenAttentionEnabled = true
        XCTAssertTrue(spoken.isEmpty)
        service.snapshot.rooms[0].policy.attention = "normal"
        await model.refresh()
        let first = try XCTUnwrap(spoken.first)
        now = try XCTUnwrap(RoomsStateRules.date(first.question.expiresAt)).addingTimeInterval(1)
        service.batch.events = []; service.batch.nextSequence = service.snapshot.sequence
        await model.pollOnce()
        XCTAssertEqual(revoked, [first.binding])
        XCTAssertFalse(model.isCurrent(first))
        model.shutdown()
    }

    func testNotificationClickRefreshesAndOnlyNavigatesExactQuestionOrApproval() async throws {
        let (model, service) = try make()
        await model.refresh()
        var navigated: [RoomsAttentionTarget] = []
        model.onAttentionNavigation = { navigated.append($0) }
        let binding = service.snapshot.questions[0].binding
        await model.openAttention(.question(binding))
        XCTAssertEqual(navigated, [.question(binding)])
        service.snapshot.questions[0].revision += 1
        await model.openAttention(.question(binding))
        XCTAssertEqual(navigated.count, 1)
        let approval = try XCTUnwrap(service.snapshot.approvals.first)
        await model.openAttention(.approval(approval))
        XCTAssertEqual(navigated.last, .approval(approval))
        XCTAssertTrue(service.textAnswers.isEmpty)
        XCTAssertTrue(service.voiceAnswers.isEmpty)
        XCTAssertTrue(service.starts.isEmpty)
        model.shutdown()
    }

    func testRunCancellationRevokesAttentionEvenBeforeQuestionStatusIsUpdated() async throws {
        let (model, service) = try make()
        var revoked: [HarnessQuestionBinding] = []
        model.onQuestionAttention = { _ in true }
        model.onQuestionAttentionRevoked = { revoked.append($0) }
        await model.refresh(); model.updateVoiceState(.idle); model.spokenAttentionEnabled = true
        let binding = service.snapshot.questions[0].binding
        service.snapshot.runs[0].status = "cancel_requested"
        await model.refresh()
        XCTAssertEqual(revoked, [binding])
        XCTAssertTrue(model.questions.isEmpty)
        let accepted = await model.answer(binding, choiceId: "dark")
        XCTAssertFalse(accepted)
        XCTAssertTrue(service.textAnswers.isEmpty)
        model.shutdown()
    }

    func testAcceptedPlanRerunUsesNewExplicitRequestWithoutEditingOrAcceptingAgain() async throws {
        let (model, service) = try make()
        service.snapshot.worker.available = true
        await model.refresh()
        let plan = service.snapshot.plans[0]
        await model.start(plan); await model.start(plan)
        XCTAssertEqual(service.starts.count, 2)
        XCTAssertNotEqual(service.starts.first?.1.requestId, service.starts.last?.1.requestId)
        XCTAssertEqual(service.starts.first?.1.planDigest, plan.digest)
        XCTAssertEqual(service.acceptCalls, 0)
        XCTAssertTrue(service.authored.isEmpty)
        model.shutdown()
    }
}
