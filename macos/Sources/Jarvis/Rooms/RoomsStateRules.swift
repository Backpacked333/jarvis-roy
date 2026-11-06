import Foundation

struct RoomsAnswerDraft {
    private(set) var text = ""
    private(set) var binding: HarnessQuestionBinding?

    mutating func update(_ text: String, question: HarnessQuestion) {
        self.text = text
        if text.isEmpty { binding = nil }
        else if binding == nil { binding = question.binding }
    }
    func isStale(for question: HarnessQuestion) -> Bool { binding != nil && binding != question.binding }
}

enum RoomsStateRules {
    static func validate(_ state: HarnessState) throws {
        guard state.version == 1,
              state.rooms.allSatisfy({ $0.version == 1 }), state.plans.allSatisfy({ $0.version == 1 }),
              state.runs.allSatisfy({ $0.version == 1 }), state.artifacts.allSatisfy({ $0.version == 1 }) else {
            throw RoomsError.unsupportedVersion
        }
        guard state.sequence >= 0,
              unique(state.rooms.map(\.id)), unique(state.plans.map(\.id)), unique(state.runs.map(\.id)),
              unique(state.questions.map(\.id)), unique(state.approvals.map(\.id)),
              unique(state.artifacts.map(\.id)), unique(state.authorings.map(\.id)),
              state.questions.allSatisfy({ $0.kind == "question" }),
              state.approvals.allSatisfy({ $0.kind == "approval" }) else { throw RoomsError.invalidResponse }
        let rooms = Set(state.rooms.map(\.id))
        guard state.plans.allSatisfy({ rooms.contains($0.roomId) && unique($0.nodes.map(\.id)) && $0.nodes.count <= 32 }),
              state.runs.allSatisfy({ rooms.contains($0.roomId) && unique($0.nodes.map(\.nodeId)) }),
              state.authorings.allSatisfy({ rooms.contains($0.roomId) }),
              state.questions.allSatisfy({ rooms.contains($0.target.roomId) }),
              state.artifacts.allSatisfy({ rooms.contains($0.roomId) && unique($0.files.map(\.path)) }) else {
            throw RoomsError.invalidResponse
        }
        let nodeStatuses: Set<String> = ["queued", "running", "waiting_question", "completed", "failed", "blocked", "cancel_requested", "cancelled", "interrupted"]
        let runStatuses = nodeStatuses.subtracting(["blocked"]).union(["paused"])
        guard state.rooms.allSatisfy({ ["active", "paused", "archived"].contains($0.status) }),
              state.plans.allSatisfy({ ["draft", "accepted"].contains($0.status) }),
              state.runs.allSatisfy({ runStatuses.contains($0.status) && validUsage($0.usage) && $0.nodes.allSatisfy { nodeStatuses.contains($0.status) && validUsage($0.usage) } }),
              state.authorings.allSatisfy({ ["authoring", "waiting_question", "completed", "failed", "cancelled", "interrupted"].contains($0.status) && validUsage($0.usage) }),
              state.questions.allSatisfy({ ["pending", "answered", "cancelled", "expired"].contains($0.status) }),
              state.approvals.allSatisfy({ ["pending", "approved", "denied", "expired", "cancelled"].contains($0.status) }) else {
            throw RoomsError.invalidResponse
        }
    }

    static func unique(_ values: [String]) -> Bool { Set(values).count == values.count }
    static func validUsage(_ usage: HarnessUsage) -> Bool {
        [usage.steps, usage.modelCalls, usage.inputTokens, usage.outputTokens, usage.reservedTokens]
            .allSatisfy { (0...9_007_199_254_740_991).contains($0) } &&
        ["measured", "partial", "unknown"].contains(usage.accounting) &&
        (usage.estimatedUsd.map { $0.isFinite && $0 >= 0 } ?? true)
    }
    static func isDigest(_ value: String) -> Bool {
        value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }
    static func safePath(_ path: String) -> Bool {
        guard !path.isEmpty, path.count <= 240, !path.hasPrefix("/"),
              path.rangeOfCharacter(from: .controlCharacters) == nil,
              !path.contains(where: { "\\:%".contains($0) }) else { return false }
        return path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }
    static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let result = formatter.date(from: value) { return result }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
    static func pending(_ question: HarnessQuestion, now: Date) -> Bool {
        question.kind == "question" && question.status == "pending" && (date(question.expiresAt) ?? .distantPast) > now
    }
    static func terminal(_ status: String) -> Bool { ["completed", "failed", "cancelled"].contains(status) }

    static func layers(_ nodes: [HarnessPlanNode]) throws -> [[HarnessPlanNode]] {
        guard !nodes.isEmpty, unique(nodes.map(\.id)), nodes.count <= 32 else { throw RoomsError.invalid("Plan must contain 1–32 uniquely identified nodes.") }
        let ids = Set(nodes.map(\.id))
        guard nodes.allSatisfy({ Set($0.dependencies).isSubset(of: ids) && Set($0.inputFrom).isSubset(of: Set($0.dependencies)) }) else {
            throw RoomsError.invalid("Every dependency must exist, and artifact inputs must be dependencies.")
        }
        var remaining = nodes
        var visited = Set<String>()
        var layers: [[HarnessPlanNode]] = []
        while !remaining.isEmpty {
            let layer = remaining.filter { Set($0.dependencies).isSubset(of: visited) }
            guard !layer.isEmpty else { throw RoomsError.invalid("The plan contains a dependency cycle.") }
            layers.append(layer)
            visited.formUnion(layer.map(\.id))
            remaining.removeAll { visited.contains($0.id) }
        }
        return layers
    }

    static func questionScope(_ target: HarnessQuestionTarget) -> String {
        switch target {
        case .authoring(_, let id): return "Planning · \(id)"
        case .node(_, let run, let node, let attempt): return "\(node) · \(run) · \(attempt)"
        }
    }
    static func safePreview(_ data: Data) -> String? {
        guard data.count <= 256 * 1_024, let text = String(data: data, encoding: .utf8), !text.contains("\0") else { return nil }
        return text
    }
}
