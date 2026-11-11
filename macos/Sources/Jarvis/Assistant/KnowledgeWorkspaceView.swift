import AppKit
import CryptoKit
import PDFKit
import SwiftUI
import UniformTypeIdentifiers

struct KnowledgeSource: Decodable, Identifiable {
    let version: Int
    let id: String, sourceId: String, revision: Int, projectId: String, title: String, filename: String
    let mediaType: String, sha256: String, bytes: Int, visibility: String, grantId: String?, resourceId: String?
    let kind: String, url: String?, createdAt: String, extraction: String, archived: Bool
}
struct KnowledgePassage: Decodable, Identifiable {
    struct Locator: Decodable { let page: Int?, lineStart: Int, lineEnd: Int }
    let id: String, sourceVersionId: String, projectId: String, ordinal: Int, text: String, locator: Locator
}
struct KnowledgeGrant: Decodable, Identifiable {
    let version: Int
    let id: String, revision: Int, projectId: String, resourceKind: String, resourceId: String, label: String
    let cloudAllowed: Bool, expiresAt: String?, revokedAt: String?
    func allowsCloudUse(at now: Date) -> Bool {
        guard version == 1, cloudAllowed, revokedAt == nil else { return false }
        guard let expiresAt else { return true }
        guard let expiry = RoomsStateRules.date(expiresAt) else { return false }
        return expiry > now
    }
}
struct KnowledgeMatch: Decodable {
    let source: KnowledgeSource, passage: KnowledgePassage, explanation: KnowledgeSearchExplanation?
    init(source: KnowledgeSource, passage: KnowledgePassage, explanation: KnowledgeSearchExplanation? = nil) {
        self.source = source; self.passage = passage; self.explanation = explanation
    }
}

@MainActor
final class KnowledgeWorkspaceModel: ObservableObject {
    @Published var sources: [KnowledgeSource] = []
    @Published var matches: [KnowledgeMatch] = []
    @Published var grants: [KnowledgeGrant] = []
    @Published var query = ""
    @Published var cloudAllowed = false
    @Published var busy = false
    @Published var error: String?
    @Published var notice: String?
    @Published var contextKind = "calendar"
    @Published var selectedBundle = ""
    @Published var contextResources: [[String: Any]] = []
    @Published var contextResult = ""
    @Published private(set) var embeddings: KnowledgeEmbeddingStatus?
    @Published private(set) var retrieval: KnowledgeRetrievalInfo?
    @Published private(set) var indexing = false
    private var readRevision = 0
    private var contextReadRevision = 0
    let projectID: String
    let client: AssistantClient
    init(projectID: String, client: AssistantClient) { self.projectID = projectID; self.client = client }
    var projectQuery: String { projectID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "" }
    var runningApplications: [(id: String, name: String)] {
        NSWorkspace.shared.runningApplications.compactMap { app in
            guard app.activationPolicy == .regular, let id = app.bundleIdentifier else { return nil }
            return (id: id, name: app.localizedName ?? id)
        }.sorted { $0.name < $1.name }
    }

    func refresh() async {
        do {
            struct Sources: Decodable { let sources: [KnowledgeSource] }
            struct Grants: Decodable { let grants: [KnowledgeGrant] }
            let loadedSources = try await client.value(Sources.self, path: "/v1/knowledge/sources?projectId=\(projectQuery)").sources
            let loadedGrants = try await client.value(Grants.self, path: "/v1/grants?projectId=\(projectQuery)").grants
            guard loadedSources.allSatisfy({ $0.version == 1 && $0.projectId == projectID }),
                  loadedGrants.allSatisfy({ $0.version == 1 && $0.projectId == projectID }) else { throw AssistantClientError.invalidResponse }
            sources = loadedSources; grants = loadedGrants
            struct Status: Decodable { let version: Int, enabled: Bool, embeddings: KnowledgeEmbeddingStatus }
            let status = try await client.value(Status.self, path: "/v1/knowledge/status")
            guard status.version == 1, status.embeddings.local, status.embeddings.provider?.local != false else { throw AssistantClientError.invalidResponse }
            embeddings = status.embeddings
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    func selectAndImport() async {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.message = "Choose a document for this project. The selected cloud-use permission applies only to this source."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        busy = true; error = nil
        defer { busy = false }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let keys: Set<URLResourceKey> = [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .fileResourceIdentifierKey]
            let before = try url.resourceValues(forKeys: keys)
            guard before.isRegularFile == true, before.isSymbolicLink != true, (before.fileSize ?? 0) <= 8 * 1_024 * 1_024 else {
                throw AssistantClientError.service("Choose a regular file up to 8 MiB. Symbolic links are not imported.")
            }
            let handle = try FileHandle(forReadingFrom: url)
            let bytes: Data
            do { bytes = try handle.read(upToCount: 8 * 1_024 * 1_024 + 1) ?? Data(); try handle.close() }
            catch { try? handle.close(); throw error }
            let after = try url.resourceValues(forKeys: keys)
            guard bytes.count <= 8 * 1_024 * 1_024,
                  String(describing: before.fileResourceIdentifier) == String(describing: after.fileResourceIdentifier),
                  before.fileSize == after.fileSize else { throw AssistantClientError.service("The selected file changed during import. Select it again.") }
            let bookmark = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: [.fileResourceIdentifierKey], relativeTo: nil)
            let identity = "file-" + SHA256.hash(data: bookmark).map { String(format: "%02x", $0) }.joined()
            let grant = try await client.value(KnowledgeGrant.self, path: "/v1/grants", method: "POST", body: [
                "projectId": projectID, "resourceKind": "file", "resourceId": identity, "label": url.lastPathComponent,
                "operations": ["read_document"], "cloudAllowed": cloudAllowed, "expiresAt": NSNull(),
            ])
            guard grant.version == 1, grant.projectId == projectID, grant.resourceId == identity else { throw AssistantClientError.invalidResponse }
            var body: [String: Any] = ["projectId": projectID, "grantId": grant.id, "resourceId": identity,
                "filename": url.lastPathComponent, "title": url.deletingPathExtension().lastPathComponent,
                "mediaType": mimeType(url), "bytesBase64": bytes.base64EncodedString()]
            if url.pathExtension.lowercased() == "pdf" {
                guard let document = PDFDocument(data: bytes), document.pageCount <= 2_000 else { throw AssistantClientError.service("The PDF could not be decoded or exceeds 2,000 pages.") }
                var pages: [String] = [], count = 0
                for index in 0..<document.pageCount {
                    let text = document.page(at: index)?.string ?? ""
                    count += text.count
                    guard count <= 1_000_000 else { throw AssistantClientError.service("PDF extracted text exceeds the one-million-character limit.") }
                    pages.append(text)
                }
                body["nativePDFPages"] = pages
            }
            guard try JSONSerialization.data(withJSONObject: body).count <= 12 * 1_024 * 1_024 else { throw AssistantClientError.service("The combined source and extracted text exceed 12 MiB. Import a smaller selection.") }
            _ = try await client.data("/v1/knowledge/import", method: "POST", body: body)
            notice = "Imported \(url.lastPathComponent). \(cloudAllowed ? "Relevant passages may be used by cloud reasoning." : "This source stays local until you change its grant.")"
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    func search() async {
        readRevision += 1
        let ticket = readRevision, capturedQuery = query
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { matches = []; retrieval = nil; return }
        do {
            struct Result: Decodable { let version: Int, matches: [KnowledgeMatch], retrieval: KnowledgeRetrievalInfo, contentTrust: String }
            let reply = try await client.value(Result.self, path: "/v1/knowledge/context", method: "POST", body: [
                "projectId": projectID, "query": capturedQuery, "purpose": "local", "limit": 10, "includeArchived": false, "maxPerSource": 2, "indexBudget": 0,
            ])
            guard ticket == readRevision, capturedQuery == query else { return }
            guard reply.version == 1, reply.contentTrust == "untrusted", reply.retrieval.provider?.local != false else { throw AssistantClientError.invalidResponse }
            let result = reply.matches
            guard result.allSatisfy({ $0.source.version == 1 && $0.source.projectId == projectID && $0.passage.projectId == projectID && $0.passage.sourceVersionId == $0.source.id }) else { throw AssistantClientError.invalidResponse }
            matches = result; retrieval = reply.retrieval
            error = nil
        } catch { if ticket == readRevision { self.error = error.localizedDescription } }
    }
    func indexSources() async {
        guard !indexing else { return }
        indexing = true; defer { indexing = false }
        do {
            struct Reply: Decodable { let version: Int, provider: KnowledgeEmbeddingIdentity?, status: String, indexed: Int, cached: Int, remaining: Int }
            let reply = try await client.value(Reply.self, path: "/v1/knowledge/index", method: "POST", body: ["projectId": projectID, "limit": 64])
            guard reply.version == 1, reply.provider?.local != false else { throw AssistantClientError.invalidResponse }
            notice = reply.status == "indexed" ? "Indexed \(reply.indexed) passages on this Mac. \(reply.remaining) remain; \(reply.cached) are cached." :
                "Local semantic indexing is unavailable. Text search remains available. Enable semantic retrieval in Settings and restart services."
            if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { await search() }
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func inspect(_ source: KnowledgeSource) async {
        readRevision += 1; let ticket = readRevision
        do {
            struct Result: Decodable { let source: KnowledgeSource, passages: [KnowledgePassage] }
            let value = try await client.value(Result.self, path: "/v1/knowledge/sources/\(source.id)?projectId=\(projectQuery)&purpose=local")
            guard value.source.version == 1, value.source.id == source.id, value.source.projectId == projectID,
                  value.passages.allSatisfy({ $0.projectId == projectID && $0.sourceVersionId == source.id }) else { throw AssistantClientError.invalidResponse }
            guard ticket == readRevision else { return }
            matches = value.passages.map { KnowledgeMatch(source: value.source, passage: $0) }
            retrieval = nil
        } catch { if ticket == readRevision { self.error = error.localizedDescription } }
    }
    func remove(_ source: KnowledgeSource) async {
        invalidateReadResults()
        do {
            _ = try await client.data("/v1/knowledge/sources/\(source.id)?projectId=\(projectQuery)", method: "DELETE")
            invalidateReadResults(); await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func revoke(_ grant: KnowledgeGrant) async {
        invalidateReadResults()
        do {
            _ = try await client.data("/v1/grants/\(grant.id)/revoke", method: "POST", body: ["expectedRevision": grant.revision])
            invalidateReadResults(); await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func changeCloudUse(_ grant: KnowledgeGrant, allowed: Bool) async {
        invalidateReadResults()
        do {
            _ = try await client.data("/v1/grants/\(grant.id)", method: "PATCH", body: ["expectedRevision": grant.revision, "cloudAllowed": allowed])
            invalidateReadResults(); await refresh()
        } catch { self.error = error.localizedDescription }
    }
    private func invalidateReadResults() {
        readRevision += 1; contextReadRevision += 1
        matches = []; retrieval = nil; contextResult = ""
    }
    func exportProject() async {
        let panel = NSSavePanel(); panel.nameFieldStringValue = "Jarvis-project.json"; panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let bytes = try await client.data("/v1/knowledge/export?projectId=\(projectQuery)", maximum: 64 * 1_024 * 1_024)
            try bytes.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            notice = "Exported the selected project's sources and provenance."
        } catch { self.error = error.localizedDescription }
    }

    func discoverContext() async {
        contextReadRevision += 1
        let ticket = contextReadRevision, kind = contextKind, bundle = selectedBundle
        contextResources = []
        do {
            var body: [String: Any] = ["projectId": projectID, "kind": kind]
            if kind == "window" { body["bundleId"] = bundle }
            let data = try await client.data("/v1/context/resources", method: "POST", body: body)
            guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any], payload["version"] as? Int == 1,
                  payload["projectId"] as? String == projectID,
                  let resources = payload["resources"] as? [[String: Any]] else { throw AssistantClientError.invalidResponse }
            guard ticket == contextReadRevision, kind == contextKind, kind != "window" || bundle == selectedBundle else { return }
            contextResources = resources; error = nil
        } catch { if ticket == contextReadRevision { self.error = error.localizedDescription } }
    }
    func grantAndRead(_ resource: [String: Any]) async {
        guard let kind = resource["resourceKind"] as? String, let id = resource["resourceId"] as? String,
              let label = resource["label"] as? String, let target = resource["target"] as? [String: Any] else { return }
        contextReadRevision += 1; let ticket = contextReadRevision
        contextResult = ""
        do {
            let operation = kind == "window" ? "inspect_window" : kind == "calendar" ? "read_calendar" : "read_mail"
            let grant = try await client.value(KnowledgeGrant.self, path: "/v1/grants", method: "POST", body: [
                "projectId": projectID, "resourceKind": kind, "resourceId": id, "label": label,
                "operations": [operation], "cloudAllowed": cloudAllowed, "expiresAt": NSNull(),
            ])
            guard grant.version == 1, grant.projectId == projectID, grant.resourceId == id else { throw AssistantClientError.invalidResponse }
            guard ticket == contextReadRevision else { return }
            let formatter = ISO8601DateFormatter()
            var body: [String: Any] = ["projectId": projectID, "grantId": grant.id, "resourceId": id, "purpose": "local", "kind": kind]
            if kind == "window" { body["target"] = target }
            else if kind == "calendar" {
                body["calendarId"] = target["calendarId"]
                body["start"] = formatter.string(from: Date()); body["end"] = formatter.string(from: Date().addingTimeInterval(7 * 86_400)); body["limit"] = 50
            } else {
                body["request"] = ["action": "list_inbox", "accountId": target["accountId"] ?? "", "since": formatter.string(from: Date().addingTimeInterval(-7 * 86_400)), "limit": 25]
            }
            let result = try await client.data("/v1/context/read", method: "POST", body: body)
            guard ticket == contextReadRevision else { return }
            let object = try JSONSerialization.jsonObject(with: result)
            guard let response = object as? [String: Any], response["version"] as? Int == 1,
                  response["projectId"] as? String == projectID, response["resourceId"] as? String == id else { throw AssistantClientError.invalidResponse }
            contextResult = String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self)
            await refresh()
        } catch { if ticket == contextReadRevision { self.error = error.localizedDescription } }
    }
    private func mimeType(_ url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "pdf": return "application/pdf"
        case "md", "markdown": return "text/markdown"
        case "csv": return "text/csv"
        default: return "text/plain"
        }
    }
}

@MainActor
struct KnowledgeWorkspaceView: View {
    @StateObject private var model: KnowledgeWorkspaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var deleting: KnowledgeSource?
    @AppStorage("Jarvis.researchEnabled") private var researchPreference = false
    init(projectID: String, client: AssistantClient) {
        _model = StateObject(wrappedValue: KnowledgeWorkspaceModel(projectID: projectID, client: client))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text("Project knowledge").font(.title2); Spacer(); Button("Done") { dismiss() } }
            Text("Choose exactly what Jarvis may read. Cloud use applies only to the source grant you create.").foregroundStyle(.secondary)
            Toggle("Allow relevant excerpts from newly selected sources in cloud reasoning", isOn: $model.cloudAllowed)
            if let error = model.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
            if let notice = model.notice { Text(notice).font(.caption).foregroundStyle(.secondary) }
            HStack {
                Button("Import document…") { Task { await model.selectAndImport() } }.buttonStyle(.jarvisPrimary).disabled(model.busy)
                Button("Export project…") { Task { await model.exportProject() } }
                Spacer()
                TextField("Search this project's evidence", text: $model.query).onSubmit { Task { await model.search() } }
                Button("Search") { Task { await model.search() } }
            }
            HStack {
                Label(model.embeddings?.available == true ? "Semantic lookup runs on this Mac" : "Text lookup ready · semantic lookup unavailable",
                      systemImage: model.embeddings?.available == true ? "sparkle.magnifyingglass" : "text.magnifyingglass")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(model.indexing ? "Indexing locally…" : "Index next 64 passages") { Task { await model.indexSources() } }
                    .disabled(model.indexing || model.busy || !AssistantFeatures.semanticRetrieval)
            }
            if let retrieval = model.retrieval {
                Text("\(retrieval.mode == "hybrid" ? "Text + semantic retrieval" : "Text retrieval") · \(retrieval.coverage.indexedPassages) of \(retrieval.coverage.eligiblePassages) passages indexed · up to \(retrieval.diversity.maxPerSource) matches per source")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(Array(retrieval.warnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.caption).foregroundStyle(.orange) }
            }
            TabView {
                if AssistantFeatures.research && (researchPreference || ProcessInfo.processInfo.environment["JARVIS_ENABLE_RESEARCH"] == "1") {
                    ResearchWorkspaceView(projectID: model.projectID, client: model.client, sources: model.sources)
                        .tabItem { Label("Research", systemImage: "sparkle.magnifyingglass") }
                }
                HSplitView {
                    List(model.sources) { source in
                        VStack(alignment: .leading, spacing: 5) {
                            Button(source.title) { Task { await model.inspect(source) } }.buttonStyle(.plain)
                            Text("Revision \(source.revision) · \(source.extraction)").font(.caption).foregroundStyle(.secondary)
                            Button("Delete indexed source", role: .destructive) { deleting = source }.font(.caption)
                        }
                    }.frame(minWidth: 240)
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 16) {
                            ForEach(model.matches, id: \.passage.id) { match in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(match.source.title).font(.headline)
                                    Text(match.passage.locator.page.map { "Page \($0)" } ?? "Lines \(match.passage.locator.lineStart)–\(match.passage.locator.lineEnd)").font(.caption).foregroundStyle(.secondary)
                                    Text(match.passage.text).textSelection(.enabled)
                                    if let explanation = match.explanation { Text(explanation.summary).font(.caption).foregroundStyle(.secondary) }
                                    Text("Evidence \(match.passage.id)").font(.caption2.monospaced()).foregroundStyle(.secondary)
                                }.padding(12)
                            }
                        }
                    }.frame(minWidth: 360)
                }.tabItem { Label("Documents", systemImage: "doc.text") }
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            Picker("Source", selection: $model.contextKind) {
                                Text("Calendar").tag("calendar"); Text("Mail account").tag("mail_account"); Text("App window").tag("window")
                            }.frame(width: 220)
                            if model.contextKind == "window" {
                                Picker("App", selection: $model.selectedBundle) {
                                    Text("Choose an app").tag("")
                                    ForEach(model.runningApplications, id: \.id) { app in Text(app.name).tag(app.id) }
                                }.frame(width: 220)
                            }
                            Button("Find sources") { Task { await model.discoverContext() } }
                        }
                        ForEach(Array(model.contextResources.enumerated()), id: \.offset) { _, resource in
                            HStack {
                                Text(resource["label"] as? String ?? "Source")
                                Spacer()
                                Button("Grant read access and preview") { Task { await model.grantAndRead(resource) } }
                            }
                        }
                        if !model.contextResult.isEmpty { Text(model.contextResult).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                    }.padding(16)
                }.tabItem { Label("Connected context", systemImage: "link") }
                List(model.grants) { grant in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(grant.label)
                            Text("\(grant.resourceKind) · \(grant.cloudAllowed ? "Cloud excerpts allowed" : "Local only") · \(grant.revokedAt == nil ? "Active" : "Revoked")").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Toggle("Cloud excerpts", isOn: Binding(get: { grant.cloudAllowed }, set: { allowed in
                            Task { await model.changeCloudUse(grant, allowed: allowed) }
                        })).disabled(grant.revokedAt != nil).fixedSize()
                        Button("Revoke") { Task { await model.revoke(grant) } }.disabled(grant.revokedAt != nil)
                    }
                }.tabItem { Label("Read grants", systemImage: "lock.shield") }
                MemoryWorkspaceView(projectID: model.projectID, client: model.client)
                    .id("memory-" + model.projectID).tabItem { Label("Memory", systemImage: "brain") }
                ContextInspectorView(projectID: model.projectID, client: model.client)
                    .id("context-" + model.projectID).tabItem { Label("Context", systemImage: "list.bullet.rectangle") }
                ScrollView {
                    ArchiveWorkspaceView(projectID: model.projectID, client: model.client)
                        .id(model.projectID).padding(18)
                }.tabItem { Label("Room history", systemImage: "archivebox") }
            }
        }.padding(24).frame(minWidth: 820, minHeight: 620)
            .task { await model.refresh() }
            .alert("Delete this indexed source?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { source in
                Button("Delete", role: .destructive) { Task { await model.remove(source) }; deleting = nil }
                Button("Cancel", role: .cancel) { deleting = nil }
            } message: { _ in Text("This deletes Jarvis's indexed copy. Your original file remains in place.") }
    }
}
