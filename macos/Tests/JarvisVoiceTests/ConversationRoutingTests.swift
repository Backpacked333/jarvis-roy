import Foundation
import XCTest
@testable import Jarvis

@MainActor
private final class FixtureRuntime: RuntimeServing {
    var requests: [(String, [String: String]?)] = []
    var onRequest: (() -> Void)?
    var failRequests = false
    var tasks: [AgentTask] = []
    var threads = [
        Conversation(id: "a", title: "Alpha", createdAt: "1", updatedAt: "2", messages: [
            ConversationMessage(id: "a1", role: "user", text: "Only Alpha", createdAt: "1", taskId: "old-a")
        ]),
        Conversation(id: "b", title: "Beta", createdAt: "1", updatedAt: "1", messages: [])
    ]

    func request(_ path: String, method: String, body: [String: String]?) async throws -> Data {
        requests.append((path, body))
        onRequest?()
        if failRequests { throw RuntimeClient.ClientError.response("Fixture offline") }
        if path == "v1/tasks" {
            let object: [String: Any] = [
                "id": UUID().uuidString, "conversationId": body!["conversationId"]!, "title": body!["message"]!,
                "status": "starting", "reply": "", "createdAt": "3", "events": [], "approvals": []
            ]
            let data = try JSONSerialization.data(withJSONObject: object)
            tasks.append(try JSONDecoder().decode(AgentTask.self, from: data))
            return data
        }
        if path == "v1/conversations" {
            let data = Data(#"{"id":"new","title":"New conversation","createdAt":"3","updatedAt":"3","messages":[]}"#.utf8)
            threads.insert(try JSONDecoder().decode(Conversation.self, from: data), at: 0)
            return data
        }
        return Data("{}".utf8)
    }

    func state() async throws -> RuntimeState {
        RuntimeState(ready: true, model: "fixture", tasks: tasks, conversations: threads, memories: [], error: nil)
    }

    func capabilities() async throws -> CapabilityState {
        CapabilityState(notice: "Fixture configuration only", capabilities: [])
    }

    func pending(_ thread: String, status: String) -> AgentTask {
        AgentTask(id: "pending-\(thread)", conversationId: thread, title: "Pending", status: status,
                  reply: "", lateReply: nil, error: nil, createdAt: "3", events: [], approvals: [])
    }
}

final class ConversationRoutingTests: XCTestCase {
    @MainActor
    func testDraftHistoryAndTaskSelectionRemainThreadScoped() async {
        let runtime = FixtureRuntime()
        runtime.tasks = [runtime.pending("a", status: "waiting")]
        let model = AppModel(client: runtime)
        await model.refresh()
        model.draft = "Alpha draft"
        model.selectedTaskID = "pending-a"
        XCTAssertFalse(model.canSend)
        XCTAssertEqual(model.selectedConversation?.messages.first?.text, "Only Alpha")
        model.selectConversation("b")
        XCTAssertTrue(model.draft.isEmpty)
        XCTAssertNil(model.selectedTask)
        XCTAssertTrue(model.conversationTasks.isEmpty)
        XCTAssertTrue(model.selectedConversation?.messages.isEmpty == true)
        model.draft = "Beta draft"
        XCTAssertTrue(model.canSend)
        model.selectConversation("a")
        XCTAssertEqual(model.draft, "Alpha draft")
        XCTAssertFalse(model.canSend)
    }

    @MainActor
    func testFollowUpUsesSelectedConversationAndOtherThreadsStayAvailable() async {
        let runtime = FixtureRuntime()
        let model = AppModel(client: runtime)
        await model.refresh()
        model.draft = "Follow-up"
        await model.send()
        XCTAssertEqual(runtime.requests.first?.1?["conversationId"], "a")
        XCTAssertEqual(runtime.requests.first?.1?["message"], "Follow-up")
        XCTAssertTrue(model.draft.isEmpty)
        XCTAssertNotNil(model.sendBlockReason)
        model.selectConversation("b")
        model.draft = "Independent task"
        XCTAssertTrue(model.canSend)
        await model.send()
        XCTAssertEqual(runtime.requests.last?.1?["conversationId"], "b")
    }

    @MainActor
    func testUnconfirmedWorkBlocksVoiceAndPreservesEveryCommand() async {
        let runtime = FixtureRuntime()
        runtime.tasks = [runtime.pending("a", status: "interrupted")]
        let model = AppModel(client: runtime)
        await model.refresh()
        XCTAssertTrue(model.prepareVoiceCapture())
        model.receiveVoiceCommand("First retained command")
        model.receiveVoiceCommand("Second retained command")
        await Task.yield()
        XCTAssertTrue(runtime.requests.isEmpty)
        XCTAssertTrue(model.voiceReview.contains("First retained command"))
        XCTAssertTrue(model.voiceReview.contains("Second retained command"))
        model.selectConversation("b")
        XCTAssertTrue(model.voiceReview.isEmpty)
        model.selectConversation("a")
        model.useVoiceReview()
        XCTAssertTrue(model.draft.contains("First retained command"))
        XCTAssertTrue(model.draft.contains("Second retained command"))
        XCTAssertTrue(model.voiceReview.isEmpty)
    }

    @MainActor
    func testSwitchBeforeQueuedVoiceSubmissionNeverTargetsNewThread() async {
        let runtime = FixtureRuntime()
        let model = AppModel(client: runtime)
        await model.refresh()
        XCTAssertTrue(model.prepareVoiceCapture())
        model.receiveVoiceCommand("A command for Alpha")
        model.selectConversation("b")
        await Task.yield()
        XCTAssertTrue(runtime.requests.isEmpty)
        XCTAssertTrue(model.voiceReview.isEmpty)
        model.selectConversation("a")
        XCTAssertEqual(model.voiceReview, "A command for Alpha")
    }

    @MainActor
    func testReadyVoiceSendsOnlyToCapturedThread() async {
        let runtime = FixtureRuntime()
        let model = AppModel(client: runtime)
        await model.refresh()
        XCTAssertTrue(model.prepareVoiceCapture())
        model.receiveVoiceCommand("Ready command")
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(runtime.requests.count, 1)
        XCTAssertEqual(runtime.requests.first?.1?["conversationId"], "a")
        XCTAssertEqual(runtime.requests.first?.1?["message"], "Ready command")
        XCTAssertTrue(model.voiceReview.isEmpty)
        XCTAssertFalse(model.voice.wakeWordEnabled)
    }

    @MainActor
    func testExistingDraftAndOfflineStateRetainVoiceWithoutOverwriting() async {
        let runtime = FixtureRuntime()
        let model = AppModel(client: runtime)
        await model.refresh()
        model.draft = "Typed text"
        XCTAssertTrue(model.prepareVoiceCapture())
        model.receiveVoiceCommand("Voice text")
        XCTAssertEqual(model.draft, "Typed text")
        model.isConnected = false
        model.receiveVoiceCommand("Offline text")
        await Task.yield()
        XCTAssertTrue(runtime.requests.isEmpty)
        model.useVoiceReview()
        XCTAssertTrue(model.draft.contains("Typed text"))
        XCTAssertTrue(model.draft.contains("Voice text"))
        XCTAssertTrue(model.draft.contains("Offline text"))
    }

    @MainActor
    func testStopAllDisconnectsPendingVoiceBeforeNetworkCancellation() async {
        for capture in [true, false] {
            let runtime = FixtureRuntime()
            let transport = FixtureVoiceTransport()
            let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true },
                                        transport: transport, microphonePermission: { true })
            let model = AppModel(client: runtime, voice: voice)
            voice.setCloudConsent(true)
            if capture { await voice.startListening() }
            else { voice.speak("Harmless fixture reply") }
            for _ in 0..<100 where transport.frames.isEmpty { await Task.yield() }
            XCTAssertEqual(transport.connections, 1)
            XCTAssertEqual(voice.state, .connecting)
            let before = transport.disconnections
            runtime.onRequest = {
                XCTAssertGreaterThan(transport.disconnections, before)
                XCTAssertFalse(model.voice.isListening)
                XCTAssertFalse(model.voice.isSpeaking)
                XCTAssertFalse(model.voice.wakeWordEnabled)
                XCTAssertNotEqual(model.voice.state, .connecting)
            }
            await model.stopAll()
            XCTAssertEqual(runtime.requests.first?.0, "v1/stop")
        }
    }

    @MainActor
    func testFailedSubmissionRetainsDraftAndNewConversationUsesServerAPI() async {
        let runtime = FixtureRuntime()
        let model = AppModel(client: runtime)
        await model.refresh()
        model.draft = "Do not lose this"
        runtime.failRequests = true
        await model.send()
        XCTAssertEqual(model.draft, "Do not lose this")
        XCTAssertNotNil(model.error)
        runtime.failRequests = false
        await model.newConversation()
        XCTAssertEqual(model.selectedConversationID, "new")
        XCTAssertEqual(runtime.requests.last?.0, "v1/conversations")
        XCTAssertTrue(model.draft.isEmpty)
        model.selectConversation("a")
        XCTAssertEqual(model.draft, "Do not lose this")
    }
}
