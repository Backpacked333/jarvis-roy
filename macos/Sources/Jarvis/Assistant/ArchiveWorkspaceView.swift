import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct RoomArchiveSummary: Decodable, Identifiable {
    struct Counts: Decodable { let plans, runs, artifacts: Int }
    let version: Int
    let id, roomId, title, archivedAt, digest: String
    let counts: Counts
}

struct RoomArchiveEnvelope: Decodable {
    struct Snapshot: Decodable { let state: HarnessState }
    let summary: RoomArchiveSummary
    let snapshot: Snapshot
}

@MainActor
final class ArchiveWorkspaceModel: ObservableObject {
    @Published var room: HarnessRoom?
    @Published var archives: [RoomArchiveSummary] = []
    @Published var selection: RoomArchiveEnvelope?
    @Published var roomIsSettled = false
    @Published var busy = false
    @Published var error: String?
    @Published var notice: String?
    let projectID: String
    let client: AssistantClient

    init(projectID: String, client: AssistantClient) {
        self.projectID = projectID; self.client = client
    }
    private var query: String { projectID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "" }

    func refresh() async {
        do {
            struct ArchiveList: Decodable { let version: Int, archives: [RoomArchiveSummary] }
            let state = try await client.value(HarnessState.self, path: "/v1/harness/state")
            let result = try await client.value(ArchiveList.self, path: "/v1/harness/archives?roomId=\(query)")
            guard state.version == 1, result.version == 1, result.archives.allSatisfy({ $0.version == 1 && $0.roomId == projectID }) else { throw AssistantClientError.invalidResponse }
            room = state.rooms.first { $0.id == projectID }
            archives = result.archives
            roomIsSettled = state.ready && state.runs.filter { $0.roomId == projectID }.allSatisfy {
                ($0.status == "completed" || ($0.status == "cancelled" && $0.cancelConfirmed)) && $0.usage.accounting == "measured" && $0.usage.reservedTokens == 0
            } && state.authorings.filter { $0.roomId == projectID }.allSatisfy {
                ["completed", "failed", "cancelled"].contains($0.status) && $0.usage.accounting == "measured" && $0.usage.reservedTokens == 0
            } && !state.questions.contains { $0.target.roomId == projectID && $0.status == "pending" }
                && !state.approvals.contains { $0.roomId == projectID && $0.status == "pending" }
            error = nil
        } catch { self.error = error.localizedDescription; roomIsSettled = false }
    }

    func markArchived(_ captured: HarnessRoom) async {
        busy = true; error = nil; defer { busy = false }
        do {
            guard captured.id == projectID, room?.revision == captured.revision else { throw AssistantClientError.service("Room changed. Refresh before archiving.") }
            _ = try await client.value(HarnessRoom.self, path: "/v1/harness/rooms/\(captured.id)", method: "PATCH", body: ["expectedRevision": captured.revision, "status": "archived"])
            notice = "Room marked archived. Review and export its settled history when ready."
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    func archiveHistory(_ captured: HarnessRoom) async {
        busy = true; error = nil; defer { busy = false }
        do {
            guard captured.id == projectID, captured.status == "archived", room?.revision == captured.revision else { throw AssistantClientError.service("Room changed. Refresh before moving history.") }
            let result = try await client.value(RoomArchiveSummary.self, path: "/v1/harness/rooms/\(captured.id)/archive", method: "POST", body: ["expectedRevision": captured.revision])
            guard result.version == 1, result.roomId == projectID else { throw AssistantClientError.invalidResponse }
            notice = "History saved in a durable archive and removed from active room storage. Original artifact files are retained."
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    func inspect(_ archive: RoomArchiveSummary) async {
        busy = true; defer { busy = false }
        do {
            let bytes = try await client.data("/v1/harness/archives/\(archive.id)?roomId=\(query)", maximum: 34 * 1_024 * 1_024)
            let value = try JSONDecoder().decode(RoomArchiveEnvelope.self, from: bytes)
            guard value.summary.version == 1, value.summary.id == archive.id, value.summary.roomId == projectID,
                  value.summary.digest == archive.digest, value.snapshot.state.version == 1,
                  value.snapshot.state.rooms.count == 1, value.snapshot.state.rooms.first?.id == projectID else { throw AssistantClientError.invalidResponse }
            selection = value; error = nil
        } catch { self.error = error.localizedDescription }
    }

    func export(_ archive: RoomArchiveSummary) async {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Jarvis-room-\(archive.id).json"
        panel.allowedContentTypes = [.json]
        panel.message = "This export contains private room history and checkpoints. Artifact file contents remain in Jarvis; the export includes their manifests."
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        busy = true; defer { busy = false }
        do {
            let bytes = try await client.data("/v1/harness/archives/\(archive.id)?roomId=\(query)", maximum: 34 * 1_024 * 1_024)
            let value = try JSONDecoder().decode(RoomArchiveEnvelope.self, from: bytes)
            guard value.summary.version == 1, value.summary.id == archive.id, value.summary.roomId == projectID,
                  value.summary.digest == archive.digest else { throw AssistantClientError.invalidResponse }
            try bytes.write(to: destination, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
            notice = "Exported private room history and artifact manifests. Keep this file with your other Jarvis backups."
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

@MainActor
struct ArchiveWorkspaceView: View {
    @StateObject private var model: ArchiveWorkspaceModel
    @State private var marking: HarnessRoom?
    @State private var archiving: HarnessRoom?
    init(projectID: String, client: AssistantClient) {
        _model = StateObject(wrappedValue: ArchiveWorkspaceModel(projectID: projectID, client: client))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Room history", systemImage: "archivebox")
                Spacer()
                Button("Refresh") { Task { await model.refresh() } }.disabled(model.busy)
            }.font(.headline)
            Text("Archive settled room history to keep active storage bounded. Saved history stays readable; a new execution starts in a new room.")
                .font(.caption).foregroundStyle(.secondary)
            if let room = model.room {
                HStack {
                    Text(room.title).font(.subheadline)
                    Spacer()
                    if room.status == "archived" {
                        Button("Archive settled history…") { archiving = room }.disabled(model.busy || !model.roomIsSettled)
                    } else {
                        Button("Mark room archived…") { marking = room }.disabled(model.busy || !model.roomIsSettled)
                    }
                }
                if !model.roomIsSettled {
                    Text("Complete work or confirm its cancellation, resolve questions and approvals, and reconcile uncertain usage before archiving.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else if model.archives.isEmpty {
                Text("This project has no archived room history.").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(model.archives) { archive in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(archive.title).font(.subheadline)
                        Text("\(archive.counts.plans) plans · \(archive.counts.runs) runs · \(archive.counts.artifacts) artifacts")
                            .font(.caption).foregroundStyle(.secondary)
                        Text(archive.archivedAt).font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Inspect") { Task { await model.inspect(archive) } }.disabled(model.busy)
                    Button("Export…") { Task { await model.export(archive) } }.disabled(model.busy)
                }
            }
            if let error = model.error { Text(error).foregroundStyle(.red).font(.caption).textSelection(.enabled) }
            if let notice = model.notice { Text(notice).foregroundStyle(.secondary).font(.caption) }
        }
        .task { await model.refresh() }
        .alert("Mark this room archived?", isPresented: Binding(get: { marking != nil }, set: { if !$0 { marking = nil } })) {
            Button("Cancel", role: .cancel) { marking = nil }
            Button("Mark archived") { if let room = marking { Task { await model.markArchived(room) } }; marking = nil }
        } message: { Text("\(marking?.title ?? "This room") will stop accepting new work. Its history remains active until you separately archive settled history.") }
        .alert("Archive this exact room history?", isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil } })) {
            Button("Cancel", role: .cancel) { archiving = nil }
            Button("Archive history") { if let room = archiving { Task { await model.archiveHistory(room) } }; archiving = nil }
        } message: { Text("Save \(archiving?.title ?? "this room") at revision \(archiving?.revision ?? 0) in an immutable archive, then remove it from active storage. Artifact files and duplicate-action records remain preserved. This does not restart or replay work.") }
        .sheet(isPresented: Binding(get: { model.selection != nil }, set: { if !$0 { model.selection = nil } })) {
            if let archive = model.selection {
                VStack(alignment: .leading, spacing: 16) {
                    HStack { Text(archive.summary.title).font(.title2); Spacer(); Button("Done") { model.selection = nil } }
                    Text("Archived history · \(archive.summary.archivedAt)").font(.caption).foregroundStyle(.secondary)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(archive.snapshot.state.plans) { plan in
                                VStack(alignment: .leading) { Text(plan.goal).font(.headline); Text("\(plan.status) · \(plan.nodes.count) steps").font(.caption).foregroundStyle(.secondary) }
                            }
                            ForEach(archive.snapshot.state.runs) { run in
                                Text("Run \(run.id): \(run.status) · \(run.usage.modelCalls) model calls").font(.caption).textSelection(.enabled)
                            }
                            ForEach(archive.snapshot.state.artifacts) { artifact in
                                VStack(alignment: .leading) {
                                    Text("Artifact \(artifact.id)").font(.caption).textSelection(.enabled)
                                    Text(artifact.files.map(\.path).joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Button("Export private history…") { Task { await model.export(archive.summary) } }
                }.padding(24).frame(minWidth: 560, minHeight: 400)
            }
        }
    }
}
