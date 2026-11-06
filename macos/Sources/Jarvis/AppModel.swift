import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @Published var tab: WorkspaceTab = .workspace
    @Published var tasks: [AgentTask] = []
    @Published var memories: [MemoryEntry] = []
    @Published var selectedTaskID: String?
    @Published var draft = ""
    @Published var isConnected = false
    @Published var isSubmitting = false
    @Published var pendingActions: Set<String> = []
    @Published var error: String?
    @Published var connectionError: String?
    @Published var modelName = "Connecting"
    @AppStorage("speakReplies") var speakReplies = true
    let voice = VoiceController()
    private let client = RuntimeClient()
    private var spokenTasks: Set<String> = []
    private var didLoad = false

    var selectedTask: AgentTask? { tasks.first { $0.id == selectedTaskID } }
    var activeCount: Int { tasks.filter(\.isActive).count }
    var approvalCount: Int { tasks.reduce(0) { $0 + $1.approvals.count } }

    func observe() async {
        while !Task.isCancelled {
            await refresh()
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
        }
    }

    func refresh() async {
        do {
            let state = try await client.state()
            guard !Task.isCancelled else { return }
            isConnected = state.ready
            connectionError = state.error
            modelName = state.model
            tasks = state.tasks.sorted { $0.createdAt > $1.createdAt }
            memories = state.memories
            if !didLoad {
                spokenTasks.formUnion(tasks.filter { !$0.isActive }.map(\.id))
                didLoad = true
            }
            for task in tasks where task.status == "completed" && !spokenTasks.contains(task.id) {
                spokenTasks.insert(task.id)
                if speakReplies, task.id == selectedTaskID { voice.speak(task.reply) }
            }
        } catch {
            guard !Task.isCancelled else { return }
            isConnected = false
            connectionError = error.localizedDescription
        }
    }

    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 8000, !isSubmitting, isConnected else { return }
        voice.stopListening()
        voice.stopSpeaking()
        if text.lowercased().trimmingCharacters(in: .punctuationCharacters) == "stop all" {
            draft = ""
            await stopAll()
            return
        }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            let data = try await client.request("v1/tasks", method: "POST", body: ["message": text])
            let task = try JSONDecoder().decode(AgentTask.self, from: data)
            selectedTaskID = task.id
            draft = ""
            tab = .workspace
            error = nil
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    func act(key: String, path: String, method: String = "POST", body: [String: String]? = nil) async {
        guard !pendingActions.contains(key) else { return }
        pendingActions.insert(key)
        defer { pendingActions.remove(key) }
        do {
            _ = try await client.request(path, method: method, body: body)
            error = nil
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    func stopAll() async {
        voice.stopListening()
        voice.stopSpeaking()
        await act(key: "stop-all", path: "v1/stop")
    }
}
