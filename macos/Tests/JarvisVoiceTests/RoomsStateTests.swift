import Foundation
import XCTest
@testable import Jarvis

final class RoomsStateTests: XCTestCase {
    func testTypedDraftRetainsItsOriginalBindingWhenQuestionChanges() throws {
        var question = try RoomsFixture.load().authoringQuestion
        var draft = RoomsAnswerDraft()
        draft.update("Original answer", question: question)
        let binding = question.binding
        question.revision += 1
        draft.update("Original answer with more text", question: question)
        XCTAssertEqual(draft.binding, binding)
        XCTAssertTrue(draft.isStale(for: question))
        draft.update("", question: question)
        draft.update("Answer after explicit re-review", question: question)
        XCTAssertFalse(draft.isStale(for: question))
        XCTAssertEqual(draft.binding, question.binding)
    }
    func testGraphUsesRealDependencyLayersAndArtifactEdges() throws {
        let fixture = try RoomsFixture.load()
        let layers = try RoomsStateRules.layers(fixture.draft.nodes)
        XCTAssertEqual(layers.map { $0.map(\.id) }, [["copy", "build"], ["verify"]])
    }
    func testGraphRejectsCyclesDuplicatesUnknownAndUnscopedArtifactInputs() throws {
        let nodes = try RoomsFixture.load().draft.nodes
        var cyclic = nodes; cyclic[0].dependencies = ["verify"]
        XCTAssertThrowsError(try RoomsStateRules.layers(cyclic))
        var unknown = nodes; unknown[0].dependencies = ["elsewhere"]
        XCTAssertThrowsError(try RoomsStateRules.layers(unknown))
        var unscoped = nodes; unscoped[0].inputFrom = ["build"]
        XCTAssertThrowsError(try RoomsStateRules.layers(unscoped))
        XCTAssertThrowsError(try RoomsStateRules.layers(nodes + [nodes[0]]))
    }
    func testStateRejectsUnsupportedNestedVersionAndDuplicateIDs() throws {
        var state = try RoomsFixture.load().state
        try RoomsStateRules.validate(state)
        state.plans[0].version = 2
        XCTAssertThrowsError(try RoomsStateRules.validate(state))
        state.plans[0].version = 1
        state.rooms.append(state.rooms[0])
        XCTAssertThrowsError(try RoomsStateRules.validate(state))
    }
    func testQuestionsAreDistinctFromApprovalsAndExpireExactly() throws {
        var question = try RoomsFixture.load().state.questions[0]
        let expiration = try XCTUnwrap(RoomsStateRules.date(question.expiresAt))
        XCTAssertTrue(RoomsStateRules.pending(question, now: expiration.addingTimeInterval(-1)))
        XCTAssertFalse(RoomsStateRules.pending(question, now: expiration))
        question.kind = "approval"
        XCTAssertFalse(RoomsStateRules.pending(question, now: expiration.addingTimeInterval(-1)))
    }
    func testSafePathsAndSourceOnlyPreview() {
        for path in ["../secret", "/etc/passwd", "a//b", "a/./b", "a\\b", "a%2fb", "x:y", "a\0b"] { XCTAssertFalse(RoomsStateRules.safePath(path), path) }
        XCTAssertTrue(RoomsStateRules.safePath("résumé folder/index #1.html"))
        let html = "<script>window.webkit.messageHandlers.secret.postMessage('run')</script>"
        XCTAssertEqual(RoomsStateRules.safePreview(Data(html.utf8)), html)
        XCTAssertNil(RoomsStateRules.safePreview(Data([0, 255, 1])))
        XCTAssertNil(RoomsStateRules.safePreview(Data(repeating: 65, count: 256 * 1_024 + 1)))
    }
}
