import Foundation
import XCTest
@testable import Jarvis

/// The deck may only show what is real. These tests pin how each line is derived from app state, and that
/// an absence of data produces an absence of content.
final class HUDDeckTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!

    func testNoStateMeansNothingIsShown() {
        XCTAssertEqual(DeckData.operations(from: nil), [])
        XCTAssertEqual(DeckData.comms(entries: []), [])
        XCTAssertEqual(DeckData.decisions(tasks: [], questions: [], rooms: [], proposals: []), [])
    }

    func testARoomWaitingOnAQuestionReadsAsHeld() throws {
        let fixture = try RoomsFixture.load()
        let operations = DeckData.operations(from: fixture.state, now: RoomsFixture.now)
        XCTAssertEqual(operations.count, 1)
        let room = try XCTUnwrap(operations.first)
        XCTAssertEqual(room.title, "Offline website exercise")
        XCTAssertEqual(room.phase, .held)
        XCTAssertEqual(room.status, "ASKS YOU")
        XCTAssertEqual(room.workers, [.done, .asking, .queued])
        // No tokens have been used, so no token figure is invented.
        XCTAssertNil(room.trailing)
    }

    func testRunProgressIsCompletedWorkersOverAllWorkers() throws {
        var state = try RoomsFixture.load().state
        state.questions = []
        state.runs[0].status = "running"
        state.runs[0].nodes[1].status = "running"
        state.runs[0].nodes[1].operation = "Building the page"
        state.runs[0].usage.inputTokens = 45_000
        state.runs[0].usage.outputTokens = 1_200
        let room = try XCTUnwrap(DeckData.operations(from: state, now: RoomsFixture.now).first)
        XCTAssertEqual(room.phase, .running(progress: 1.0 / 3.0))
        XCTAssertEqual(room.status, "RUNNING")
        XCTAssertEqual(room.workers, [.done, .running, .queued])
        XCTAssertEqual(room.trailing, "46K TOK")
        XCTAssertEqual(room.detail, "Building the page")

        state.runs[0].status = "cancelled"; state.runs[0].cancelConfirmed = false
        XCTAssertEqual(DeckData.operations(from: state, now: RoomsFixture.now).first?.status, "STOP NOT CONFIRMED")
        state.runs[0].cancelConfirmed = true
        XCTAssertEqual(DeckData.operations(from: state, now: RoomsFixture.now).first?.status, "CANCELLED")
        state.runs[0].status = "completed"
        XCTAssertEqual(DeckData.operations(from: state, now: RoomsFixture.now).first?.phase, .finished(ok: true))
    }

    func testAnAcceptedPlanIsReadyButNeverShownAsRunning() throws {
        var state = try RoomsFixture.load().state
        state.runs = []; state.questions = []
        let room = try XCTUnwrap(DeckData.operations(from: state, now: RoomsFixture.now).first)
        XCTAssertEqual(room.phase, .ready)
        XCTAssertEqual(room.status, "ACCEPTED REV 1 · READY")
        XCTAssertEqual(room.trailing, "3 WORKERS")
        XCTAssertEqual(room.workers, [])
        state.plans = []
        XCTAssertEqual(DeckData.operations(from: state, now: RoomsFixture.now).first?.phase, .idle)
    }

    func testCountsAreCompactWithoutRoundingAwayRealUsage() {
        XCTAssertEqual(DeckData.compact(0), "0")
        XCTAssertEqual(DeckData.compact(999), "999")
        XCTAssertEqual(DeckData.compact(1_234), "1.2K")
        XCTAssertEqual(DeckData.compact(46_200), "46K")
        XCTAssertEqual(DeckData.compact(1_260_000), "1.3M")
        XCTAssertEqual(DeckData.compact(-5), "0")
    }

    func testCommsShowsTheLatestExchangesAsSinglePlainLines() throws {
        let state = try UISnapshotFixtures.richConversation()
        let entries = AssistantThread.entries(turns: state.turns, presentations: state.presentations)
        let lines = DeckData.comms(entries: entries, limit: 4, timeZone: utc)
        XCTAssertEqual(lines.map(\.speaker), [.you, .jarvis, .you, .jarvis])
        XCTAssertEqual(lines.first?.time, "09:00:00")
        XCTAssertEqual(lines.first?.text, "What should I use to store notes locally? I want it simple and safe.")
        for line in lines {
            XCTAssertFalse(line.text.contains("\n"))
            XCTAssertFalse(line.text.contains("**"))
            XCTAssertFalse(line.text.hasPrefix("#"))
            XCTAssertLessThanOrEqual(line.text.count, 240)
        }
        XCTAssertEqual(DeckData.comms(entries: entries, limit: 1, timeZone: utc).count, 1)
        XCTAssertEqual(Set(lines.map(\.id)).count, lines.count)
    }

    func testMarkdownIsReducedToItsFirstMeaningfulLine() {
        XCTAssertEqual(DeckData.oneLine("## Short answer\n\nUse **SQLite** in `WAL` mode."), "Short answer")
        XCTAssertEqual(DeckData.oneLine("\n\n- first point\n- second"), "first point")
        XCTAssertEqual(DeckData.oneLine("```sql\nPRAGMA x;\n```\nThen restart."), "PRAGMA x;")
        XCTAssertEqual(DeckData.oneLine(""), "")
        XCTAssertEqual(DeckData.clock("not a date"), "--:--:--")
        XCTAssertEqual(DeckData.clock("2026-11-10T09:04:05.000Z", timeZone: utc), "09:04:05")
    }

    func testDecisionsListApprovalsQuestionsAndVoiceReviews() throws {
        let fixture = try RoomsFixture.load()
        let decisions = DeckData.decisions(tasks: [UISnapshotFixtures.approvalTask()], questions: fixture.state.questions,
                                           rooms: fixture.state.rooms, proposals: [])
        XCTAssertEqual(decisions.map(\.kind), [.approval, .question])
        XCTAssertEqual(decisions[0].title, "Write a note to your Jarvis folder")
        XCTAssertEqual(decisions[0].origin, "Save the storage note")
        XCTAssertEqual(decisions[1].origin, "Offline website exercise")
        XCTAssertEqual(Set(decisions.map(\.id)).count, 2)
    }

    func testTickerAndTopBarStateOnlyWhatIsTrue() throws {
        let fixture = try RoomsFixture.load()
        let operations = DeckData.operations(from: fixture.state, now: RoomsFixture.now)
        let ticker = DeckData.ticker(supervisor: "ready", connected: true, model: "openai/gpt-6-sol-fast", voice: "Voice off", operations: operations, decisions: 2)
        XCTAssertTrue(ticker.contains("SERVICES READY"))
        XCTAssertTrue(ticker.contains("AGENT CONNECTED"))
        XCTAssertTrue(ticker.contains("MODEL OPENAI/GPT-6-SOL-FAST"))
        XCTAssertTrue(ticker.contains("1 ROOM WAITING ON YOU"))
        XCTAssertTrue(ticker.contains("2 DECISIONS PENDING"))
        XCTAssertFalse(ticker.contains("RUNNING"))
        let quiet = DeckData.ticker(supervisor: "starting", connected: false, model: "Connecting", voice: "Voice off", operations: [], decisions: 0)
        XCTAssertTrue(quiet.contains("AGENT OFFLINE"))
        XCTAssertFalse(quiet.contains("MODEL"))
        XCTAssertFalse(quiet.contains("DECISION"))

        var calendar = Calendar(identifier: .iso8601); calendar.timeZone = utc
        XCTAssertEqual(DeckData.dateLine(Date(timeIntervalSince1970: 1_794_217_602), calendar: calendar), "MON 09 NOV 2026 · W46")
        XCTAssertEqual(DeckData.elapsed(6_130), "01:42:10")
        XCTAssertEqual(DeckData.elapsed(-4), "00:00:00")
        XCTAssertEqual(DeckData.firstName("Roy Salman"), "ROY")
        XCTAssertNil(DeckData.firstName("  "))
        let parts = HUDTopBar.clockParts(Date(timeIntervalSince1970: 1_794_217_602), timeZone: utc)
        XCTAssertEqual(parts.minutes + parts.seconds, "09:46:42")
    }
}
