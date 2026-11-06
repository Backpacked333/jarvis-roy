import Foundation

enum RoomsObservationOwner: Hashable { case application, workspace }

struct RoomsGraphEdge: Equatable {
    let source, destination: String
    let artifact: Bool
    static func edges(_ nodes: [HarnessPlanNode]) -> [Self] {
        nodes.flatMap { node in
            Set(node.dependencies).sorted().map { Self(source: $0, destination: node.id, artifact: node.inputFrom.contains($0)) }
        }
    }
}

struct RoomsQuestionAttention: Equatable {
    let question: HarnessQuestion
    var binding: HarnessQuestionBinding { question.binding }
    var context: HarnessVoiceContext {
        .init(roomId: binding.target.roomId, conversationId: nil, question: binding)
    }
}

enum RoomsAttentionTarget: Equatable {
    case question(HarnessQuestionBinding)
    case approval(HarnessApproval)
}

struct RoomsNotificationNotice: Equatable {
    let identifier: String
    let target: RoomsAttentionTarget
    let title = "Jarvis needs your attention"
    let body = "Open Jarvis to review a pending item."
}

struct RoomsNotificationChanges {
    var removed: [String] = []
    var added: [RoomsNotificationNotice] = []
}

struct RoomsNotificationLedger {
    private(set) var notices: [RoomsNotificationNotice] = []
    private var announced: [RoomsAttentionTarget] = []

    mutating func reconcile(_ targets: [RoomsAttentionTarget], enabled: Bool) -> RoomsNotificationChanges {
        var changes = RoomsNotificationChanges()
        announced.removeAll { !targets.contains($0) }
        changes.removed = notices.filter { !enabled || !targets.contains($0.target) }.map(\.identifier)
        notices.removeAll { changes.removed.contains($0.identifier) }
        guard enabled else { return changes }
        for target in targets where notices.count < 32 && !announced.contains(target) {
            let notice = RoomsNotificationNotice(identifier: "jarvis.rooms.\(UUID().uuidString)", target: target)
            notices.append(notice)
            announced.append(target)
            changes.added.append(notice)
        }
        return changes
    }

    func target(for identifier: String) -> RoomsAttentionTarget? {
        notices.first { $0.identifier == identifier }?.target
    }

    mutating func failed(_ identifier: String) {
        guard let target = target(for: identifier) else { return }
        notices.removeAll { $0.identifier == identifier }
        announced.removeAll { $0 == target }
    }
}

enum RoomsObservationSchedule {
    static func seconds(active: Bool, connected: Bool, working: Bool, failures: Int) -> Int {
        guard connected else { return min(30, 2 << min(max(0, failures), 4)) }
        return active ? (working ? 2 : 6) : 15
    }
}
