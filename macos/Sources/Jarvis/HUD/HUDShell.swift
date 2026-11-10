import SwiftUI

/// The app's window content in the HUD design: instrument chrome, the top bar, then the selected screen.
/// The Command Deck is drawn natively here. The other tabs still host their existing views inside the chrome
/// until each is rebuilt to the handoff.
struct HUDShell: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: VoiceController
    @ObservedObject private var supervisor = RuntimeSupervisor.shared
    /// Off in rendered snapshots, where a web view cannot be captured.
    var presence = true
    @AppStorage("Jarvis.assistantEnabled") private var assistantPreference = false
    @AppStorage("Jarvis.hudScanlines") private var scanlines = true

    private var assistantAvailable: Bool { _ = assistantPreference; return AssistantFeatures.assistant }
    private var tabs: [WorkspaceTab] { WorkspaceTab.hud(assistant: assistantAvailable, classic: false) }
    private var operations: [DeckOperation] { DeckData.operations(from: model.rooms.state) }
    private var decisions: [DeckDecision] {
        DeckData.decisions(tasks: model.tasks, questions: model.rooms.questions, rooms: model.rooms.state?.rooms ?? [],
                           proposals: model.assistant.visibleProposals)
    }

    var body: some View {
        HUDScreen(tickerText: DeckData.ticker(supervisor: supervisor.state.rawValue, connected: model.isConnected, model: model.modelName,
                                              voice: DeckData.voiceWord(state: voice.state, consent: voice.cloudConsentGranted),
                                              operations: operations, decisions: decisions.count), scanlines: scanlines) {
            VStack(spacing: 0) {
                HUDTopBar(model: model, voice: voice, tabs: tabs, questionCount: model.rooms.questions.count)
                    .frame(height: JV.S.topBarHeight)
                    .padding(.top, JV.S.topBarY - JV.S.ruler)
                    .padding(.leading, JV.S.contentInsetLeading).padding(.trailing, JV.S.contentInsetTrailing)
                // Header rule: bright at both ends, faint through the middle.
                LinearGradient(stops: [.init(color: JV.C.cyan.opacity(0.5), location: 0), .init(color: JV.C.cyan.opacity(0.08), location: 0.3),
                                       .init(color: JV.C.cyan.opacity(0.08), location: 0.7), .init(color: JV.C.cyan.opacity(0.5), location: 1)],
                               startPoint: .leading, endPoint: .trailing)
                    .frame(height: 1).padding(.top, 10)
                    .padding(.leading, JV.S.contentInsetLeading).padding(.trailing, JV.S.contentInsetTrailing)
                if model.stopPhase != .idle {
                    StopAllBanner(phase: model.stopPhase, retry: { Task { await model.stopAll() } }, dismiss: { model.dismissStopBanner() })
                        .padding(.leading, JV.S.contentInsetLeading).padding(.trailing, JV.S.contentInsetTrailing)
                }
                if model.tab == .deck {
                    DeckView(model: model, voice: voice, operations: operations, decisions: decisions, presence: presence)
                        .padding(.top, 16)
                        .padding(.leading, JV.S.contentInsetLeading).padding(.trailing, JV.S.contentInsetTrailing).padding(.bottom, 14)
                } else {
                    WorkspaceView(model: model, voice: voice, chrome: false)
                        .padding(.top, 8).padding(.leading, JV.S.ruler + 1)
                }
            }
        }
        .tint(JV.C.cyan)
        .overlay {
            if let open = lock {
                AuthorizationLockView(model: model, task: open.entry.task, approval: open.entry.approval, position: open.index + 1, total: queue.count,
                                      close: { model.openDecisionID = nil })
                    .transition(.opacity)
            }
        }
        .animation(JV.M.overlayIn, value: model.openDecisionID)
        .onChange(of: queue.map { $0.approval.id }) { _, waiting in
            // When the open decision is settled, the next one in the queue takes its place; with none left the lock closes.
            guard let open = model.openDecisionID, !waiting.contains(open) else { return }
            model.openDecisionID = waiting.first
        }
    }

    private var queue: [(task: AgentTask, approval: Approval)] { AuthorizationData.queue(tasks: model.tasks) }
    private var lock: (entry: (task: AgentTask, approval: Approval), index: Int)? {
        guard let id = model.openDecisionID, let index = queue.firstIndex(where: { $0.approval.id == id }) else { return nil }
        return (queue[index], index)
    }
}

/// Brand, tabs, clock and the live status grid.
struct HUDTopBar: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: VoiceController
    @ObservedObject private var supervisor = RuntimeSupervisor.shared
    let tabs: [WorkspaceTab]
    let questionCount: Int
    private static let launched = Date()

    var body: some View {
        HStack(spacing: 26) {
            brand
            HStack(spacing: 16) { ForEach(tabs) { tab in tabButton(tab) } }
            Spacer(minLength: 8)
            clock
            Spacer(minLength: 8)
            status
        }
    }

    private var brand: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().stroke(JV.C.cyan.opacity(0.6), lineWidth: 1).shadow(color: JV.C.cyan.opacity(0.6), radius: 7)
                Circle().fill(JV.C.cyan).frame(width: 12, height: 12).shadow(color: JV.C.cyan, radius: 5)
            }.frame(width: 30, height: 30).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text("JARVIS").jvText(JV.F.wordmark, JV.C.cyan50).shadow(color: JV.C.cyan.opacity(0.7), radius: 8)
                Text(DeckData.firstName(NSFullUserName()).map { "PERSONAL INTELLIGENCE · \($0)" } ?? "PERSONAL INTELLIGENCE")
                    .jvText((JV.F.hud(8, .medium), 2.6), JV.C.text2)
            }
        }
        .fixedSize()
        .accessibilityElement(children: .combine)
    }

    private func tabButton(_ tab: WorkspaceTab) -> some View {
        let active = model.tab == tab || (tab == .capabilities && model.tab == .privacy)
        return Button { model.tab = tab } label: {
            HStack(spacing: 5) {
                Text(tab.hudTitle).jvText((JV.F.hud(10.5), 2.4), active ? JV.C.text1 : JV.C.text2)
                if tab == .rooms && questionCount > 0 {
                    Text("\(questionCount)").font(JV.F.mono(9, .medium)).foregroundStyle(JV.C.amber)
                }
            }
            .frame(height: JV.S.topBarHeight)
            .overlay(alignment: .bottom) {
                Rectangle().fill(active ? JV.C.cyan : Color.clear).frame(height: 2).shadow(color: active ? JV.C.cyan : .clear, radius: 4).padding(.bottom, 4)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tab == .rooms && questionCount > 0 ? "\(tab.hudTitle), \(questionCount) questions waiting" : tab.hudTitle)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private var clock: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let parts = Self.clockParts(context.date)
            VStack(spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text(parts.minutes).jvText(JV.F.clock, JV.C.text1)
                    Text(parts.seconds).jvText(JV.F.clock, JV.C.cyan)
                }
                Text(DeckData.dateLine(context.date)).jvText((JV.F.hud(8, .medium), 2.4), JV.C.text2)
            }
        }
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Clock")
    }

    nonisolated static func clockParts(_ date: Date, timeZone: TimeZone = .current) -> (minutes: String, seconds: String) {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "HH:mm"
        let minutes = formatter.string(from: date)
        formatter.dateFormat = ":ss"
        return (minutes, formatter.string(from: date))
    }

    /// Six cells, each a fact the app can vouch for right now.
    private var status: some View {
        let worker = model.rooms.state?.worker
        return TimelineView(.periodic(from: .now, by: 1)) { context in
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 5) {
                GridRow {
                    cell(model.isConnected ? .ok : .attention, "BRIDGE", ":39202")
                    cell(supervisor.state == .ready ? .ok : supervisor.state == .failed ? .error : .attention, "RUNTIME", supervisor.state == .ready ? ":39201" : supervisor.state.rawValue.uppercased())
                    cell(keyLED, "MODEL KEY", keyText)
                }
                GridRow {
                    cell(voice.cloudConsentGranted ? .ok : .off, "VOICE CONSENT", voice.cloudConsentGranted ? "✓" : "OFF")
                    cell(worker?.available == true ? .ok : .off, "WORKERS", worker?.available == true ? "READY" : "OFF")
                    cell(.off, "SESSION", DeckData.elapsed(context.date.timeIntervalSince(Self.launched)))
                }
            }
        }
        .fixedSize()
    }

    private var hasKey: Bool? { supervisor.externallyManaged ? model.providerConfigured : supervisor.providerConfigured }
    private var keyLED: StatusLED.State { hasKey == true ? .ok : hasKey == false ? .attention : .off }
    private var keyText: String { hasKey == true ? "SAVED" : hasKey == false ? "MISSING" : "—" }

    private func cell(_ led: StatusLED.State, _ label: String, _ value: String) -> some View {
        HStack(spacing: 6) {
            StatusLED(state: led, size: 5)
            Text(label).font(JV.F.mono(9, .medium)).foregroundStyle(JV.C.text2)
            Text(value).font(JV.F.mono(9, .medium)).foregroundStyle(led == .attention ? JV.C.amber : led == .error ? JV.C.red : JV.C.cyan200)
        }
        .lineLimit(1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label) \(value)")
    }
}
