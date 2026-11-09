import SwiftUI

struct ObjectiveEvidenceSelection {
    var publicQuery = ""
    var publicSearchAllowed = false
    var sourceIDs: Set<String> = []
    var query: String { publicQuery.trimmingCharacters(in: .whitespacesAndNewlines) }
    var valid: Bool {
        query.utf16.count <= 400 && sourceIDs.count <= 20 && (query.isEmpty || publicSearchAllowed) &&
            (!sourceIDs.isEmpty || (!query.isEmpty && publicSearchAllowed))
    }
    var parameters: [String: Any] {
        var fields: [String: Any] = ["sourceVersionIds": sourceIDs.sorted(), "providers": [String]()]
        if publicSearchAllowed, !query.isEmpty, query.utf16.count <= 400 {
            fields["publicQuery"] = query; fields["providers"] = ["arxiv", "crossref"]
        }
        return fields
    }
}

@MainActor
struct ObjectiveEvidenceSelectionView: View {
    let projectID: String?, authority: String, client: AssistantClient
    @Binding var selection: ObjectiveEvidenceSelection
    @State private var sources: [KnowledgeSource] = []
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Optional public search terms", text: $selection.publicQuery)
            if !selection.query.isEmpty {
                Toggle("Send only these terms to arXiv and Crossref", isOn: $selection.publicSearchAllowed)
                Text("\(selection.query.utf16.count) / 400 characters. The private goal is not used as the public search query.").font(.caption).foregroundStyle(.secondary)
            }
            if !sources.isEmpty {
                DisclosureGroup("Selected project sources (\(selection.sourceIDs.count)/20)") {
                    ForEach(sources) { source in
                        Toggle(source.title, isOn: Binding(get: { selection.sourceIDs.contains(source.id) }, set: { selected in
                            if selected { selection.sourceIDs.insert(source.id) } else { selection.sourceIDs.remove(source.id) }
                        })).disabled(selection.sourceIDs.count >= 20 && !selection.sourceIDs.contains(source.id))
                    }
                    Text("The research service rechecks each source's cloud-use grant before reading it.").font(.caption).foregroundStyle(.secondary)
                }
            }
            if !selection.valid { Text("Choose project sources or approve explicit public search terms before starting research.").font(.caption).foregroundStyle(.secondary) }
            if let error { Text(error).font(.caption).foregroundStyle(.orange) }
        }.task { await loadSources() }
    }
    private func loadSources() async {
        guard authority == "local", AssistantFeatures.knowledge, let projectID else { return }
        do {
            struct Reply: Decodable { let sources: [KnowledgeSource] }
            let result = try await client.value(Reply.self, path: "/v1/knowledge/sources?projectId=\(projectID)")
            guard !Task.isCancelled, TodayModel.currentAuthorityID == authority else { return }
            guard result.sources.allSatisfy({ $0.version == 1 && $0.projectId == projectID }) else { throw AssistantClientError.invalidResponse }
            sources = result.sources.filter { !$0.archived }
        } catch { if !Task.isCancelled, TodayModel.currentAuthorityID == authority { self.error = error.localizedDescription } }
    }
}
