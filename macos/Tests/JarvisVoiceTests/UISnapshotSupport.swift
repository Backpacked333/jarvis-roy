import AppKit
import SwiftUI
import XCTest
@testable import Jarvis

/// Renders real views with fixture state to PNG files so a change to the
/// interface can be looked at, not only compiled. Rendering runs only when
/// `JARVIS_UI_SNAPSHOT_DIR` names an output directory; CI sets it and uploads
/// the directory as an artifact.
@MainActor
enum UISnapshot {
    static var directory: URL? {
        guard let path = ProcessInfo.processInfo.environment["JARVIS_UI_SNAPSHOT_DIR"], !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    static func requireDirectory() throws -> URL {
        guard let directory else { throw XCTSkip("Set JARVIS_UI_SNAPSHOT_DIR to render interface snapshots.") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    /// Hosts the view in an offscreen window, lets it settle, and writes `<name>.png`.
    /// Returns the number of distinct sampled colours so a test can reject a blank render.
    @discardableResult
    static func render<Content: View>(_ view: Content, size: CGSize, name: String,
                                      settle: Duration = .milliseconds(700)) async throws -> Int {
        let directory = try requireDirectory()
        _ = NSApplication.shared
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height).environment(\.colorScheme, .dark))
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(calibratedWhite: 0.07, alpha: 1)
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: -30_000, y: -30_000))
        window.orderFrontRegardless()
        defer { window.orderOut(nil); window.contentView = nil }
        try await Task.sleep(for: settle)
        host.layoutSubtreeIfNeeded()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            throw SnapshotFailure.noBitmap(name)
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw SnapshotFailure.noBitmap(name) }
        try png.write(to: directory.appendingPathComponent(name + ".png"), options: .atomic)
        return distinctColours(in: bitmap)
    }

    private static func distinctColours(in bitmap: NSBitmapImageRep) -> Int {
        var seen = Set<UInt32>()
        let columns = 48, rows = 32
        for row in 0..<rows {
            for column in 0..<columns {
                let x = (bitmap.pixelsWide - 1) * column / (columns - 1), y = (bitmap.pixelsHigh - 1) * row / (rows - 1)
                guard let colour = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                let red = UInt32(colour.redComponent * 255), green = UInt32(colour.greenComponent * 255), blue = UInt32(colour.blueComponent * 255)
                seen.insert(red << 16 | green << 8 | blue)
            }
        }
        return seen.count
    }

    enum SnapshotFailure: Error { case noBitmap(String) }
}

/// Feature flags are read from the process environment before preferences, so
/// a snapshot can show an enabled product without writing any preference.
enum UISnapshotFlags {
    static func enable(_ names: [String]) { for name in names { setenv(name, "1", 1) } }
    static func reset(_ names: [String]) { for name in names { unsetenv(name) } }
    static let assistant = ["JARVIS_ENABLE_ASSISTANT", "JARVIS_ENABLE_KNOWLEDGE", "JARVIS_ENABLE_MEMORY"]
}

@MainActor
final class SnapshotRuntime: RuntimeServing {
    var tasks: [AgentTask] = []
    var threads: [Conversation] = []
    var capabilityState = CapabilityState(notice: "Fixture configuration only", capabilities: [])

    func request(_ path: String, method: String, body: [String: String]?) async throws -> Data { Data("{}".utf8) }
    func state() async throws -> RuntimeState {
        RuntimeState(ready: true, model: "anthropic/claude-sonnet-4.5", tasks: tasks, conversations: threads, memories: [], error: nil)
    }
    func capabilities() async throws -> CapabilityState { capabilityState }
}

enum UISnapshotFixtures {
    static let answerMarkdown = """
    ## Short answer

    Use **SQLite in WAL mode** for the local store. Readers keep working while a write is in flight, and there is no server to run.

    ### Why it fits

    - One file, easy to back up
    - Readers never block the writer
    - Comfortable up to a few hundred writes per second

    1. Turn WAL on once per database
    2. Keep transactions short
    3. Checkpoint when the app is idle

    > WAL does not help when several machines write to the same file over a network share.

    | Option | Setup | Concurrent readers |
    | --- | --- | --- |
    | SQLite WAL | None | Yes |
    | Postgres | A server | Yes |

    ```sql
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    ```

    More in the [SQLite documentation](https://sqlite.org/wal.html).
    """

    static let streamingMarkdown = "Two things to check before you switch:\n\n- Whether any reader holds a transaction open for minutes\n- How large the WAL file"

    static func focus() -> [String: Any] { ["kind": "conversation", "conversationId": "conversation_fixture"] }

    static func session(id: String = "session_fixture", title: String = "Local storage for the notes app") -> [String: Any] {
        ["version": 1, "id": id, "title": title, "revision": 3, "focus": focus(),
         "createdAt": "2026-11-10T09:00:00.000Z", "updatedAt": "2026-11-10T09:04:00.000Z"]
    }

    static func turn(id: String, text: String, status: String, session: String = "session_fixture") -> [String: Any] {
        ["version": 1, "id": id, "sessionId": session, "revision": 2, "text": text, "intent": "continue",
         "capturedFocus": focus(), "sessionRevision": 1, "status": status, "conversationId": "conversation_fixture",
         "createdAt": "2026-11-10T09:00:00.000Z", "updatedAt": "2026-11-10T09:01:00.000Z"]
    }

    static func presentation(id: String, turn: String, title: String, content: [String: Any],
                             revision: Int = 1, session: String = "session_fixture") -> [String: Any] {
        ["version": 1, "id": id, "sessionId": session, "turnId": turn, "revision": revision, "title": title,
         "capturedFocus": focus(), "content": content,
         "createdAt": "2026-11-10T09:00:30.000Z", "updatedAt": "2026-11-10T09:01:00.000Z"]
    }

    static func text(id: String, turn: String, markdown: String, revision: Int = 1) -> [String: Any] {
        presentation(id: id, turn: turn, title: "Answer", content: ["kind": "text", "markdown": markdown], revision: revision)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object))
    }

    static func state(sessions: [[String: Any]], turns: [[String: Any]], presentations: [[String: Any]]) throws -> AssistantState {
        try decode(AssistantState.self, ["version": 1, "sequence": 12, "sessions": sessions, "turns": turns,
                                         "presentations": presentations, "proposals": [] as [Any]] as [String: Any])
    }

    /// A conversation with one finished answer that also produced sources and a
    /// table, and one answer that is still arriving.
    static func richConversation() throws -> AssistantState {
        try state(sessions: [session()], turns: [
            turn(id: "turn_one", text: "What should I use to store notes locally? I want it simple and safe.", status: "completed"),
            turn(id: "turn_two", text: "Anything I should check before switching?", status: "running"),
        ], presentations: [
            text(id: "presentation_answer", turn: "turn_one", markdown: answerMarkdown, revision: 4),
            presentation(id: "presentation_sources", turn: "turn_one", title: "Sources", content: ["kind": "sources", "sources": [
                ["id": "source_one", "title": "Write-Ahead Logging", "url": "https://sqlite.org/wal.html",
                 "excerpt": "WAL provides more concurrency as readers do not block writers and a writer does not block readers.",
                 "retrievedAt": "2026-11-10T09:00:40.000Z", "status": "retrieved"],
                ["id": "source_two", "title": "Appropriate Uses For SQLite", "url": "https://sqlite.org/whentouse.html",
                 "excerpt": "SQLite works great as the database engine for most low to medium traffic applications.",
                 "retrievedAt": "2026-11-10T09:00:42.000Z", "status": "retrieved"],
            ]]),
            presentation(id: "presentation_table", turn: "turn_one", title: "Options compared", content: [
                "kind": "table", "columns": ["Option", "Setup", "Writes per second"],
                "rows": [["SQLite WAL", "None", 400] as [Any], ["Postgres", "A server", 5000] as [Any]],
            ] as [String: Any]),
            text(id: "presentation_streaming", turn: "turn_two", markdown: streamingMarkdown, revision: 2),
        ])
    }

    /// A plain exchange with no sources, tables or other working material.
    static func plainConversation() throws -> AssistantState {
        try state(sessions: [session(title: "A quick question")], turns: [
            turn(id: "turn_plain", text: "Give me a one line reason to prefer WAL mode.", status: "completed"),
        ], presentations: [
            text(id: "presentation_plain", turn: "turn_plain", markdown: "Readers and the writer stop blocking each other, so the app stays responsive while it saves."),
        ])
    }

    static func legacyThreads() -> [Conversation] {
        [Conversation(id: "conversation_fixture", title: "Local storage for the notes app", createdAt: "1", updatedAt: "2", messages: [
            ConversationMessage(id: "message_one", role: "user", text: "What should I use to store notes locally?", createdAt: "1", taskId: "task_one"),
            ConversationMessage(id: "message_two", role: "assistant", text: answerMarkdown, createdAt: "2", taskId: "task_one"),
        ])]
    }

    static func approvalTask() -> AgentTask {
        AgentTask(id: "task_approval", conversationId: "conversation_fixture", title: "Save the storage note", status: "waiting",
                  reply: "", lateReply: nil, error: nil, createdAt: "3", events: ["Requested approval to write a note"],
                  approvals: [Approval(id: "approval_one", title: "Write a note to your Jarvis folder",
                                       detail: "{\n  \"path\": \"notes/storage.md\",\n  \"content\": \"Use SQLite in WAL mode.\"\n}",
                                       options: [ApprovalOption(id: "approve", label: "Approve"), ApprovalOption(id: "deny", label: "Deny")],
                                       reviewable: true, blockedReason: nil, kind: "approval", revision: 1)])
    }
}

@MainActor
struct UISnapshotScene {
    let runtime = SnapshotRuntime()
    let transport = FixtureVoiceTransport()
    let voice: VoiceController
    let model: AppModel

    init(rooms: RoomsTestService? = nil) {
        voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true },
                                transport: transport, microphonePermission: { true })
        model = AppModel(client: runtime, harnessClient: rooms, voice: voice)
    }
}
