import AppKit
import SwiftUI
import XCTest
@testable import Jarvis

/// Each test writes one PNG. They are skipped unless `JARVIS_UI_SNAPSHOT_DIR`
/// is set, so an ordinary `swift test` opens no windows.
final class UISnapshotTests: XCTestCase {
    private static let window = CGSize(width: 1280, height: 840)

    override func setUp() {
        super.setUp()
        UISnapshotFlags.enable(UISnapshotFlags.assistant)
    }

    override func tearDown() {
        UISnapshotFlags.reset(UISnapshotFlags.assistant)
        super.tearDown()
    }

    @MainActor
    private func assertRendered<Content: View>(_ view: Content, size: CGSize = UISnapshotTests.window, name: String,
                                                file: StaticString = #filePath, line: UInt = #line) async throws {
        let colours = try await UISnapshot.render(view, size: size, name: name)
        XCTAssertGreaterThan(colours, 6, "\(name) rendered as a nearly blank image", file: file, line: line)
    }

    @MainActor
    func testMarkdownBlocks() async throws {
        _ = try UISnapshot.requireDirectory()
        let view = ScrollView { MarkdownBlocksView(UISnapshotFixtures.answerMarkdown).padding(28) }
        try await assertRendered(view, size: CGSize(width: 720, height: 860), name: "markdown-blocks")
    }

    @MainActor
    func testAssistantConversation() async throws {
        _ = try UISnapshot.requireDirectory()
        let scene = UISnapshotScene()
        defer { scene.model.shutdown() }
        await scene.model.refresh()
        try scene.model.assistant.apply(try UISnapshotFixtures.richConversation())
        scene.model.tab = .assistant
        scene.model.assistant.followPresentations()
        try await assertRendered(WorkspaceView(model: scene.model, voice: scene.voice), name: "assistant-conversation")
    }

    @MainActor
    func testAssistantMaterialBesideConversation() async throws {
        _ = try UISnapshot.requireDirectory()
        let scene = UISnapshotScene()
        defer { scene.model.shutdown() }
        await scene.model.refresh()
        try scene.model.assistant.apply(try UISnapshotFixtures.richConversation())
        scene.model.tab = .assistant
        scene.model.assistant.selectPresentation("presentation_table")
        scene.voice.setCloudConsent(true)
        try await assertRendered(WorkspaceView(model: scene.model, voice: scene.voice), name: "assistant-material")
    }

    @MainActor
    func testAssistantPlainConversation() async throws {
        _ = try UISnapshot.requireDirectory()
        let scene = UISnapshotScene()
        defer { scene.model.shutdown() }
        await scene.model.refresh()
        try scene.model.assistant.apply(try UISnapshotFixtures.plainConversation())
        scene.model.tab = .assistant
        try await assertRendered(WorkspaceView(model: scene.model, voice: scene.voice), name: "assistant-plain")
    }

    @MainActor
    func testAssistantEmpty() async throws {
        _ = try UISnapshot.requireDirectory()
        let scene = UISnapshotScene()
        defer { scene.model.shutdown() }
        await scene.model.refresh()
        scene.model.tab = .assistant
        try await assertRendered(WorkspaceView(model: scene.model, voice: scene.voice), name: "assistant-empty")
    }

    @MainActor
    func testVoiceOrbStates() async throws {
        _ = try UISnapshot.requireDirectory()
        let states: [(String, HarnessVoiceState, Bool, Double, Double)] = [
            ("Voice off", .idle, false, 0, 0), ("Ready", .idle, true, 0, 0), ("Connecting", .connecting, true, 0, 0),
            ("Listening, quiet", .listening, true, 0.05, 0), ("Listening, loud", .listening, true, 0.85, 0),
            ("Thinking", .thinking, true, 0, 0), ("Speaking", .speaking, true, 0, 0.6), ("Unavailable", .unavailable, true, 0, 0),
        ]
        let view = HStack(spacing: 28) {
            ForEach(Array(states.enumerated()), id: \.offset) { _, entry in
                VStack(spacing: 14) {
                    VoiceOrb(state: entry.1, levels: .init(inputRMS: entry.3, playbackRMS: entry.4, generation: 1), consent: entry.2, diameter: 72)
                    Text(entry.0).font(.caption).foregroundStyle(.secondary)
                    Text(VoicePresence.label(state: entry.1, consent: entry.2)).font(.caption2)
                }
            }
        }.padding(36).background(RoomsPalette.background)
        try await assertRendered(view, size: CGSize(width: 1000, height: 220), name: "voice-orb-states")
    }

    @MainActor
    func testQuickSummon() async throws {
        _ = try UISnapshot.requireDirectory()
        let scene = UISnapshotScene()
        defer { scene.model.shutdown() }
        await scene.model.refresh()
        try scene.model.assistant.apply(try UISnapshotFixtures.plainConversation())
        let view = QuickSummonView(app: scene.model, assistant: scene.model.assistant, voice: scene.voice,
                                   captureStarted: {}, openWorkspace: {}, close: {})
        try await assertRendered(view, size: CGSize(width: 572, height: 250), name: "quick-summon")
    }

    @MainActor
    func testToday() async throws {
        _ = try UISnapshot.requireDirectory()
        let scene = UISnapshotScene()
        defer { scene.model.shutdown() }
        await scene.model.refresh()
        scene.model.tab = .today
        try await assertRendered(WorkspaceView(model: scene.model, voice: scene.voice), name: "today")
    }

    @MainActor
    func testLegacyThreadWithApproval() async throws {
        _ = try UISnapshot.requireDirectory()
        let scene = UISnapshotScene()
        defer { scene.model.shutdown() }
        scene.runtime.threads = UISnapshotFixtures.legacyThreads()
        scene.runtime.tasks = [UISnapshotFixtures.approvalTask()]
        await scene.model.refresh()
        scene.model.selectConversation("conversation_fixture")
        scene.model.selectedTaskID = "task_approval"
        try await assertRendered(WorkspaceView(model: scene.model, voice: scene.voice), name: "legacy-thread-approval")
    }

    @MainActor
    func testRooms() async throws {
        _ = try UISnapshot.requireDirectory()
        let scene = UISnapshotScene(rooms: RoomsTestService(try RoomsFixture.load()))
        defer { scene.model.shutdown() }
        await scene.model.refresh()
        await scene.model.rooms.refresh()
        scene.model.tab = .rooms
        try await assertRendered(WorkspaceView(model: scene.model, voice: scene.voice), name: "rooms")
    }

    @MainActor
    func testGuidedSetup() async throws {
        _ = try UISnapshot.requireDirectory()
        let scene = UISnapshotScene()
        defer { scene.model.shutdown() }
        try await assertRendered(GuidedSetupView(app: scene.model), size: CGSize(width: 900, height: 690), name: "guided-setup")
    }
}
