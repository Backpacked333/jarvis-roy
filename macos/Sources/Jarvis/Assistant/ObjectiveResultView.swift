import SwiftUI

struct ObjectiveResultTarget: Identifiable {
    let objectiveID: String, projectID: String, authority: String
    var id: String { authority + ":" + objectiveID }
}
struct ObjectiveReviewPackage: Decodable {
    struct Objective: Decodable { let id: String, projectId: String, title: String, revision: Int, status: String }
    struct Research: Decodable, Identifiable {
        let attemptId: String, stepId: String, result: ResearchResult
        var id: String { attemptId }
    }
    struct Worker: Decodable, Identifiable {
        let attemptId: String, stepId: String, imageDigest: String?, artifacts: [HarnessArtifact], omittedArtifacts: Int
        var id: String { attemptId }
    }
    struct Unavailable: Decodable, Identifiable { let attemptId: String, stepId: String, reason: String; var id: String { attemptId } }
    struct Budget: Decodable { let maxBytes: Int, bytes: Int, omittedEntries: Int }
    let version: Int, objective: Objective, research: [Research], workers: [Worker], unavailable: [Unavailable], budget: Budget, verification: String
    func isBound(to target: ObjectiveResultTarget) -> Bool {
        version == 1 && objective.id == target.objectiveID && objective.projectId == target.projectID && objective.revision > 0 &&
            research.allSatisfy { $0.result.run.version == 1 && $0.result.run.projectId == target.projectID && $0.result.deliverable.version == 1 && $0.result.deliverable.projectId == target.projectID } &&
            workers.allSatisfy { $0.artifacts.allSatisfy { $0.version == 1 && $0.roomId == target.projectID } }
    }
}

@MainActor
struct ObjectiveResultView: View {
    let target: ObjectiveResultTarget, client: AssistantClient
    @ObservedObject private var profiles = RuntimeProfiles.shared
    @Environment(\.dismiss) private var dismiss
    @State private var package: ObjectiveReviewPackage?
    @State private var loading = true
    @State private var error: String?
    private var currentAuthority: String { profiles.selected == .cloud ? profiles.cloudProfile?.id ?? "unpaired" : "local" }
    var body: some View {
        VStack(spacing: 0) {
            HStack { Text("Inspect the result").font(.title2); Spacer(); Button("Refresh") { Task { await load() } }; Button("Done") { dismiss() } }.padding(22)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if loading { ProgressView() }
                    if let error { Text(error).foregroundStyle(.orange) }
                    if currentAuthority != target.authority { Text("The work location changed. Reopen the result from its original profile.").foregroundStyle(.secondary) }
                    else if let package {
                        Text(package.objective.title).font(.title)
                        Text("Revision \(package.objective.revision) · \(package.objective.status.capitalized)").font(.caption).foregroundStyle(.secondary)
                        ForEach(package.research) { research in ObjectiveResearchResultCard(result: research.result) }
                        ForEach(package.workers) { worker in ObjectiveWorkerResultCard(worker: worker) }
                        ForEach(package.unavailable) { item in Text("\(item.stepId): \(item.reason.replacingOccurrences(of: "_", with: " "))").font(.callout).foregroundStyle(.orange) }
                        if package.research.isEmpty && package.workers.isEmpty { Text("No complete, currently accessible deliverable is available. Source access is rechecked whenever you open this view.").foregroundStyle(.secondary) }
                        if package.budget.omittedEntries > 0 { Text("\(package.budget.omittedEntries) entries exceed this review package's size allowance.").font(.caption).foregroundStyle(.secondary) }
                    }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.frame(width: 860, height: 700).task { await load() }
            .environment(\.openURL, OpenURLAction { url in
                guard url.scheme == "https", url.user == nil, url.password == nil else { return .discarded }; return .systemAction
            })
    }
    private func load() async {
        guard currentAuthority == target.authority else { package = nil; loading = false; return }
        loading = true; package = nil; error = nil; defer { loading = false }
        do {
            let path = "/v1/objectives/\(target.objectiveID)/deliverable?projectId=\(target.projectID)"
            let result: ObjectiveReviewPackage
            if target.authority == "local" { result = try await client.value(ObjectiveReviewPackage.self, path: path, maximum: 512_000) }
            else {
                let bytes = try await PairedCloudConnection.shared.objectiveData(path: path.replacingOccurrences(of: "/v1/objectives", with: "/v1/cloud/objectives"))
                guard bytes.count <= 512_000 else { throw AssistantClientError.invalidResponse }
                result = try JSONDecoder().decode(ObjectiveReviewPackage.self, from: bytes)
            }
            guard currentAuthority == target.authority else { return }
            guard result.isBound(to: target) else { throw AssistantClientError.invalidResponse }
            package = result
        } catch { if currentAuthority == target.authority { self.error = error.localizedDescription } }
    }
}

private struct ObjectiveResearchResultCard: View {
    let result: ResearchResult
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(result.deliverable.title).font(.title2)
            Text("Critique: \(result.critique.verdict.replacingOccurrences(of: "_", with: " "))").font(.headline)
            Text(result.critique.summary).textSelection(.enabled)
            ForEach(Array(result.critique.issues.enumerated()), id: \.offset) { entry in
                Text("\(entry.element.severity.capitalized): \(entry.element.explanation)").textSelection(.enabled)
            }
            Text("A model critique is not independent factual or computational verification. Scholarly metadata and abstracts do not establish full-text conclusions.").font(.caption).foregroundStyle(.secondary)
            Divider()
            MarkdownBlocksView(result.deliverable.markdown)
            ForEach(Array(result.deliverable.unresolved.enumerated()), id: \.offset) { entry in Text("Unresolved: \(entry.element)").textSelection(.enabled) }
            Text(result.budgetNotice).font(.caption).foregroundStyle(.secondary)
        }.padding(18).background(.quaternary.opacity(0.22), in: RoundedRectangle(cornerRadius: 12))
    }
}
private struct ObjectiveWorkerResultCard: View {
    let worker: ObjectiveReviewPackage.Worker
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Worker outputs · \(worker.stepId)").font(.headline)
            Text("Recorded checks establish the reported command outcomes; they do not verify every claim.").font(.caption).foregroundStyle(.secondary)
            if let image = worker.imageDigest { Text("Environment \(image)").font(.caption.monospaced()).textSelection(.enabled) }
            ForEach(worker.artifacts) { artifact in
                VStack(alignment: .leading, spacing: 6) {
                    Text(artifact.verificationSummary).textSelection(.enabled)
                    Text("\(artifact.verification) · SHA-256 \(artifact.digest)").font(.caption.monospaced()).textSelection(.enabled)
                    ForEach(artifact.files) { file in Text("\(file.path) · \(file.bytes.formatted()) bytes").font(.caption).textSelection(.enabled) }
                }
            }
            if worker.omittedArtifacts > 0 { Text("\(worker.omittedArtifacts) additional artifacts were omitted from this package.").font(.caption).foregroundStyle(.secondary) }
        }.padding(18).background(.quaternary.opacity(0.22), in: RoundedRectangle(cornerRadius: 12))
    }
}
