import SwiftUI

@MainActor
final class TodayModel: ObservableObject {
    @Published private(set) var objectives: [AssistantObjective] = []
    @Published private(set) var readiness: ObjectiveReadiness?
    @Published private(set) var busy = false
    @Published var error: String?
    private let client: AssistantClient
    private var readGeneration = 0
    private var authorityID = "local"
    static var currentAuthorityID: String { RuntimeProfiles.shared.selected == .cloud ? RuntimeProfiles.shared.cloudProfile?.id ?? "unpaired" : "local" }
    func resetAuthority() {
        readGeneration += 1; authorityID = Self.currentAuthorityID
        objectives = []; readiness = nil; error = nil
    }
    private func request<T: Decodable>(_ type: T.Type, path: String, method: String = "GET", body: [String: Any]? = nil, authority: String) async throws -> T {
        guard Self.currentAuthorityID == authority else { throw AssistantClientError.invalidResponse }
        if authority == "local" { return try await client.value(type, path: path, method: method, body: body) }
        let bytes = try await PairedCloudConnection.shared.objectiveData(path: path.replacingOccurrences(of: "/v1/objectives", with: "/v1/cloud/objectives"), method: method, body: body)
        guard Self.currentAuthorityID == authority else { throw AssistantClientError.invalidResponse }
        return try JSONDecoder().decode(type, from: bytes)
    }
    init(client: AssistantClient) { self.client = client }

    func refresh() async {
        guard AssistantFeatures.objectives else { objectives = []; readiness = nil; return }
        readGeneration += 1
        let generation = readGeneration, authority = Self.currentAuthorityID
        do {
            struct Response: Decodable { let version: Int, objectives: [AssistantObjective], readiness: ObjectiveReadiness }
            let result = try await request(Response.self, path: "/v1/objectives", authority: authority)
            guard generation == readGeneration, authority == Self.currentAuthorityID else { return }
            guard result.version == 1, result.objectives.allSatisfy({ $0.version == 1 && $0.revision > 0 }) else { throw AssistantClientError.invalidResponse }
            objectives = ObjectiveDisplayPolicy.ordered(result.objectives); readiness = result.readiness; error = nil
        } catch { if generation == readGeneration, authority == Self.currentAuthorityID { self.error = error.localizedDescription } }
    }

    func create(projectID: String, goal: String, ceiling: Double) async -> Bool {
        let goal = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy, !goal.isEmpty, goal.utf16.count <= 16_000, ceiling >= 1, ceiling <= 5 else { return false }
        return await mutate(path: "/v1/objectives", body: ["version": 1, "requestId": UUID().uuidString,
            "projectId": projectID, "title": String(goal.prefix(120)), "goal": goal, "estimatedUsdLimit": ceiling,
            "steps": [["id": "research", "authority": "research", "prompt": goal, "parameters": [:],
                "dependsOn": [], "estimatedUsd": 1, "maxWallTimeMs": 1_800_000]]])
    }

    func control(_ objective: AssistantObjective, action: String) async {
        guard ["pause", "resume", "stop"].contains(action) else { return }
        _ = await mutate(path: "/v1/objectives/\(objective.id)/\(action)?projectId=\(objective.projectId)",
            body: ["expectedRevision": objective.revision], expected: objective)
    }
    func answer(_ objective: AssistantObjective, text: String) async -> Bool {
        guard let question = objective.question, let expires = RoomsStateRules.date(question.expiresAt), expires > Date(),
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf16.count <= 4_000 else { return false }
        return await mutate(path: "/v1/objectives/\(objective.id)/answer?projectId=\(objective.projectId)", body: ["expectedRevision": objective.revision,
            "questionId": question.id, "questionRevision": question.revision, "answer": text], expected: objective)
    }
    private func mutate(path: String, body: [String: Any], expected: AssistantObjective? = nil) async -> Bool {
        guard !busy else { return false }
        busy = true; readGeneration += 1; error = nil
        let authority = Self.currentAuthorityID
        defer { busy = false }
        do {
            let result = try await request(AssistantObjective.self, path: path, method: "POST", body: body, authority: authority)
            guard authority == Self.currentAuthorityID else { return false }
            guard result.version == 1, expected.map({ result.id == $0.id && result.projectId == $0.projectId && result.revision >= $0.revision }) ?? true else { throw AssistantClientError.invalidResponse }
            AssistantRevisionMerge.upsert(result, in: &objectives)
            objectives = ObjectiveDisplayPolicy.ordered(objectives)
            await refresh(); return true
        } catch {
            guard authority == Self.currentAuthorityID else { return false }
            self.error = "\(error.localizedDescription) The operation is unconfirmed; refresh before trying again."
            return false
        }
    }
}

@MainActor
struct TodayWorkspaceView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var assistant: AssistantModel
    @StateObject private var today: TodayModel
    @ObservedObject private var profiles = RuntimeProfiles.shared
    @State private var goalDrafts: [String: String] = [:]
    @State private var cloudProjectID = ""
    private var draftScope: String { TodayModel.currentAuthorityID + ":" + (projectID ?? "none") }
    private var goal: String {
        get { goalDrafts[draftScope] ?? "" }
        nonmutating set { goalDrafts[draftScope] = newValue }
    }
    @State private var ceiling = 5.0
    @State private var setupVisible = false
    @State private var memoryVisible = false
    @State private var stopTarget: AssistantObjective?
    init(app: AppModel, assistant: AssistantModel) {
        self.app = app; self.assistant = assistant
        _today = StateObject(wrappedValue: TodayModel(client: assistant.client))
    }
    private var projectID: String? { profiles.selected == .cloud ? (cloudProjectID.isEmpty ? nil : cloudProjectID) : assistant.selectedSession?.focus.projectID }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("What would make today a good day?").font(.largeTitle.weight(.medium))
                        Text("Keep your work, decisions, and next conversation in one place.").foregroundStyle(.secondary)
                    }
                    Spacer()
                    Picker("Work location", selection: Binding(get: { profiles.selected }, set: { value in
                        do { try profiles.select(value) } catch { today.error = error.localizedDescription }
                    })) {
                        Text("This Mac").tag(RuntimeProfileKind.local)
                        if profiles.cloudProfile != nil { Text("Paired cloud").tag(RuntimeProfileKind.cloud) }
                    }.frame(width: 180)
                    Button { setupVisible = true } label: { Label("Setup", systemImage: "checklist") }
                }
                HStack(spacing: 12) {
                    Button { Task { await app.startNewConversation() } } label: { Label(profiles.selected == .cloud ? "Start a local conversation" : "Start a conversation", systemImage: "waveform") }
                        .buttonStyle(.borderedProminent).disabled(!app.isConnected)
                    if assistant.selectedSession != nil { Button("Continue conversation") { app.tab = .assistant } }
                    Button { memoryVisible = true } label: { Label(profiles.selected == .cloud ? "Local memory inbox" : "Memory inbox", systemImage: "brain") }
                }
                if let error = today.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
                if !AssistantFeatures.objectives {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Keep a goal moving", systemImage: "target").font(.headline)
                        Text("Enable objectives in Settings to run bounded research, keep checkpoints, and bring decisions back here.").foregroundStyle(.secondary)
                        SettingsLink { Text("Open Settings") }
                    }.padding(20).background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 14))
                } else {
                    objectiveComposer
                    if let readiness = today.readiness {
                        HStack {
                            Label(readiness.ready ? "Ready for bounded work" : "Work is paused", systemImage: readiness.ready ? "checkmark.circle" : "pause.circle")
                            Spacer()
                            Text("\(readiness.activeWorkers)/\(readiness.maxWorkers) workers · $\(readiness.dailyCommittedUsd, specifier: "%.2f") / $\(readiness.dailyLimitUsd, specifier: "%.0f") today")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if let reason = readiness.reason { Text(reason).font(.caption).foregroundStyle(.orange) }
                        if readiness.unknownReservations > 0 { Text("\(readiness.unknownReservations) budget reservations have uncertain outcomes. Review them before starting more work.").font(.caption).foregroundStyle(.orange) }
                    }
                    HStack { Text("Your objectives").font(.title2); Spacer(); Button("Refresh") { Task { await today.refresh() } } }
                    if today.objectives.isEmpty {
                        ContentUnavailableView("Room for your next goal", systemImage: "target", description: Text("Describe a research result you want. Review the estimate and start when ready."))
                    }
                    ForEach(today.objectives) { objective in
                        ObjectiveCard(objective: objective, busy: today.busy,
                            openProject: { if profiles.selected == .cloud { cloudProjectID = objective.projectId } else { Task { await app.openProject(objective.projectId) } } },
                            control: { action in
                                if action == "stop" { stopTarget = objective }
                                else { Task { await today.control(objective, action: action) } }
                            }, answer: { await today.answer(objective, text: $0) })
                    }
                }
                if app.approvalCount > 0 {
                    HStack {
                        Label("\(app.approvalCount) actions need your review", systemImage: "checkmark.shield")
                        Spacer(); Button("Review actions") { app.tab = .workspace }
                    }.padding(20).background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                }
            }.padding(32).frame(maxWidth: 1_100, alignment: .leading).frame(maxWidth: .infinity)
        }
        .task(id: TodayModel.currentAuthorityID) {
            today.resetAuthority()
            while !Task.isCancelled {
                await today.refresh()
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
        .sheet(isPresented: $setupVisible) { GuidedSetupView(app: app) }
        .sheet(isPresented: $memoryVisible) {
            VStack { HStack { Spacer(); Button("Done") { memoryVisible = false } }.padding(); MemoryWorkspaceView(projectID: assistant.selectedSession?.focus.projectID, client: assistant.client, reviewInbox: true) }
                .frame(minWidth: 860, minHeight: 620)
        }
        .confirmationDialog("Stop this objective?", isPresented: Binding(get: { stopTarget != nil }, set: { if !$0 { stopTarget = nil } }), titleVisibility: .visible) {
            if let target = stopTarget { Button("Stop \(String(target.title.prefix(40)))", role: .destructive) { Task { await today.control(target, action: "stop") }; stopTarget = nil } }
            Button("Keep working", role: .cancel) { stopTarget = nil }
        } message: { Text("Jarvis will request cancellation and report whether the current work actually stopped. Completed effects remain recorded.") }
    }
    private var objectiveComposer: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Give Jarvis a research objective", systemImage: "target").font(.headline)
            TextField("For example: Compare the evidence for these approaches and write a sourced brief", text: Binding(get: { goal }, set: { goal = $0 }), axis: .vertical)
                .lineLimit(2...5).textFieldStyle(.roundedBorder)
            if profiles.selected == .cloud {
                HStack {
                    Picker("Cloud project", selection: $cloudProjectID) {
                        Text("Choose a cloud project").tag("")
                        ForEach(Array(Set(today.objectives.map(\.projectId) + (cloudProjectID.isEmpty ? [] : [cloudProjectID]))).sorted(), id: \.self) { id in Text(String(id.prefix(24))).tag(id) }
                    }
                    Button("New cloud project") { cloudProjectID = UUID().uuidString }
                }
                Text("Runs on your paired cloud. Local documents and conversations are not copied by this action.").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Text(profiles.selected == .cloud ? "Cloud project" : assistant.selectedSession?.title ?? "Choose a project by starting a conversation").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Picker("Estimate ceiling", selection: $ceiling) { ForEach(1...5, id: \.self) { Text("$\($0)").tag(Double($0)) } }.frame(width: 190)
                Button("Start bounded research") {
                    guard let projectID else { return }
                    let captured = goal, scope = draftScope, capturedCeiling = ceiling
                    Task { if await today.create(projectID: projectID, goal: captured, ceiling: capturedCeiling), goalDrafts[scope] == captured { goalDrafts[scope] = "" } }
                }.disabled(today.busy || today.readiness?.ready != true || projectID == nil || goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || goal.utf16.count > 16_000)
            }
            Text("Up to 30 minutes; two workers shared across objectives. Uses permitted project sources. Estimates are separate from provider billing caps. Actions still require their own approval.")
                .font(.caption).foregroundStyle(.secondary)
        }.padding(20).background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 14))
    }
}

@MainActor
private struct ObjectiveCard: View {
    let objective: AssistantObjective, busy: Bool, openProject: () -> Void, control: (String) -> Void, answer: (String) async -> Bool
    @State private var response = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text(objective.title).font(.headline)
                    Text(objective.statusLabel).font(.caption).foregroundStyle(objective.needsAttention ? .orange : .secondary)
                }
                Spacer(); Button("Open project", action: openProject)
            }
            Text(objective.goal).lineLimit(3).textSelection(.enabled)
            if let checkpoint = objective.checkpoint { Text(checkpoint.summary).font(.callout).textSelection(.enabled); Text("Checkpoint summary · verify against the outputs").font(.caption).foregroundStyle(.secondary) }
            if let error = objective.lastError { Text(error).font(.callout).foregroundStyle(.orange) }
            if objective.hasUncertainWork { Text("The last work or charge could not be confirmed. Jarvis will not silently repeat it.").font(.caption).foregroundStyle(.orange) }
            if let question = objective.question {
                Text(question.prompt).font(.headline)
                HStack { TextField("Your answer", text: $response); Button("Reply") { let text = response; Task { if await answer(text), response == text { response = "" } } }.disabled(busy || response.isEmpty) }
            }
            DisclosureGroup("Steps and observed work") {
                ForEach(objective.steps) { step in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(step.prompt).font(.callout).textSelection(.enabled)
                        ForEach(objective.attempts.filter { $0.stepId == step.id }) { attempt in
                            Text("\(attempt.authority.capitalized): \(attempt.status) · \(attempt.accounting)\(attempt.cancelConfirmed ? " · cancellation confirmed" : "")")
                                .font(.caption).foregroundStyle(.secondary)
                            if let detail = attempt.detail { Text(detail).font(.caption).textSelection(.enabled) }
                        }
                    }.padding(.vertical, 4)
                }
            }
            HStack {
                Text("$\(objective.budget.spentUsd, specifier: "%.2f") estimated used · $\(objective.budget.reservedUsd, specifier: "%.2f") reserved · $\(objective.budget.limitUsd, specifier: "%.0f") ceiling").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if ["scheduled", "running", "waiting", "waiting_for_user", "waiting_for_device"].contains(objective.status) { Button("Pause") { control("pause") }.disabled(busy) }
                if objective.status == "paused" { Button("Resume") { control("resume") }.disabled(busy) }
                if !objective.terminal { Button("Stop", role: .destructive) { control("stop") }.disabled(busy) }
            }
        }.padding(20).background(.quaternary.opacity(0.2), in: RoundedRectangle(cornerRadius: 14))
    }
}
