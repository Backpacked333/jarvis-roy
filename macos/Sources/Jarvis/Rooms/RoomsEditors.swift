import SwiftUI

struct RoomsPlanReuseView: View {
    @ObservedObject var model: RoomsModel
    let plan: HarnessPlan
    @State private var goal: String
    @Environment(\.dismiss) private var dismiss

    init(model: RoomsModel, plan: HarnessPlan) {
        self.model = model; self.plan = plan; _goal = State(initialValue: plan.goal)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Draft a variation").font(.title2)
            Text("Reuse this goal in its original room. Jarvis authors a new draft under the current policy; the old plan stays immutable. Review, accept and Start are still separate steps.")
                .font(.caption).foregroundStyle(.secondary)
            Text("Source: \(plan.id) · revision \(plan.revision)").font(.caption.monospaced()).textSelection(.enabled)
            TextField("Goal for the new draft", text: $goal, axis: .vertical).lineLimit(5...12).textFieldStyle(.roundedBorder)
            if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Author new draft") {
                    let capturedGoal = goal
                    Task { if await model.authorGoal(capturedGoal, roomId: plan.roomId) { dismiss() } }
                }.buttonStyle(.jarvisPrimary).keyboardShortcut(.defaultAction)
                    .disabled(!model.canMutate || model.pendingActions.contains("author:\(plan.roomId)") || goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(28).frame(width: 560).jarvisThemed()
    }
}

struct RoomsRoomEditor: View {
    @Environment(\.theme) private var theme
    @ObservedObject var model: RoomsModel
    let room: HarnessRoom?
    @State private var title: String
    @State private var detail: String
    @State private var status: String
    @State private var policy: HarnessRoomPolicy
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    init(model: RoomsModel, room: HarnessRoom?, policy: HarnessRoomPolicy) {
        self.model = model; self.room = room
        _title = State(initialValue: room?.title ?? "")
        _detail = State(initialValue: room?.description ?? "")
        _status = State(initialValue: room?.status ?? "active")
        _policy = State(initialValue: policy)
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text(room == nil ? "Create a room" : "Room policy").font(.title2)
                    Text(room.map { "Editing room revision \($0.revision). Existing runs keep their policy snapshot." }
                         ?? "A durable scope for plans, workers, questions and artifacts.")
                        .font(.caption).foregroundStyle(theme.muted)
                }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(saving ? "Saving…" : "Save room") { save() }
                    .buttonStyle(.jarvisPrimary).keyboardShortcut(.defaultAction)
                    .disabled(saving || !model.canMutate || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }.padding(24)
            Divider()
            Form {
                Section("Identity") {
                    TextField("Room name", text: $title)
                    TextField("Scope / description", text: $detail, axis: .vertical).lineLimit(2...5)
                    if room != nil {
                        Picker("Room state", selection: $status) {
                            Text("Active").tag("active"); Text("Paused").tag("paused"); Text("Archived").tag("archived")
                        }
                        Text("Pausing or archiving a room does not undo work. Use each run’s stop control to request cancellation.").font(.caption)
                    }
                    Picker("Question attention", selection: $policy.attention) {
                        Text("Normal").tag("normal"); Text("Quiet · inbox only").tag("quiet")
                    }
                }
                Section("Orchestration limits") {
                    Stepper("Parallel workers: \(policy.maxConcurrentWorkers)", value: $policy.maxConcurrentWorkers, in: 1...8)
                    Stepper("Maximum plan nodes: \(policy.maxNodes)", value: $policy.maxNodes, in: 1...32)
                    Stepper("Dependencies per node: \(policy.maxDependenciesPerNode)", value: $policy.maxDependenciesPerNode, in: 0...16)
                    Text("The runtime also applies a global concurrency ceiling. These are upper bounds, not promised capacity.").font(.caption)
                }
                Section("Full-run budget · including retries and continuations") { RoomsBudgetEditor(budget: $policy.runBudget) }
                Section("Plan-authoring budget") { RoomsBudgetEditor(budget: $policy.authoringBudget) }
                Section("Isolated worker") {
                    LabeledContent("Backend", value: "Docker · fail closed")
                    TextField("Pinned image digest (blank = unavailable)", text: Binding(
                        get: { policy.sandbox.image ?? "" }, set: { policy.sandbox.image = $0.isEmpty ? nil : $0 }
                    )).font(.system(.caption, design: .monospaced))
                    LabeledContent("Network", value: "None")
                    LabeledContent("Host / external operations", value: "Separate exact approval cards only")
                    Stepper("CPU limit: \(policy.sandbox.cpus, specifier: "%.2f")", value: $policy.sandbox.cpus, in: 0.25...4, step: 0.25)
                    number("Memory (MiB)", value: $policy.sandbox.memoryMiB)
                    number("Process limit", value: $policy.sandbox.pidsLimit)
                    number("Workspace (MiB)", value: $policy.sandbox.workspaceMiB)
                    number("Artifact byte limit", value: $policy.sandbox.maxArtifactBytes)
                    number("Artifact file limit", value: $policy.sandbox.maxArtifactFiles)
                    number("Log byte limit", value: $policy.sandbox.maxLogBytes)
                    Text("No host-code fallback, secret mounts or worker network. Configuring a digest does not download or provision an image.")
                        .font(.caption).foregroundStyle(theme.warning)
                }
            }.formStyle(.grouped)
            if let error = model.error { Text(error).font(.caption).foregroundStyle(theme.danger).textSelection(.enabled).padding(16) }
        }.frame(width: 720, height: 760).background(theme.background).jarvisThemed()
            .interactiveDismissDisabled(saving)
    }
    private func number(_ title: String, value: Binding<Int>) -> some View {
        TextField(title, value: value, format: .number.grouping(.never)).monospacedDigit()
    }
    private func save() {
        saving = true
        Task {
            let success: Bool
            if let room { success = await model.updateRoom(room, title: title, description: detail, status: status, policy: policy) }
            else { success = await model.createRoom(title: title, description: detail, policy: policy) }
            saving = false
            if success { dismiss() }
        }
    }
}

struct RoomsBudgetEditor: View {
    @Environment(\.theme) private var theme
    @Binding var budget: HarnessBudgetLimits
    var body: some View {
        TextField("Steps (1–100)", value: $budget.maxSteps, format: .number.grouping(.never))
        TextField("Model calls (1–100)", value: $budget.maxModelCalls, format: .number.grouping(.never))
        TextField("Total tokens (128–1,000,000)", value: $budget.maxTokens, format: .number.grouping(.never))
        TextField("Output tokens per call (64–16,384)", value: $budget.maxOutputTokensPerCall, format: .number.grouping(.never))
        TextField("Wall time (milliseconds)", value: $budget.maxWallTimeMs, format: .number.grouping(.never))
        Toggle("Use an estimated dollar threshold", isOn: Binding(
            get: { budget.estimatedUsdLimit != nil }, set: { budget.estimatedUsdLimit = $0 ? 1 : nil }
        ))
        if budget.estimatedUsdLimit != nil {
            TextField("Estimated USD threshold", value: Binding(get: { budget.estimatedUsdLimit ?? 0 }, set: { budget.estimatedUsdLimit = $0 }), format: .number)
        }
        Text("Dollar thresholds are estimates, not hard provider billing caps. Unknown usage keeps conservative reservations.")
            .font(.caption).foregroundStyle(theme.muted)
    }
}

struct RoomsPlanEditor: View {
    @Environment(\.theme) private var theme
    @ObservedObject var model: RoomsModel
    let plan: HarnessPlan
    @State private var draft: HarnessPlanDraft
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    init(model: RoomsModel, plan: HarnessPlan) {
        self.model = model; self.plan = plan
        _draft = State(initialValue: .init(goal: plan.goal, nodes: plan.nodes))
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Edit the plan").font(.title2)
                    Text("Revision \(plan.revision) · saving does not accept or start work").font(.caption).foregroundStyle(theme.muted)
                }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(saving ? "Saving…" : "Save draft") {
                    saving = true
                    Task { let ok = await model.savePlan(plan, draft: draft); saving = false; if ok { dismiss() } }
                }.buttonStyle(.jarvisPrimary).keyboardShortcut(.defaultAction)
                    .disabled(saving || !model.canMutate || draft.nodes.isEmpty || draft.goal.isEmpty)
            }.padding(24)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    TextField("Goal", text: $draft.goal, axis: .vertical).lineLimit(2...6).textFieldStyle(.roundedBorder)
                    RoomsDependencyGraph(nodes: draft.nodes)
                    ForEach($draft.nodes) { $node in
                        RoomsNodeEditor(node: $node, nodes: draft.nodes) {
                            let id = node.id
                            draft.nodes.removeAll { $0.id == id }
                            for index in draft.nodes.indices {
                                draft.nodes[index].dependencies.removeAll { $0 == id }
                                draft.nodes[index].inputFrom.removeAll { $0 == id }
                            }
                        }
                    }
                    Button { addNode() } label: { Label("Add a worker node", systemImage: "plus") }
                        .disabled(draft.nodes.count >= (model.state?.rooms.first(where: { $0.id == plan.roomId })?.policy.maxNodes ?? 32))
                    if let error = model.error { Text(error).font(.caption).foregroundStyle(theme.danger).textSelection(.enabled) }
                }.padding(24)
            }
        }.frame(width: 820, height: 760).background(theme.background).jarvisThemed()
            .interactiveDismissDisabled(saving)
    }
    private func addNode() {
        guard let policy = model.state?.rooms.first(where: { $0.id == plan.roomId })?.policy else { return }
        var limits = policy.runBudget
        let count = draft.nodes.count + 1
        limits.maxSteps = max(1, policy.runBudget.maxSteps / count)
        limits.maxModelCalls = max(1, policy.runBudget.maxModelCalls / count)
        limits.maxTokens = max(128, policy.runBudget.maxTokens / count)
        limits.maxOutputTokensPerCall = min(limits.maxTokens, limits.maxOutputTokensPerCall)
        draft.nodes.append(.init(id: "node_" + UUID().uuidString, title: "New worker", role: "builder", instructions: "", dependencies: [], inputFrom: [], outputPaths: [], limits: limits))
    }
}

private struct RoomsNodeEditor: View {
    @Environment(\.theme) private var theme
    @Binding var node: HarnessPlanNode
    let nodes: [HarnessPlanNode]
    let onDelete: () -> Void
    var body: some View {
        RoomsPanel(title: "", eyebrow: node.id) {
            HStack {
                TextField("Worker title", text: $node.title).font(.headline)
                Picker("Role", selection: $node.role) {
                    Text("Builder").tag("builder"); Text("Researcher").tag("researcher")
                    Text("Reviewer").tag("reviewer"); Text("Tester").tag("tester")
                }.frame(width: 180)
                Button(role: .destructive, action: onDelete) { Image(systemName: "trash") }.accessibilityLabel("Remove \(node.title)")
            }
            TextField("Instructions", text: $node.instructions, axis: .vertical).lineLimit(3...10)
            if nodes.count > 1 {
                Text("Dependencies & immutable input snapshots").font(.caption).foregroundStyle(theme.muted)
                ForEach(nodes.filter { $0.id != node.id }) { other in
                    HStack {
                        Toggle("Wait for \(other.title)", isOn: Binding(
                            get: { node.dependencies.contains(other.id) },
                            set: { enabled in
                                if enabled { node.dependencies.append(other.id) }
                                else { node.dependencies.removeAll { $0 == other.id }; node.inputFrom.removeAll { $0 == other.id } }
                            }
                        ))
                        Spacer()
                        Toggle("Receive artifacts", isOn: Binding(
                            get: { node.inputFrom.contains(other.id) },
                            set: { enabled in if enabled { node.inputFrom.append(other.id) } else { node.inputFrom.removeAll { $0 == other.id } } }
                        )).disabled(!node.dependencies.contains(other.id)).accessibilityLabel("Receive immutable artifacts from \(other.title)")
                    }.font(.caption)
                }
            }
            TextField("Expected output paths · one per line", text: Binding(
                get: { node.outputPaths.joined(separator: "\n") }, set: { node.outputPaths = $0.components(separatedBy: "\n") }
            ), axis: .vertical).lineLimit(2...6).font(.system(.caption, design: .monospaced))
            DisclosureGroup("Node budget") { RoomsBudgetEditor(budget: $node.limits).padding(.top, 12) }
                .font(.caption)
        }
        .textFieldStyle(.roundedBorder)
    }
}
