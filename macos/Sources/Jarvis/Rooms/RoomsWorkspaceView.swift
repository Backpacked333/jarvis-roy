import SwiftUI

private enum RoomsWorkspaceSection: String, CaseIterable {
    case overview = "Overview", plans = "Plans", artifacts = "Artifacts", attention = "Attention"
}

struct RoomsWorkspaceView: View {
    @ObservedObject var model: RoomsModel
    let onVoiceContext: (HarnessVoiceContext) -> Void
    let onSpeakQuestion: (HarnessQuestion) -> Void
    let onReviewApproval: (HarnessApproval) -> Void
    var observationOwnership: RoomsObservationOwner = .workspace
    @State private var section: RoomsWorkspaceSection = .overview
    @State private var creatingRoom = false
    @State private var editingRoom: HarnessRoom?
    @State private var editingPlan: HarnessPlan?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                roomRail.frame(width: geometry.size.width < 900 ? 175 : 218)
                Rectangle().fill(RoomsPalette.line).frame(width: 1)
                VStack(spacing: 0) {
                    header
                    if let error = model.error { errorBanner(error) }
                    if model.state == nil {
                        initialState.padding(32)
                    } else {
                        HStack(alignment: .top, spacing: 0) {
                            ScrollView {
                                VStack(alignment: .leading, spacing: 24) {
                                    if !model.isConnected { disconnectedBanner }
                                    if let state = model.state, !state.ready {
                                        Label("Reconciling saved work. Controls remain unavailable until the service is ready.", systemImage: "clock.badge.exclamationmark")
                                            .font(.caption).foregroundStyle(RoomsPalette.amber)
                                    }
                                    content
                                }.padding(28).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if geometry.size.width >= 1240 && section != .attention {
                                Rectangle().fill(RoomsPalette.line).frame(width: 1)
                                ScrollView { attention.padding(22) }.frame(width: 316).background(RoomsPalette.panel.opacity(0.35))
                            }
                        }
                    }
                    footer
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(RoomsPalette.background).foregroundStyle(.white).tint(RoomsPalette.cyan).preferredColorScheme(.dark)
        .onAppear {
            if observationOwnership == .workspace {
                model.setApplicationActive(scenePhase == .active)
                model.startObserving(owner: .workspace)
            }
            onVoiceContext(model.voiceContext)
            showAttentionNavigation()
        }
        .onDisappear { if observationOwnership == .workspace { model.stopObserving(owner: .workspace) } }
        .onChange(of: scenePhase) { _, phase in
            if observationOwnership == .workspace { model.setApplicationActive(phase == .active) }
        }
        .onChange(of: model.attentionNavigation) { _, _ in showAttentionNavigation() }
        .onChange(of: model.selectedRoomId) { _, _ in onVoiceContext(model.voiceContext) }
        .onChange(of: model.focusedQuestion) { _, _ in onVoiceContext(model.voiceContext) }
        .onChange(of: model.state?.sequence) { _, _ in speakNextQuestion() }
        .onChange(of: model.voiceState) { _, _ in speakNextQuestion() }
        .onChange(of: model.spokenAttentionEnabled) { _, enabled in if enabled { speakNextQuestion() } }
        .sheet(isPresented: $creatingRoom) {
            if let policy = model.state?.defaultPolicy { RoomsRoomEditor(model: model, room: nil, policy: policy) }
        }
        .sheet(item: $editingRoom) { RoomsRoomEditor(model: model, room: $0, policy: $0.policy) }
        .sheet(item: $editingPlan) { RoomsPlanEditor(model: model, plan: $0) }
    }

    private var roomRail: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Image(systemName: "circle.hexagongrid").font(.system(size: 26, weight: .ultraLight)).foregroundStyle(RoomsPalette.cyan)
                Text("JARVIS").font(.system(size: 17, weight: .medium)).tracking(4)
            }.padding(.top, 32)
            Text("ROOM CONTROL").font(.system(size: 9, weight: .medium)).tracking(2.8).foregroundStyle(RoomsPalette.muted).padding(.top, 9)
            HStack {
                Text("YOUR ROOMS").font(.system(size: 10, weight: .semibold)).tracking(1.5).foregroundStyle(RoomsPalette.muted)
                Spacer()
                Button { creatingRoom = true } label: { Image(systemName: "plus") }
                    .buttonStyle(.plain).help("Create a room (⇧⌘N)").accessibilityLabel("Create a room")
                    .keyboardShortcut("n", modifiers: [.command, .shift]).disabled(!model.canMutate)
            }.padding(.top, 40).padding(.bottom, 16)
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(model.state?.rooms ?? []) { room in roomButton(room) }
                    if model.state?.rooms.isEmpty == true {
                        Text("Rooms you create persist here across restarts.").font(.caption).foregroundStyle(RoomsPalette.muted).lineSpacing(4).padding(.vertical, 12)
                    }
                }
            }
            Spacer(minLength: 18)
            VStack(alignment: .leading, spacing: 10) {
                Label("Local by design", systemImage: "lock.shield").font(.system(size: 11, weight: .medium))
                Text("Isolated work. Explicit starts.\nYour approval for host actions.").font(.system(size: 10)).foregroundStyle(RoomsPalette.muted).lineSpacing(5)
                Rectangle().fill(RoomsPalette.line).frame(height: 1).padding(.vertical, 8)
                Text("MAC SLEEP / SHUTDOWN\nLOCAL WORK STOPS").font(.system(size: 9, weight: .semibold)).tracking(1.1).foregroundStyle(RoomsPalette.amber).lineSpacing(5)
            }.padding(.bottom, 24)
        }.padding(.horizontal, 20).background(RoomsPalette.panel.opacity(0.5))
    }

    private func roomButton(_ room: HarnessRoom) -> some View {
        let selected = model.selectedRoomId == room.id
        let pending = model.questions.filter { $0.target.roomId == room.id }.count
        return Button { model.selectedRoomId = room.id } label: {
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 2).fill(selected ? RoomsPalette.cyan : RoomsPalette.muted.opacity(0.3)).frame(width: 3, height: 28)
                VStack(alignment: .leading, spacing: 6) {
                    Text(room.title).font(.system(size: 12, weight: .medium)).lineLimit(2)
                    HStack(spacing: 5) {
                        Text(room.status.capitalized)
                        if room.policy.attention == "quiet" { Image(systemName: "bell.slash") }
                    }.font(.system(size: 10)).foregroundStyle(RoomsPalette.muted)
                }
                Spacer(minLength: 0)
                if pending > 0 { Text("\(pending)").font(.system(size: 10, design: .monospaced)).foregroundStyle(RoomsPalette.amber) }
            }.padding(.vertical, 13).padding(.horizontal, 10).frame(maxWidth: .infinity, alignment: .leading)
                .background(selected ? RoomsPalette.cyan.opacity(0.075) : .clear, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? RoomsPalette.cyan.opacity(0.18) : .clear))
        }.buttonStyle(.plain).accessibilityLabel("\(room.title), \(room.status), \(pending) pending questions")
            .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 19) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("CONTROL CENTER / LOCAL").font(.system(size: 9, weight: .medium, design: .monospaced)).tracking(2).foregroundStyle(RoomsPalette.muted)
                    Text(model.selectedRoom?.title ?? "Your next idea starts here").font(.system(size: 23, weight: .light)).lineLimit(1)
                }
                Spacer()
                Circle().fill(model.isConnected ? RoomsPalette.cyan : RoomsPalette.amber).frame(width: 6, height: 6).accessibilityHidden(true)
                Text(model.isConnected ? "Bridge connected" : "Bridge offline").font(.system(size: 10)).foregroundStyle(RoomsPalette.muted)
                Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh rooms").keyboardShortcut("r", modifiers: .command).disabled(model.isRefreshing)
                if let room = model.selectedRoom {
                    Button { editingRoom = room } label: { Label("Policy", systemImage: "slider.horizontal.3") }
                        .disabled(!model.canMutate)
                }
            }
            HStack(spacing: 22) {
                ForEach(RoomsWorkspaceSection.allCases, id: \.self) { item in
                    Button { section = item } label: {
                        VStack(spacing: 10) {
                            HStack(spacing: 6) {
                                Text(item.rawValue).font(.system(size: 11, weight: .medium))
                                if item == .attention && model.questions.count + model.approvals.count > 0 { Text("\(model.questions.count + model.approvals.count)").font(.system(size: 10, design: .monospaced)).foregroundStyle(RoomsPalette.amber) }
                            }
                            Rectangle().fill(section == item ? RoomsPalette.cyan : .clear).frame(height: 2)
                        }.foregroundStyle(section == item ? .white : RoomsPalette.muted)
                    }.buttonStyle(.plain).accessibilityAddTraits(section == item ? [.isSelected] : [])
                }
                Spacer(minLength: 0)
            }
        }.padding(.horizontal, 28).padding(.top, 24)
            .overlay(alignment: .bottom) { Rectangle().fill(RoomsPalette.line).frame(height: 1) }
    }

    @ViewBuilder private var content: some View {
        if section == .attention { attention }
        else if let room = model.selectedRoom {
            switch section {
            case .overview:
                RoomsOverview(model: model, room: room)
                if let plan = model.plans.first { RoomsPlanCard(model: model, plan: plan, onEdit: { editingPlan = $0 }) }
                ForEach(model.runs) { RoomsRunCard(model: model, run: $0) }
            case .plans:
                if model.plans.isEmpty { RoomsEmptyState(icon: "point.3.connected.trianglepath.dotted", title: "A plan before action.", detail: "Describe a goal in Overview. Jarvis will draft a dependency graph for you to edit and accept. Planning never starts a worker.") }
                ForEach(model.plans) { RoomsPlanCard(model: model, plan: $0, onEdit: { editingPlan = $0 }) }
            case .artifacts: RoomsArtifactsView(model: model)
            case .attention: EmptyView()
            }
        } else {
            RoomsPanel(title: "", eyebrow: "ROOM TO BUILD") {
                RoomsEmptyState(icon: "square.stack.3d.up", title: "Give an idea its own room.", detail: "Set a scope and limits. Describe the outcome. Review the plan, then start real isolated workers. Jarvis asks when it needs you.")
                Button("Create your first room") { creatingRoom = true }.buttonStyle(.borderedProminent).disabled(!model.canMutate)
            }
        }
    }

    private var attention: some View {
        RoomsAttentionView(model: model, onSpeakQuestion: { question in
            onVoiceContext(model.voiceContext)
            onSpeakQuestion(question)
        }, onReviewApproval: onReviewApproval)
    }
    private var initialState: some View {
        VStack(alignment: .leading, spacing: 18) {
            if model.isRefreshing { ProgressView("Loading durable rooms…") }
            else {
                RoomsEmptyState(icon: "network.slash", title: "The local service is unavailable.", detail: "Jarvis's local services are not answering. Use Retry in the banner above, or restart them in Settings. Your saved rooms remain on disk; no placeholder activity is shown.")
                Button("Reconnect") { Task { await model.refresh() } }
            }
            Spacer()
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    private var disconnectedBanner: some View {
        Label("Read-only saved snapshot. Reconnect before issuing controls or answers.", systemImage: "wifi.slash")
            .font(.caption).foregroundStyle(RoomsPalette.amber)
    }
    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
            Text(message).font(.caption).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            Button { model.clearError() } label: { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel("Dismiss error")
        }.padding(14).foregroundStyle(RoomsPalette.amber).background(RoomsPalette.amber.opacity(0.07))
    }
    private var footer: some View {
        HStack(spacing: 12) {
            Text("NO NETWORK IN WORKERS").tracking(1)
            Spacer()
            if let updated = model.lastUpdated { Text("Synced \(updated.formatted(date: .omitted, time: .standard))") }
            Text("LOCAL WORK DOES NOT CONTINUE THROUGH MAC SLEEP")
        }.font(.system(size: 9, design: .monospaced)).foregroundStyle(RoomsPalette.muted).padding(.horizontal, 24).padding(.vertical, 12)
            .background(RoomsPalette.panel.opacity(0.5))
    }
    private func speakNextQuestion() {
        guard model.onQuestionAttention == nil, scenePhase == .active, let question = model.nextSpokenQuestion() else { return }
        onVoiceContext(model.voiceContext)
        onSpeakQuestion(question)
    }

    private func showAttentionNavigation() {
        guard let target = model.attentionNavigation else { return }
        section = .attention
        if case .approval(let approval) = target, model.onAttentionNavigation == nil { onReviewApproval(approval) }
        model.clearAttentionNavigation()
    }
}

private struct RoomsOverview: View {
    @ObservedObject var model: RoomsModel
    let room: HarnessRoom
    private var goal: Binding<String> {
        Binding(get: { model.goalDraft(roomId: room.id) }, set: { model.setGoalDraft($0, roomId: room.id) })
    }
    private var running: Int { model.runs.flatMap(\.nodes).filter { $0.status == "running" }.count }
    private var waiting: Int { model.questions.filter { $0.target.roomId == room.id }.count }
    var body: some View {
        VStack(spacing: 22) {
            RoomsPanel(title: "", eyebrow: "ROOM INTELLIGENCE") {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 26) { heroCopy.frame(minWidth: 210, maxWidth: .infinity, alignment: .leading); signal }
                    VStack(alignment: .leading, spacing: 24) { heroCopy; signal.frame(maxWidth: .infinity) }
                }
            }
            if model.state?.worker.available == false {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "shippingbox").foregroundStyle(RoomsPalette.amber)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Workers unavailable").font(.system(size: 13, weight: .medium))
                        Text(model.state?.worker.reason ?? "Configure a digest-pinned local Docker image. There is no host execution fallback.")
                            .font(.caption).foregroundStyle(RoomsPalette.muted)
                        Text("You can still create rooms and draft plans when the planning service is ready.").font(.caption).foregroundStyle(RoomsPalette.muted)
                    }
                    Spacer()
                }.padding(18).background(RoomsPalette.amber.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
            }
            RoomsPanel(title: "What should this room build?", eyebrow: "01 / DESCRIBE THE OUTCOME") {
                TextField("Describe the outcome, constraints and deliverables…", text: goal, axis: .vertical)
                    .lineLimit(3...8).textFieldStyle(.plain).font(.system(size: 14)).padding(14)
                    .background(RoomsPalette.background, in: RoundedRectangle(cornerRadius: 10)).accessibilityLabel("Room goal")
                HStack {
                    Text("Draft → review & accept → explicit start").font(.system(size: 10)).foregroundStyle(RoomsPalette.muted)
                    Spacer()
                    Button { model.submitGoalDraft(roomId: room.id) } label: { Label("Draft a plan", systemImage: "arrow.up.right") }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command)
                        .disabled(!model.canMutate || room.status != "active" || model.pendingActions.contains("author:\(room.id)") || goal.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let transcript = model.lastVoiceGoal { Text("Last captured voice goal: \(transcript)").font(.caption).foregroundStyle(RoomsPalette.muted).textSelection(.enabled) }
            }
            ForEach(model.authorings) { authoring in
                RoomsPanel(title: "Plan authoring", eyebrow: authoring.id) {
                    HStack { RoomsStatus(value: authoring.status); Spacer(); if ["authoring", "waiting_question"].contains(authoring.status) { Button("Cancel planning") { Task { await model.cancelAuthoring(authoring) } }.disabled(!model.canMutate || model.pendingActions.contains("authoring:\(authoring.id)")) } }
                    Text(authoring.goal).font(.caption).textSelection(.enabled)
                    RoomsUsageView(usage: authoring.usage)
                    if let error = authoring.error { Text(error).font(.caption).foregroundStyle(RoomsPalette.red) }
                }
            }
        }
    }
    private var signal: some View { RoomsSignalCore(state: model.voiceState, levels: model.audioLevels, history: model.audioHistory) }
    private var heroCopy: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(waiting > 0 ? "Your judgment.\nTheir next step." : running > 0 ? "Ideas in motion.\nYou stay in control." : "Room to think.\nSpace to build.")
                .font(.system(size: 33, weight: .light)).tracking(-0.7).lineSpacing(3)
            Text(room.description.isEmpty ? "A persistent workspace for bounded, independent agents." : room.description)
                .font(.system(size: 12)).foregroundStyle(RoomsPalette.muted).lineSpacing(4).lineLimit(4)
            HStack(spacing: 22) {
                count(running, "RUNNING")
                count(waiting, "QUESTIONS")
                count(model.artifacts.count, "SNAPSHOTS")
            }
            Text(model.voiceState == .unavailable ? "Premium voice unavailable · text remains ready" : "Premium voice · \(model.voiceState.rawValue) · real audio levels only")
                .font(.system(size: 10)).foregroundStyle(RoomsPalette.muted)
            if model.focusedQuestion != nil {
                Button("Clear question voice target") { model.clearQuestionFocus() }.font(.caption)
            }
        }
    }
    private func count(_ value: Int, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(value)").font(.system(size: 23, weight: .light, design: .monospaced)).foregroundStyle(RoomsPalette.cyan)
            Text(label).font(.system(size: 9, weight: .medium)).tracking(1).foregroundStyle(RoomsPalette.muted)
        }
    }
}

private struct RoomsPlanCard: View {
    @ObservedObject var model: RoomsModel
    let plan: HarnessPlan
    let onEdit: (HarnessPlan) -> Void
    @State private var reviewing: HarnessPlan?
    @State private var reusing: HarnessPlan?
    private var hasPriorRuns: Bool { model.state?.runs.contains { $0.planId == plan.id && $0.roomId == plan.roomId } == true }
    private var policyMatches: Bool { model.state?.rooms.first(where: { $0.id == plan.roomId })?.policy.revision == plan.policyRevision }
    var body: some View {
        RoomsPanel(title: plan.status == "accepted" ? "Reusable accepted plan" : "The plan", eyebrow: plan.status == "draft" ? "02 / REVIEW BEFORE ACCEPTING" : "03 / ACCEPTED · NOT AUTO-STARTED") {
            HStack { RoomsStatus(value: plan.status); Text("Revision \(plan.revision) · policy \(plan.policyRevision)").font(.caption).foregroundStyle(RoomsPalette.muted); Spacer() }
            Text(plan.goal).font(.system(size: 14)).textSelection(.enabled)
            RoomsDependencyGraph(nodes: plan.nodes)
            DisclosureGroup("Inspect worker instructions, outputs & budgets") {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(plan.nodes) { node in
                        VStack(alignment: .leading, spacing: 7) {
                            Text(node.title).font(.headline)
                            Text(node.instructions).font(.caption).textSelection(.enabled)
                            Text("Outputs: \(node.outputPaths.joined(separator: ", "))").font(.caption).foregroundStyle(RoomsPalette.cyan)
                            Text("\(node.limits.maxSteps) steps · \(node.limits.maxModelCalls) calls · \(node.limits.maxTokens) tokens · \(node.limits.maxWallTimeMs / 1_000)s").font(.caption2).foregroundStyle(RoomsPalette.muted)
                        }
                    }
                    if let digest = plan.digest { Text("Immutable plan SHA256\n\(digest)").font(.system(size: 10, design: .monospaced)).textSelection(.enabled) }
                }.padding(.top, 14)
            }.font(.caption).foregroundStyle(RoomsPalette.muted)
            if !policyMatches { Label("Room policy changed. Author a fresh plan before starting.", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(RoomsPalette.amber) }
            HStack {
                if plan.status == "draft" {
                    Button("Edit draft") { onEdit(plan) }
                    Spacer()
                    Button("Accept this revision…") { reviewing = plan }.buttonStyle(.borderedProminent)
                } else {
                    Button("Draft a variation…") { reusing = plan }
                    Spacer()
                    Button(hasPriorRuns ? "Review & run again…" : "Start isolated run…") { reviewing = plan }.buttonStyle(.borderedProminent)
                        .disabled(!policyMatches || model.state?.worker.available != true)
                }
            }.disabled(!model.canMutate || model.pendingActions.contains("plan:\(plan.id)"))
        }
        .sheet(item: $reusing) { RoomsPlanReuseView(model: model, plan: $0) }
        .confirmationDialog("Confirm the reviewed plan", isPresented: Binding(get: { reviewing != nil }, set: { if !$0 { reviewing = nil } }), titleVisibility: .visible, presenting: reviewing) { reviewed in
            if reviewed.status == "draft" { Button("Accept revision \(reviewed.revision)") { Task { await model.accept(reviewed) }; reviewing = nil } }
            else { Button("Start isolated run") { Task { await model.start(reviewed) }; reviewing = nil } }
            Button("Cancel", role: .cancel) { }
        } message: { reviewed in
            Text(reviewed.status == "draft" ? "This freezes revision \(reviewed.revision) and its budgets. No workers start until you separately choose Start isolated run." : "Creates a new run from revision \(reviewed.revision) with \(reviewed.nodes.count) bounded worker nodes and no worker network access. Local work stops during Mac sleep or shutdown. External actions still require exact approval cards.")
        }
    }
}

private struct RoomsRunCard: View {
    @ObservedObject var model: RoomsModel
    let run: HarnessRun
    @State private var stopping: HarnessRun?
    @State private var retrying: RoomsRetrySelection?
    private var plan: HarnessPlan? { model.state?.plans.first { $0.id == run.planId && $0.digest == run.planDigest && $0.roomId == run.roomId } }
    var body: some View {
        RoomsPanel(title: "Worker floor", eyebrow: "RUN / \(run.id)") {
            HStack {
                RoomsStatus(value: run.status)
                Spacer()
                if !RoomsStateRules.terminal(run.status) && run.status != "cancel_requested" {
                    if run.status == "paused" {
                        Button("Resume dispatch") { Task { await model.control(run, action: "resume") } }
                    } else if run.status != "interrupted" {
                        Button("Pause dispatch") { Task { await model.control(run, action: "pause") } }
                    }
                    Button("Stop run…", role: .destructive) { stopping = run }
                }
            }.disabled(!model.canMutate || model.pendingActions.contains("run:\(run.id)"))
            if run.status == "cancel_requested" || (run.status == "cancelled" && !run.cancelConfirmed) {
                Label("Stop requested, not confirmed. Resources may still be active.", systemImage: "exclamationmark.octagon").font(.caption).foregroundStyle(RoomsPalette.red)
            }
            if run.status == "interrupted" {
                Text("Restart reconciliation could not confirm completion. No uncertain work is replayed automatically. Retry requires the server to confirm the old resource stopped.")
                    .font(.caption).foregroundStyle(RoomsPalette.amber)
            }
            if run.status == "paused" { Text("New dispatch is paused. Already-running workers may finish; pause is not cancellation.").font(.caption).foregroundStyle(RoomsPalette.amber) }
            RoomsUsageView(usage: run.usage, limits: run.policy.runBudget)
            RoomsWorkerCensus(nodes: run.nodes)
            DisclosureGroup("Immutable run policy · revision \(run.policy.revision)") {
                VStack(alignment: .leading, spacing: 7) {
                    Text("\(run.policy.maxConcurrentWorkers) concurrent workers · \(run.policy.runBudget.maxTokens) token cap · \(run.policy.runBudget.maxWallTimeMs / 1_000)s wall-time cap")
                    Text("Docker · no network · \(run.policy.sandbox.memoryMiB) MiB · \(run.policy.sandbox.cpus, specifier: "%.2f") CPU · \(run.policy.sandbox.pidsLimit) processes")
                    Text(run.policy.sandbox.image ?? "Image was unconfigured").font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                    Text("Host actions: exact approval cards only. Later room edits do not change this run.")
                }.font(.caption).foregroundStyle(RoomsPalette.muted).padding(.top, 10)
            }.font(.caption).foregroundStyle(RoomsPalette.muted)
            if let plan { RoomsDependencyGraph(nodes: plan.nodes, states: run.nodes) }
            ForEach(run.nodes) { node in worker(node) }
        }
        .confirmationDialog("Stop this run?", isPresented: Binding(get: { stopping != nil }, set: { if !$0 { stopping = nil } }), titleVisibility: .visible, presenting: stopping) { reviewed in
            Button("Request cancellation", role: .destructive) { Task { await model.control(reviewed, action: "cancel") }; stopping = nil }
            Button("Keep running", role: .cancel) { }
        } message: { _ in Text("Cancellation is a request until the worker confirms its resource stopped. Completed actions cannot be undone.") }
        .confirmationDialog("Explicitly retry this node?", isPresented: Binding(get: { retrying != nil }, set: { if !$0 { retrying = nil } }), presenting: retrying) { reviewed in
            Button("Retry in a new attempt") { Task { await model.retry(reviewed.node, run: reviewed.run) }; retrying = nil }
            Button("Cancel", role: .cancel) { retrying = nil }
        } message: { _ in Text("The runtime must confirm the previous resource is stopped. Retry consumes the remaining full-run budget; uncertain side effects are not automatically replayed.") }
    }
    private func worker(_ node: HarnessNodeState) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack {
                Text(plan?.nodes.first(where: { $0.id == node.nodeId })?.title ?? node.nodeId).font(.system(size: 13, weight: .medium))
                Spacer()
                RoomsStatus(value: node.status)
            }
            Text(node.operation ?? (node.status == "queued" ? "Waiting for dependency success and budget reservation" : "No operation detail reported"))
                .font(.caption).foregroundStyle(RoomsPalette.muted).textSelection(.enabled)
            if let attempt = node.attemptId { Text("Attempt \(node.attemptNumber) · \(attempt)").font(.system(size: 10, design: .monospaced)).foregroundStyle(RoomsPalette.muted).textSelection(.enabled) }
            if let error = node.error { Text(error).font(.caption).foregroundStyle(RoomsPalette.red).textSelection(.enabled) }
            DisclosureGroup("Usage & output references") {
                VStack(alignment: .leading, spacing: 10) {
                    RoomsUsageView(usage: node.usage)
                    ForEach(node.artifactIds, id: \.self) { Text($0).font(.system(size: 10, design: .monospaced)).textSelection(.enabled) }
                }.padding(.top, 10)
            }.font(.caption).foregroundStyle(RoomsPalette.muted)
            if ["failed", "interrupted", "cancelled"].contains(node.status), node.attemptId != nil {
                Button("Review explicit retry…") { retrying = RoomsRetrySelection(run: run, node: node) }.font(.caption)
                    .disabled(!model.canMutate || model.pendingActions.contains("run:\(run.id)"))
            }
        }.padding(15).background(RoomsPalette.elevated.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct RoomsRetrySelection {
    let run: HarnessRun
    let node: HarnessNodeState
}
