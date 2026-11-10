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
                AssistantThreadView(model: model, assistant: assistant, voice: voice, onContextUsed: { contextUsed = $0 })
                    .frame(minWidth: 380, idealWidth: 540, maxWidth: surfaceMode == .hidden ? .infinity : 720, maxHeight: .infinity)
                if surfaceMode != .hidden { surface.frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity) }
            }
            Divider()
            composer
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
    private var capturing: Bool { voice.isListening || voice.dictationActive }
    private var intentLabel: String? {
        switch assistant.intent {
        case "side_question": return "Asking alongside running work"
        case "redirect_work": return "Proposing a goal change"
        default: return nil
        }
    }

    /// One row to talk or type. The microphone is the single voice control;
    /// less common choices sit in the options menu.
    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let selection = assistant.visualSelection {
                HStack { Label(selection.label, systemImage: "scope"); Text("Bound to displayed revision").foregroundStyle(.secondary); Spacer(); Button("Clear") { assistant.selectVisual(nil) } }.font(.caption)
            }
            if capturing || voice.dictationPaused {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(voice.transcript.isEmpty ? (voice.dictationPaused ? "Dictation paused. Continue or finish when you are ready." : "Listening…") : voice.transcript)
                        .font(.callout).foregroundStyle(voice.transcript.isEmpty ? Color.secondary : Color.primary).lineLimit(4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityLabel(voice.transcript.isEmpty ? "Listening" : "Live transcription: \(voice.transcript)")
                    if voice.dictationPaused { Button("Continue dictation") { Task { await voice.continueDictation() } } }
                    if voice.isListening { Button("Still thinking") { voice.holdConversationPause() }.help("Keep listening through a long pause") }
                    if capturing || voice.dictationPaused { Button("Finish") { voice.finishListening() } }
                }.font(.caption).padding(.horizontal, 14).padding(.vertical, 10)
                    .background(RoomsPalette.cyan.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
            }
            HStack(alignment: .center, spacing: 12) {
                VoiceMicButton(model: model, voice: voice, rooms: model.rooms, diameter: 46, unavailable: !model.isConnected && assistant.selectedSession == nil)
                TextField("Ask Jarvis anything, or press the microphone and talk", text: $assistant.draft, axis: .vertical).id(assistant.selectedSessionID)
                    .disabled(assistant.selectedSession == nil)
                    .textFieldStyle(.plain).font(.system(size: 14)).lineLimit(1...5)
                    .onSubmit { Task { await assistant.sendDraft() } }
                Menu {
                    Picker("Next turn", selection: $assistant.intent) {
                        Text("Continue").tag("continue")
                        Text("Ask alongside work").tag("side_question")
                        Text("Propose goal change").tag("redirect_work")
                    }
                    Picker("Voice capture", selection: $voice.captureMode) {
                        ForEach(VoiceCaptureMode.allCases) { mode in Text(mode.title).tag(mode) }
                    }.disabled(voice.captureInProgress || voice.dictationActive)
                } label: { Image(systemName: "ellipsis.circle").font(.title3) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .help("Choose how the next turn is handled and how speech is captured")
                    .accessibilityLabel("Turn and capture options")
                VoicePauseSettingsView(mode: voice.captureMode).buttonStyle(.plain).foregroundStyle(.secondary)
                Button { Task { await assistant.sendDraft() } } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 28)) }
                    .buttonStyle(.plain).foregroundStyle(RoomsPalette.cyan)
                    .disabled(assistant.submitting || assistant.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || assistant.selectedSession == nil)
                    .accessibilityLabel("Send assistant request")
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(RoomsPalette.panel, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(capturing ? RoomsPalette.cyan.opacity(0.55) : RoomsPalette.line))
            HStack(spacing: 12) {
                Text(VoicePresence.label(state: voice.state, consent: voice.cloudConsentGranted, dictationPaused: voice.dictationPaused))
                    .foregroundStyle(capturing ? RoomsPalette.cyan : RoomsPalette.muted)
                if let intentLabel {
                    Text("·").foregroundStyle(RoomsPalette.muted)
                    Text(intentLabel).foregroundStyle(RoomsPalette.amber)
                    Button("Reset") { assistant.intent = "continue" }.buttonStyle(.plain).foregroundStyle(RoomsPalette.muted)
                }
                if voice.captureMode == .dictation {
                    Text("·").foregroundStyle(RoomsPalette.muted)
                    Text("Extended dictation").foregroundStyle(RoomsPalette.muted)
                }
                Spacer()
                if voice.cloudConsentGranted {
                    Button("Stop speaking") { assistant.muteNarration(); voice.stopSpeaking(); Task { await assistant.invalidateVoiceReview() } }
                        .buttonStyle(.plain).foregroundStyle(voice.isSpeaking ? RoomsPalette.cyan : RoomsPalette.muted)
                        .help("Silence this reply. Work in progress continues.")
                }
            }.font(.caption)
        }.padding(.horizontal, 22).padding(.vertical, 14).frame(maxWidth: 864).frame(maxWidth: .infinity)
    }

    private var material: [AssistantPresentation] { AssistantThread.material(assistant.visiblePresentations) }
    private var surfaceMode: AssistantSurfaceMode {
        AssistantThread.surfaceMode(selected: assistant.selectedPresentation, following: assistant.followingPresentation, hasMaterial: !material.isEmpty)
    }

    /// The working surface shows the selected presentation and nothing else.
    /// While Jarvis is being followed and the newest result is the reply
    /// already written in the conversation, it lists the session's material.
    private var surface: some View {
        VStack(spacing: 0) {
            HStack {
                Button { assistant.goBack() } label: { Label("Back", systemImage: "chevron.left") }.disabled(!assistant.canGoBack)
                if !assistant.followingPresentation {
                    Button("Follow Jarvis") { assistant.followPresentations() }.help("Let new results update the working surface")
                    if assistant.hasPresentationUpdate { Button("Show update") { assistant.showPresentationUpdate() } }
                }
                Spacer()
                if surfaceMode == .detail, let selected = assistant.selectedPresentation {
                    if let text = selected.content.markdown {
                        Button("Read aloud") { voice.speak(text, context: selected.capturedFocus.voiceContext) }
                            .disabled(!voice.cloudConsentGranted || voice.captureInProgress || voice.dictationActive)
                    }
                    Text("Revision \(selected.revision)").font(.caption).foregroundStyle(.secondary)
                    Button { assistant.togglePin(selected.id) } label: {
                        Label(assistant.pinned.contains(selected.id) ? "Unpin" : "Pin", systemImage: assistant.pinned.contains(selected.id) ? "pin.fill" : "pin")
                    }
                } else {
                    Text("Working material").font(.caption).foregroundStyle(.secondary)
                }
            }.padding(12)
            Divider()
            ScrollView {
                if surfaceMode == .detail, let selected = assistant.selectedPresentation {
                    AssistantPresentationView(presentation: selected, assistant: assistant, rooms: model.rooms).id("\(selected.id):\(selected.revision)").padding(24)
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("From this conversation").font(.title3.weight(.medium))
                        Text("Sources, tables, code and drafts open here. The conversation stays on the left.").font(.callout).foregroundStyle(.secondary)
                        ForEach(material.reversed()) { presentation in
                            Button { assistant.selectPresentation(presentation.id) } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: presentation.content.kind.symbol).font(.title3).frame(width: 28)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(presentation.displayTitle).lineLimit(2).multilineTextAlignment(.leading)
                                        Text("\(presentation.content.kind.label) · \(presentation.materialDetail)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                                }
                            }.buttonStyle(AssistantMaterialButtonStyle(selected: false))
                        }
                    }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }.background(RoomsPalette.panel.opacity(0.45))
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
                MarkdownBlocksView(content.markdown ?? "")
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
