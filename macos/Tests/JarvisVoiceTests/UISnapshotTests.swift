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
        JarvisFonts.registerBundledFonts()
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
    func testHUDDeck() async throws {
        _ = try UISnapshot.requireDirectory()
        let scene = UISnapshotScene(rooms: RoomsTestService(try RoomsFixture.load()))
        defer { scene.model.shutdown() }
        scene.runtime.tasks = [UISnapshotFixtures.approvalTask()]
        await scene.model.refresh()
        await scene.model.rooms.refresh()
        try scene.model.assistant.apply(try UISnapshotFixtures.richConversation())
        scene.model.tab = .deck
        try await assertRendered(HUDShell(model: scene.model, voice: scene.voice, presence: false), size: CGSize(width: 1440, height: 900), name: "hud-deck")
    }

    @MainActor
    func testHUDDeckEmptyAtMinimumSize() async throws {
        _ = try UISnapshot.requireDirectory()
        let scene = UISnapshotScene()
        defer { scene.model.shutdown() }
        await scene.model.refresh()
        scene.model.tab = .deck
        try await assertRendered(HUDShell(model: scene.model, voice: scene.voice, presence: false), size: CGSize(width: 1280, height: 800), name: "hud-deck-empty")
    }

    @MainActor
    func testHUDThread() async throws {
        _ = try UISnapshot.requireDirectory()
        let scene = UISnapshotScene()
        defer { scene.model.shutdown() }
        await scene.model.refresh()
        try scene.model.assistant.apply(try UISnapshotFixtures.richConversation())
        scene.model.tab = .assistant
        scene.model.assistant.followPresentations()
        try await assertRendered(HUDShell(model: scene.model, voice: scene.voice, presence: false), size: CGSize(width: 1440, height: 900), name: "hud-thread")
    }

    @MainActor
    func testHUDComponentSheet() async throws {
        _ = try UISnapshot.requireDirectory()
        let view = HUDScreen(tickerText: "BRIDGE READY · RUNTIME READY · VOICE CONSENT OFF · NO WORK RUNNING", scanlines: true) {
            HStack(alignment: .top, spacing: 14) {
                VStack(spacing: 14) {
                    HUDPanel(index: "01", title: "Indicators", meta: "LIVE", metaLED: .ok) {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack(spacing: 14) { StatusLED(state: .ok); StatusLED(state: .attention); StatusLED(state: .error); StatusLED(state: .off) }
                            SegmentedMeter(value: 0.92, glow: true).frame(width: 84)
                            SegmentedMeter(value: 0.4, color: JV.C.amber).frame(width: 84)
                            HStack(spacing: 12) {
                                RingGauge(value: 0.46) { Text("46").font(JV.F.mono(10, .medium)).foregroundStyle(JV.C.cyan200) }
                                RingGauge(value: 0, color: JV.C.amber, dashed: true) { Image(systemName: "play.fill").font(.system(size: 9)).foregroundStyle(JV.C.amber) }
                                Keycap(label: "⌘K"); Keycap(label: "⌃⌥␣")
                            }
                            HStack(spacing: 8) { GateBadge(kind: .gated); GateBadge(kind: .authorized); GateBadge(kind: .rejected) }
                        }
                    }
                    HUDPanel(index: "02", title: "Buttons", emphasis: true) {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(spacing: 10) {
                                Button("Primary") {}.buttonStyle(.hud(.primary)); Button("Secondary") {}.buttonStyle(.hud(.secondary))
                                Button("Ghost") {}.buttonStyle(.hud(.ghost))
                            }
                            HStack(spacing: 10) { Button("Stop run…") {}.buttonStyle(.hud(.danger)); Button("Needs you") {}.buttonStyle(.hud(.attention)) }
                            HoldToConfirmButton(action: {})
                            EventRow(glyph: .op, time: "10:14:03", source: "R_1", text: "builder sealed out/trend.json")
                            EventRow(glyph: .question, time: "10:15:48", source: "R_2", text: "asked which budget year to use", tint: JV.C.amber)
                        }
                    }
                    Text("Sentence text in the display face").jvText(JV.F.display)
                    Text("0123456789 · mono data").jvText(JV.F.data, JV.C.cyan200)
                }.frame(width: 340)
                VStack(spacing: 18) {
                    HStack(spacing: 18) {
                        CoreView(mode: .standby, diameter: 380, metrics: (context: 0.62, budget: 0.17))
                        CoreView(mode: .listening, diameter: 380, inputRMS: 0.7)
                    }
                    HStack(spacing: 18) {
                        CoreView(mode: .thinking, diameter: 180); CoreView(mode: .speaking, diameter: 180, playbackRMS: 0.6)
                        CoreView(mode: .authorization, diameter: 180); CoreView(mode: .stopped, diameter: 180); CoreView(mode: .armed, diameter: 180)
                    }
                }
            }.padding(.leading, JV.S.contentInsetLeading).padding(.trailing, JV.S.contentInsetTrailing).padding(.top, 30)
        }
        try await assertRendered(view, size: CGSize(width: 1440, height: 900), name: "hud-components")
    }

    @MainActor
    func testReadinessBanners() async throws {
        _ = try UISnapshot.requireDirectory()
        let notices = [
            ReadinessNotice.current(state: .starting, detail: "Starting your local assistant…", providerConfigured: nil),
            ReadinessNotice.current(state: .ready, detail: "", providerConfigured: false),
            ReadinessNotice.current(state: .failed, detail: "Ports 39201 or 39202 are already in use. Quit any other copy of Jarvis or its developer launcher, then retry.",
                                    failureLog: ["Jarvis bridge could not start: port 39202 is already in use. Quit the other Jarvis instance first."], providerConfigured: true),
        ].compactMap { $0 }
        XCTAssertEqual(notices.count, 3)
        let view = VStack(spacing: 18) { ForEach(Array(notices.enumerated()), id: \.offset) { _, notice in ReadinessBanner(notice: notice) } }
            .padding(.vertical, 18).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(RoomsPalette.background)
        try await assertRendered(view, size: CGSize(width: 1280, height: 300), name: "readiness-banners")
    }

    @MainActor
    func testGuidedSetup() async throws {
        _ = try UISnapshot.requireDirectory()
        let scene = UISnapshotScene()
        defer { scene.model.shutdown() }
        try await assertRendered(GuidedSetupView(app: scene.model), size: CGSize(width: 900, height: 690), name: "guided-setup")
    }
}
