import SwiftUI

/// What the deck shows while you speak (handoff screen 6b): the core, the words as they arrive, and the
/// measured input level. Speech here only ever drafts; nothing runs because of what is said.
/// The design's spectrogram and intent cards need data the voice service does not report yet, so this shows
/// the level history it does report and leaves the rest out rather than drawing a likeness.
struct ListeningView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: VoiceController
    @ObservedObject private var rooms: RoomsModel
    var presence: Bool
    @State private var started = Date()

    init(model: AppModel, voice: VoiceController, presence: Bool = true) {
        self.model = model
        self.voice = voice
        self.presence = presence
        _rooms = ObservedObject(wrappedValue: model.rooms)
    }

    var body: some View {
        GeometryReader { geometry in
            let coreSize = min(540, max(260, geometry.size.height - 190), geometry.size.width * 0.4)
            VStack(spacing: 0) {
                header
                HStack(alignment: .top, spacing: 44) {
                    VStack(spacing: JV.S.gutter) {
                        CoreView(mode: CoreView.Mode(voice.state, wakeArmed: false, decisionOnScreen: false), diameter: coreSize,
                                 inputRMS: rooms.audioLevels.inputRMS, playbackRMS: rooms.audioLevels.playbackRMS, presence: presence, labelled: true,
                                 detail: Self.decibels(rooms.audioLevels.inputRMS))
                        levels.frame(width: coreSize)
                    }
                    transcript.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
                .padding(.top, 18)
                footer
            }
        }
        .onAppear { started = Date() }
    }

    private var header: some View {
        HStack {
            Text("CAPTURE").jvText(JV.F.panelTitle, JV.C.text2)
            Spacer()
            HStack(spacing: 8) {
                StatusLED(state: .ok, size: 6)
                Text(Self.captureLine(model: voice.reportedVoiceModel)).font(JV.F.hud(10)).tracking(2).foregroundStyle(JV.C.cyan50)
            }
            .padding(.horizontal, 14).padding(.vertical, 7)
            .background(JV.C.cyan.opacity(0.08)).overlay(Rectangle().stroke(JV.C.lineActive, lineWidth: 1))
            .shadow(color: JV.C.cyan.opacity(0.25), radius: 10)
            Spacer()
            TimelineView(.periodic(from: .now, by: 0.1)) { context in
                Text("ELAPSED \(Self.elapsed(context.date.timeIntervalSince(started)))").font(JV.F.mono(10)).foregroundStyle(JV.C.text2)
            }
        }
    }

    /// The measured input level over the last moments, one bar per report. Flat when nothing is heard.
    private var levels: some View {
        HUDPanel(index: "07", title: "Input level", meta: "MEASURED · NOT A SPECTROGRAM") {
            HStack(alignment: .bottom, spacing: 1) {
                let history = Array(rooms.audioHistory.suffix(86))
                ForEach(Array(history.enumerated()), id: \.offset) { _, level in
                    Rectangle().fill(JV.C.cyan.opacity(0.25 + min(1, max(0, level)) * 0.75))
                        .frame(maxWidth: .infinity).frame(height: 2 + CGFloat(min(1, max(0, level))) * 58)
                }
                if history.isEmpty { Text("No audio measured yet.").jvText(JV.F.body, JV.C.text2) }
            }
            .frame(height: 60, alignment: .bottom)
            .accessibilityElement().accessibilityLabel("Input level history")
        }
    }

    private var transcript: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Text("08").jvText(JV.F.index, JV.C.textIndex)
                Text("Live transcription").jvText(JV.F.panelTitle, JV.C.cyan, uppercase: true)
            }
            ScrollView {
                Text(voice.transcript.isEmpty ? "Listening…" : voice.transcript)
                    .font(JV.F.hud(34, .light)).tracking(-0.2).lineSpacing(21)
                    .foregroundStyle(voice.transcript.isEmpty ? JV.C.text3 : JV.C.text1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            if let notice = model.voiceNotice { Text(notice).font(JV.F.mono(10)).foregroundStyle(JV.C.text2).fixedSize(horizontal: false, vertical: true) }
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Text("BOUND TO THIS CAPTURE · SPEECH DRAFTS, NEVER RUNS").font(JV.F.mono(9.5)).foregroundStyle(JV.C.text2)
            Spacer()
            Button { model.muteVoice() } label: { HStack(spacing: 8) { Text("Cancel"); Keycap(label: "ESC", color: JV.C.text2) } }
                .buttonStyle(.hud(.ghost)).keyboardShortcut(.cancelAction)
            Button { voice.finishListening() } label: { HStack(spacing: 8) { Text("Finish"); Keycap(label: "⏎", color: JV.C.cyanInk) } }
                .buttonStyle(.hud(.primary)).keyboardShortcut(.defaultAction)
        }
        .padding(.top, 12)
    }

    /// "● CLOUD CAPTURE · {model}" with the speech model only when the voice service has reported one.
    nonisolated static func captureLine(model: String?) -> String {
        guard let model = VoicePresence.modelLabel(model) else { return "CLOUD CAPTURE" }
        return "CLOUD CAPTURE · \(model.uppercased())"
    }

    /// mm:ss.s
    nonisolated static func elapsed(_ seconds: TimeInterval) -> String {
        let value = max(0, seconds)
        return String(format: "%02d:%04.1f", Int(value) / 60, value.truncatingRemainder(dividingBy: 60))
    }

    /// The level as decibels relative to full scale, or nil at silence, where a figure would be meaningless.
    nonisolated static func decibels(_ rms: Double) -> String? {
        guard rms.isFinite, rms > 0.000_1 else { return nil }
        return String(format: "%.0f dBFS", 20 * log10(min(1, rms)))
    }
}
