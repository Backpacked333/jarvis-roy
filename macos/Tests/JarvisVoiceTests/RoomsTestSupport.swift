import Foundation
import XCTest
@testable import Jarvis

struct RoomsFixture: Decodable {
    var state: HarnessState
    var draft: HarnessPlan
    var authoringQuestion: HarnessQuestion
    var events: HarnessEvents

    static func load() throws -> RoomsFixture {
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return try JSONDecoder().decode(Self.self, from: Data(contentsOf: repo.appendingPathComponent("contracts/fixtures/harness-v1.json")))
    }
    static let now = Date(timeIntervalSince1970: 1_793_988_000)
}

@MainActor
final class RoomsTestService: HarnessServing {
    var snapshot: HarnessState
    var batch: HarnessEvents
    var stateCalls = 0
    var stateHandler: (() async throws -> HarnessState)?
    var createHandler: ((HarnessCreateRoomRequest) async throws -> HarnessRoom)?
    var authorHandler: ((String, HarnessAuthorPlanRequest) async throws -> HarnessAuthoring)?
    var answerHandler: ((HarnessAnswerRequest) async throws -> HarnessQuestion)?
    var failure: Error?
    var textAnswers: [HarnessAnswerRequest] = []
    var voiceAnswers: [HarnessVoiceAnswerRequest] = []
    var authored: [(String, HarnessAuthorPlanRequest)] = []
    var starts: [(String, HarnessStartRunRequest)] = []
    var controls: [(String, String, String, Int)] = []
    var retries: [(String, String, String, HarnessRetryNodeRequest)] = []
    var created: [HarnessCreateRoomRequest] = []
    var acceptCalls = 0

    init(_ fixture: RoomsFixture) {
        snapshot = fixture.state; batch = fixture.events
        snapshot.authorings = [.init(id: "authoring_fixture", roomId: snapshot.rooms[0].id, requestId: "request_fixture",
                                    revision: 1, policyRevision: snapshot.rooms[0].policy.revision,
                                    goal: fixture.draft.goal, status: "completed", planId: fixture.draft.id,
                                    usage: snapshot.runs[0].usage, createdAt: fixture.draft.createdAt,
                                    updatedAt: fixture.draft.createdAt, error: nil)]
    }
    func state() async throws -> HarnessState {
        stateCalls += 1
        if let stateHandler { return try await stateHandler() }
        return snapshot
    }
    func events(after: Int, roomId: String?) async throws -> HarnessEvents { batch }
    func createRoom(_ input: HarnessCreateRoomRequest) async throws -> HarnessRoom {
        created.append(input)
        if let createHandler { return try await createHandler(input) }
        if let failure { throw failure }
        var room = snapshot.rooms[0]
        room.id = "created_room"; room.title = input.title; room.description = input.description; room.policy = input.policy
        snapshot.rooms.append(room); snapshot.sequence += 1
        return room
    }
    func updateRoom(_ roomId: String, input: HarnessUpdateRoomRequest) async throws -> HarnessRoom {
        if let failure { throw failure }
        var room = snapshot.rooms[0]
        room.title = input.title ?? room.title; room.description = input.description ?? room.description
        room.policy = input.policy ?? room.policy; room.revision += 1
        snapshot.rooms[0] = room; snapshot.sequence += 1
        return room
    }
    func authorPlan(_ roomId: String, input: HarnessAuthorPlanRequest) async throws -> HarnessAuthoring {
        authored.append((roomId, input))
        if let authorHandler { return try await authorHandler(roomId, input) }
        if let failure { throw failure }
        var value = snapshot.authorings[0]
        value.roomId = roomId; value.goal = input.goal; value.requestId = input.requestId
        return value
    }
    func cancelAuthoring(_ roomId: String, authoringId: String, revision: Int) async throws -> HarnessAuthoring { snapshot.authorings[0] }
    func updatePlan(_ roomId: String, planId: String, input: HarnessUpdatePlanRequest) async throws -> HarnessPlan {
        var value = snapshot.plans[0]; value.nodes = input.draft.nodes; value.goal = input.draft.goal; value.revision += 1
        return value
    }
    func acceptPlan(_ roomId: String, planId: String, revision: Int) async throws -> HarnessPlan { acceptCalls += 1; return snapshot.plans[0] }
    func startRun(_ roomId: String, input: HarnessStartRunRequest) async throws -> HarnessRun {
        starts.append((roomId, input)); if let failure { throw failure }; return snapshot.runs[0]
    }
    func controlRun(_ roomId: String, runId: String, action: String, revision: Int) async throws -> HarnessRun {
        controls.append((roomId, runId, action, revision)); if let failure { throw failure }; return snapshot.runs[0]
    }
    func retryNode(_ roomId: String, runId: String, nodeId: String, input: HarnessRetryNodeRequest) async throws -> HarnessRun {
        retries.append((roomId, runId, nodeId, input)); if let failure { throw failure }; return snapshot.runs[0]
    }
    func answerQuestion(_ input: HarnessAnswerRequest) async throws -> HarnessQuestion {
        textAnswers.append(input)
        if let answerHandler { return try await answerHandler(input) }
        if let failure { throw failure }
        return consume(input.binding, text: input.text, choice: input.choiceId)
    }
    func answerVoice(_ input: HarnessVoiceAnswerRequest) async throws -> HarnessQuestion {
        voiceAnswers.append(input)
        if let failure { throw failure }
        return consume(input.binding, text: input.transcript, choice: nil)
    }
    func consume(_ binding: HarnessQuestionBinding, text: String?, choice: String?) -> HarnessQuestion {
        let index = snapshot.questions.firstIndex { $0.id == binding.questionId }!
        snapshot.questions[index].status = "answered"
        snapshot.questions[index].revision += 1
        snapshot.questions[index].answer = .init(text: text, choiceId: choice, answeredAt: "2026-11-06T18:00:00Z")
        snapshot.sequence += 1
        return snapshot.questions[index]
    }
    func artifactContent(_ artifact: HarnessArtifact, path: String) async throws -> Data { Data("source".utf8) }
}

@MainActor
final class RoomsTestTransport: RoomsHTTPTransport {
    var requests: [URLRequest] = []
    var handler: (URLRequest, Int) throws -> (Data, HTTPURLResponse)
    init(handler: @escaping (URLRequest, Int) throws -> (Data, HTTPURLResponse)) { self.handler = handler }
    func send(_ request: URLRequest, limit: Int) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        return try handler(request, limit)
    }
    static func response(_ request: URLRequest, data: Data, status: Int = 200) -> (Data, HTTPURLResponse) {
        (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!)
    }
}
