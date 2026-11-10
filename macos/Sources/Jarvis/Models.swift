import Foundation

struct RuntimeState: Decodable {
    let ready: Bool
    let model: String
    let tasks: [AgentTask]
    let conversations: [Conversation]
    let memories: [MemoryEntry]
    let error: String?
    /// Whether the bridge process holds a reasoning credential. Absent from older services.
    var providerConfigured: Bool? = nil
}

struct AgentTask: Decodable, Identifiable {
    let id: String
    let conversationId: String
    let title: String
    let status: String
    let reply: String
    let lateReply: String?
    let error: String?
    let createdAt: String
    let events: [String]
    let approvals: [Approval]
    var questions: [Approval]? = nil

    var isActive: Bool { ["starting", "running", "waiting", "cancelling"].contains(status) }
    var canCancel: Bool { isActive || status == "interrupted" }
    var statusLabel: String {
        switch status {
        case "waiting": return approvals.isEmpty ? "Needs your answer" : "Needs your approval"
        case "starting": return "Starting"
        case "running": return "Working"
        case "completed": return "Complete"
        case "cancelled": return "Cancelled"
        case "cancelling": return "Stopping"
        case "interrupted": return "Interrupted"
        case "failed": return "Failed"
        default: return status.capitalized
        }
    }
}

struct Approval: Decodable, Identifiable {
    let id: String
    let title: String
    let detail: String
    let options: [ApprovalOption]
    let reviewable: Bool?
    let blockedReason: String?
    var kind: String? = nil
    var revision: Int? = nil
    var expiresAt: String? = nil
    var allowText: Bool? = nil
}

struct ApprovalOption: Decodable, Identifiable {
    let id: String
    let label: String
}

struct MemoryEntry: Decodable, Identifiable {
    let id: String
    let text: String
}

enum WorkspaceTab: String, CaseIterable, Identifiable {
    case today = "Today", assistant = "Assistant", rooms = "Rooms", workspace = "Workspace", capabilities = "Capabilities", memory = "Memory", privacy = "Privacy"
    var id: String { rawValue }
    /// What the person sees. The older task-thread view is kept for existing threads, under a name that says so.
    var title: String { self == .workspace ? "Classic threads" : rawValue }
    /// Sidebar and ⌘1–⌘7 order: the conversation first, the older thread view last.
    static let ordered: [WorkspaceTab] = [.assistant, .today, .rooms, .memory, .capabilities, .privacy, .workspace]
    /// The tabs offered, in order. The Assistant tab exists only while that experience is on.
    static func available(assistant: Bool) -> [WorkspaceTab] { ordered.filter { $0 != .assistant || assistant } }
    var icon: String {
        switch self {
        case .today: return "sun.max"
        case .assistant: return "waveform"
        case .rooms: return "circle.hexagongrid"
        case .workspace: return "square.stack.3d.up"
        case .capabilities: return "slider.horizontal.3"
        case .memory: return "brain.head.profile"
        case .privacy: return "lock.shield"
        }
    }
}

struct Conversation: Decodable, Identifiable {
    let id: String
    let title: String
    let createdAt: String
    let updatedAt: String
    let messages: [ConversationMessage]
}

struct ConversationMessage: Decodable, Identifiable {
    let id: String
    let role: String
    let text: String
    let createdAt: String
    let taskId: String
}

/// One rule for every approval button in the app. A response already on its way, a lost connection, or an
/// action the service marked unreviewable can never be approved; denying an unreviewable action stays possible.
enum ApprovalGate {
    static func allows(optionID: String, reviewable: Bool?, pending: Bool, connected: Bool) -> Bool {
        guard !pending, connected else { return false }
        return reviewable != false || optionID == "deny"
    }
}

struct CapabilityState: Decodable {
    let notice: String
    let capabilities: [Capability]
}

struct Capability: Decodable, Identifiable {
    let id: String
    let title: String
    let state: String
    let detail: String
    let setup: String
    var stateLabel: String { state.replacingOccurrences(of: "_", with: " ").capitalized }
}
