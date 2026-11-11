import AppKit
import SwiftUI

/// The conversation page: the thread, anything waiting on you, and a floating glass composer.
struct ChatView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: VoiceController
    @ObservedObject var chrome: WorkspaceChrome
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var composerFocused: Bool

    /// Work that is still open, anything waiting on an answer, and the task picked in Activity. Oldest first.
    private var visibleTasks: [AgentTask] {
        let open = model.conversationTasks.filter { task in
            task.canCancel || !task.approvals.isEmpty || !(task.questions ?? []).isEmpty || task.id == model.selectedTaskID
        }
        return Array(open.reversed())
    }

    private var scrollKey: String {
        let conversation = model.selectedConversation
        return "\(conversation?.id ?? "none"):\(conversation?.messages.count ?? 0):\(visibleTasks.map(\.id).joined(separator: ","))"
    }

    var body: some View {
        HStack(spacing: 0) {
            thread
            if chrome.inspectorVisible {
                ActivityPanel(model: model)
                    .frame(width: 272)
                    .padding(.trailing, 8).padding(.bottom, 8)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.22), value: chrome.inspectorVisible)
        .onAppear { composerFocused = true }
        .onChange(of: model.selectedConversationID) { _, _ in composerFocused = true }
    }

    private var thread: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let conversation = model.selectedConversation {
                        if conversation.messages.isEmpty && visibleTasks.isEmpty { welcome }
                        ForEach(conversation.messages) { message in
                            MessageRow(message: message, voice: voice)
                        }
                        ForEach(visibleTasks) { task in
                            TaskCard(model: model, voice: voice, task: task).id("task:" + task.id)
                        }
                    } else {
                        welcome
                    }
                    Color.clear.frame(height: 1).id("thread-end")
                }
                .padding(.horizontal, 28).padding(.top, 8).padding(.bottom, 12)
                .frame(maxWidth: 840)
                .frame(maxWidth: .infinity)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { composer }
            .onAppear { proxy.scrollTo("thread-end", anchor: .bottom) }
            .onChange(of: scrollKey) { _, _ in
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo("thread-end", anchor: .bottom) }
            }
        }
    }

    // MARK: Welcome

    private var welcome: some View {
        VStack(spacing: 18) {
            JarvisOrb(size: 104, listening: voice.isListening, working: model.activeCount > 0, connected: model.isConnected)
            Text(voice.isListening ? "I’m listening." : "What can I help with?")
                .font(.system(size: 30, weight: .semibold)).foregroundStyle(theme.text)
            Text("Talk through an idea or hand off a task. Nothing touches your Mac without your approval.")
                .font(.system(size: 14)).foregroundStyle(theme.muted).multilineTextAlignment(.center)
            if model.selectedConversation == nil {
                Button { Task { await model.startNewConversation() } } label: { Label("Start a conversation", systemImage: "plus") }
                    .buttonStyle(.jarvisPrimary)
                    .disabled(!model.isConnected || model.pendingActions.contains("new-conversation"))
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 10) { suggestions }
                    VStack(spacing: 10) { suggestions }
                }
                .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 36).padding(.bottom, 12)
    }

    @ViewBuilder private var suggestions: some View {
        suggestion("Make a plan", detail: "Turn an idea into clear next steps", icon: "point.3.connected.trianglepath.dotted", prompt: "Help me make a practical plan for ")
        suggestion("Remember something", detail: "Save a preference, with your approval", icon: "brain", prompt: "Remember that ")
        suggestion("Create a note", detail: "Save a draft to your Jarvis folder", icon: "doc.text", prompt: "Write and save a note about ")
    }

    private func suggestion(_ title: String, detail: String, icon: String, prompt: String) -> some View {
        Button {
            model.draft = prompt
            composerFocused = true
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: icon).font(.system(size: 16)).foregroundStyle(theme.accentText)
                Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(theme.text)
                Text(detail).font(.system(size: 12)).foregroundStyle(theme.muted).multilineTextAlignment(.leading)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
        }
        .buttonStyle(SuggestionButtonStyle())
        .frame(minWidth: 180)
    }

    // MARK: Composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.voiceReview.isEmpty { voiceReview }
            HStack(alignment: .bottom, spacing: 10) {
                Button {
                    if voice.isListening { voice.stopListening() } else { Task { await model.startManualListening() } }
                } label: {
                    Image(systemName: voice.isListening ? "stop.fill" : "mic.fill")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(voice.isListening ? theme.warning : theme.text)
                        .frame(width: 46, height: 46)
                        .contentShape(Circle())
                }
                .buttonStyle(PressScaleButtonStyle())
                .jarvisGlass(Circle(), interactive: true)
                .disabled(voice.isRequestingPermission || model.selectedConversationID == nil)
                .help(voice.isListening ? "Stop the microphone" : "Speak to this conversation")
                .accessibilityLabel(voice.isListening ? "Stop microphone" : "Start microphone")

                TextField("Message Jarvis…", text: $model.draft, axis: .vertical)
                    .textFieldStyle(.plain).font(.system(size: 14)).lineLimit(1...6)
                    .foregroundStyle(theme.text)
                    .focused($composerFocused)
                    .disabled(model.selectedConversationID == nil)
                    .onSubmit { Task { await model.send() } }
                    .padding(.horizontal, 18).padding(.vertical, 14)
                    .frame(minHeight: 46)
                    .jarvisGlass(RoundedRectangle(cornerRadius: 23, style: .continuous))
                    .overlay {
                        if model.isSubmitting || voice.isListening || model.conversationTasks.contains(where: \.isActive) {
                            BorderBeam(shape: RoundedRectangle(cornerRadius: 23, style: .continuous), lap: 2.6,
                                       color: voice.isListening ? theme.warning : theme.accentText)
                        }
                    }

                Button { Task { await model.send() } } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(theme.onAccent)
                        .frame(width: 46, height: 46)
                        .background(theme.accentFill, in: Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(PressScaleButtonStyle())
                .disabled(!model.canSend)
                .opacity(model.canSend ? 1 : 0.4)
                .help("Send (Return)")
                .accessibilityLabel("Send in selected conversation")
            }
            HStack(spacing: 8) {
                if let reason = model.sendBlockReason {
                    Label(reason, systemImage: "info.circle").foregroundStyle(theme.warning)
                } else if model.draft.count > 8000 {
                    Label("Keep a task under 8,000 characters.", systemImage: "exclamationmark.circle").foregroundStyle(theme.warning)
                } else {
                    Text("Return to send · ⌥Return for a new line · approvals always need a button").foregroundStyle(theme.faint)
                }
                Spacer(minLength: 8)
                if voice.isSpeaking {
                    Button("Stop speaking") { voice.stopSpeaking() }.buttonStyle(.jarvisGhost)
                }
            }
            .font(.system(size: 11)).lineLimit(2)
            .padding(.horizontal, 6)
        }
        .padding(.horizontal, 28).padding(.top, 10).padding(.bottom, 12)
        .frame(maxWidth: 840)
        .frame(maxWidth: .infinity)
        // Scroll edge: the thread fades out beneath the hint line so it stays readable.
        .background(alignment: .bottom) {
            LinearGradient(colors: [theme.background.opacity(0), theme.background.opacity(0.92)], startPoint: .top, endPoint: .bottom)
                .frame(height: 44).allowsHitTesting(false)
        }
    }

    private var voiceReview: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Voice text kept for your review", systemImage: "text.bubble").font(.system(size: 12, weight: .semibold)).foregroundStyle(theme.warning)
            ScrollView {
                Text(model.voiceReview).font(.system(size: 13)).foregroundStyle(theme.text).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 96)
            Button("Add to draft (mutes microphone)") { model.useVoiceReview() }.buttonStyle(.jarvisCompact)
        }
        .padding(14)
        .jarvisSurface(.panel, radius: 16)
    }
}

/// Scale on press; the label draws everything else.
private struct PressScaleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private struct SuggestionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { SuggestionButtonBody(configuration: configuration) }
}

private struct SuggestionButtonBody: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.theme) private var theme
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        configuration.label
            .background(theme.panel, in: shape)
            .overlay(shape.strokeBorder(hovering ? theme.accent.opacity(0.55) : theme.line, lineWidth: 1))
            .contentShape(shape)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: hovering)
            .onHover { hovering = $0 }
    }
}

// MARK: - Messages

/// One turn of the thread. Your messages sit right on the accent; Jarvis replies sit left on a flat surface.
private struct MessageRow: View {
    let message: ConversationMessage
    @ObservedObject var voice: VoiceController
    @Environment(\.theme) private var theme
    @State private var hovering = false
    @State private var copied = false

    private var fromUser: Bool { message.role == "user" }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if fromUser { Spacer(minLength: 60) }
            else {
                Image(systemName: "sparkle").font(.system(size: 12, weight: .semibold)).foregroundStyle(theme.accentText)
                    .frame(width: 26, height: 26).background(theme.accentSoft, in: Circle())
                    .accessibilityHidden(true)
            }
            VStack(alignment: fromUser ? .trailing : .leading, spacing: 5) {
                Text(message.text)
                    .font(.system(size: 14)).lineSpacing(4).textSelection(.enabled)
                    .foregroundStyle(fromUser ? theme.onAccent : theme.text)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(fromUser ? AnyShapeStyle(theme.accentFill) : AnyShapeStyle(theme.panel),
                                in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(fromUser ? Color.clear : theme.line, lineWidth: 1))
                HStack(spacing: 2) {
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(message.text, forType: .string)
                        copied = true
                        Task { try? await Task.sleep(for: .seconds(1.4)); copied = false }
                    } label: { Image(systemName: copied ? "checkmark" : "doc.on.doc") }
                        .buttonStyle(JarvisIconButtonStyle(size: 24))
                        .help(copied ? "Copied" : "Copy")
                        .accessibilityLabel("Copy message")
                    if !fromUser {
                        Button { voice.speak(message.text) } label: { Image(systemName: "speaker.wave.2") }
                            .buttonStyle(JarvisIconButtonStyle(size: 24))
                            .disabled(!voice.cloudConsentGranted)
                            .help(voice.cloudConsentGranted ? "Read aloud" : "Turn on cloud voice to read aloud")
                            .accessibilityLabel("Read message aloud")
                    }
                    if let when = JarvisFormat.relative(message.createdAt) {
                        Text(when).font(.system(size: 11)).foregroundStyle(theme.faint).padding(.horizontal, 4)
                    }
                }
                .opacity(hovering || copied ? 1 : 0)
                .animation(.easeOut(duration: 0.12), value: hovering)
            }
            if !fromUser { Spacer(minLength: 60) }
        }
        .frame(maxWidth: .infinity, alignment: fromUser ? .trailing : .leading)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(fromUser ? "You" : "Jarvis")
    }
}

// MARK: - Tasks and approvals

/// One piece of work: its status, anything it needs from you, its partial output and its log.
private struct TaskCard: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: VoiceController
    let task: AgentTask
    @Environment(\.theme) private var theme
    @State private var questionAnswers: [String: String] = [:]

    private var needsReview: Bool { !task.approvals.isEmpty || !(task.questions ?? []).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                StatusPill(label: task.statusLabel, color: statusColor, working: task.isActive && task.status != "waiting")
                Spacer(minLength: 8)
                if task.canCancel {
                    Button("Cancel task") { Task { await model.act(key: task.id, path: "v1/tasks/\(task.id)/cancel") } }
                        .buttonStyle(.jarvisCompact)
                        .disabled(model.pendingActions.contains(task.id))
                } else if model.selectedTaskID == task.id {
                    Button { model.selectedTaskID = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(JarvisIconButtonStyle(size: 24))
                        .help("Hide these details").accessibilityLabel("Hide task details")
                }
            }
            Text(task.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(theme.text)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            ForEach(task.approvals + (task.questions ?? [])) { approval in
                approvalCard(approval)
            }
            if let error = task.error {
                NoticeBanner(message: error, icon: "exclamationmark.triangle", tone: .danger)
            }
            if let lateReply = task.lateReply, !lateReply.isEmpty {
                NoticeBanner(message: "Output observed after cancellation; not a successful result: \(lateReply)", icon: "exclamationmark.triangle", tone: .warning)
            }
            if !task.reply.isEmpty && !["completed", "cancelled"].contains(task.status) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("Reply so far").font(.system(size: 12, weight: .semibold)).foregroundStyle(theme.muted)
                        Spacer()
                        Button { voice.speak(task.reply) } label: { Image(systemName: "speaker.wave.2") }
                            .buttonStyle(JarvisIconButtonStyle(size: 24)).accessibilityLabel("Read result aloud").help("Read aloud")
                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(task.reply, forType: .string)
                        } label: { Image(systemName: "doc.on.doc") }
                            .buttonStyle(JarvisIconButtonStyle(size: 24)).accessibilityLabel("Copy result").help("Copy")
                    }
                    Text(task.reply).font(.system(size: 14)).lineSpacing(4).foregroundStyle(theme.text).textSelection(.enabled)
                }
                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .jarvisSurface(.elevated, radius: 12)
            }
            if !task.events.isEmpty {
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(Array(task.events.enumerated()), id: \.offset) { _, event in
                            HStack(alignment: .firstTextBaseline, spacing: 9) {
                                Circle().fill(theme.faint).frame(width: 4, height: 4).offset(y: -3)
                                Text(event).font(.system(size: 12, design: .monospaced)).foregroundStyle(theme.muted).textSelection(.enabled)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
                } label: {
                    Text("Execution log · \(task.events.count) \(task.events.count == 1 ? "step" : "steps")")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(theme.muted)
                }
            }
        }
        .jarvisCard(needsReview ? .warning : .panel, padding: 16, radius: 18)
    }

    private var statusColor: Color {
        if task.status == "failed" { return theme.danger }
        if task.status == "waiting" || task.status == "interrupted" { return theme.warning }
        if task.status == "completed" { return theme.success }
        return task.isActive ? theme.accentText : theme.muted
    }

    /// The exact request and its response controls. Wording and behaviour match the runtime contract.
    private func approvalCard(_ approval: Approval) -> some View {
        let key = "\(task.id):\(approval.id):\(approval.revision ?? 0)"
        let isQuestion = approval.kind == "question"
        let isApproval = approval.kind == "approval"
        return VStack(alignment: .leading, spacing: 12) {
            Label(isQuestion ? "Your answer · not approval" : isApproval ? "Your approval" : "Unsupported request",
                  systemImage: isApproval ? "hand.raised.fill" : "questionmark.circle.fill")
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(theme.warning)
            Text(approval.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(theme.text)
                .fixedSize(horizontal: false, vertical: true)
            Text(approval.detail).font(.system(size: 12, design: .monospaced)).foregroundStyle(theme.text)
                .textSelection(.enabled)
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(theme.trough, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            if let reason = approval.blockedReason, !reason.isEmpty {
                Label(reason, systemImage: "lock").font(.system(size: 12)).foregroundStyle(theme.warning)
            }
            if !approval.options.isEmpty {
                HStack(spacing: 8) {
                    ForEach(approval.options) { option in
                        Button(option.label) {
                            Task { await model.act(key: approval.id, path: "v1/tasks/\(task.id)/respond", body: ["interactionId": approval.id, "optionId": option.id, "expectedRevision": String(approval.revision ?? 0)]) }
                        }
                        .buttonStyle(JarvisButtonStyle(kind: option.id == "approve" ? .primary : .secondary))
                        .disabled(model.pendingActions.contains(approval.id) || !model.isConnected || (approval.reviewable == false && option.id != "deny"))
                    }
                    if model.pendingActions.contains(approval.id) { ProgressView().controlSize(.small) }
                }
            }
            if isQuestion && approval.allowText == true {
                let answer = questionAnswers[key] ?? ""
                let blocked = model.pendingActions.contains(approval.id) || !model.isConnected
                    || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                HStack(spacing: 8) {
                    TextField("Answer this exact question (never secrets)", text: Binding(
                        get: { questionAnswers[key] ?? "" }, set: { questionAnswers[key] = $0 }))
                        .jarvisField()
                        .onSubmit { if !blocked { sendAnswer(answer, approval: approval) } }
                    Button("Send answer · not approval") { sendAnswer(answer, approval: approval) }
                        .buttonStyle(.jarvisPrimary)
                        .disabled(blocked)
                }
            }
            if approval.kind == "other" || (approval.options.isEmpty && approval.allowText != true) {
                Text("This prompt has no supported response control. Stop the task and start a new conversation with the missing details; ambient text cannot answer pending prompts.")
                    .font(.system(size: 12)).foregroundStyle(theme.warning)
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .jarvisSurface(.panel, radius: 14)
    }

    private func sendAnswer(_ answer: String, approval: Approval) {
        Task { await model.act(key: approval.id, path: "v1/tasks/\(task.id)/respond",
            body: ["interactionId": approval.id, "text": answer, "expectedRevision": String(approval.revision ?? 0)]) }
    }
}

// MARK: - Activity

/// The tasks of the selected conversation. Picking one shows its details in the thread.
private struct ActivityPanel: View {
    @ObservedObject var model: AppModel
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Activity").font(.system(size: 13, weight: .semibold)).foregroundStyle(theme.text)
                Spacer()
                if model.activeCount > 0 { StatusPill(label: "\(model.activeCount) active", color: theme.accentText) }
            }
            if model.conversationTasks.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "square.stack.3d.up").font(.system(size: 20, weight: .light)).foregroundStyle(theme.faint)
                    Text("Nothing running").font(.system(size: 13, weight: .medium)).foregroundStyle(theme.text)
                    Text("Tasks, approvals and results for this conversation appear here.")
                        .font(.system(size: 12)).foregroundStyle(theme.muted).lineSpacing(2)
                }
                .padding(.vertical, 12)
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(model.conversationTasks) { task in row(task) }
                    }
                }
                .scrollIndicators(.never)
            }
            Text("\(model.modelName) · approval-gated tools")
                .font(.system(size: 11)).foregroundStyle(theme.faint).lineLimit(2)
        }
        .padding(14)
        .frame(maxHeight: .infinity, alignment: .top)
        .jarvisSurface(.panel, radius: 18)
    }

    private func row(_ task: AgentTask) -> some View {
        let selected = model.selectedTaskID == task.id
        return Button { model.selectedTaskID = selected ? nil : task.id } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Circle().fill(color(task)).frame(width: 6, height: 6)
                    Text(task.statusLabel).font(.system(size: 11, weight: .medium)).foregroundStyle(color(task))
                    Spacer(minLength: 4)
                    if let when = JarvisFormat.relative(task.createdAt) {
                        Text(when).font(.system(size: 11)).foregroundStyle(theme.faint)
                    }
                }
                Text(task.title).font(.system(size: 12)).foregroundStyle(theme.text)
                    .lineLimit(2).multilineTextAlignment(.leading)
            }
            .padding(10)
        }
        .buttonStyle(JarvisRowButtonStyle(selected: selected))
        .help(selected ? "Hide details" : "Show details in the conversation")
        .accessibilityLabel("\(task.title), \(task.statusLabel)")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func color(_ task: AgentTask) -> Color {
        if task.status == "failed" { return theme.danger }
        if task.status == "waiting" || task.status == "interrupted" { return theme.warning }
        if task.status == "completed" { return theme.success }
        return task.isActive ? theme.accentText : theme.muted
    }
}
