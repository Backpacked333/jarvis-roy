import SwiftUI
import AppKit

private enum Palette {
    static let background = Color(red: 0.035, green: 0.047, blue: 0.063)
    static let panel = Color(red: 0.061, green: 0.075, blue: 0.094)
    static let line = Color.white.opacity(0.075)
    static let cyan = Color(red: 0.40, green: 0.88, blue: 0.91)
    static let muted = Color(red: 0.52, green: 0.59, blue: 0.65)
    static let amber = Color(red: 0.97, green: 0.73, blue: 0.39)
}

struct WorkspaceView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: VoiceController
    @State private var memoryToDelete: MemoryEntry?

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Rectangle().fill(Palette.line).frame(width: 1)
            VStack(spacing: 0) {
                header
                Rectangle().fill(Palette.line).frame(height: 1)
                if let error = model.error {
                    notice(error, icon: "exclamationmark.triangle", color: Palette.amber)
                }
                if !model.isConnected {
                    notice(model.connectionError ?? "Connecting to the local agent service…", icon: "network", color: Palette.amber)
                }
                switch model.tab {
                case .workspace: workspace
                case .memory: memory
                case .privacy: privacy
                }
            }
        }
        .background(Palette.background)
        .tint(Palette.cyan)
        .onChange(of: voice.transcript) { _, text in model.draft = text }
        .alert("Delete this memory?", isPresented: Binding(
            get: { memoryToDelete != nil },
            set: { if !$0 { memoryToDelete = nil } }
        ), presenting: memoryToDelete) { entry in
            Button("Cancel", role: .cancel) { memoryToDelete = nil }
            Button("Delete", role: .destructive) {
                Task { await model.act(key: entry.id, path: "v1/memories/\(entry.id)", method: "DELETE") }
                memoryToDelete = nil
            }
        } message: { _ in
            Text("This removes the saved preference. It does not erase mentions in previous task history.")
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "waveform.circle.fill").font(.system(size: 29)).foregroundStyle(Palette.cyan)
                Text("JARVIS").font(.system(size: 19, weight: .semibold)).tracking(4)
            }.padding(.top, 45).padding(.bottom, 8)
            Text("A PERSONAL ASSISTANT").font(.system(size: 9, weight: .medium)).tracking(2).foregroundStyle(Palette.muted)
            Text("YOUR SPACE").font(.system(size: 10, weight: .medium)).tracking(1.8).foregroundStyle(Palette.muted).padding(.top, 50).padding(.bottom, 15)
            ForEach(WorkspaceTab.allCases) { tab in
                Button { model.tab = tab } label: {
                    HStack(spacing: 12) {
                        Image(systemName: tab.icon).frame(width: 18)
                        Text(tab.rawValue).font(.system(size: 13, weight: .medium))
                        Spacer()
                        if tab == .workspace && model.approvalCount > 0 {
                            Text("\(model.approvalCount)").font(.caption2).foregroundStyle(Palette.amber)
                        }
                    }
                    .foregroundStyle(model.tab == tab ? Palette.cyan : Palette.muted)
                    .padding(12)
                    .background(model.tab == tab ? Palette.cyan.opacity(0.075) : .clear, in: RoundedRectangle(cornerRadius: 8))
                }.buttonStyle(.plain).padding(.bottom, 6)
            }
            Spacer()
            VStack(alignment: .leading, spacing: 10) {
                Label("You stay in control", systemImage: "lock.shield").font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(0.8))
                Text("Desktop actions wait for your approval. Always.").font(.system(size: 11)).foregroundStyle(Palette.muted).lineSpacing(4)
                Rectangle().fill(Palette.line).frame(height: 1).padding(.vertical, 6)
                Text("LOCAL CONTROL\nCLOUD REASONING").font(.system(size: 9, weight: .medium)).tracking(1.5).foregroundStyle(Palette.muted).lineSpacing(5)
            }.padding(.bottom, 28)
        }.padding(.horizontal, 22).frame(width: 205).background(Palette.panel.opacity(0.5))
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text(model.tab.rawValue).font(.system(size: 14, weight: .medium))
            Spacer()
            Circle().fill(model.isConnected ? Palette.cyan : Palette.amber).frame(width: 6, height: 6)
            Text(model.isConnected ? "Agent connected" : "Agent offline").font(.system(size: 11)).foregroundStyle(Palette.muted)
            Divider().frame(height: 16).padding(.horizontal, 12)
            Button { Task { await model.stopAll() } } label: {
                Label("Stop all", systemImage: "stop.circle").font(.system(size: 12, weight: .medium))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.red.opacity(0.9))
            .disabled(model.pendingActions.contains("stop-all"))
            .help("Stop speech and cancel active agent work (⌘.). Completed actions cannot be undone.")
        }.padding(.horizontal, 28).frame(height: 74)
    }

    private var workspace: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        if let task = model.selectedTask { taskDetail(task) } else { welcome }
                    }.padding(32).frame(maxWidth: .infinity, alignment: .leading)
                }
                composer
            }
            Rectangle().fill(Palette.line).frame(width: 1)
            activity.frame(width: 260)
        }
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack {
                Spacer()
                StatusOrb(listening: voice.isListening, working: model.activeCount > 0, connected: model.isConnected)
                Spacer()
            }.padding(.top, 20)
            Text(voice.isListening ? "I’m listening." : "Room to think.\nHelp to get it done.")
                .font(.system(size: 37, weight: .light)).tracking(-1).lineSpacing(3)
            Text("Talk through an idea. Hand off a task.\nKeep the final say.")
                .font(.system(size: 14)).foregroundStyle(Palette.muted).lineSpacing(6)
            VStack(spacing: 8) {
                suggestion("Make a plan", detail: "Turn an idea into clear next steps", icon: "point.3.connected.trianglepath.dotted", prompt: "Help me make a practical plan for ")
                suggestion("Remember something", detail: "Save a preference, with your approval", icon: "brain", prompt: "Remember that ")
                suggestion("Create a note", detail: "Save a draft to your Jarvis folder", icon: "doc.text", prompt: "Write and save a note about ")
            }.padding(.top, 6)
        }.frame(maxWidth: 570, alignment: .leading)
    }

    private func suggestion(_ title: String, detail: String, icon: String, prompt: String) -> some View {
        Button { model.draft = prompt } label: {
            HStack(spacing: 14) {
                Image(systemName: icon).foregroundStyle(Palette.cyan).frame(width: 24)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(0.9))
                    Text(detail).font(.system(size: 11)).foregroundStyle(Palette.muted)
                }
                Spacer()
                Image(systemName: "arrow.up.left").font(.system(size: 10)).foregroundStyle(Palette.muted)
            }.padding(14).background(Palette.panel, in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let error = voice.error { Text(error).font(.caption).foregroundStyle(Palette.amber) }
            HStack(alignment: .bottom, spacing: 12) {
                Button {
                    if voice.isListening { voice.stopListening() } else { Task { await voice.startListening() } }
                } label: {
                    Image(systemName: voice.isListening ? "stop.fill" : "mic.fill")
                        .font(.system(size: 15)).frame(width: 38, height: 38)
                        .background(voice.isListening ? Palette.cyan.opacity(0.2) : .white.opacity(0.05), in: Circle())
                }.buttonStyle(.plain).foregroundStyle(Palette.cyan)
                    .disabled(voice.isRequestingPermission)
                    .accessibilityLabel(voice.isListening ? "Stop microphone" : "Start microphone")
                TextField("What would you like to do?", text: $model.draft, axis: .vertical)
                    .textFieldStyle(.plain).font(.system(size: 14)).lineLimit(1...5).padding(.vertical, 10)
                    .onSubmit { Task { await model.send() } }
                Button { Task { await model.send() } } label: {
                    Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)).frame(width: 36, height: 36)
                }.buttonStyle(.borderedProminent).tint(Palette.cyan)
                    .disabled(!model.isConnected || model.isSubmitting || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.draft.count > 8000)
                    .accessibilityLabel("Send task")
            }.padding(12).background(Palette.panel, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(voice.isListening ? Palette.cyan.opacity(0.5) : Palette.line))
            HStack {
                Text(voice.isListening ? "Listening on device · stop, review, then send" : "Each message starts an independent task · ⌘. stops all work")
                    .font(.system(size: 9)).foregroundStyle(model.draft.count > 8000 ? Palette.amber : Palette.muted)
                Spacer()
                Button {
                    model.speakReplies.toggle()
                    if !model.speakReplies { voice.stopSpeaking() }
                } label: {
                    Image(systemName: model.speakReplies ? "speaker.wave.2" : "speaker.slash")
                }.buttonStyle(.plain).foregroundStyle(Palette.muted)
                    .accessibilityLabel(model.speakReplies ? "Mute spoken replies" : "Enable spoken replies")
                if voice.isSpeaking {
                    Button("Stop speaking") { voice.stopSpeaking() }.font(.caption).buttonStyle(.plain)
                }
            }
            if model.draft.count > 8000 { Text("Keep a task under 8,000 characters.").font(.caption).foregroundStyle(Palette.amber) }
        }.padding(24)
    }

    private var activity: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("ACTIVITY").font(.system(size: 10, weight: .semibold)).tracking(2).foregroundStyle(Palette.muted)
                Spacer()
                Text("\(model.activeCount) active").font(.system(size: 10)).foregroundStyle(Palette.cyan)
            }
            Button { model.selectedTaskID = nil } label: { Label("New task", systemImage: "plus") }
                .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Palette.cyan)
            ScrollView {
                LazyVStack(spacing: 10) {
                    if model.tasks.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Image(systemName: "square.stack.3d.up").font(.title2).foregroundStyle(Palette.muted.opacity(0.6))
                            Text("A clear workspace.").font(.system(size: 12, weight: .medium))
                            Text("Tasks, approvals, and results will appear here as you work.").font(.system(size: 11)).foregroundStyle(Palette.muted).lineSpacing(4)
                        }.padding(.vertical, 24).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    ForEach(model.tasks) { task in
                        Button { model.selectedTaskID = task.id } label: {
                            VStack(alignment: .leading, spacing: 9) {
                                HStack(spacing: 6) {
                                    Circle().fill(statusColor(task)).frame(width: 5, height: 5)
                                    Text(task.statusLabel).font(.system(size: 9, weight: .medium)).foregroundStyle(statusColor(task))
                                }
                                Text(task.title).font(.system(size: 12)).lineLimit(3).multilineTextAlignment(.leading).foregroundStyle(.white.opacity(0.85))
                            }.padding(13).frame(maxWidth: .infinity, alignment: .leading)
                                .background(model.selectedTaskID == task.id ? Palette.cyan.opacity(0.06) : Palette.panel, in: RoundedRectangle(cornerRadius: 9))
                                .overlay(RoundedRectangle(cornerRadius: 9).stroke(model.selectedTaskID == task.id ? Palette.cyan.opacity(0.25) : Palette.line))
                        }.buttonStyle(.plain)
                    }
                }
            }
            Text("\(model.modelName)\nApproval-gated tools").font(.system(size: 9)).foregroundStyle(Palette.muted).lineSpacing(5)
        }.padding(20).background(Palette.panel.opacity(0.25))
    }

    private func taskDetail(_ task: AgentTask) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack {
                Label(task.statusLabel, systemImage: task.isActive ? "circle.dotted" : task.status == "completed" ? "checkmark.circle" : "minus.circle")
                    .font(.system(size: 11)).foregroundStyle(statusColor(task))
                Spacer()
                if task.canCancel {
                    Button("Cancel task") { Task { await model.act(key: task.id, path: "v1/tasks/\(task.id)/cancel") } }
                        .disabled(model.pendingActions.contains(task.id)).font(.caption)
                }
            }
            Text(task.title).font(.system(size: 25, weight: .medium)).textSelection(.enabled)
            ForEach(task.approvals) { approval in
                VStack(alignment: .leading, spacing: 14) {
                    Label("YOUR APPROVAL", systemImage: "hand.raised").font(.system(size: 10, weight: .semibold)).tracking(1.5).foregroundStyle(Palette.amber)
                    Text(approval.title).font(.system(size: 15, weight: .medium))
                    Text(approval.detail).font(.system(size: 12, design: .monospaced)).textSelection(.enabled).foregroundStyle(.white.opacity(0.8))
                    HStack {
                        ForEach(approval.options) { option in
                            Button(option.label) {
                                Task { await model.act(key: approval.id, path: "v1/tasks/\(task.id)/respond", body: ["interactionId": approval.id, "optionId": option.id]) }
                            }.disabled(model.pendingActions.contains(approval.id) || !model.isConnected)
                        }
                    }
                }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.amber.opacity(0.05), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.amber.opacity(0.25)))
            }
            if let error = task.error { notice(error, icon: "exclamationmark.triangle", color: Palette.amber) }
            if !task.reply.isEmpty {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text("JARVIS").font(.system(size: 10, weight: .semibold)).tracking(2).foregroundStyle(Palette.cyan)
                        Spacer()
                        Button { voice.speak(task.reply) } label: { Image(systemName: "speaker.wave.2") }
                            .buttonStyle(.plain).accessibilityLabel("Read result aloud")
                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(task.reply, forType: .string)
                        } label: { Image(systemName: "doc.on.doc") }
                            .buttonStyle(.plain).accessibilityLabel("Copy result")
                    }.foregroundStyle(Palette.muted)
                    Text(task.reply).font(.system(size: 14)).lineSpacing(6).textSelection(.enabled)
                }.padding(22).background(Palette.panel, in: RoundedRectangle(cornerRadius: 12))
            }
            if !task.events.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("EXECUTION LOG").font(.system(size: 10, weight: .medium)).tracking(1.5).foregroundStyle(Palette.muted)
                    ForEach(Array(task.events.enumerated()), id: \.offset) { _, event in
                        HStack(alignment: .top, spacing: 10) {
                            Circle().fill(Palette.muted.opacity(0.4)).frame(width: 4, height: 4).padding(.top, 5)
                            Text(event).font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.muted).textSelection(.enabled)
                        }
                    }
                }
            }
        }
    }

    private var memory: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Useful context.\nYours to keep or forget.").font(.system(size: 32, weight: .light))
                Text("Only preferences you explicitly ask Jarvis to remember are saved here, after approval. They live on this Mac and may be sent to the cloud model when recalled.")
                    .font(.system(size: 14)).foregroundStyle(Palette.muted).lineSpacing(5)
                if model.memories.isEmpty {
                    Label("No saved memories yet", systemImage: "brain.head.profile").foregroundStyle(Palette.muted).padding(.vertical, 24)
                }
                ForEach(model.memories) { entry in
                    HStack(alignment: .top, spacing: 20) {
                        Text(entry.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        Button { memoryToDelete = entry } label: { Image(systemName: "trash") }
                            .buttonStyle(.plain).foregroundStyle(Palette.muted).accessibilityLabel("Delete memory")
                            .disabled(model.pendingActions.contains(entry.id))
                    }.padding(20).background(Palette.panel, in: RoundedRectangle(cornerRadius: 12))
                }
            }.padding(36).frame(maxWidth: 850, alignment: .leading)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var privacy: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                Text("An assistant.\nNot an open door.").font(.system(size: 32, weight: .light))
                privacyRow("Microphone", icon: "mic", text: "Off until you press the microphone button. Recognition is on-device only; if unavailable, use text. Review the transcript before sending. No wake-word or always-on recording.")
                privacyRow("Cloud reasoning", icon: "cloud", text: "Submitted text, recalled memories, and tool results go to the configured model through Vercel AI Gateway. This is not an offline assistant. Your API key stays in the local runtime, not task history.")
                privacyRow("Desktop permissions", icon: "hand.raised", text: "Jarvis can propose opening an HTTPS website, saving a note in its own folder, or remembering a preference. Each requires an explicit approval. There is no shell, screen capture, email, or unrestricted file access.")
                privacyRow("Stopping work", icon: "stop.circle", text: "Stop all ends speech and asks the agent runtime to cancel active work. Check task status for confirmation. An action already completed—such as opening a page—cannot be undone.")
                privacyRow("Stored on this Mac", icon: "internaldrive", text: "Task history, approved notes, and saved memories remain in the local Jarvis data directory and runtime workflow store. Deleting a memory does not remove past mentions from task history. See the README for full deletion instructions.")
                privacyRow("First-version boundaries", icon: "info.circle", text: "Tasks are independent, not one continuous conversation. The analyst can draft and reason but cannot browse for live information. Approvals require a click. The app is a source-build preview, not a signed or notarized distribution.")
            }.padding(36).frame(maxWidth: 850, alignment: .leading)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func privacyRow(_ title: String, icon: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 18) {
            Image(systemName: icon).font(.system(size: 19)).foregroundStyle(Palette.cyan).frame(width: 28)
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.system(size: 15, weight: .medium))
                Text(text).font(.system(size: 13)).foregroundStyle(Palette.muted).lineSpacing(5)
            }
        }
    }

    private func notice(_ message: String, icon: String, color: Color) -> some View {
        Label(message, systemImage: icon).font(.system(size: 11)).foregroundStyle(color)
            .padding(12).frame(maxWidth: .infinity, alignment: .leading).background(color.opacity(0.06))
    }

    private func statusColor(_ task: AgentTask) -> Color {
        if task.status == "failed" { return .red.opacity(0.8) }
        if task.status == "waiting" || task.status == "interrupted" { return Palette.amber }
        return task.isActive || task.status == "completed" ? Palette.cyan : Palette.muted
    }
}

private struct StatusOrb: View {
    let listening: Bool
    let working: Bool
    let connected: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        ZStack {
            Circle().fill(Palette.cyan.opacity(0.035)).frame(width: 202, height: 202)
            Circle().stroke(Palette.cyan.opacity(0.08), lineWidth: 1).frame(width: 182, height: 182)
            Circle().stroke(Palette.cyan.opacity(0.15), style: StrokeStyle(lineWidth: 1, dash: [2, 8])).frame(width: 154, height: 154)
            Circle().fill(RadialGradient(colors: [Palette.cyan.opacity(0.2), Palette.cyan.opacity(0.025), .clear], center: .center, startRadius: 0, endRadius: 70)).frame(width: 140, height: 140)
            Circle().stroke(AngularGradient(colors: [Palette.cyan.opacity(0.15), Palette.cyan, Palette.cyan.opacity(0.2)], center: .center), lineWidth: 2).frame(width: 112, height: 112)
                .shadow(color: Palette.cyan.opacity(0.3), radius: 12)
            Image(systemName: listening ? "waveform" : "sparkle").font(.system(size: 32, weight: .ultraLight)).foregroundStyle(Palette.cyan)
        }
        .opacity(connected ? 1 : 0.45)
        .scaleEffect(pulse && (listening || working) && !reduceMotion ? 1.035 : 1)
        .animation(reduceMotion ? nil : .easeInOut(duration: 2.5).repeatForever(autoreverses: true), value: pulse)
        .onAppear { pulse = true }
        .frame(height: 210)
        .accessibilityLabel(listening ? "Listening" : working ? "Tasks active" : connected ? "Ready" : "Disconnected")
    }
}
