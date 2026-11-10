import AppKit
import SwiftUI

@MainActor
final class QuickSummonController: NSObject, NSWindowDelegate {
    private let panel: NSPanel
    private let model: AppModel
    private var ownsCapture = false
    init(model: AppModel, openWorkspace: @escaping () -> Void) {
        self.model = model
        panel = QuickSummonPanel(contentRect: NSRect(x: 0, y: 0, width: 620, height: 300),
            styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        super.init()
        panel.title = "Ask Jarvis"; panel.titleVisibility = .hidden; panel.titlebarAppearsTransparent = true
        panel.level = .floating; panel.isReleasedWhenClosed = false; panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.delegate = self
        panel.contentViewController = NSHostingController(rootView: QuickSummonView(app: model, assistant: model.assistant,
            voice: model.voice, captureStarted: { [weak self] in self?.ownsCapture = true },
            openWorkspace: { [weak self] in self?.hide(); openWorkspace() }, close: { [weak self] in self?.hide() }))
    }
    func show() {
        if !panel.isVisible { panel.center() }
        panel.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    func hide() {
        if ownsCapture { model.voice.stopListening(); ownsCapture = false }
        panel.orderOut(nil)
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { hide(); return false }
    func windowDidResignKey(_ notification: Notification) {
        // Losing focus never leaves a microphone opened by this utility panel.
        if ownsCapture { model.voice.stopListening(); ownsCapture = false }
    }
}

private final class QuickSummonPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { performClose(sender) }
}

@MainActor
struct QuickSummonView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var assistant: AssistantModel
    @ObservedObject var voice: VoiceController
    let captureStarted: () -> Void, openWorkspace: () -> Void, close: () -> Void
    @FocusState private var focused: Bool
    @State private var creating = false
    private var capturing: Bool { voice.isListening || voice.dictationActive }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label("Ask Jarvis", systemImage: "waveform.circle.fill").font(.title2)
                Spacer()
                Button("Workspace", action: openWorkspace).keyboardShortcut("o", modifiers: [.command])
            }
            if AssistantFeatures.assistant {
                Text(assistant.selectedSession?.title ?? "Start a conversation to choose its context").font(.caption).foregroundStyle(.secondary)
                if assistant.selectedSession == nil {
                    Button(creating ? "Creating…" : "New conversation") {
                        creating = true
                        Task { await app.startNewConversation(); creating = false; focused = true }
                    }.disabled(creating || !app.isConnected)
                } else {
                    TextField("What are you working on?", text: $assistant.draft, axis: .vertical).id(assistant.selectedSessionID)
                        .textFieldStyle(.plain).font(.title3).lineLimit(2...5).focused($focused)
                        .onSubmit { send() }
                    if let selection = assistant.visualSelection { Text("Referring to: \(selection.label)").font(.caption).foregroundStyle(.secondary) }
                    if let error = assistant.error { Text(error).font(.caption).foregroundStyle(.orange).lineLimit(3) }
                    if capturing { Text(voice.transcript.isEmpty ? "Listening…" : voice.transcript).font(.caption).lineLimit(3) }
                    HStack(spacing: 12) {
                        // The same microphone as the workspace, bound to this session before capture starts.
                        VoiceMicButton(model: app, voice: voice, rooms: app.rooms, diameter: 42,
                                       prepare: { captureStarted(); app.tab = .assistant })
                        Text(VoicePresence.label(state: voice.state, consent: voice.cloudConsentGranted, dictationPaused: voice.dictationPaused))
                            .font(.caption).foregroundStyle(capturing ? RoomsPalette.cyan : RoomsPalette.muted)
                        if voice.dictationPaused { Button("Continue") { captureStarted(); Task { await voice.continueDictation() } } }
                        Spacer()
                        Button("Send", action: send).buttonStyle(.borderedProminent)
                            .disabled(assistant.submitting || assistant.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            } else {
                Text("Open your workspace to continue a conversation. Enable the assistant experience in Settings for quick text and voice turns.").foregroundStyle(.secondary)
                Button("Open workspace", action: openWorkspace).buttonStyle(.borderedProminent)
            }
        }.padding(24).frame(width: 572).background(.regularMaterial)
            .onAppear { focused = true }
    }
    private func send() {
        app.tab = .assistant
        Task { await assistant.sendDraft() }
    }
}
