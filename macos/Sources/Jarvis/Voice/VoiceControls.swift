import SwiftUI

/// Jarvis's presence: a small orb that moves only with measured microphone and
/// playback levels. With no audio it is still.
struct VoiceOrb: View {
    let state: HarnessVoiceState
    let levels: HarnessAudioLevels
    var consent = true
    var diameter: CGFloat = 46
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var amplitude: Double {
        let value = max(levels.inputRMS, levels.playbackRMS)
        return value.isFinite ? min(1, max(0, value)) : 0
    }
    private var motion: Double { reduceMotion ? 0 : amplitude }
    private var active: Bool { consent && ![.unavailable, .interrupted].contains(state) }
    private var tint: Color { active ? RoomsPalette.cyan : RoomsPalette.muted }
    private var working: Bool { consent && [.thinking, .connecting].contains(state) }

    var body: some View {
        ZStack {
            Circle().fill(RadialGradient(colors: [tint.opacity(0.10 + amplitude * 0.30), .clear], center: .center,
                                         startRadius: diameter * 0.2, endRadius: diameter * 0.62))
                .scaleEffect(1.12 + motion * 0.30)
            Circle().fill(RadialGradient(colors: [tint.opacity(active ? 0.42 + amplitude * 0.38 : 0.14), RoomsPalette.panel],
                                         center: .topLeading, startRadius: 0, endRadius: diameter * 0.95))
                .padding(diameter * (0.10 - motion * 0.05))
            Circle().stroke(tint.opacity(0.35 + amplitude * 0.5), lineWidth: max(1, diameter * 0.028))
                .padding(diameter * (0.10 - motion * 0.05))
            if working {
                TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
                    Circle().trim(from: 0, to: 0.26)
                        .stroke(tint.opacity(0.9), style: StrokeStyle(lineWidth: max(1.2, diameter * 0.035), lineCap: .round))
                        .rotationEffect(.degrees(reduceMotion ? -90 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4 * 360))
                        .padding(diameter * 0.03)
                }
            }
            Image(systemName: VoicePresence.symbol(state: state, consent: consent))
                .font(.system(size: diameter * 0.34, weight: .medium)).foregroundStyle(tint.opacity(active ? 0.98 : 0.8))
        }
        .frame(width: diameter, height: diameter)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.09), value: amplitude)
        .accessibilityHidden(true)
    }
}

/// The one microphone control. The first press in a session presents the
/// cloud voice disclosure; nothing is captured before it is accepted.
struct VoiceMicButton: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: VoiceController
    @ObservedObject var rooms: RoomsModel
    var diameter: CGFloat = 46
    var unavailable = false
    /// Runs immediately before a capture is requested, for a caller that must
    /// first choose the target of the speech.
    var prepare: () -> Void = {}
    @State private var disclosure = false

    private var action: VoicePresence.MicAction {
        VoicePresence.micAction(consent: voice.cloudConsentGranted, listening: voice.isListening,
                                dictationActive: voice.dictationActive, speaking: voice.isSpeaking)
    }

    var body: some View {
        Button { press() } label: {
            VoiceOrb(state: voice.state, levels: rooms.audioLevels, consent: voice.cloudConsentGranted, diameter: diameter)
        }
        .buttonStyle(.plain)
        .disabled(unavailable || voice.isRequestingPermission || model.pendingActions.contains("voice-start"))
        .opacity(unavailable ? 0.45 : 1)
        .help(VoicePresence.micHelp(action))
        .accessibilityLabel(VoicePresence.micHelp(action))
        .accessibilityValue(VoicePresence.label(state: voice.state, consent: voice.cloudConsentGranted, dictationPaused: voice.dictationPaused))
        .cloudVoiceDisclosure(isPresented: $disclosure, voice: voice) { start() }
    }

    private func press() {
        switch action {
        case .askConsent: disclosure = true
        case .finish: voice.finishListening()
        case .interruptAndListen, .listen: start()
        }
    }

    private func start() {
        prepare()
        Task { await model.startManualListening() }
    }
}

extension View {
    /// The cloud voice disclosure. Accepting grants consent for this session
    /// only, exactly as the Cloud voice setting does.
    func cloudVoiceDisclosure(isPresented: Binding<Bool>, voice: VoiceController, accepted: @escaping () -> Void = {}) -> some View {
        confirmationDialog(VoiceDisclosure.cloudTitle, isPresented: isPresented, titleVisibility: .visible) {
            Button(VoiceDisclosure.cloudAllow) { voice.setCloudConsent(true); accepted() }
            Button("Cancel", role: .cancel) {}
        } message: { Text(VoiceDisclosure.cloudMessage) }
    }

    func handsFreeDisclosure(isPresented: Binding<Bool>, voice: VoiceController) -> some View {
        confirmationDialog(VoiceDisclosure.handsFreeTitle, isPresented: isPresented, titleVisibility: .visible) {
            Button(VoiceDisclosure.handsFreeAllow) { Task { await voice.setHandsFreeEnabled(true) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text(VoiceDisclosure.handsFreeMessage) }
    }
}

/// Voice settings for this session, in one compact menu.
struct VoiceMenu: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: VoiceController
    @State private var cloudDisclosure = false
    @State private var handsFreeDisclosure = false

    private var label: String { VoicePresence.label(state: voice.state, consent: voice.cloudConsentGranted, dictationPaused: voice.dictationPaused) }
    private var lively: Bool { voice.cloudConsentGranted && [.listening, .speaking, .thinking, .connecting].contains(voice.state) }

    var body: some View {
        Menu {
            Toggle("Cloud voice for this session", isOn: Binding(get: { voice.cloudConsentGranted }, set: { enabled in
                if enabled { cloudDisclosure = true } else { model.muteVoice(); voice.setCloudConsent(false) }
            }))
            Toggle("Hands-free conversation", isOn: Binding(get: { voice.handsFreeEnabled }, set: { enabled in
                if enabled { handsFreeDisclosure = true } else { Task { await voice.setHandsFreeEnabled(false) } }
            })).disabled(!voice.cloudConsentGranted || voice.isRequestingPermission)
            Divider()
            Button("Finish and send") { voice.finishListening() }.disabled(!voice.isCapturingCommand)
            Button("Mute and stop voice") { model.muteVoice() }
            Divider()
            Text(voice.wakeStatus)
            if voice.handsFreeEnabled { Text(voice.handsFreeStatus) }
            if let speechModel = VoicePresence.modelLabel(voice.reportedVoiceModel) { Text("Speech model: \(speechModel)") }
        } label: {
            HStack(spacing: 7) {
                Circle().fill(lively ? RoomsPalette.cyan : RoomsPalette.muted.opacity(0.6)).frame(width: 6, height: 6)
                Text(label).font(.system(size: 11, weight: .medium))
            }.foregroundStyle(voice.isListening ? RoomsPalette.amber : Color.primary.opacity(0.85))
        }
        .menuStyle(.borderlessButton).fixedSize()
        .help("Voice for this session")
        .accessibilityLabel("Voice: \(label)")
        .cloudVoiceDisclosure(isPresented: $cloudDisclosure, voice: voice)
        .handsFreeDisclosure(isPresented: $handsFreeDisclosure, voice: voice)
    }
}
