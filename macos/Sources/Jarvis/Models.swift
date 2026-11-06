import Foundation

struct RuntimeState: Decodable {
    let ready: Bool
    let model: String
    let tasks: [AgentTask]
    let memories: [MemoryEntry]
    let error: String?
}

struct AgentTask: Decodable, Identifiable {
    let id: String
    let title: String
    let status: String
    let reply: String
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
    case workspace = "Workspace", memory = "Memory", privacy = "Privacy"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .workspace: return "square.stack.3d.up"
        case .memory: return "brain.head.profile"
        case .privacy: return "lock.shield"
        }
    }
}
