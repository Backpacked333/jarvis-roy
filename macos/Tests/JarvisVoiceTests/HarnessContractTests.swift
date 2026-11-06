import Foundation
import XCTest
@testable import Jarvis

final class HarnessContractTests: XCTestCase {
    private struct Fixture: Decodable {
        var state: HarnessState
        var draft: HarnessPlan
        var authoringQuestion: HarnessQuestion
        var answer: HarnessAnswerRequest
        var events: HarnessEvents
        var voiceServerFrames: [HarnessVoiceServerFrame]
    }
    private func fixtureData() throws -> Data {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return try Data(contentsOf: repo.appendingPathComponent("contracts/fixtures/harness-v1.json"))
    }
    func testSharedStateDecodesAndRoundTripsWithoutLosingNulls() throws {
        let data = try fixtureData()
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        XCTAssertEqual(fixture.state.version, 1)
        XCTAssertEqual(fixture.state.rooms[0].policy.sandbox.network, "none")
        XCTAssertNil(fixture.state.rooms[0].policy.sandbox.image)
        XCTAssertEqual(fixture.state.plans[0].status, "accepted")
        XCTAssertEqual(fixture.draft.status, "draft")
        XCTAssertNil(fixture.draft.digest)
        let original = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let expected = try XCTUnwrap(original["state"] as? NSDictionary)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(fixture.state)) as? NSDictionary
        XCTAssertEqual(encoded, expected)
    }
    func testAnswerKeepsExactBindingAcrossSelectionChanges() throws {
        let fixture = try JSONDecoder().decode(Fixture.self, from: fixtureData())
        XCTAssertEqual(fixture.answer.binding, fixture.state.questions[0].binding)
        XCTAssertEqual(fixture.answer.binding.target, .node(roomId: "room_fixture", runId: "run_fixture", nodeId: "build", attemptId: "attempt_build_1"))
        XCTAssertEqual(fixture.authoringQuestion.target, .authoring(roomId: "room_fixture", authoringId: "authoring_fixture"))
        XCTAssertEqual(fixture.answer.choiceId, "dark")
        XCTAssertEqual(fixture.state.approvals[0].kind, "approval")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(fixture.answer)) as? [String: Any])
        XCTAssertTrue(body["text"] is NSNull)
        XCTAssertEqual(body["source"] as? String, "voice")
    }
    func testVoiceDecodesCapturedContextAndDistinctSampleRates() throws {
        let fixture = try JSONDecoder().decode(Fixture.self, from: fixtureData())
        let transcript = try XCTUnwrap(fixture.voiceServerFrames.first { $0.type == "transcript" })
        XCTAssertEqual(transcript.context?.question, fixture.answer.binding)
        XCTAssertEqual(transcript.generation, 3)
        let audio = try XCTUnwrap(fixture.voiceServerFrames.first { $0.type == "audio" })
        XCTAssertEqual(audio.sampleRate, 24_000)
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(audio.pcm))?.count, 4)
    }
}
