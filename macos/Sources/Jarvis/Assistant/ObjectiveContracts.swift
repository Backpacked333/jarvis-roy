import Foundation

struct AssistantObjective: Decodable, AssistantRevisioned {
    struct Budget: Decodable { let limitUsd: Double, spentUsd: Double, reservedUsd: Double }
    struct Child: Decodable { let authority: String, projectId: String; let taskId: String?, conversationId: String?, runId: String?, roomId: String? }
    struct Step: Decodable, Identifiable {
        let id: String, authority: String, prompt: String, dependsOn: [String]
        let estimatedUsd: Double, maxWallTimeMs: Int
    }
    struct Attempt: Decodable, Identifiable {
        let id: String, stepId: String, authority: String, status: String, child: Child?
        let startedAt: String, deadlineAt: String, updatedAt: String, accounting: String
        let reservedUsd: Double, chargedUsd: Double, cancelConfirmed: Bool, detail: String?
    }
    struct Checkpoint: Decodable {
        let version: Int, id: String, objectiveId: String, projectId: String, createdAt: String, summary: String
        let childRefs: [Child], verification: String
    }
    struct Question: Decodable { let id: String, revision: Int, prompt: String, expiresAt: String }
    let version: Int, id: String, requestId: String, projectId: String, title: String, goal: String, revision: Int
    let status: String, createdAt: String, updatedAt: String, deadlineAt: String, wakeAt: String?
    let steps: [Step], attempts: [Attempt], checkpoint: Checkpoint?, question: Question?, budget: Budget, lastError: String?
    var needsAttention: Bool { ["needs_plan", "waiting", "waiting_for_user", "waiting_for_device", "paused", "failed", "interrupted", "expired"].contains(status) }
    var terminal: Bool { ["completed", "failed", "cancelled", "expired"].contains(status) }
    var statusLabel: String { status.replacingOccurrences(of: "_", with: " ").capitalized }
    var hasUncertainWork: Bool { attempts.contains { $0.status == "unknown" || $0.accounting == "unknown" } }
}

struct ObjectiveReadiness: Decodable {
    let version: Int, enabled: Bool, ready: Bool, stopped: Bool, activeWorkers: Int, maxWorkers: Int
    var acceptingWork: Bool { version == 1 && enabled && ready && !stopped }
    let dailyLimitUsd: Double, monthlyLimitUsd: Double, dailyCommittedUsd: Double, monthlyCommittedUsd: Double
    let unknownReservations: Int, nextWakeAt: String?, reason: String?
}

enum ObjectiveDisplayPolicy {
    static func ordered(_ objectives: [AssistantObjective]) -> [AssistantObjective] {
        objectives.sorted {
            if $0.needsAttention != $1.needsAttention { return $0.needsAttention }
            if $0.terminal != $1.terminal { return !$0.terminal }
            return $0.updatedAt > $1.updatedAt
        }
    }
}
