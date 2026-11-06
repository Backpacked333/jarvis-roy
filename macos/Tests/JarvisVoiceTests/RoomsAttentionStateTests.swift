import Foundation
import XCTest
@testable import Jarvis

final class RoomsAttentionStateTests: XCTestCase {
    func testQueuedQuestionIsAnImmutableCaptureOfExactContext() throws {
        var question = try RoomsFixture.load().authoringQuestion
        let notice = RoomsQuestionAttention(question: question)
        question.revision += 1
        question.question.prompt = "Changed prompt"
        XCTAssertNotEqual(notice.question, question)
        XCTAssertEqual(notice.context.question, notice.binding)
        XCTAssertEqual(notice.context.roomId, notice.binding.target.roomId)
        XCTAssertNil(notice.context.conversationId)
    }

    func testNotificationLedgerIsOffUntilEnabledAndDoesNotLeakPrivateContent() throws {
        let question = try RoomsFixture.load().authoringQuestion
        let target = RoomsAttentionTarget.question(question.binding)
        var ledger = RoomsNotificationLedger()
        XCTAssertTrue(ledger.reconcile([target], enabled: false).added.isEmpty)
        let notice = try XCTUnwrap(ledger.reconcile([target], enabled: true).added.first)
        XCTAssertEqual(notice.title, "Jarvis needs your attention")
        XCTAssertEqual(notice.body, "Open Jarvis to review a pending item.")
        XCTAssertFalse(notice.identifier.contains(question.id))
        XCTAssertEqual(ledger.target(for: notice.identifier), target)
        XCTAssertNil(ledger.target(for: "unrecognized-notification"))
        XCTAssertTrue(ledger.reconcile([target], enabled: true).added.isEmpty)
    }

    func testNotificationRevisionChangeRevokesOldClickAndNeverRetargets() throws {
        var binding = try RoomsFixture.load().authoringQuestion.binding
        var ledger = RoomsNotificationLedger()
        let old = try XCTUnwrap(ledger.reconcile([.question(binding)], enabled: true).added.first)
        binding.revision += 1
        let changes = ledger.reconcile([.question(binding)], enabled: true)
        XCTAssertEqual(changes.removed, [old.identifier])
        XCTAssertNil(ledger.target(for: old.identifier))
        XCTAssertEqual(changes.added.first?.target, .question(binding))
    }

    func testMuteRemovesNoticesAndUnmuteDoesNotReplayAlreadyAnnouncedItems() throws {
        let target = RoomsAttentionTarget.question(try RoomsFixture.load().authoringQuestion.binding)
        var ledger = RoomsNotificationLedger()
        let first = try XCTUnwrap(ledger.reconcile([target], enabled: true).added.first)
        XCTAssertEqual(ledger.reconcile([target], enabled: false).removed, [first.identifier])
        XCTAssertNil(ledger.target(for: first.identifier))
        XCTAssertTrue(ledger.reconcile([target], enabled: true).added.isEmpty)
    }

    func testNotificationQueueIsBoundedAndApprovalsRemainExactReviewTargets() throws {
        let fixture = try RoomsFixture.load()
        var ledger = RoomsNotificationLedger()
        let targets: [RoomsAttentionTarget] = (0..<80).map { index in
            var binding = fixture.authoringQuestion.binding; binding.questionId = "question_\(index)"
            return .question(binding)
        }
        XCTAssertEqual(ledger.reconcile(targets, enabled: true).added.count, 32)
        XCTAssertEqual(ledger.notices.count, 32)
        XCTAssertEqual(ledger.reconcile([], enabled: true).removed.count, 32)
        let approval = try XCTUnwrap(fixture.state.approvals.first)
        let notice = try XCTUnwrap(ledger.reconcile([.approval(approval)], enabled: true).added.first)
        XCTAssertEqual(ledger.target(for: notice.identifier), .approval(approval))
        ledger.failed(notice.identifier)
        XCTAssertNil(ledger.target(for: notice.identifier))
    }

    func testBackgroundAndDisconnectedPollingAreBounded() {
        XCTAssertEqual(RoomsObservationSchedule.seconds(active: true, connected: true, working: true, failures: 0), 2)
        XCTAssertEqual(RoomsObservationSchedule.seconds(active: true, connected: true, working: false, failures: 0), 6)
        XCTAssertEqual(RoomsObservationSchedule.seconds(active: false, connected: true, working: true, failures: 0), 15)
        XCTAssertEqual(RoomsObservationSchedule.seconds(active: false, connected: false, working: true, failures: 1_000), 30)
    }

    func testGraphConnectionsDescribeActualEdgesNotSequentialDecoration() throws {
        let nodes = try RoomsFixture.load().draft.nodes
        let edges = RoomsGraphEdge.edges(nodes)
        XCTAssertEqual(edges.count, nodes.reduce(0) { $0 + Set($1.dependencies).count })
        XCTAssertFalse(edges.contains { $0.source == "copy" && $0.destination == "build" })
        for edge in edges {
            let node = try XCTUnwrap(nodes.first { $0.id == edge.destination })
            XCTAssertTrue(node.dependencies.contains(edge.source))
            XCTAssertEqual(edge.artifact, node.inputFrom.contains(edge.source))
        }
    }
}
