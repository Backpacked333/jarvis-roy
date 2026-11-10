import SwiftUI

struct ResearchRun: Decodable, Identifiable {
    struct Progress: Decodable { let sequence: Int, at: String, stage: String, detail: String }
    let version: Int, id: String, projectId: String, revision: Int, goal: String, status: String
    let modelCalls: Int, passageCount: Int, estimatedModelUsd: Double, reservedRetrievalUsd: Double
    let accounting: String, critiqueVerdict: String?, deliverableId: String?, error: String?
    let progress: [Progress]
    var settled: Bool { ["completed", "failed", "cancelled", "interrupted"].contains(status) }
}
struct ResearchResult: Decodable {
    struct Deliverable: Decodable { let version: Int, projectId: String, title: String, markdown: String, unresolved: [String] }
    struct Critique: Decodable {
        struct Issue: Decodable { let claimIndex: Int?, severity: String, explanation: String }
        let verdict: String, summary: String, issues: [Issue]
    }
    let run: ResearchRun, deliverable: Deliverable, critique: Critique
    let reviewAuthority: String, budgetNotice: String
}

@MainActor
final class ResearchWorkspaceModel: ObservableObject {
    @Published var goal = ""
    @Published var publicQuery = ""
    @Published var estimateLimit = 5.0
    @Published var minutes = 30
    @Published var runs: [ResearchRun] = []
    @Published var selectedSources: Set<String> = []
    @Published var result: ResearchResult?
    @Published var error: String?
    @Published var submitting = false
    private var requestID: String?
    private var submittedBody: Data?
    let projectID: String, client: AssistantClient
    init(projectID: String, client: AssistantClient) { self.projectID = projectID; self.client = client }
    private var projectQuery: String { projectID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "" }
    func refresh() async {
        do {
            struct Reply: Decodable { let runs: [ResearchRun] }
            let result = try await client.value(Reply.self, path: "/v1/research/runs?projectId=\(projectQuery)").runs
            guard result.allSatisfy({ $0.version == 1 && $0.projectId == projectID }) else { throw AssistantClientError.invalidResponse }
            runs = result
        } catch { self.error = error.localizedDescription }
    }
    func start() async {
        guard AssistantFeatures.research, AssistantFeatures.knowledge else {
            error = "Enable reviewed research and project knowledge in Settings, then restart local services."; return
        }
        guard !submitting, !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        submitting = true; defer { submitting = false }
        do {
            var body: [String: Any] = ["projectId": projectID, "goal": goal,
                "providers": ["arxiv", "crossref"], "sourceVersionIds": selectedSources.sorted(),
                "budget": ["estimatedUsd": estimateLimit, "maxWallTimeMs": minutes * 60_000, "maxConcurrentWorkers": 2, "maxModelCalls": 2, "maxTokens": 100_000]]
            if !publicQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { body["publicQuery"] = publicQuery }
            let canonical = try JSONSerialization.data(withJSONObject: body, options: .sortedKeys)
            // Repeating an uncertain submission retains its identity. Editing
            // scope creates a distinct reviewed request rather than replaying it.
            if canonical != submittedBody { requestID = UUID().uuidString; submittedBody = canonical }
            body["requestId"] = requestID
            let run = try await client.value(ResearchRun.self, path: "/v1/research/runs", method: "POST", body: body)
            guard run.version == 1, run.projectId == projectID else { throw AssistantClientError.invalidResponse }
            if let index = runs.firstIndex(where: { $0.id == run.id }) { runs[index] = run } else { runs.append(run) }
            error = nil
        } catch { self.error = "Research was not confirmed. Refresh before retrying. \(error.localizedDescription)" }
    }
    func cancel(_ run: ResearchRun) async {
        do { _ = try await client.data("/v1/research/runs/\(run.id)/cancel", method: "POST", body: ["projectId": projectID]); await refresh() }
        catch { self.error = error.localizedDescription }
    }
    func inspect(_ run: ResearchRun) async {
        result = nil
        do {
            let value = try await client.value(ResearchResult.self, path: "/v1/research/runs/\(run.id)/result?projectId=\(projectQuery)")
            guard value.run.version == 1, value.run.id == run.id, value.run.projectId == projectID,
                  value.deliverable.version == 1, value.deliverable.projectId == projectID else { throw AssistantClientError.invalidResponse }
            result = value; error = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct ResearchWorkspaceView: View {
    @StateObject private var model: ResearchWorkspaceModel
    let sources: [KnowledgeSource]
    init(projectID: String, client: AssistantClient, sources: [KnowledgeSource]) {
        _model = StateObject(wrappedValue: ResearchWorkspaceModel(projectID: projectID, client: client)); self.sources = sources
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Research with evidence").font(.title3)
                Text("Plan a synthesis, inspect the sources, and receive a separate critique. Numerical and code checks must be run explicitly; a written explanation is not an executed check.").font(.callout).foregroundStyle(.secondary)
                TextField("Question and desired deliverable", text: $model.goal, axis: .vertical).lineLimit(3...6)
                TextField("Optional public search query sent to arXiv and Crossref", text: $model.publicQuery)
                Text("The research goal goes to your configured reasoning provider. Only this separate public query goes to scholarly search providers.").font(.caption).foregroundStyle(.secondary)
                Text("Scholarly search retrieves metadata and available abstracts. Full-text conclusions require imported or separately retrieved passages.").font(.caption).foregroundStyle(.secondary)
                ForEach(sources) { source in
                    Toggle(source.title, isOn: Binding(get: { model.selectedSources.contains(source.id) }, set: { selected in
                        if selected { model.selectedSources.insert(source.id) } else { model.selectedSources.remove(source.id) }
                    }))
                }
                HStack {
                    Text("Estimate limit ($)")
                    TextField("5", value: $model.estimateLimit, format: .number).frame(width: 65)
                    Stepper("\(model.minutes) minutes", value: $model.minutes, in: 1...60).frame(width: 180)
                    Spacer()
                    Button("Start reviewed research") { Task { await model.start() } }
                        .disabled(model.submitting || model.goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.estimateLimit < 0 || model.estimateLimit > 100)
                }
                Text("Up to two concurrent retrieval workers. Estimates are admission limits, not provider billing caps. Private sources require cloud permission.").font(.caption).foregroundStyle(.secondary)
                if let error = model.error { Text(error).foregroundStyle(.orange) }
                Divider()
                ForEach(model.runs) { run in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(run.goal).font(.headline)
                        HStack {
                            Text(run.status.capitalized)
                            Text("\(run.passageCount) passages · \(run.modelCalls) calls · $\((run.estimatedModelUsd + run.reservedRetrievalUsd).formatted(.number.precision(.fractionLength(2)))) estimated")
                        }.font(.caption).foregroundStyle(.secondary)
                        if let progress = run.progress.last { Text(progress.detail).font(.callout) }
                        if let error = run.error { Text(error).foregroundStyle(.orange).font(.caption) }
                        HStack {
                            if !run.settled { Button("Cancel") { Task { await model.cancel(run) } } }
                            if run.deliverableId != nil { Button("Read result and critique") { Task { await model.inspect(run) } } }
                        }
                    }.padding(12).background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
                }
                if let result = model.result {
                    Divider()
                    Text(result.deliverable.title).font(.title2)
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Critique: \(result.critique.verdict.replacingOccurrences(of: "_", with: " "))").font(.headline)
                        Text(result.critique.summary).textSelection(.enabled)
                        ForEach(Array(result.critique.issues.enumerated()), id: \.offset) { _, issue in
                            Text("\(issue.severity.capitalized)\(issue.claimIndex.map { " · claim \($0 + 1)" } ?? ""): \(issue.explanation)").textSelection(.enabled)
                        }
                        Text("A separate model reviewed this draft. Factual verification still depends on the cited evidence and recorded checks.").font(.caption).foregroundStyle(.secondary)
                    }.padding(14).background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
                    MarkdownBlocksView(result.deliverable.markdown)
                    if !result.deliverable.unresolved.isEmpty {
                        Text("Unresolved questions").font(.headline)
                        ForEach(Array(result.deliverable.unresolved.enumerated()), id: \.offset) { _, question in Text(question).textSelection(.enabled) }
                    }
                    Text(result.budgetNotice).font(.caption).foregroundStyle(.secondary)
                }
            }.padding(18)
        }.environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "https", url.user == nil, url.password == nil else { return .discarded }
            return .systemAction
        }).task {
            while !Task.isCancelled {
                await model.refresh()
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
    }
}
