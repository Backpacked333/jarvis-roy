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

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(assistant.selectedSession?.title ?? "Talk through your next idea")
                        .font(.title2.weight(.medium))
                    Text(assistant.connected ? "A shared workspace for conversation, evidence, and action" : "Connecting to your local assistant")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Menu {
                    ForEach(assistant.sessions) { session in
                        Button(String(session.title.prefix(30))) { assistant.selectSession(session.id) }
                    }
                    Divider()
                    Button("New assistant conversation") { Task { await model.newAssistantConversation() } }
                } label: { Label("Sessions", systemImage: "bubble.left.and.bubble.right") }
                if AssistantFeatures.knowledge {
                    Button { knowledgeVisible.toggle() } label: { Label("Knowledge", systemImage: "books.vertical") }
                        .disabled(assistant.selectedSession?.focus.projectID == nil)
                }
                Button { memoryVisible.toggle() } label: { Label("Memory", systemImage: "brain") }
                if AssistantFeatures.knowledge || AssistantFeatures.memory {
                    Button { contextVisible.toggle() } label: { Label("Context", systemImage: "list.bullet.rectangle") }
                        .disabled(assistant.selectedSession?.focus.projectID == nil)
                }
            }.padding(22)
            Divider()
            if let error = assistant.error { Text(error).foregroundStyle(.orange).font(.callout).padding(12).frame(maxWidth: .infinity, alignment: .leading) }
            if let notice = assistant.notice { Text(notice).font(.callout).foregroundStyle(.secondary).padding(.horizontal, 22).padding(.top, 8) }
            HSplitView {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if !assistant.visiblePinnedPresentations.isEmpty {
                            Text("Pinned revisions").font(.caption).foregroundStyle(.secondary)
                            ForEach(assistant.visiblePinnedPresentations) { presentation in
                                Button { assistant.selectPinnedPresentation(presentation.id) } label: {
                                    Label("\(presentation.title) · r\(presentation.revision)", systemImage: "pin.fill").lineLimit(2)
                                }.buttonStyle(.bordered)
                            }
                        }
                        if assistant.visibleTurns.isEmpty {
                            ContentUnavailableView("Start with a question", systemImage: "waveform",
                                description: Text("Discuss a paper, compare evidence, plan work, or prepare an action. Sources and results will appear alongside the conversation."))
                        }
                        ForEach(assistant.visibleTurns) { turn in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(turn.text).font(.body).textSelection(.enabled)
                                HStack {
                                    Text(turn.intent == "side_question" ? "Side conversation" : turn.status.capitalized)
                                    if !turn.isSettled { ProgressView().controlSize(.small) }
                                }.font(.caption).foregroundStyle(.secondary)
                                if let error = turn.error { Text(error).font(.caption).foregroundStyle(.orange) }
                                if let taskID = turn.taskId, let project = turn.capturedFocus.projectID, AssistantFeatures.knowledge || AssistantFeatures.memory {
                                    Button("Context used") { contextUsed = .init(id: taskID, projectID: project) }.font(.caption)
                                }
                                ForEach(assistant.visiblePresentations.filter { $0.turnId == turn.id }) { presentation in
                                    Button { assistant.selectPresentation(presentation.id) } label: {
                                        Label(presentation.title.isEmpty ? presentation.content.kind.rawValue.capitalized : presentation.title,
                                              systemImage: icon(presentation.content.kind))
                                            .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                                    }.buttonStyle(.bordered)
                                }
                            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))
                        }
                        ForEach(assistant.visibleProposals) { proposal in
                            VStack(alignment: .leading, spacing: 10) {
                                Label("Review exact action", systemImage: "checkmark.shield").font(.headline)
                                Text(proposal.action.toolName).font(.subheadline)
                                Text(proposal.action.reviewText).font(.callout).textSelection(.enabled)
                                Text(proposal.status.replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(.secondary)
                                if let challenge = proposal.challenge, proposal.status == "awaiting_confirmation" {
                                    Text("Say: \(challenge)").font(.headline).foregroundStyle(.cyan)
                                }
                                Button("Read and confirm by voice") { Task { await assistant.readProposal(proposal) } }
                                    .disabled(!["proposed", "reviewed"].contains(proposal.status) || !voice.cloudConsentGranted)
                            }.padding(14).background(.orange.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                        }
                        ForEach(model.tasks.filter { task in assistant.visibleTurns.contains { $0.taskId == task.id } }) { task in
                            ForEach(task.approvals) { approval in
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(approval.title).font(.headline)
                                    Text(approval.detail).font(.callout).textSelection(.enabled)
                                    HStack {
                                        ForEach(approval.options) { option in
                                            Button(option.label) {
                                                Task { await model.act(key: approval.id, path: "v1/tasks/\(task.id)/respond",
                                                    body: ["interactionId": approval.id, "optionId": option.id, "expectedRevision": String(approval.revision ?? 0)]) }
                                            }
                                            if AssistantFeatures.voiceApproval, option.id == "approve" {
                                                Button("Review by voice") { Task { await assistant.createVoiceProposal(task: task, approval: approval, option: option) } }
                                            }
                                        }
                                    }
                                }.padding(14).background(.orange.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                            }
                        }
                    }.padding(18)
                }.frame(minWidth: 250, idealWidth: 350, maxWidth: 470)
                VStack(spacing: 0) {
                    HStack {
                        Button { assistant.goBack() } label: { Label("Back", systemImage: "chevron.left") }.disabled(!assistant.canGoBack)
                        if !assistant.followingPresentation {
                            Button("Follow Jarvis") { assistant.followPresentations() }.help("Let new results update the working surface")
                            if assistant.hasPresentationUpdate { Button("Show update") { assistant.showPresentationUpdate() } }
                        }
                        Spacer()
                        if let selected = assistant.selectedPresentation {
                            if let text = selected.content.markdown {
                                Button("Read aloud") { voice.speak(text, context: selected.capturedFocus.voiceContext) }
                                    .disabled(!voice.cloudConsentGranted || voice.captureInProgress || voice.dictationActive)
                            }
                            Text("Revision \(selected.revision)").font(.caption).foregroundStyle(.secondary)
                            Button { assistant.togglePin(selected.id) } label: {
                                Label(assistant.pinned.contains(selected.id) ? "Unpin" : "Pin", systemImage: assistant.pinned.contains(selected.id) ? "pin.fill" : "pin")
                            }
                        }
                    }.padding(12)
                    Divider()
                    ScrollView {
                        if let selected = assistant.selectedPresentation { AssistantPresentationView(presentation: selected, assistant: assistant, rooms: model.rooms).id("\(selected.id):\(selected.revision)").padding(24) }
                        else { ContentUnavailableView("Your working surface", systemImage: "rectangle.3.group", description: Text("Ask Jarvis to explain, compare, calculate, or draft. Select a card to explore its evidence and details.")) }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }.frame(minWidth: 330)
            }
            Divider()
            VStack(spacing: 10) {
                if let selection = assistant.visualSelection {
                    HStack { Label(selection.label, systemImage: "scope"); Text("Bound to displayed revision").foregroundStyle(.secondary); Spacer(); Button("Clear") { assistant.selectVisual(nil) } }.font(.caption)
                }
                HStack {
                    Picker("Next turn", selection: $assistant.intent) {
                        Text("Continue").tag("continue")
                        Text("Ask alongside work").tag("side_question")
                        Text("Propose goal change").tag("redirect_work")
                    }.labelsHidden().frame(maxWidth: 230)
                    Picker("Capture", selection: $voice.captureMode) {
                        ForEach(VoiceCaptureMode.allCases) { mode in Text(mode.title).tag(mode) }
                    }.labelsHidden().frame(maxWidth: 220).disabled(voice.captureInProgress || voice.dictationActive)
                    VoicePauseSettingsView(mode: voice.captureMode)
                    Spacer()
                    if voice.dictationPaused { Button("Continue dictation") { Task { await voice.continueDictation() } } }
                    if voice.isListening {
                        Button("Still thinking") { voice.holdConversationPause() }
                    }
                    if voice.isListening || voice.dictationActive { Button("Finish") { voice.finishListening() } }
                    Button { Task { await model.startManualListening() } } label: { Label("Speak", systemImage: "mic.fill") }
                        .disabled(!voice.cloudConsentGranted || assistant.selectedSession == nil || voice.dictationActive)
                    Button("Stop speaking") { assistant.muteNarration(); voice.stopSpeaking(); Task { await assistant.invalidateVoiceReview() } }
                }
                HStack(alignment: .bottom) {
                    TextField("Ask Jarvis, or continue by voice…", text: $assistant.draft, axis: .vertical).id(assistant.selectedSessionID)
                        .disabled(assistant.selectedSession == nil)
                        .textFieldStyle(.plain).lineLimit(1...5).padding(12)
                        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
                    Button { Task { await assistant.sendDraft() } } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }
                        .buttonStyle(.plain).disabled(assistant.submitting || assistant.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || assistant.selectedSession == nil)
                        .accessibilityLabel("Send assistant request")
                }
                if voice.isListening || voice.dictationActive { Text(voice.transcript.isEmpty ? "Listening…" : voice.transcript).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
            }.padding(18)
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
            Text(presentation.title).font(.title2.weight(.medium))
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
                    }.padding(14).background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
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
                    }.padding(14).background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
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
