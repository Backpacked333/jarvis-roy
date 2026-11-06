import Foundation

struct RuntimeState: Decodable {
    let ready: Bool
    let model: String
    let tasks: [AgentTask]
    let conversations: [Conversation]
    let memories: [MemoryEntry]
    let error: String?
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

    var isActive: Bool { ["starting", "running", "waiting", "cancelling"].contains(status) }
    var canCancel: Bool { isActive || status == "interrupted" }
    var statusLabel: String {
        switch status {
        case "waiting": return "Needs your approval"
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
    case workspace = "Workspace", capabilities = "Capabilities", memory = "Memory", privacy = "Privacy"
    var id: String { rawValue }
    var icon: String {
        switch self {
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
