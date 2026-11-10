import AppKit
import SwiftUI

private struct ThreadGeometry: Equatable {
    var offset: CGFloat
    var height: CGFloat
}

/// The conversation itself: your messages, Jarvis's replies written in place
/// as they arrive, and the actions that still need you.
struct AssistantThreadView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var assistant: AssistantModel
    @ObservedObject var voice: VoiceController
    let onContextUsed: (ContextUsedTarget) -> Void
    @State private var follow = ThreadScrollFollow()
    @State private var viewport: CGFloat = 0
    private static let space = "assistant-thread"
    private static let latest = "assistant-thread-latest"

    private var entries: [AssistantThreadEntry] {
        AssistantThread.entries(turns: assistant.visibleTurns, presentations: assistant.visiblePresentations)
    }

    var body: some View {
        let entries = self.entries
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    if !assistant.visiblePinnedPresentations.isEmpty { pinned }
                    if entries.isEmpty { AssistantThreadWelcome(assistant: assistant) }
                    ForEach(entries) { entry in turn(entry) }
                    ForEach(assistant.visibleProposals) { proposal in proposalCard(proposal) }
                    approvals
                    Color.clear.frame(height: 1).id(Self.latest)
                }
                .padding(.horizontal, 28).padding(.vertical, 24)
                .frame(maxWidth: 820).frame(maxWidth: .infinity)
                .background(GeometryReader { geometry in
                    let frame = geometry.frame(in: .named(Self.space))
                    Color.clear.onChange(of: ThreadGeometry(offset: frame.minY, height: frame.height), initial: true) { _, value in
                        if follow.update(offset: value.offset, contentHeight: value.height, viewportHeight: viewport) {
                            proxy.scrollTo(Self.latest, anchor: .bottom)
                        }
                    }
                })
            }
            .coordinateSpace(name: Self.space)
            .background(GeometryReader { geometry in
                Color.clear.onChange(of: geometry.size.height, initial: true) { _, height in viewport = height }
            })
            .onChange(of: entries.count) { _, _ in showLatest(proxy) }
            .onChange(of: assistant.selectedSessionID) { _, _ in showLatest(proxy) }
            .overlay(alignment: .bottom) {
                if !follow.following {
                    Button { showLatest(proxy) } label: { Label("Jump to latest", systemImage: "arrow.down") }
                        .buttonStyle(.plain).font(.caption.weight(.medium)).foregroundStyle(RoomsPalette.cyan)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(RoomsPalette.elevated, in: Capsule())
                        .overlay(Capsule().stroke(RoomsPalette.cyan.opacity(0.35)))
                        .padding(.bottom, 12)
                        .help("Follow the newest reply again")
                }
            }
        }
    }

    private func showLatest(_ proxy: ScrollViewProxy) {
        follow.jumpToLatest()
        proxy.scrollTo(Self.latest, anchor: .bottom)
    }

    private var pinned: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PINNED").font(.system(size: 10, weight: .semibold)).tracking(1.6).foregroundStyle(RoomsPalette.muted)
            ForEach(assistant.visiblePinnedPresentations) { presentation in
                Button { assistant.selectPinnedPresentation(presentation.id) } label: {
                    Label("\(presentation.displayTitle) · revision \(presentation.revision)", systemImage: "pin.fill")
                        .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(AssistantMaterialButtonStyle(selected: false))
            }
        }
    }

    private func turn(_ entry: AssistantThreadEntry) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 0) {
                Spacer(minLength: 72)
                VStack(alignment: .trailing, spacing: 5) {
                    Text(entry.turn.text).font(.body).lineSpacing(3).textSelection(.enabled)
                        .padding(.horizontal, 15).padding(.vertical, 11)
                        .background(RoomsPalette.cyan.opacity(0.13), in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(RoomsPalette.cyan.opacity(0.16)))
                    if entry.turn.intent == "side_question" {
                        Text("Asked alongside running work").font(.caption2).foregroundStyle(RoomsPalette.muted)
                    }
                }
            }.accessibilityElement(children: .combine).accessibilityLabel("You: \(entry.turn.text)")
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 7) {
                    Image(systemName: "waveform").font(.system(size: 11, weight: .semibold))
                    Text("JARVIS").font(.system(size: 10, weight: .semibold)).tracking(1.8)
                }.foregroundStyle(RoomsPalette.cyan).accessibilityHidden(true)
                ForEach(entry.replies) { reply in
                    if let markdown = reply.content.markdown, !markdown.isEmpty {
                        MarkdownBlocksView(markdown).equatable()
                            .accessibilityElement(children: .contain).accessibilityLabel("Jarvis replied")
                    }
                }
                if entry.awaitingReply || entry.streaming {
                    AssistantThinkingIndicator(label: AssistantThread.statusLabel(entry))
                } else if let status = AssistantThread.statusLabel(entry) {
                    Label(status, systemImage: "exclamationmark.circle").font(.callout).foregroundStyle(RoomsPalette.amber)
                }
                if let error = entry.turn.error { Text(error).font(.caption).foregroundStyle(RoomsPalette.amber).textSelection(.enabled) }
                if !entry.material.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(entry.material) { presentation in
                            Button { assistant.selectPresentation(presentation.id) } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: presentation.content.kind.symbol).frame(width: 18)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(presentation.displayTitle).lineLimit(1)
                                        Text(presentation.materialDetail).font(.caption2).foregroundStyle(RoomsPalette.muted).lineLimit(1)
                                    }
                                    Spacer(minLength: 8)
                                    Image(systemName: "sidebar.right").font(.caption).foregroundStyle(RoomsPalette.muted)
                                }
                            }.buttonStyle(AssistantMaterialButtonStyle(selected: assistant.selectedPresentationID == presentation.id))
                                .help("Open beside the conversation")
                        }
                    }.frame(maxWidth: 440, alignment: .leading)
                }
                if entry.turn.isSettled { replyActions(entry) }
            }
        }
    }

    private func replyActions(_ entry: AssistantThreadEntry) -> some View {
        HStack(spacing: 14) {
            if let reply = entry.replies.last(where: { !($0.content.markdown ?? "").isEmpty }), let markdown = reply.content.markdown {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(markdown, forType: .string)
                } label: { Label("Copy", systemImage: "doc.on.doc") }.help("Copy this reply")
                Button { voice.speak(markdown, context: reply.capturedFocus.voiceContext) } label: { Label("Read aloud", systemImage: "speaker.wave.2") }
                    .disabled(!voice.cloudConsentGranted || voice.captureInProgress || voice.dictationActive)
                    .help(voice.cloudConsentGranted ? "Read this reply aloud" : "Turn on voice to hear replies")
                Button { assistant.selectPresentation(reply.id) } label: { Label("Open beside", systemImage: "sidebar.right") }
                    .help("Hold this revision beside the conversation to pin it or refer to it")
            }
            if let taskID = entry.turn.taskId, let project = entry.turn.capturedFocus.projectID, AssistantFeatures.knowledge || AssistantFeatures.memory {
                Button { onContextUsed(.init(id: taskID, projectID: project)) } label: { Label("Context used", systemImage: "list.bullet.rectangle") }
                    .help("See what Jarvis drew on for this reply")
            }
        }.buttonStyle(.plain).labelStyle(.titleAndIcon).font(.caption).foregroundStyle(RoomsPalette.muted)
    }

    private func proposalCard(_ proposal: AssistantProposal) -> some View {
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
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoomsPalette.amber.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(RoomsPalette.amber.opacity(0.25)))
    }

    private var approvals: some View {
        ForEach(model.tasks.filter { task in assistant.visibleTurns.contains { $0.taskId == task.id } }) { task in
            ForEach(task.approvals) { approval in
                VStack(alignment: .leading, spacing: 10) {
                    Label("YOUR APPROVAL", systemImage: "hand.raised").font(.system(size: 10, weight: .semibold)).tracking(1.5).foregroundStyle(RoomsPalette.amber)
                    Text(approval.title).font(.headline)
                    Text(approval.detail).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                    Button { model.openDecisionID = approval.id } label: { Label("Review full screen", systemImage: "lock.shield") }
                        .buttonStyle(.plain).font(.caption.weight(.medium)).foregroundStyle(RoomsPalette.amber)
                        .help("Open this decision on the authorization lock, with its impact and fingerprint")
                    HStack {
                        ForEach(approval.options) { option in
                            Button(option.label) {
                                Task { await model.act(key: approval.id, path: "v1/tasks/\(task.id)/respond",
                                    body: ["interactionId": approval.id, "optionId": option.id, "expectedRevision": String(approval.revision ?? 0)]) }
                            }.disabled(!ApprovalGate.allows(optionID: option.id, reviewable: approval.reviewable,
                                                             pending: model.pendingActions.contains(approval.id), connected: model.isConnected))
                            if AssistantFeatures.voiceApproval, option.id == "approve" {
                                Button("Review by voice") { Task { await assistant.createVoiceProposal(task: task, approval: approval, option: option) } }
                                    .disabled(!ApprovalGate.allows(optionID: option.id, reviewable: approval.reviewable,
                                                                   pending: model.pendingActions.contains(approval.id), connected: model.isConnected))
                            }
                        }
                    }
                }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoomsPalette.amber.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(RoomsPalette.amber.opacity(0.25)))
            }
        }
    }
}

struct AssistantMaterialButtonStyle: ButtonStyle {
    let selected: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout).foregroundStyle(selected ? RoomsPalette.cyan : Color.primary.opacity(0.9))
            .padding(.horizontal, 12).padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background((selected ? RoomsPalette.cyan.opacity(0.10) : Color.white.opacity(configuration.isPressed ? 0.08 : 0.04)), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? RoomsPalette.cyan.opacity(0.4) : RoomsPalette.line))
            .contentShape(RoundedRectangle(cornerRadius: 10))
    }
}

/// A quiet sign that Jarvis is working. It never invents progress: the label
/// comes from the turn's recorded status.
struct AssistantThinkingIndicator: View {
    let label: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 9) {
            TimelineView(.periodic(from: .now, by: reduceMotion ? 3_600 : 0.32)) { context in
                let phase = reduceMotion ? 1 : Int(context.date.timeIntervalSinceReferenceDate / 0.32) % 3
                HStack(spacing: 4) {
                    ForEach(0..<3, id: \.self) { index in
                        Circle().fill(RoomsPalette.cyan.opacity(index == phase ? 0.95 : 0.3)).frame(width: 5, height: 5)
                    }
                }
            }
            if let label { Text(label).font(.callout).foregroundStyle(RoomsPalette.muted) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label.map { "Jarvis: \($0)" } ?? "Jarvis is still writing")
    }
}

struct AssistantThreadWelcome: View {
    @ObservedObject var assistant: AssistantModel

    var body: some View {
        ContentUnavailableView("Start with a question", systemImage: "waveform",
            description: Text("Discuss a paper, compare evidence, plan work, or prepare an action. Sources and results will appear alongside the conversation."))
            .frame(maxWidth: .infinity).padding(.top, 60)
    }
}
