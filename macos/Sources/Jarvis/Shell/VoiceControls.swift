import SwiftUI

extension HarnessVoiceState {
    var label: String {
        switch self {
        case .connecting: return "Connecting"
        case .listening: return "Listening"
        case .thinking: return "Thinking"
        case .speaking: return "Speaking"
        case .idle: return "Ready"
        case .interrupted: return "Interrupted"
        case .unavailable: return "Unavailable"
        }
    }
}

/// The voice button in the top bar. One glance shows the state; one click opens every voice setting.
struct VoiceControl: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: VoiceController
    @Binding var cloudDisclosure: Bool
    @Binding var handsFreeDisclosure: Bool
    @Environment(\.theme) private var theme
    @State private var open = false

    var body: some View {
        Button { open.toggle() } label: {
            HStack(spacing: 7) {
                Image(systemName: icon).foregroundStyle(tone)
                Text(label)
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(theme.faint)
            }
        }
        .buttonStyle(.jarvisCompact)
        .help("Voice settings and controls")
        .accessibilityLabel("Voice: \(label)")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            VoicePanel(model: model, voice: voice,
                       requestCloudVoice: { open = false; cloudDisclosure = true },
                       requestHandsFree: { open = false; handsFreeDisclosure = true })
                .jarvisThemed()
        }
    }

    private var label: String {
        guard voice.cloudConsentGranted else { return voice.wakeWordEnabled ? "Wake word on" : "Voice off" }
        return voice.state == .idle ? "Voice ready" : voice.state.label
    }

    private var icon: String {
        guard voice.cloudConsentGranted else { return "mic.slash" }
        switch voice.state {
        case .listening: return "waveform"
        case .speaking: return "speaker.wave.2.fill"
        case .unavailable: return "mic.slash"
        default: return "mic"
        }
    }

    private var tone: Color {
        guard voice.cloudConsentGranted else { return theme.muted }
        switch voice.state {
        case .listening, .interrupted: return theme.warning
        case .unavailable: return theme.danger
        default: return theme.accentText
        }
    }
}

/// Every voice permission and control in one place, each with a line saying what it does.
private struct VoicePanel: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: VoiceController
    let requestCloudVoice: () -> Void
    let requestHandsFree: () -> Void
    @Environment(\.theme) private var theme

    private var listenTitle: String {
        if voice.isSpeaking { return "Interrupt and listen" }
        if model.tab == .rooms, model.rooms.selectedRoomId == nil { return "Create room and listen" }
        return "Listen"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Voice").font(.system(size: 15, weight: .semibold))
                Spacer()
                StatusPill(label: voice.cloudConsentGranted ? voice.state.label : "Off",
                           color: voice.cloudConsentGranted ? (voice.isListening ? theme.warning : theme.accentText) : theme.muted)
            }
            VStack(spacing: 12) {
                row("Cloud voice", detail: "ElevenLabs speech for this session. Resets when Jarvis quits.",
                    isOn: Binding(get: { voice.cloudConsentGranted }, set: { enabled in
                        if enabled { requestCloudVoice() } else { model.muteVoice(); voice.setCloudConsent(false) }
                    }))
                row("Hands-free", detail: "Keep talking after each reply without pressing Listen.",
                    isOn: Binding(get: { voice.handsFreeEnabled }, set: { enabled in
                        if enabled { requestHandsFree() } else { Task { await voice.setHandsFreeEnabled(false) } }
                    }))
                    .disabled(!voice.cloudConsentGranted || voice.isRequestingPermission)
                row("Hey Jarvis", detail: "Opt-in on-device listening for the wake phrase. Needs a selected chat.",
                    isOn: Binding(get: { voice.wakeWordEnabled }, set: { enabled in
                        Task { await model.setWakeEnabled(enabled) }
                    }))
                    .disabled(model.selectedConversationID == nil)
                row("Speak replies", detail: "Read finished replies aloud in Chat.",
                    isOn: Binding(get: { model.speakReplies }, set: { enabled in
                        model.objectWillChange.send()
                        model.speakReplies = enabled
                        if !enabled { voice.stopSpeaking() }
                    }))
            }
            .padding(14)
            .jarvisSurface(.elevated, radius: 12)

            HStack(spacing: 8) {
                Button { Task { await model.startManualListening() } } label: { Label(listenTitle, systemImage: "mic.fill") }
                    .buttonStyle(.jarvisPrimary)
                    .disabled(!voice.cloudConsentGranted || voice.isRequestingPermission || model.pendingActions.contains("voice-start"))
                Button("Finish") { voice.finishListening() }
                    .buttonStyle(.jarvisSecondary)
                    .disabled(!voice.isCapturingCommand)
                Spacer(minLength: 0)
                Button { model.muteVoice() } label: { Label("Mute", systemImage: "mic.slash") }
                    .buttonStyle(.jarvisDanger)
                    .help("Stop the microphone and any speech")
            }

            VStack(alignment: .leading, spacing: 5) {
                Text(voice.wakeStatus)
                if voice.handsFreeEnabled { Text(voice.handsFreeStatus).foregroundStyle(theme.warning) }
                Text("Speech uses ElevenLabs v4 Turbo and Scribe. A spoken yes never approves an action.")
            }
            .font(.system(size: 11)).foregroundStyle(theme.muted)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .frame(width: 360)
        .background(theme.panel)
    }

    private func row(_ title: String, detail: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.text)
                Text(detail).font(.system(size: 11)).foregroundStyle(theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .toggleStyle(.switch)
        .controlSize(.small)
    }
}

/// Shown while speech is being captured: where it will go, the live transcript, and how to end it.
/// A single glass body with flat content.
struct VoiceCaptureBar: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: VoiceController
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let context = voice.capturedContext {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: "waveform")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(voice.isListening ? theme.warning : theme.accentText)
                    .symbolEffect(.variableColor.iterative, isActive: voice.isListening && !reduceMotion)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 3) {
                    Text(captureLabel(context)).font(.system(size: 12, weight: .semibold)).foregroundStyle(theme.text)
                    if !voice.transcript.isEmpty {
                        Text(voice.transcript).font(.system(size: 13)).foregroundStyle(theme.text)
                            .lineLimit(3).textSelection(.enabled)
                            .accessibilityLabel("Live transcription: \(voice.transcript)")
                    } else if voice.isListening {
                        Text("Listening…").font(.system(size: 12)).foregroundStyle(theme.muted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if voice.isCapturingCommand {
                    Button("Finish") { voice.finishListening() }.buttonStyle(.jarvisCompactPrimary)
                }
                Button { model.muteVoice() } label: { Label("Mute", systemImage: "mic.slash") }
                    .buttonStyle(.jarvisCompact)
                    .help("Stop the microphone and any speech")
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .jarvisGlass(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .padding(.horizontal, 16).padding(.bottom, 10)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    private func captureLabel(_ context: HarnessVoiceContext) -> String {
        if let room = context.roomId {
            let title = model.rooms.state?.rooms.first { $0.id == room }?.title ?? room
            return context.question == nil ? "Captured room: \(title) · draft authoring only" : "Captured clarification: \(title) · exact question only"
        }
        if let conversation = context.conversationId {
            return "Captured conversation: \(model.conversations.first { $0.id == conversation }?.title ?? conversation)"
        }
        return "No captured target · speech will not be submitted"
    }
}
