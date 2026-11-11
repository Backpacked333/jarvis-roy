import Charts
import SwiftUI

struct AssistantWorkspaceView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var assistant: AssistantModel
    @ObservedObject var voice: VoiceController
    @State private var knowledgeVisible = false
    @State private var memoryVisible = false
    @State private var contextVisible = false
    @State private var contextUsed: ContextUsedTarget?
    @Environment(\.theme) private var theme

    private var sendDisabled: Bool {
        assistant.submitting || assistant.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || assistant.selectedSession == nil
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Menu {
                    ForEach(assistant.sessions) { session in
                        Button(String(session.title.prefix(30))) { assistant.selectSession(session.id) }
                    }
                    Divider()
                    Button("New assistant conversation") { Task { await model.newAssistantConversation() } }
                } label: {
                    Label(assistant.selectedSession?.title ?? "Choose a session", systemImage: "bubble.left.and.bubble.right")
                }
                .menuStyle(.borderlessButton).fixedSize()
                .help("Switch session or start a new one")
                if !assistant.connected {
                    StatusPill(label: "Connecting", color: theme.warning, working: true)
                }
                Spacer(minLength: 8)
                if AssistantFeatures.knowledge {
                    Button { knowledgeVisible.toggle() } label: { Label("Knowledge", systemImage: "books.vertical") }
                        .buttonStyle(.jarvisCompact)
                        .disabled(assistant.selectedSession?.focus.projectID == nil)
                }
                Button { memoryVisible.toggle() } label: { Label("Memory", systemImage: "brain") }
                    .buttonStyle(.jarvisCompact)
                if AssistantFeatures.knowledge || AssistantFeatures.memory {
                    Button { contextVisible.toggle() } label: { Label("Context", systemImage: "list.bullet.rectangle") }
                        .buttonStyle(.jarvisCompact)
                        .disabled(assistant.selectedSession?.focus.projectID == nil)
                }
            }.padding(.horizontal, 22).padding(.top, 4).padding(.bottom, 10)
            if let error = assistant.error {
                NoticeBanner(message: error, icon: "exclamationmark.triangle", tone: .warning, onDismiss: { assistant.error = nil })
                    .padding(.horizontal, 22).padding(.bottom, 8)
            }
            if let notice = assistant.notice {
                NoticeBanner(message: notice, icon: "info.circle", tone: .info, onDismiss: { assistant.notice = nil })
                    .padding(.horizontal, 22).padding(.bottom, 8)
            }
            HSplitView {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if !assistant.visiblePinnedPresentations.isEmpty {
                            SectionHeader(title: "Pinned revisions")
                            ForEach(assistant.visiblePinnedPresentations) { presentation in
                                Button { assistant.selectPinnedPresentation(presentation.id) } label: {
                                    Label("\(presentation.title) · r\(presentation.revision)", systemImage: "pin.fill").lineLimit(2)
                                        .font(.system(size: 12, weight: .medium)).foregroundStyle(theme.text)
                                        .padding(.horizontal, 10).padding(.vertical, 8)
                                }.buttonStyle(JarvisRowButtonStyle(selected: assistant.selectedPresentation?.id == presentation.id))
                            }
                        }
                        if assistant.visibleTurns.isEmpty {
                            EmptyStateView(icon: "waveform", title: "Start with a question",
                                detail: "Discuss a paper, compare evidence, plan work, or prepare an action. Sources and results will appear alongside the conversation.")
                        }
                        ForEach(assistant.visibleTurns) { turn in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(turn.text).font(.system(size: 14)).lineSpacing(3).foregroundStyle(theme.text).textSelection(.enabled)
                                HStack(spacing: 8) {
                                    StatusPill(label: turn.intent == "side_question" ? "Side conversation" : turn.status.capitalized,
                                               color: turn.isSettled ? theme.muted : theme.accentText, working: !turn.isSettled)
                                    if let taskID = turn.taskId, let project = turn.capturedFocus.projectID, AssistantFeatures.knowledge || AssistantFeatures.memory {
                                        Button("Context used") { contextUsed = .init(id: taskID, projectID: project) }.buttonStyle(.jarvisGhost)
                                    }
                                }
                                if let error = turn.error { Text(error).font(.system(size: 12)).foregroundStyle(theme.warning).textSelection(.enabled) }
                                ForEach(assistant.visiblePresentations.filter { $0.turnId == turn.id }) { presentation in
                                    Button { assistant.selectPresentation(presentation.id) } label: {
                                        HStack(spacing: 10) {
                                            Image(systemName: icon(presentation.content.kind)).foregroundStyle(theme.accentText).frame(width: 18)
                                            Text(presentation.title.isEmpty ? presentation.content.kind.rawValue.capitalized : presentation.title)
                                                .font(.system(size: 12, weight: .medium)).foregroundStyle(theme.text)
                                                .lineLimit(2).multilineTextAlignment(.leading)
                                            Spacer(minLength: 4)
                                            Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(theme.faint)
                                        }.padding(.horizontal, 10).padding(.vertical, 8)
                                    }
                                    .buttonStyle(JarvisRowButtonStyle(selected: assistant.selectedPresentation?.id == presentation.id))
                                    .background(theme.elevated, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                    .help("Open on the working surface")
                                }
                            }.jarvisCard(padding: 14, radius: 14)
                        }
                        ForEach(assistant.visibleProposals) { proposal in
                            VStack(alignment: .leading, spacing: 10) {
                                Label("Review exact action", systemImage: "checkmark.shield").font(.system(size: 12, weight: .semibold)).foregroundStyle(theme.warning)
                                Text(proposal.action.toolName).font(.system(size: 14, weight: .semibold)).foregroundStyle(theme.text)
                                Text(proposal.action.reviewText).font(.system(size: 13)).foregroundStyle(theme.text).textSelection(.enabled)
                                Text(proposal.status.replacingOccurrences(of: "_", with: " ")).font(.system(size: 12)).foregroundStyle(theme.muted)
                                if let challenge = proposal.challenge, proposal.status == "awaiting_confirmation" {
                                    Text("Say: \(challenge)").font(.system(size: 15, weight: .semibold)).foregroundStyle(theme.accentText)
                                }
                                Button("Read and confirm by voice") { Task { await assistant.readProposal(proposal) } }
                                    .disabled(!["proposed", "reviewed"].contains(proposal.status) || !voice.cloudConsentGranted)
                            }.jarvisCard(.warning, padding: 14, radius: 14)
                        }
                        ForEach(model.tasks.filter { task in assistant.visibleTurns.contains { $0.taskId == task.id } }) { task in
                            ForEach(task.approvals) { approval in
                                VStack(alignment: .leading, spacing: 10) {
                                    Label("Your approval", systemImage: "hand.raised.fill").font(.system(size: 12, weight: .semibold)).foregroundStyle(theme.warning)
                                    Text(approval.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(theme.text)
                                    Text(approval.detail).font(.system(size: 12, design: .monospaced)).foregroundStyle(theme.text).textSelection(.enabled)
                                        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                        .background(theme.trough, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                    HStack {
                                        ForEach(approval.options) { option in
                                            Button(option.label) {
                                                Task { await model.act(key: approval.id, path: "v1/tasks/\(task.id)/respond",
                                                    body: ["interactionId": approval.id, "optionId": option.id, "expectedRevision": String(approval.revision ?? 0)]) }
                                            }.buttonStyle(JarvisButtonStyle(kind: option.id == "approve" ? .primary : .secondary))
                                            if AssistantFeatures.voiceApproval, option.id == "approve" {
                                                Button("Review by voice") { Task { await assistant.createVoiceProposal(task: task, approval: approval, option: option) } }
                                            }
                                        }
                                    }
                                }.jarvisCard(.warning, padding: 14, radius: 14)
                            }
                        }
                    }.padding(.leading, 22).padding(.trailing, 10).padding(.bottom, 16)
                }.frame(minWidth: 270, idealWidth: 360, maxWidth: 480)
                VStack(spacing: 0) {
                    HStack(spacing: 8) {
                        Button { assistant.goBack() } label: { Image(systemName: "chevron.left") }
                            .buttonStyle(.jarvisIcon).disabled(!assistant.canGoBack).help("Back").accessibilityLabel("Back")
                        if !assistant.followingPresentation {
                            Button("Follow Jarvis") { assistant.followPresentations() }.buttonStyle(.jarvisCompact).help("Let new results update the working surface")
                            if assistant.hasPresentationUpdate { Button("Show update") { assistant.showPresentationUpdate() }.buttonStyle(.jarvisCompactPrimary) }
                        }
                        Spacer()
                        if let selected = assistant.selectedPresentation {
                            Text("Revision \(selected.revision)").font(.system(size: 11)).foregroundStyle(theme.muted)
                            if let text = selected.content.markdown {
                                Button { voice.speak(text, context: selected.capturedFocus.voiceContext) } label: { Image(systemName: "speaker.wave.2") }
                                    .buttonStyle(.jarvisIcon).help("Read aloud").accessibilityLabel("Read aloud")
                                    .disabled(!voice.cloudConsentGranted || voice.captureInProgress || voice.dictationActive)
                            }
                            Button { assistant.togglePin(selected.id) } label: {
                                Image(systemName: assistant.pinned.contains(selected.id) ? "pin.fill" : "pin")
                            }
                            .buttonStyle(JarvisIconButtonStyle(active: assistant.pinned.contains(selected.id)))
                            .help(assistant.pinned.contains(selected.id) ? "Unpin" : "Pin this revision")
                            .accessibilityLabel(assistant.pinned.contains(selected.id) ? "Unpin" : "Pin")
                        }
                    }.padding(.horizontal, 12).frame(height: 44)
                    Rectangle().fill(theme.line).frame(height: 1)
                    ScrollView {
                        if let selected = assistant.selectedPresentation { AssistantPresentationView(presentation: selected, assistant: assistant, rooms: model.rooms).id("\(selected.id):\(selected.revision)").padding(24) }
                        else {
                            EmptyStateView(icon: "rectangle.3.group", title: "Your working surface",
                                detail: "Ask Jarvis to explain, compare, calculate, or draft. Select a card to explore its evidence and details.")
                                .padding(.top, 60)
                        }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .frame(minWidth: 330)
                .jarvisSurface(.panel, radius: 18)
                .padding(.trailing, 8).padding(.leading, 4)
            }
            VStack(spacing: 8) {
                if let selection = assistant.visualSelection {
                    HStack(spacing: 8) {
                        Label(selection.label, systemImage: "scope").foregroundStyle(theme.accentText)
                        Text("Bound to displayed revision").foregroundStyle(theme.muted)
                        Spacer()
                        Button("Clear") { assistant.selectVisual(nil) }.buttonStyle(.jarvisGhost)
                    }.font(.system(size: 12)).padding(.horizontal, 6)
                }
                if voice.isListening || voice.dictationActive {
                    Text(voice.transcript.isEmpty ? "Listening…" : voice.transcript).font(.system(size: 12)).foregroundStyle(theme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6)
                }
                HStack(alignment: .bottom, spacing: 10) {
                    Button { Task { await model.startManualListening() } } label: {
                        Image(systemName: "mic.fill").font(.system(size: 16, weight: .medium)).foregroundStyle(theme.text)
                            .frame(width: 46, height: 46).contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .jarvisGlass(Circle(), interactive: true)
                    .disabled(!voice.cloudConsentGranted || assistant.selectedSession == nil || voice.dictationActive)
                    .help(voice.cloudConsentGranted ? "Speak to this session" : "Turn on cloud voice to speak")
                    .accessibilityLabel("Speak")
                    TextField("Ask Jarvis, or continue by voice…", text: $assistant.draft, axis: .vertical).id(assistant.selectedSessionID)
                        .disabled(assistant.selectedSession == nil)
                        .textFieldStyle(.plain).font(.system(size: 14)).lineLimit(1...5).foregroundStyle(theme.text)
                        .onSubmit { Task { await assistant.sendDraft() } }
                        .padding(.horizontal, 18).padding(.vertical, 14).frame(minHeight: 46)
                        .jarvisGlass(RoundedRectangle(cornerRadius: 23, style: .continuous))
                    Button { Task { await assistant.sendDraft() } } label: {
                        Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)).foregroundStyle(theme.onAccent)
                            .frame(width: 46, height: 46).background(theme.accentFill, in: Circle()).contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(sendDisabled).opacity(sendDisabled ? 0.4 : 1)
                    .help("Send (Return)")
                    .accessibilityLabel("Send assistant request")
                }
                HStack(spacing: 8) {
                    Picker("Next turn", selection: $assistant.intent) {
                        Text("Continue").tag("continue")
                        Text("Ask alongside work").tag("side_question")
                        Text("Propose goal change").tag("redirect_work")
                    }.labelsHidden().frame(maxWidth: 200).help("How the next message relates to the work in progress")
                    Picker("Capture", selection: $voice.captureMode) {
                        ForEach(VoiceCaptureMode.allCases) { mode in Text(mode.title).tag(mode) }
                    }.labelsHidden().frame(maxWidth: 200).disabled(voice.captureInProgress || voice.dictationActive).help("How speech is captured")
                    VoicePauseSettingsView(mode: voice.captureMode)
                    Spacer()
                    if voice.dictationPaused { Button("Continue dictation") { Task { await voice.continueDictation() } }.buttonStyle(.jarvisCompact) }
                    if voice.isListening { Button("Still thinking") { voice.holdConversationPause() }.buttonStyle(.jarvisCompact) }
                    if voice.isListening || voice.dictationActive { Button("Finish") { voice.finishListening() }.buttonStyle(.jarvisCompactPrimary) }
                    Button("Stop speaking") { assistant.muteNarration(); voice.stopSpeaking(); Task { await assistant.invalidateVoiceReview() } }
                        .buttonStyle(.jarvisCompact)
                }
            }.padding(.horizontal, 22).padding(.top, 10).padding(.bottom, 12)
        }
        .sheet(isPresented: $knowledgeVisible) {
            if let project = assistant.selectedSession?.focus.projectID {
                KnowledgeWorkspaceView(projectID: project, client: assistant.client).id(project)
            }
        }
        .sheet(isPresented: $memoryVisible) {
            VStack(spacing: 0) {
                HStack { Spacer(); Button("Done") { memoryVisible = false } }.padding([.top, .horizontal], 20)
                MemoryWorkspaceView(projectID: assistant.selectedSession?.focus.projectID, client: assistant.client)
                    .id(assistant.selectedSession?.focus.projectID ?? "personal")
            }.frame(minWidth: 860, minHeight: 620)
        }
        .sheet(item: $contextUsed) { target in
            VStack(spacing: 0) {
                HStack { Spacer(); Button("Done") { contextUsed = nil } }.padding()
                ContextUsedView(projectID: target.projectID, taskID: target.id, client: assistant.client)
            }.frame(minWidth: 760, minHeight: 620)
        }
        .sheet(isPresented: $contextVisible) {
            if let focus = assistant.selectedSession?.focus, let projectID = focus.projectID {
                VStack(spacing: 0) {
                    HStack { Spacer(); Button("Done") { contextVisible = false } }.padding([.top, .horizontal], 20)
                    ContextInspectorView(projectID: projectID, conversationID: focus.conversationId, client: assistant.client)
                        .id(projectID + ":" + (focus.conversationId ?? ""))
                }.frame(minWidth: 760, minHeight: 620)
            }
        }
    }
    private func icon(_ kind: AssistantPresentationContent.Kind) -> String {
        switch kind { case .text: return "doc.text"; case .sources: return "books.vertical"; case .code: return "chevron.left.forwardslash.chevron.right"
        case .math: return "function"; case .table: return "tablecells"; case .chart: return "chart.xyaxis.line"; case .artifact: return "doc.zipper"; case .plan: return "list.bullet.rectangle"
        case .document: return "doc.text.magnifyingglass"; case .draft: return "square.and.pencil"; case .code_diff: return "arrow.triangle.branch" }
    }
}

private struct AssistantPresentationView: View {
    let presentation: AssistantPresentation
    @ObservedObject var assistant: AssistantModel
    @ObservedObject var rooms: RoomsModel
    private var content: AssistantPresentationContent { presentation.content }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(presentation.title).font(.system(size: 20, weight: .semibold))
            switch content.kind {
            case .text:
                Text(.init(content.markdown ?? "")).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            case .document:
                Text("Source version \(content.sourceVersionId ?? "")").font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                ForEach(content.passages ?? []) { passage in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(passage.locator.display).font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button(assistant.visualSelection?.passageId == passage.id ? "Selected for next turn" : "Refer to this passage") {
                                assistant.selectVisual(.init(kind: .document_passage, passageId: passage.id))
                            }.font(.caption)
                        }
                        Text(passage.text).textSelection(.enabled)
                        Text("Evidence \(passage.id)").font(.caption2.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }.jarvisCard(.elevated, padding: 14, radius: 12)
                }
            case .draft:
                Label(content.format == "email" ? "Email draft" : "Document draft", systemImage: content.format == "email" ? "envelope" : "doc.text")
                    .font(.caption).foregroundStyle(.secondary)
                PresentationDraftEditor(presentation: presentation, assistant: assistant)
            case .code_diff:
                Text("\(content.language ?? "Code") · Verification: \(content.verification ?? "unverified")").font(.caption).foregroundStyle(.secondary)
                PresentationDiffView(diff: content.diff ?? "")
            case .sources:
                ForEach(content.sources ?? []) { source in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(source.title).font(.headline)
                        Text(source.excerpt).textSelection(.enabled)
                        Text(source.url).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        Text("\(source.status.capitalized) · \(source.retrievedAt)").font(.caption2).foregroundStyle(.secondary)
                    }.jarvisCard(.elevated, padding: 14, radius: 12)
                }
            case .code:
                Text(content.verification == "passed" ? "Checks passed" : "Verification: \(content.verification ?? "unverified")").font(.caption).foregroundStyle(.secondary)
                ScrollView(.horizontal) { Text(content.code ?? "").font(.system(.body, design: .monospaced)).textSelection(.enabled) }
            case .math:
                EquationPresentationView(latex: content.latex ?? "")
                Text(content.explanation ?? "").textSelection(.enabled)
                Text("Verification: \(content.verification ?? "unverified")").font(.caption).foregroundStyle(.secondary)
            case .table:
                ScrollView(.horizontal) {
                    Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 12) {
                        GridRow { ForEach(Array((content.columns ?? []).enumerated()), id: \.offset) { _, title in Text(title).font(.headline) } }
                        ForEach(Array((content.rows ?? []).enumerated()), id: \.offset) { rowIndex, row in
                            GridRow { ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                                Button { assistant.selectVisual(.init(kind: .table_cell, row: rowIndex, column: column)) } label: {
                                    Text(cell.display).textSelection(.enabled).padding(6)
                                        .background(assistant.visualSelection == AssistantVisualSelection(kind: .table_cell, row: rowIndex, column: column) ? Color.accentColor.opacity(0.15) : Color.clear, in: RoundedRectangle(cornerRadius: 5))
                                }.buttonStyle(.plain).help("Use this cell as the reference for your next turn")
                            } }
                        }
                    }
                }
            case .chart:
                Chart {
                    ForEach(Array((content.series ?? []).enumerated()), id: \.offset) { _, series in
                        ForEach(Array(series.points.enumerated()), id: \.offset) { _, point in
                            if let x = point.x.numeric {
                                if content.chartType == "bar" { BarMark(x: .value(content.xLabel ?? "x", x), y: .value(content.yLabel ?? "y", point.y)).foregroundStyle(by: .value("Series", series.name)) }
                                else if content.chartType == "scatter" { PointMark(x: .value(content.xLabel ?? "x", x), y: .value(content.yLabel ?? "y", point.y)).foregroundStyle(by: .value("Series", series.name)) }
                                else { LineMark(x: .value(content.xLabel ?? "x", x), y: .value(content.yLabel ?? "y", point.y)).foregroundStyle(by: .value("Series", series.name)) }
                            } else {
                                if content.chartType == "bar" { BarMark(x: .value(content.xLabel ?? "x", point.x.display), y: .value(content.yLabel ?? "y", point.y)).foregroundStyle(by: .value("Series", series.name)) }
                                else if content.chartType == "scatter" { PointMark(x: .value(content.xLabel ?? "x", point.x.display), y: .value(content.yLabel ?? "y", point.y)).foregroundStyle(by: .value("Series", series.name)) }
                                else { LineMark(x: .value(content.xLabel ?? "x", point.x.display), y: .value(content.yLabel ?? "y", point.y)).foregroundStyle(by: .value("Series", series.name)) }
                            }
                        }
                    }
                }.frame(height: 300).chartXAxisLabel(content.xLabel ?? "").chartYAxisLabel(content.yLabel ?? "")
            case .artifact:
                Label(content.path ?? "Artifact", systemImage: "doc")
                Text("Verification: \(content.verification ?? "unverified")").foregroundStyle(.secondary)
                ArtifactInlineView(presentation: presentation, rooms: rooms)
                Text(content.digest ?? "").font(.caption.monospaced()).textSelection(.enabled)
            case .plan:
                Text(content.status?.capitalized ?? "Plan").font(.caption).foregroundStyle(.secondary)
                Text(content.summary ?? "").textSelection(.enabled)
                Text("Plan revision \(content.planRevision ?? 0) · Review acceptance and start separately in Rooms.").font(.caption).foregroundStyle(.secondary)
                if AssistantFeatures.voiceApproval, ["draft", "accepted"].contains(content.status ?? "") {
                    Button(content.status == "draft" ? "Review acceptance by voice" : "Review start by voice") {
                        Task { await assistant.createPlanVoiceProposal(presentation) }
                    }
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.openURL, OpenURLAction { url in
                guard url.scheme == "https", url.user == nil, url.password == nil else { return .discarded }
                return .systemAction
            })
    }
}
