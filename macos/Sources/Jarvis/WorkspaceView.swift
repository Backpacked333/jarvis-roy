import SwiftUI
import AppKit

/// The shell's colour names, all taken from the shared theme.
private enum Palette {
    static let background = JarvisTheme.Colors.background
    static let panel = JarvisTheme.Colors.panel
    static let line = JarvisTheme.Colors.line
    static let cyan = JarvisTheme.Colors.accent
    static let muted = JarvisTheme.Colors.muted
    static let amber = JarvisTheme.Colors.warning
}

struct WorkspaceView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: VoiceController
    @ObservedObject private var supervisor = RuntimeSupervisor.shared
    /// False when the HUD shell supplies the navigation and header, and this view only hosts a tab's content.
    var chrome = true
    @State private var showingPrivacy = false
    @State private var memoryToDelete: MemoryEntry?
    @State private var questionAnswers: [String: String] = [:]
    @AppStorage("Jarvis.assistantEnabled") private var assistantPreference = false
    @AppStorage("Jarvis.memoryEnabled") private var memoryPreference = false

    private var assistantAvailable: Bool { _ = assistantPreference; return AssistantFeatures.assistant }
    private var memoryAvailable: Bool { _ = memoryPreference; return AssistantFeatures.memory }

    var body: some View {
        HStack(spacing: 0) {
            if chrome {
                sidebar
                Rectangle().fill(Palette.line).frame(width: 1)
            }
            VStack(spacing: 0) {
                if chrome {
                    header
                    Rectangle().fill(Palette.line).frame(height: 1)
                }
                if let error = model.error {
                    notice(error, icon: "exclamationmark.triangle", color: Palette.amber)
                }
                if let error = voice.error {
                    notice(error, icon: "mic.badge.xmark", color: Palette.amber)
                }
                // While services are starting or have failed, the banner above the workspace already says so.
                if !model.isConnected && (supervisor.state == .ready || supervisor.externallyManaged) {
                    notice(model.connectionError ?? "Connecting to the local agent service…", icon: "network", color: Palette.amber)
                }
                switch model.tab {
                case .deck:
                    DeckView(model: model, voice: voice, operations: DeckData.operations(from: model.rooms.state),
                             decisions: DeckData.decisions(tasks: model.tasks, questions: model.rooms.questions, rooms: model.rooms.state?.rooms ?? [],
                                                           proposals: model.assistant.visibleProposals), presence: false)
                        .padding(18)
                case .today: TodayWorkspaceView(app: model, assistant: model.assistant)
                case .assistant: AssistantWorkspaceView(model: model, assistant: model.assistant, voice: voice)
                case .rooms:
                    RoomsWorkspaceView(model: model.rooms, onVoiceContext: { _ in },
                        onSpeakQuestion: { model.speakQuestion($0) },
                        onReviewApproval: { approval in Task { await model.reviewApproval(approval) } },
                        observationOwnership: .application)
                case .workspace: workspace
                case .capabilities:
                    if chrome { capabilities } else { trust }
                case .memory:
                    if memoryAvailable {
                        MemoryWorkspaceView(projectID: model.assistant.selectedSession?.focus.projectID, client: model.assistant.client)
                            .id(model.assistant.selectedSession?.focus.projectID ?? "personal")
                    } else { memory }
                case .privacy: privacy
                }
            }
        }
        .background(chrome ? Palette.background : Color.clear)
        .tint(Palette.cyan)
        // Inside the HUD, any control that does not style itself takes the HUD's square buttons.
        .buttonStyle(JarvisButtonStyle(kind: .secondary))
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
            Text("A PERSONAL ASSISTANT").font(.system(size: 10, weight: .medium)).tracking(2).foregroundStyle(Palette.muted)
            Text("YOUR SPACE").font(.system(size: 10, weight: .medium)).tracking(1.8).foregroundStyle(Palette.muted).padding(.top, 50).padding(.bottom, 15)
            ForEach(WorkspaceTab.available(assistant: assistantAvailable)) { tab in
                Button { model.tab = tab } label: {
                    HStack(spacing: 12) {
                        Image(systemName: tab.icon).frame(width: 18)
                        Text(tab.title).font(.system(size: 13, weight: .medium))
                        Spacer()
                        if tab == .workspace && model.approvalCount > 0 {
                            Text("\(model.approvalCount)").font(.caption2).foregroundStyle(Palette.amber)
                        }
                    }
                    .foregroundStyle(model.tab == tab ? Palette.cyan : Palette.muted)
                    .padding(12)
                    .background(model.tab == tab ? Palette.cyan.opacity(0.075) : .clear, in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(RoundedRectangle(cornerRadius: 8))
                }.buttonStyle(.plain).padding(.bottom, 6)
                    .accessibilityLabel(tab.title).accessibilityAddTraits(model.tab == tab ? .isSelected : [])
            }
            Button { Task { await model.startNewConversation() } } label: {
                Label("New conversation", systemImage: "plus")
            }.buttonStyle(.plain).foregroundStyle(Palette.cyan).padding(.vertical, 14)
                .disabled(!model.isConnected || model.pendingActions.contains("new-conversation"))
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(model.conversations) { conversation in
                        Button { model.selectConversation(conversation.id) } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(conversation.title).lineLimit(2).font(.system(size: 12))
                                let pending = model.tasks.filter { $0.conversationId == conversation.id && $0.canCancel }
                                if !pending.isEmpty {
                                    Text(pending.contains { !$0.approvals.isEmpty } ? "Needs approval" : "Active / unconfirmed")
                                        .font(.caption2).foregroundStyle(Palette.amber)
                                }
                            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                .background(model.selectedConversationID == conversation.id ? Palette.cyan.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 8))
                        }.buttonStyle(.plain)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 10) {
                Label("You stay in control", systemImage: "lock.shield").font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(0.8))
                Text("Desktop actions wait for your approval. Always.").font(.system(size: 11)).foregroundStyle(Palette.muted).lineSpacing(4)
                Rectangle().fill(Palette.line).frame(height: 1).padding(.vertical, 6)
                Text("LOCAL CONTROL\nCLOUD REASONING").font(.system(size: 10, weight: .medium)).tracking(1.5).foregroundStyle(Palette.muted).lineSpacing(5)
            }.padding(.bottom, 28)
        }.padding(.horizontal, 22).frame(width: 205).background(Palette.panel.opacity(0.5))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 14) {
                Text(model.tab.title).font(.system(size: 14, weight: .medium))
                Spacer()
                if model.tab == .rooms, AssistantFeatures.assistant, model.rooms.selectedRoom != nil {
                    Button("Discuss this room") { Task { await model.discussSelectedRoom() } }.font(.caption)
                }
                if headerMicrophone {
                    HStack(spacing: 8) {
                        VoiceMicButton(model: model, voice: voice, rooms: model.rooms, diameter: 30)
                        Text(listenTitle).font(.system(size: 11)).foregroundStyle(Palette.muted)
                    }
                }
                VoiceMenu(model: model, voice: voice)
                Circle().fill(model.isConnected ? Palette.cyan : Palette.amber).frame(width: 6, height: 6)
                Text(model.isConnected ? "Agent connected" : "Agent offline").font(.system(size: 11)).foregroundStyle(Palette.muted)
                Button { Task { await model.stopAll() } } label: { Label("Stop all", systemImage: "stop.circle") }
                    .font(.caption).foregroundStyle(.red.opacity(0.9))
                    .disabled(model.pendingActions.contains("stop-all"))
                    .help("Stop voice and request cancellation of all work (⌘.). Completed actions cannot be undone.")
            }
            if voice.cloudConsentGranted || voice.wakeWordEnabled {
                Text(voice.wakeStatus).font(.system(size: 10)).foregroundStyle(Palette.muted)
            }
            if voice.handsFreeEnabled {
                Text(voice.handsFreeStatus).font(.system(size: 10)).foregroundStyle(Palette.amber)
            }
            if let notice = model.voiceNotice { Text(notice).font(.system(size: 10)).foregroundStyle(Palette.muted) }
            if let context = voice.capturedContext, model.tab != .assistant {
                Text(captureLabel(context)).font(.system(size: 10, weight: .medium)).foregroundStyle(Palette.cyan)
            }
            if voice.capturedContext != nil, !voice.transcript.isEmpty, model.tab != .assistant {
                Text(voice.transcript).font(.system(size: 13)).lineLimit(3).textSelection(.enabled)
                    .accessibilityLabel("Live transcription: \(voice.transcript)")
                    .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                    .background(Palette.cyan.opacity(0.055), in: RoundedRectangle(cornerRadius: 8))
            }
        }.padding(.horizontal, 24).padding(.vertical, 14)
    }

    /// Conversations carry the microphone beside their composer. Rooms has no
    /// composer, so its microphone lives here; a screen never shows two.
    private var headerMicrophone: Bool { model.tab == .rooms }

    private var listenTitle: String {
        if voice.isListening || voice.dictationActive { return "Finish" }
        if voice.isSpeaking { return "Interrupt and speak" }
        if model.tab == .rooms, model.rooms.selectedRoomId == nil { return "Create a room and speak" }
        return "Speak a goal"
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

    private var workspace: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        if let conversation = model.selectedConversation {
                            Text(conversation.title).font(.title2)
                            if conversation.messages.isEmpty { welcome }
                            ForEach(conversation.messages) { message in
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(message.role == "user" ? "YOU" : "JARVIS").font(.caption).foregroundStyle(Palette.cyan)
                                    if message.role == "user" { Text(message.text).textSelection(.enabled).lineSpacing(5) }
                                    else { MarkdownBlocksView(message.text) }
                                }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Palette.panel, in: RoundedRectangle(cornerRadius: 12))
                            }
                            if let task = model.selectedTask {
                                Divider()
                                taskDetail(task)
                            }
                        } else {
                            welcome
                            Button("Start a conversation") { Task { await model.startNewConversation() } }
                                .disabled(!model.isConnected || model.pendingActions.contains("new-conversation"))
                        }
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
            if let notice = model.voiceNotice { Text(notice).font(.caption).foregroundStyle(Palette.muted) }
            if !model.voiceReview.isEmpty {
                DisclosureGroup("Voice text retained for review") {
                    ScrollView { Text(model.voiceReview).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 120)
                    Button("Add to draft (mutes microphone)") { model.useVoiceReview() }
                }.font(.caption).foregroundStyle(Palette.amber)
            }
            Toggle("Hey Jarvis · opt-in on-device listening", isOn: Binding(
                get: { voice.wakeWordEnabled }, set: { enabled in Task { await model.setWakeEnabled(enabled) } }
            )).toggleStyle(.switch).font(.caption).disabled(model.selectedConversationID == nil)
            HStack(alignment: .bottom, spacing: 12) {
                VoiceMicButton(model: model, voice: voice, rooms: model.rooms, diameter: 40, unavailable: model.selectedConversationID == nil)
                TextField("What would you like to do?", text: $model.draft, axis: .vertical)
                    .textFieldStyle(.plain).font(.system(size: 14)).lineLimit(1...5).padding(.vertical, 10)
                    .disabled(model.selectedConversationID == nil)
                    .onSubmit { Task { await model.send() } }
                Button { Task { await model.send() } } label: {
                    Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)).frame(width: 36, height: 36)
                }.buttonStyle(.borderedProminent).tint(Palette.cyan)
                    .disabled(!model.canSend)
                    .accessibilityLabel("Send in selected conversation")
            }.padding(12).background(Palette.panel, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(voice.isListening ? Palette.cyan.opacity(0.5) : Palette.line))
            HStack {
                Text(model.sendBlockReason ?? "Follow-up in this conversation · approvals require buttons · ⌘. stops all work")
                    .font(.system(size: 10)).foregroundStyle(model.draft.count > 8000 ? Palette.amber : Palette.muted)
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
            Text("Selected thread · tasks & approvals").font(.caption2).foregroundStyle(Palette.muted)
            ScrollView {
                LazyVStack(spacing: 10) {
                    if model.conversationTasks.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Image(systemName: "square.stack.3d.up").font(.title2).foregroundStyle(Palette.muted.opacity(0.6))
                            Text("A clear workspace.").font(.system(size: 12, weight: .medium))
                            Text("Tasks, approvals, and results will appear here as you work.").font(.system(size: 11)).foregroundStyle(Palette.muted).lineSpacing(4)
                        }.padding(.vertical, 24).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    ForEach(model.conversationTasks) { task in
                        Button { model.selectedTaskID = task.id } label: {
                            VStack(alignment: .leading, spacing: 9) {
                                HStack(spacing: 6) {
                                    Circle().fill(statusColor(task)).frame(width: 5, height: 5)
                                    Text(task.statusLabel).font(.system(size: 10, weight: .medium)).foregroundStyle(statusColor(task))
                                }
                                Text(task.title).font(.system(size: 12)).lineLimit(3).multilineTextAlignment(.leading).foregroundStyle(.white.opacity(0.85))
                            }.padding(13).frame(maxWidth: .infinity, alignment: .leading)
                                .background(model.selectedTaskID == task.id ? Palette.cyan.opacity(0.06) : Palette.panel, in: RoundedRectangle(cornerRadius: 9))
                                .overlay(RoundedRectangle(cornerRadius: 9).stroke(model.selectedTaskID == task.id ? Palette.cyan.opacity(0.25) : Palette.line))
                        }.buttonStyle(.plain)
                    }
                }
            }
            Text("\(model.modelName)\nApproval-gated tools").font(.system(size: 10)).foregroundStyle(Palette.muted).lineSpacing(5)
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
            ForEach(task.approvals + (task.questions ?? [])) { approval in
                VStack(alignment: .leading, spacing: 14) {
                    Label(approval.kind == "question" ? "YOUR ANSWER · NOT APPROVAL" : approval.kind == "approval" ? "YOUR APPROVAL" : "UNSUPPORTED REQUEST", systemImage: approval.kind == "approval" ? "hand.raised" : "questionmark.circle").font(.system(size: 10, weight: .semibold)).tracking(1.5).foregroundStyle(Palette.amber)
                    Text(approval.title).font(.system(size: 15, weight: .medium))
                    Text(approval.detail).font(.system(size: 12, design: .monospaced)).textSelection(.enabled).foregroundStyle(.white.opacity(0.8))
                    HStack {
                        ForEach(approval.options) { option in
                            Button(option.label) {
                                Task { await model.act(key: approval.id, path: "v1/tasks/\(task.id)/respond", body: ["interactionId": approval.id, "optionId": option.id, "expectedRevision": String(approval.revision ?? 0)]) }
                            }.disabled(!ApprovalGate.allows(optionID: option.id, reviewable: approval.reviewable,
                                                             pending: model.pendingActions.contains(approval.id), connected: model.isConnected))
                        }
                    }
                    if approval.kind == "question" && approval.allowText == true {
                        let key = "\(task.id):\(approval.id):\(approval.revision ?? 0)"
                        TextField("Answer this exact question (never secrets)", text: Binding(
                            get: { questionAnswers[key] ?? "" }, set: { questionAnswers[key] = $0 }))
                        Button("Send answer · not approval") {
                            let answer = questionAnswers[key] ?? ""
                            Task { await model.act(key: approval.id, path: "v1/tasks/\(task.id)/respond",
                                body: ["interactionId": approval.id, "text": answer, "expectedRevision": String(approval.revision ?? 0)]) }
                        }.disabled(model.pendingActions.contains(approval.id) || !model.isConnected ||
                            (questionAnswers[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    if approval.kind == "other" || (approval.options.isEmpty && approval.allowText != true) {
                        Text("This prompt has no supported response control. Stop the task and start a new conversation with the missing details; ambient text cannot answer pending prompts.")
                            .font(.caption).foregroundStyle(Palette.amber)
                    }
                }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.amber.opacity(0.05), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.amber.opacity(0.25)))
            }
            if let error = task.error { notice(error, icon: "exclamationmark.triangle", color: Palette.amber) }
            if let lateReply = task.lateReply, !lateReply.isEmpty {
                notice("Output observed after cancellation; not a successful result: \(lateReply)", icon: "exclamationmark.triangle", color: Palette.amber)
            }
            if !task.reply.isEmpty && !["completed", "cancelled"].contains(task.status) {
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
                    MarkdownBlocksView(task.reply).font(.system(size: 14))
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

    private var capabilities: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("Capabilities & setup").font(.largeTitle.weight(.light))
                Text("Optional capabilities stay off until you turn them on. Switches and provider keys live in Settings; restart local services there to apply a change. Each capability below shows what it needs.")
                    .foregroundStyle(Palette.muted)
                if let error = model.capabilityError {
                    notice("Capability status unavailable: \(error)", icon: "exclamationmark.triangle", color: Palette.amber)
                }
                if let state = model.capabilityState {
                    Text(state.notice).font(.caption).foregroundStyle(Palette.amber)
                    ForEach(state.capabilities) { capability in
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Text(capability.title).font(.headline)
                                Spacer()
                                Text(capability.stateLabel).font(.caption).foregroundStyle(Palette.amber)
                            }
                            Text(capability.detail).font(.callout).foregroundStyle(Palette.muted)
                            Text(capability.setup).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                        }.padding(20).background(Palette.panel, in: RoundedRectangle(cornerRadius: 12))
                    }
                } else if model.capabilityError == nil {
                    Text("Reading actual runtime configuration…").foregroundStyle(Palette.muted)
                }
                Link("Open macOS Privacy & Security", destination: URL(string: "x-apple.systempreferences:com.apple.preference.security")!)
                Text("Turning a capability on does not grant macOS permission. macOS asks separately, and names Jarvis (or the terminal, if you used the developer launcher); grant only the identity you recognize.").font(.caption).foregroundStyle(Palette.muted)
            }.padding(32).frame(maxWidth: 850, alignment: .leading)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The HUD's Trust tab: what Jarvis may use, and what leaves this Mac, behind one switch.
    private var trust: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button("Capabilities") { showingPrivacy = false }.buttonStyle(.hud(showingPrivacy ? .ghost : .secondary))
                Button("Privacy") { showingPrivacy = true }.buttonStyle(.hud(showingPrivacy ? .secondary : .ghost))
                Spacer()
            }.padding(.horizontal, 32).padding(.top, 14)
            if showingPrivacy { privacy } else { capabilities }
        }
    }

    private var privacy: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                Text("An assistant.\nNot an open door.").font(.system(size: 32, weight: .light))
                privacyRow("Microphone", icon: "mic", text: "Off by default. Opt in to Hey Jarvis for rolling on-device English-US recognition, not a low-power wake model. Automatic command submission needs an idle selected thread and empty draft; otherwise text stays for review. Thread changes mute capture. Background speech is not submitted. Hardware/language support and capture gaps apply.")
                privacyRow("Cloud reasoning", icon: "cloud", text: "Submitted text, recalled memories, and tool results go to the configured model through Vercel AI Gateway. This is not an offline assistant. Your API key stays in the local runtime, not task history.")
                privacyRow("Desktop & account access", icon: "hand.raised", text: "Optional screen/app control, terminal, Mail, Calendar, iMessage sends and supported Home Assistant actions require setup and runtime approval. Approved screen/account content can enter cloud model context. Terminal runs with your user privileges, NOT in a security sandbox. Exact tool arguments must be visible; redacted, missing or oversized actions are deny-only.")
                privacyRow("Stopping work", icon: "stop.circle", text: "Stop all ends speech and asks the agent runtime to cancel active work. Check task status for confirmation. An action already completed—such as opening a page—cannot be undone.")
                privacyRow("Stored on this Mac", icon: "internaldrive", text: "Task history, approved notes, and saved memories remain in the local Jarvis data directory and runtime workflow store. Deleting a memory does not remove past mentions from task history. See the README for full deletion instructions.")
                privacyRow("Preview boundaries", icon: "info.circle", text: "Follow-ups continue the selected conversation. Separate threads have separate model history, but explicitly saved memories are global. Live research requires your Tavily configuration. The analyst drafts from supplied evidence, with no private tools. iMessage is send-only. This is an ad-hoc signed source-build preview, not a signed installer or notarized distribution.")
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
