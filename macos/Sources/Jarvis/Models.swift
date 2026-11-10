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
    /// What approving would set in motion, as the runtime describes the tool. Absent for questions and older services.
    var impact: ApprovalImpact? = nil
}

/// The runtime's fixed description of a tool's effect. Shown beside the exact arguments; it never decides anything.
struct ApprovalImpact: Decodable, Equatable {
    struct Hop: Decodable, Equatable { let label: String; let scope: String }
    let tool: String
    var operation: String? = nil
    let risk: String
    var reversible: Bool? = nil
    let egress: [Hop]
    let facts: [String]
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
    case deck = "Deck", today = "Today", assistant = "Assistant", rooms = "Rooms", workspace = "Workspace", capabilities = "Capabilities", memory = "Memory", privacy = "Privacy"
    var id: String { rawValue }
    /// What the person sees. The older task-thread view is kept for existing threads, under a name that says so.
    var title: String { self == .workspace ? "Classic threads" : rawValue }
    /// The name on the HUD's top bar, where capabilities and privacy share one tab.
    var hudTitle: String {
        switch self {
        case .deck: return "DECK"
        case .assistant: return "THREAD"
        case .rooms: return "ROOMS"
        case .memory: return "MEMORY"
        case .today: return "TODAY"
        case .capabilities, .privacy: return "TRUST"
        case .workspace: return "CLASSIC"
        }
    }
    /// Order for the Go menu's ⌘1–⌘8: the deck and the conversation first, the older thread view last.
    static let ordered: [WorkspaceTab] = [.deck, .assistant, .rooms, .memory, .today, .capabilities, .privacy, .workspace]
    /// The tabs offered, in order. The deck and the Assistant tab exist only while that experience is on.
    static func available(assistant: Bool) -> [WorkspaceTab] { ordered.filter { ($0 != .assistant && $0 != .deck) || assistant } }
    /// The HUD's top bar. Privacy is reached inside Trust; the classic view is offered while it is the only
    /// conversation surface, or still holds threads.
    static func hud(assistant: Bool, classic: Bool) -> [WorkspaceTab] {
        (assistant ? [.deck, .assistant] : []) + [.rooms, .memory, .today, .capabilities] + (classic || !assistant ? [.workspace] : [])
    }
    var icon: String {
        switch self {
        case .deck: return "scope"
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
