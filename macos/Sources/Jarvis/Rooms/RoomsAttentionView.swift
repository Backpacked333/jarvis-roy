import SwiftUI

struct RoomsAttentionView: View {
    @ObservedObject var model: RoomsModel
    let onSpeakQuestion: (HarnessQuestion) -> Void
    let onReviewApproval: (HarnessApproval) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text("Attention").font(.system(size: 20, weight: .medium))
                Spacer()
                Text("\(model.questions.count + model.approvals.count)").font(.system(size: 13, design: .monospaced)).foregroundStyle(RoomsPalette.amber)
            }
            Toggle("Read new questions aloud", isOn: $model.spokenAttentionEnabled).font(.caption)
                .help("Opt-in spoken attention, not microphone consent. Quiet rooms stay in this inbox. One exact question at a time.")
            Text("QUESTIONS · INFORMATION ONLY").font(.system(size: 9, weight: .semibold)).tracking(1.3).foregroundStyle(RoomsPalette.amber)
            if model.questions.isEmpty {
                Text("No pending clarifications. Questions will appear here with their exact room and attempt.")
                    .font(.caption).foregroundStyle(RoomsPalette.muted).lineSpacing(4)
            }
            ForEach(model.questions) { question in
                RoomsQuestionCard(model: model, question: question, onSpeak: onSpeakQuestion)
            }
            Rectangle().fill(RoomsPalette.line).frame(height: 1)
            Text("APPROVALS · EXPLICIT REVIEW").font(.system(size: 9, weight: .semibold)).tracking(1.3).foregroundStyle(RoomsPalette.red)
            Text("A spoken “yes” never authorizes an operation.").font(.caption).foregroundStyle(RoomsPalette.muted)
            if model.approvals.isEmpty {
                Text("No operations awaiting approval.").font(.caption).foregroundStyle(RoomsPalette.muted)
            }
            ForEach(model.approvals) { approval in
                VStack(alignment: .leading, spacing: 12) {
                    Label(approval.title, systemImage: "lock.shield").font(.system(size: 13, weight: .semibold)).foregroundStyle(RoomsPalette.red)
                    Text(approval.detail).font(.caption).textSelection(.enabled).lineLimit(8)
                    Text(roomName(approval.roomId)).font(.caption2).foregroundStyle(RoomsPalette.muted)
                    if let reason = approval.blockedReason { Text(reason).font(.caption).foregroundStyle(RoomsPalette.amber) }
                    Button("Review exact operation…") { onReviewApproval(approval) }
                        .disabled(!approval.reviewable || !model.canMutate)
                        .help("Opens the existing approval-card flow for interaction \(approval.interactionId). This button does not authorize it.")
                }.padding(15).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoomsPalette.red.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(RoomsPalette.red.opacity(0.18)))
            }
        }
    }
    private func roomName(_ id: String?) -> String { model.state?.rooms.first(where: { $0.id == id })?.title ?? "Existing conversation / host operation" }
}

private struct RoomsQuestionCard: View {
    @ObservedObject var model: RoomsModel
    let question: HarnessQuestion
    let onSpeak: (HarnessQuestion) -> Void
    @State private var draft = RoomsAnswerDraft()
    private var submitting: Bool { model.pendingActions.contains("answer:\(question.id)") }
    private var room: HarnessRoom? { model.state?.rooms.first { $0.id == question.target.roomId } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label(room?.title ?? question.target.roomId, systemImage: "bubble.left.and.bubble.right")
                    .font(.system(size: 11, weight: .medium)).foregroundStyle(RoomsPalette.amber)
                Spacer()
                if room?.policy.attention == "quiet" { Image(systemName: "bell.slash").help("Quiet room: excluded from spoken attention") }
            }
            Text(question.question.prompt).font(.system(size: 14, weight: .medium)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Text(RoomsStateRules.questionScope(question.target)).font(.system(size: 9, design: .monospaced)).foregroundStyle(RoomsPalette.muted).textSelection(.enabled)
            Text("Expires \(RoomsStateRules.date(question.expiresAt)?.formatted(date: .abbreviated, time: .shortened) ?? question.expiresAt)")
                .font(.caption2).foregroundStyle(RoomsPalette.muted)
            ForEach(question.question.choices) { choice in
                Button(choice.label) { Task { _ = await model.answer(question.binding, choiceId: choice.id) } }
                    .frame(maxWidth: .infinity, alignment: .leading).disabled(submitting || !model.canMutate)
            }
            if question.question.allowText {
                TextField("Answer this question", text: Binding(get: { draft.text }, set: { draft.update($0, question: question) }), axis: .vertical).lineLimit(2...5)
                    .textFieldStyle(.roundedBorder).accessibilityLabel("Answer: \(question.question.prompt)")
                if draft.isStale(for: question) {
                    Text("This question changed while you were drafting. Your answer is still bound to the earlier revision, not this updated question.")
                        .font(.caption).foregroundStyle(RoomsPalette.red)
                    Button("Clear draft and review the new question") { draft = RoomsAnswerDraft() }
                }
                Button(submitting ? "Waiting for confirmation…" : "Send answer") {
                    let text = draft.text
                    let binding = draft.binding ?? question.binding
                    Task { if await model.answer(binding, text: text) { draft = RoomsAnswerDraft() } }
                }.disabled(submitting || !model.canMutate || draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.isStale(for: question))
            } else if submitting {
                Text("Waiting for server confirmation…").font(.caption).foregroundStyle(RoomsPalette.amber)
            }
            HStack {
                Button(model.focusedQuestion == question.binding ? "Voice target selected" : "Answer by voice") { model.focus(question) }
                    .disabled(!model.canMutate || model.voiceState == .unavailable || submitting)
                    .help("Binds the next capture to this exact question. Microphone consent is separate.")
                Button { model.focus(question); onSpeak(question) } label: { Image(systemName: "speaker.wave.2") }
                    .accessibilityLabel("Read this question aloud")
                    .disabled(model.voiceState == .unavailable || model.voiceState == .connecting || !model.canMutate)
            }.font(.caption)
        }.padding(15).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoomsPalette.amber.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(model.focusedQuestion == question.binding ? RoomsPalette.amber.opacity(0.6) : RoomsPalette.amber.opacity(0.18)))
    }
}
