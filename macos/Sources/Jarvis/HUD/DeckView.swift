import SwiftUI

/// The Command Deck (handoff screen 6a): what needs you, what is running, the core, and the place to say or type
/// the next thing. Every figure and line comes from the app's real state. A panel with nothing real to show says
/// so in one quiet line; nothing is ever filled in to look busy.
struct DeckView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: VoiceController
    @ObservedObject private var rooms: RoomsModel
    @ObservedObject private var assistant: AssistantModel
    let operations: [DeckOperation]
    let decisions: [DeckDecision]
    var presence: Bool
    @State private var command = ""
    @State private var disclosure = false
    @FocusState private var commandFocused: Bool

    init(model: AppModel, voice: VoiceController, operations: [DeckOperation], decisions: [DeckDecision], presence: Bool = true) {
        self.model = model
        self.voice = voice
        self.operations = operations
        self.decisions = decisions
        self.presence = presence
        _rooms = ObservedObject(wrappedValue: model.rooms)
        _assistant = ObservedObject(wrappedValue: model.assistant)
    }

    private var mode: CoreView.Mode {
        CoreView.Mode(voice.state, wakeArmed: voice.wakeWordEnabled, decisionOnScreen: model.openDecisionID != nil)
    }
    private var entries: [AssistantThreadEntry] {
        AssistantThread.entries(turns: assistant.visibleTurns, presentations: assistant.visiblePresentations)
    }
    private var liveRooms: Int { operations.filter { if case .running = $0.phase { return true } else { return false } }.count }

    var body: some View {
        GeometryReader { geometry in
            let column: CGFloat = geometry.size.width < 1_240 ? 300 : JV.S.columnWidth
            let centerWidth = max(260, geometry.size.width - column * 2 - JV.S.gutter * 2)
            let coreHeight = max(240, geometry.size.height - 142 - JV.S.gutter - 96)
            VStack(spacing: JV.S.gutter) {
                HStack(alignment: .top, spacing: JV.S.gutter) {
                    VStack(spacing: JV.S.gutter) { needsYou; threads; Spacer(minLength: 0) }.frame(width: column)
                    center(diameter: min(520, centerWidth - 8, coreHeight)).frame(width: centerWidth)
                    VStack(spacing: JV.S.gutter) { operationsPanel; Spacer(minLength: 0) }.frame(width: column)
                }
                .frame(maxHeight: .infinity)
                HStack(spacing: JV.S.gutter) {
                    comms.frame(maxWidth: .infinity, maxHeight: .infinity)
                    commandPanel.frame(maxWidth: .infinity, maxHeight: .infinity)
                    stopAll.frame(width: 210).frame(maxHeight: .infinity)
                }
                .frame(height: 142)
            }
        }
        .cloudVoiceDisclosure(isPresented: $disclosure, voice: voice) { startListening() }
    }

    // MARK: Centre

    private func center(diameter: CGFloat) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Rectangle().fill(LinearGradient(colors: [.clear, JV.C.cyan], startPoint: .leading, endPoint: .trailing)).frame(width: 12, height: 1)
                Text("VOICE · \(DeckData.voiceWord(state: voice.state, consent: voice.cloudConsentGranted))").jvText(JV.F.panelTitle, JV.C.cyan)
                Rectangle().fill(LinearGradient(colors: [JV.C.cyan, .clear], startPoint: .leading, endPoint: .trailing)).frame(width: 12, height: 1)
            }
            Button { pressCore() } label: {
                CoreView(mode: mode, diameter: diameter, inputRMS: rooms.audioLevels.inputRMS, playbackRMS: rooms.audioLevels.playbackRMS,
                         presence: presence, labelled: diameter >= 300, detail: coreDetail)
            }
            .buttonStyle(.plain)
            .disabled(voice.isRequestingPermission || model.pendingActions.contains("voice-start"))
            .help(VoicePresence.micHelp(micAction))
            .accessibilityLabel(VoicePresence.micHelp(micAction))
            HStack(spacing: 10) {
                chip("hand.raised", "DECISIONS \(decisions.count)", tint: decisions.isEmpty ? JV.C.cyan : JV.C.amber) { openFirstDecision() }
                    .disabled(decisions.isEmpty)
                chip("circle.hexagongrid", liveRooms > 0 ? "ROOMS \(liveRooms) LIVE" : "ROOMS \(operations.count)", tint: JV.C.cyan) { model.tab = .rooms }
                chip("brain.head.profile", "MEMORY", tint: JV.C.cyan) { model.tab = .memory }
            }
        }
        .frame(maxHeight: .infinity)
    }

    /// The line under the core's title while standing by: only what is true about the microphone and wake word.
    private var coreDetail: String? {
        guard mode == .standby || mode == .armed else { return nil }
        return "MIC \(voice.cloudConsentGranted ? "READY" : "OFF") · WAKE \(voice.wakeWordEnabled ? "ON" : "OFF")"
    }

    private var micAction: VoicePresence.MicAction {
        VoicePresence.micAction(consent: voice.cloudConsentGranted, listening: voice.isListening,
                                dictationActive: voice.dictationActive, speaking: voice.isSpeaking)
    }

    /// The core is the microphone. It follows exactly the same steps as the app's single voice control,
    /// including the disclosure before any audio leaves the Mac.
    private func pressCore() {
        switch micAction {
        case .askConsent: disclosure = true
        case .finish: voice.finishListening()
        case .interruptAndListen, .listen: startListening()
        }
    }
    private func startListening() { Task { await model.startManualListening() } }

    private func chip(_ icon: String, _ label: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: icon).font(.system(size: 13))
                Text(label).font(JV.F.hud(9.5)).tracking(2)
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 11).padding(.vertical, 7)
            .background(tint.opacity(0.05))
            .overlay(Rectangle().stroke(tint.opacity(0.35), lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Left column

    private var needsYou: some View {
        HUDPanel(index: "01", title: "Needs you", meta: decisions.isEmpty ? "CLEAR" : "\(decisions.count) OPEN", metaLED: decisions.isEmpty ? .ok : .attention) {
            if decisions.isEmpty {
                quiet("Nothing is waiting on you.")
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(decisions.prefix(4)) { decision in
                        Button { open(decision) } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: decision.kind == .question ? "questionmark.circle" : "hand.raised").font(.system(size: 14)).foregroundStyle(JV.C.amber)
                                    .frame(width: 28, height: 28).background(JV.C.amber.opacity(0.06)).overlay(Rectangle().stroke(JV.C.amber.opacity(0.45), lineWidth: 1))
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(decision.title).jvText(JV.F.body).lineLimit(2).multilineTextAlignment(.leading)
                                    Text(decision.origin).font(JV.F.mono(9.5)).foregroundStyle(JV.C.text2).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                    if decisions.count > 4 { quiet("and \(decisions.count - 4) more") }
                }
            }
        }
    }

    private var threads: some View {
        let sessions = assistant.sessions.sorted { $0.updatedAt > $1.updatedAt }
        return HUDPanel(index: "02", title: "Threads", meta: sessions.isEmpty ? nil : "\(sessions.count)") {
            if sessions.isEmpty {
                quiet("No conversations yet. Say or type something below.")
            } else {
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(sessions.prefix(5), id: \.id) { session in
                        Button { assistant.selectSession(session.id); model.tab = .assistant } label: {
                            HStack(spacing: 10) {
                                Text(session.id == assistant.selectedSessionID ? "◆" : "◇").font(JV.F.mono(10)).foregroundStyle(JV.C.cyan)
                                Text(session.title).jvText(JV.F.body, session.id == assistant.selectedSessionID ? JV.C.text1 : JV.C.text2).lineLimit(1)
                                Spacer(minLength: 0)
                                Text(DeckData.clock(session.updatedAt)).font(JV.F.mono(9.5)).foregroundStyle(JV.C.text3)
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: Right column

    private var operationsPanel: some View {
        let available = rooms.state?.worker.available == true
        return HUDPanel(index: "03", title: "Operations", meta: available ? "WORKERS READY · NO NET" : "WORKERS OFF", metaLED: available ? .ok : .off) {
            if operations.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    quiet("No rooms yet. A room plans and runs longer work in isolation.")
                    Button("Open rooms") { model.tab = .rooms }.buttonStyle(.hud(.secondary))
                }
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(operations.prefix(5)) { operation in
                        Button { rooms.selectedRoomId = operation.id; model.tab = .rooms } label: { row(operation) }.buttonStyle(.plain)
                    }
                    if operations.count > 5 { quiet("and \(operations.count - 5) more") }
                }
            }
        }
    }

    private func row(_ operation: DeckOperation) -> some View {
        HStack(spacing: 12) {
            gauge(operation.phase)
            VStack(alignment: .leading, spacing: 5) {
                Text(operation.title).jvText(JV.F.body).lineLimit(1)
                HStack(spacing: 4) {
                    ForEach(Array(operation.workers.prefix(10).enumerated()), id: \.offset) { _, worker in square(worker) }
                    Text(operation.status).jvText(JV.F.micro, operation.phase == .held ? JV.C.amber : JV.C.text2).padding(.leading, operation.workers.isEmpty ? 0 : 4)
                }
            }
            Spacer(minLength: 0)
            if let trailing = operation.trailing { Text(trailing).font(JV.F.mono(9)).foregroundStyle(JV.C.text3) }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(operation.title), \(operation.status.lowercased())")
    }

    @ViewBuilder private func gauge(_ phase: DeckOperation.Phase) -> some View {
        switch phase {
        case .running(let progress):
            RingGauge(value: progress) { Text("\(Int((progress * 100).rounded()))").font(JV.F.mono(10, .medium)).foregroundStyle(JV.C.cyan200) }
        case .held:
            RingGauge(value: 1, color: JV.C.amber) { Image(systemName: "pause.fill").font(.system(size: 9)).foregroundStyle(JV.C.amber) }
        case .ready:
            RingGauge(value: 0, dashed: true) { Image(systemName: "play.fill").font(.system(size: 9)).foregroundStyle(JV.C.cyan) }
        case .drafting:
            RingGauge(value: 0, dashed: true) { Image(systemName: "square.and.pencil").font(.system(size: 9)).foregroundStyle(JV.C.cyan200) }
        case .finished(let ok):
            RingGauge(value: 1, color: ok ? JV.C.cyan : JV.C.text2) { Text(ok ? "✓" : "–").font(JV.F.mono(11, .medium)).foregroundStyle(ok ? JV.C.cyan : JV.C.text2) }
        case .idle:
            RingGauge(value: 0, color: JV.C.text2, dashed: true) { EmptyView() }
        }
    }

    @ViewBuilder private func square(_ worker: DeckOperation.Worker) -> some View {
        switch worker {
        case .done: Rectangle().fill(JV.C.cyan).frame(width: 8, height: 8)
        case .running: Rectangle().fill(JV.C.cyan50).frame(width: 8, height: 8).shadow(color: JV.C.cyan, radius: 3)
        case .asking: Rectangle().fill(JV.C.amber).frame(width: 8, height: 8)
        case .failed: Rectangle().fill(JV.C.red).frame(width: 8, height: 8)
        case .queued: Rectangle().stroke(JV.C.text2, lineWidth: 1).frame(width: 8, height: 8)
        }
    }

    // MARK: Bottom row

    private var comms: some View {
        let lines = DeckData.comms(entries: entries)
        let you = DeckData.firstName(NSFullUserName()) ?? "YOU"
        return HUDPanel(index: "05", title: "Comms", meta: assistant.selectedSession.map { "THREAD · \($0.title.uppercased().prefix(28))" }) {
            if lines.isEmpty {
                quiet(assistant.selectedSession == nil ? "No conversation open." : "Nothing said in this conversation yet.")
            } else {
                Button { model.tab = .assistant } label: {
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(lines) { line in
                            HStack(spacing: 8) {
                                Text(line.time).font(JV.F.mono(11.5)).foregroundStyle(JV.C.text3).frame(width: 62, alignment: .leading)
                                Text(line.speaker == .you ? you : "JARVIS").font(JV.F.mono(9)).foregroundStyle(JV.C.cyan200)
                                    .padding(.horizontal, 5).padding(.vertical, 1).frame(width: 58)
                                    .background(line.speaker == .jarvis ? JV.C.cyan.opacity(0.15) : Color.clear)
                                    .overlay(Rectangle().stroke(JV.C.cyan.opacity(line.speaker == .you ? 0.45 : 0), lineWidth: 1))
                                Text(line.text).font(JV.F.mono(11.5)).foregroundStyle(JV.C.text1).lineLimit(1).truncationMode(.tail)
                                Spacer(minLength: 0)
                            }
                        }
                    }.contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Open the full conversation")
            }
        }
    }

    private var commandPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Text("›").font(JV.F.mono(20, .medium)).foregroundStyle(JV.C.cyan).shadow(color: JV.C.cyan.opacity(0.7), radius: 8)
                TextField("", text: $command, prompt: Text("Speak or type a command").foregroundColor(JV.C.text1.opacity(0.42)))
                    .textFieldStyle(.plain).font(JV.F.hud(17, .light)).foregroundStyle(JV.C.text1)
                    .focused($commandFocused)
                    .onSubmit { send() }
                    .disabled(!model.isConnected)
                    .accessibilityLabel("Command")
                levelBars
                Image(systemName: VoicePresence.symbol(state: voice.state, consent: voice.cloudConsentGranted)).font(.system(size: 15)).foregroundStyle(JV.C.cyan)
                    .accessibilityHidden(true)
            }
            if let reason = blockedReason { Text(reason).font(JV.F.mono(9.5)).foregroundStyle(JV.C.amber).lineLimit(2) }
            Spacer(minLength: 0)
            HStack(spacing: 14) {
                hint("⌃⌥␣", "TALK"); hint("⏎", "SEND"); hint("⌘.", "STOP ALL")
                Spacer(minLength: 0)
                Button("Send") { send() }.buttonStyle(.hud(.primary)).disabled(command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || blockedReason != nil)
                    .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(JV.S.panelPadding)
        .background(LinearGradient(colors: [JV.C.glassTop, JV.C.glassBottom], startPoint: .top, endPoint: .bottom))
        .overlay(Rectangle().stroke(commandFocused ? JV.C.lineActive : JV.C.lineStrong, lineWidth: 1))
        .overlay(CornerAccents())
        .shadow(color: JV.C.cyan.opacity(0.08), radius: 40)
        .background(Button("") { commandFocused = true }.keyboardShortcut("l", modifiers: .command).opacity(0).accessibilityHidden(true))
    }

    /// Why a typed command cannot be sent right now, or nil when it can.
    private var blockedReason: String? {
        if !AssistantFeatures.assistant { return "Turn on the assistant in Settings to use the command bar." }
        if !model.isConnected { return "Jarvis's local services are not answering yet." }
        if model.providerConfigured == false { return "Add a model key in setup before Jarvis can answer." }
        if assistant.submitting { return "Sending…" }
        return nil
    }

    private func send() {
        let text = command
        guard blockedReason == nil, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        command = ""
        Task { await model.sendFromDeck(text) }
    }

    /// Five bars driven by the measured microphone level. At silence, or with the microphone off, they are flat.
    private var levelBars: some View {
        let level = voice.isListening ? rooms.audioLevels.inputRMS : 0
        return HStack(alignment: .bottom, spacing: 2) {
            ForEach(0..<5, id: \.self) { index in
                Rectangle().fill(JV.C.cyan.opacity(level * 5 > Double(index) ? 1 : 0.2))
                    .frame(width: 3, height: 4 + CGFloat(index) * 3)
            }
        }
        .frame(height: 18, alignment: .bottom)
        .accessibilityHidden(true)
    }

    private func hint(_ key: String, _ label: String) -> some View {
        HStack(spacing: 6) { Keycap(label: key); Text(label).jvText(JV.F.micro, JV.C.text2) }
    }

    private var stopAll: some View {
        Button { Task { await model.stopAll() } } label: {
            VStack(spacing: 8) {
                Image(systemName: "stop.circle").font(.system(size: 26))
                Text("STOP ALL").font(JV.F.hud(15)).tracking(5).shadow(color: JV.C.red.opacity(0.6), radius: 8)
                HStack(spacing: 4) { Keycap(label: "⌘", color: JV.C.red); Keycap(label: ".", color: JV.C.red) }
                Text("MUTES · CANCELS · NO ROLLBACK").font(JV.F.mono(8.5)).opacity(0.75)
            }
            .foregroundStyle(JV.C.red)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(HazardStripes(color: JV.C.red.opacity(0.10)))
            .overlay(Rectangle().stroke(JV.C.red.opacity(0.55), lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.pendingActions.contains("stop-all"))
        .help("Stop voice and request cancellation of all work (⌘.). Completed actions cannot be undone.")
        .accessibilityLabel("Stop all. Mutes voice and requests cancellation of all work. Completed actions cannot be undone.")
    }

    // MARK: Helpers

    private func quiet(_ text: String) -> some View {
        Text(text).jvText(JV.F.body, JV.C.text2).fixedSize(horizontal: false, vertical: true)
    }

    private func openFirstDecision() { if let first = decisions.first { open(first) } }

    private func open(_ decision: DeckDecision) {
        switch decision.kind {
        case .question: model.tab = .rooms
        // An approval is decided on the authorization lock, in front of everything else.
        case .approval: model.openDecisionID = decision.reference
        case .proposal: model.tab = AssistantFeatures.assistant ? .assistant : .workspace
        }
    }
}
