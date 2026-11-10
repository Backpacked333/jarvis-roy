import Foundation
import XCTest
@testable import Jarvis

final class AssistantThreadTests: XCTestCase {
    private func entries(_ state: AssistantState) -> [AssistantThreadEntry] {
        AssistantThread.entries(turns: state.turns, presentations: state.presentations)
    }

    func testReplyTextIsReadInPlaceAndMaterialOpensBeside() throws {
        let entries = entries(try UISnapshotFixtures.richConversation())
        XCTAssertEqual(entries.map(\.id), ["turn_one", "turn_two"])
        XCTAssertEqual(entries[0].replies.map(\.id), ["presentation_answer"])
        XCTAssertEqual(entries[0].material.map(\.id), ["presentation_sources", "presentation_table"])
        XCTAssertFalse(entries[0].awaitingReply)
        XCTAssertFalse(entries[0].streaming)
        XCTAssertNil(AssistantThread.statusLabel(entries[0]))
    }

    func testAnswerStillArrivingIsStreamingNotWaiting() throws {
        let entry = entries(try UISnapshotFixtures.richConversation())[1]
        XCTAssertEqual(entry.replies.first?.content.markdown, UISnapshotFixtures.streamingMarkdown)
        XCTAssertTrue(entry.streaming)
        XCTAssertFalse(entry.awaitingReply)
        XCTAssertNil(AssistantThread.statusLabel(entry))
    }

    func testAcceptedTurnWithNoTextShowsItsRecordedStatus() throws {
        let state = try UISnapshotFixtures.state(sessions: [UISnapshotFixtures.session()], turns: [
            UISnapshotFixtures.turn(id: "dispatching", text: "One", status: "dispatching"),
            UISnapshotFixtures.turn(id: "running", text: "Two", status: "running"),
            UISnapshotFixtures.turn(id: "failed", text: "Three", status: "failed"),
            UISnapshotFixtures.turn(id: "interrupted", text: "Four", status: "interrupted"),
        ], presentations: [UISnapshotFixtures.text(id: "empty", turn: "running", markdown: "")])
        let entries = entries(state)
        XCTAssertEqual(entries.map(\.awaitingReply), [true, true, false, false])
        XCTAssertEqual(entries.map { AssistantThread.statusLabel($0) },
                       ["Starting", "Thinking", "This didn't finish", "Stopped before finishing"])
    }

    func testSurfaceIsHiddenUntilTheSessionHasWorkingMaterial() throws {
        let plain = try UISnapshotFixtures.plainConversation()
        XCTAssertTrue(AssistantThread.material(plain.presentations).isEmpty)
        XCTAssertEqual(AssistantThread.surfaceMode(selected: nil, following: true, hasMaterial: false), .hidden)
        // Following a text reply shows nothing extra: the reply is already in the conversation.
        XCTAssertEqual(AssistantThread.surfaceMode(selected: plain.presentations[0], following: true, hasMaterial: false), .hidden)
    }

    func testSurfaceListsMaterialWhileTheFollowedResultIsTheInlineReply() throws {
        let rich = try UISnapshotFixtures.richConversation()
        let reply = try XCTUnwrap(rich.presentations.first { $0.id == "presentation_streaming" })
        XCTAssertEqual(AssistantThread.material(rich.presentations).map(\.id), ["presentation_sources", "presentation_table"])
        XCTAssertEqual(AssistantThread.surfaceMode(selected: nil, following: true, hasMaterial: true), .overview)
        XCTAssertEqual(AssistantThread.surfaceMode(selected: reply, following: true, hasMaterial: true), .overview)
    }

    func testSurfaceShowsExactlyTheSelectedPresentation() throws {
        let rich = try UISnapshotFixtures.richConversation()
        let table = try XCTUnwrap(rich.presentations.first { $0.id == "presentation_table" })
        let reply = try XCTUnwrap(rich.presentations.first { $0.id == "presentation_answer" })
        XCTAssertEqual(AssistantThread.surfaceMode(selected: table, following: true, hasMaterial: true), .detail)
        XCTAssertEqual(AssistantThread.surfaceMode(selected: table, following: false, hasMaterial: true), .detail)
        // A reply opened beside the conversation is a held revision, so it is shown even in a plain session.
        XCTAssertEqual(AssistantThread.surfaceMode(selected: reply, following: false, hasMaterial: false), .detail)
    }

    @MainActor
    func testHeldRevisionAndVisualReferenceBehaveAsBefore() throws {
        let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true },
                                    transport: FixtureVoiceTransport(), microphonePermission: { true })
        let assistant = AssistantModel(voice: voice)
        try assistant.apply(try UISnapshotFixtures.richConversation())
        XCTAssertNil(assistant.selectedPresentation)
        XCTAssertTrue(assistant.followingPresentation)

        assistant.selectPresentation("presentation_table")
        XCTAssertEqual(assistant.selectedPresentationID, "presentation_table")
        XCTAssertFalse(assistant.followingPresentation)
        assistant.selectVisual(.init(kind: .table_cell, row: 1, column: 2))
        XCTAssertEqual(assistant.visualSelection, AssistantVisualSelection(kind: .table_cell, row: 1, column: 2))

        assistant.selectPresentation("presentation_answer")
        XCTAssertNil(assistant.visualSelection)
        XCTAssertTrue(assistant.canGoBack)
        assistant.togglePin("presentation_answer")
        XCTAssertEqual(assistant.visiblePinnedPresentations.map(\.revision), [4])
        assistant.goBack()
        XCTAssertEqual(assistant.selectedPresentationID, "presentation_table")

        assistant.followPresentations()
        XCTAssertTrue(assistant.followingPresentation)
        XCTAssertEqual(assistant.selectedPresentationID, "presentation_streaming")
    }
}

final class ThreadScrollFollowTests: XCTestCase {
    func testFollowsNewContentWhileAtTheLatestMessage() {
        var follow = ThreadScrollFollow()
        XCTAssertFalse(follow.update(offset: 0, contentHeight: 300, viewportHeight: 600), "Content that fits needs no scrolling")
        XCTAssertTrue(follow.update(offset: 0, contentHeight: 900, viewportHeight: 600), "Overflowing content is brought into view")
        XCTAssertFalse(follow.update(offset: -300, contentHeight: 900, viewportHeight: 600))
        // A large block arrives at once; the reader has not moved.
        XCTAssertTrue(follow.update(offset: -300, contentHeight: 1_400, viewportHeight: 600))
        XCTAssertTrue(follow.following)
    }

    func testScrollingBackToReadStopsFollowing() {
        var follow = ThreadScrollFollow()
        _ = follow.update(offset: -300, contentHeight: 900, viewportHeight: 600)
        XCTAssertFalse(follow.update(offset: -120, contentHeight: 900, viewportHeight: 600))
        XCTAssertFalse(follow.following)
        XCTAssertFalse(follow.update(offset: -120, contentHeight: 1_500, viewportHeight: 600), "New text must not pull the reader away")
        XCTAssertFalse(follow.following)
    }

    func testReturningToTheEndResumesFollowing() {
        var follow = ThreadScrollFollow()
        _ = follow.update(offset: -300, contentHeight: 900, viewportHeight: 600)
        _ = follow.update(offset: -100, contentHeight: 900, viewportHeight: 600)
        XCTAssertFalse(follow.following)
        _ = follow.update(offset: -200, contentHeight: 900, viewportHeight: 600)
        XCTAssertFalse(follow.following, "Part way back is still reading")
        _ = follow.update(offset: -280, contentHeight: 900, viewportHeight: 600)
        XCTAssertTrue(follow.following)
    }

    func testSmallMovementsNearTheEndKeepFollowing() {
        var follow = ThreadScrollFollow()
        _ = follow.update(offset: -300, contentHeight: 900, viewportHeight: 600)
        _ = follow.update(offset: -270, contentHeight: 900, viewportHeight: 600)
        XCTAssertTrue(follow.following)
    }

    func testShrinkingContentIsNotMistakenForTheReaderScrolling() {
        var follow = ThreadScrollFollow()
        _ = follow.update(offset: -900, contentHeight: 1_500, viewportHeight: 600)
        // A revision replaced a long answer with a shorter one and the view was clamped.
        _ = follow.update(offset: -200, contentHeight: 800, viewportHeight: 600)
        XCTAssertTrue(follow.following)
    }

    func testJumpToLatestResumesFollowing() {
        var follow = ThreadScrollFollow()
        _ = follow.update(offset: -300, contentHeight: 900, viewportHeight: 600)
        _ = follow.update(offset: 0, contentHeight: 900, viewportHeight: 600)
        XCTAssertFalse(follow.following)
        follow.jumpToLatest()
        XCTAssertTrue(follow.update(offset: 0, contentHeight: 900, viewportHeight: 600))
    }
}
