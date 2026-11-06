import Foundation

// Keep required nullable wire fields present when encoding requests or fixture round trips.
@propertyWrapper
struct HarnessNullable<Value: Codable & Equatable>: Codable, Equatable {
    var wrappedValue: Value?
    init(wrappedValue: Value?) { self.wrappedValue = wrappedValue }
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        wrappedValue = container.decodeNil() ? nil : try container.decode(Value.self)
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let wrappedValue { try container.encode(wrappedValue) } else { try container.encodeNil() }
    }
}

struct HarnessBudgetLimits: Codable, Equatable {
    var maxSteps, maxModelCalls, maxTokens, maxOutputTokensPerCall, maxWallTimeMs: Int
    @HarnessNullable var estimatedUsdLimit: Double? = nil
}

struct HarnessUsage: Codable, Equatable {
    var steps, modelCalls, inputTokens, outputTokens, reservedTokens: Int
    var accounting: String
    @HarnessNullable var estimatedUsd: Double? = nil
}

struct HarnessSandboxPolicy: Codable, Equatable {
    var backend: String
    @HarnessNullable var image: String? = nil
    var network: String
    var cpus: Double
    var memoryMiB, pidsLimit, workspaceMiB, maxArtifactBytes, maxArtifactFiles, maxLogBytes: Int
}

struct HarnessRoomPolicy: Codable, Equatable {
    var revision, maxConcurrentWorkers, maxNodes, maxDependenciesPerNode: Int
    var runBudget, authoringBudget: HarnessBudgetLimits
    var sandbox: HarnessSandboxPolicy
    var hostActions, attention: String
}

struct HarnessRoom: Codable, Equatable, Identifiable {
    var version: Int
    var id, title, description, status: String
    var revision: Int
    var policy: HarnessRoomPolicy
    var createdAt, updatedAt: String
}

struct HarnessPlanNode: Codable, Equatable, Identifiable {
    var id, title, role, instructions: String
    var dependencies, inputFrom, outputPaths: [String]
    var limits: HarnessBudgetLimits
}

struct HarnessPlanDraft: Codable, Equatable {
    var goal: String
    var nodes: [HarnessPlanNode]
}

struct HarnessPlan: Codable, Equatable, Identifiable {
    var version: Int
    var id, roomId: String
    var revision, policyRevision: Int
    var status: String
    @HarnessNullable var digest: String? = nil
    var goal: String
    var nodes: [HarnessPlanNode]
    var createdAt: String
    @HarnessNullable var acceptedAt: String? = nil
}

struct HarnessNodeState: Codable, Equatable, Identifiable {
    var nodeId, status: String
    var id: String { nodeId }
    @HarnessNullable var attemptId: String? = nil
    var attemptNumber: Int
    @HarnessNullable var startedAt: String? = nil
    @HarnessNullable var finishedAt: String? = nil
    @HarnessNullable var operation: String? = nil
    var artifactIds: [String]
    var usage: HarnessUsage
    @HarnessNullable var error: String? = nil
}

struct HarnessRun: Codable, Equatable, Identifiable {
    var version: Int
    var id, roomId, planId: String
    var planRevision: Int
    var planDigest: String
    var policy: HarnessRoomPolicy
    var revision: Int
    var status: String
    var nodes: [HarnessNodeState]
    var usage: HarnessUsage
    var createdAt, updatedAt: String
    var cancelConfirmed: Bool
}

struct HarnessAuthoring: Codable, Equatable, Identifiable {
    var id, roomId, requestId: String
    var revision, policyRevision: Int
    var goal, status: String
    @HarnessNullable var planId: String? = nil
    var usage: HarnessUsage
    var createdAt, updatedAt: String
    @HarnessNullable var error: String? = nil
}

enum HarnessQuestionTarget: Codable, Equatable {
    case node(roomId: String, runId: String, nodeId: String, attemptId: String)
    case authoring(roomId: String, authoringId: String)

    var roomId: String {
        switch self {
        case .node(let roomId, _, _, _), .authoring(let roomId, _): return roomId
        }
    }
    private enum Keys: String, CodingKey { case scope, roomId, runId, nodeId, attemptId, authoringId }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        switch try values.decode(String.self, forKey: .scope) {
        case "node": self = .node(roomId: try values.decode(String.self, forKey: .roomId),
                                  runId: try values.decode(String.self, forKey: .runId),
                                  nodeId: try values.decode(String.self, forKey: .nodeId),
                                  attemptId: try values.decode(String.self, forKey: .attemptId))
        case "authoring": self = .authoring(roomId: try values.decode(String.self, forKey: .roomId),
                                            authoringId: try values.decode(String.self, forKey: .authoringId))
        default: throw DecodingError.dataCorruptedError(forKey: .scope, in: values, debugDescription: "Unknown question scope")
        }
    }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: Keys.self)
        try values.encode(roomId, forKey: .roomId)
        switch self {
        case .node(_, let runId, let nodeId, let attemptId):
            try values.encode("node", forKey: .scope)
            try values.encode(runId, forKey: .runId)
            try values.encode(nodeId, forKey: .nodeId)
            try values.encode(attemptId, forKey: .attemptId)
        case .authoring(_, let authoringId):
            try values.encode("authoring", forKey: .scope)
            try values.encode(authoringId, forKey: .authoringId)
        }
    }
}

struct HarnessQuestionChoice: Codable, Equatable, Identifiable { var id, label: String }
struct HarnessQuestionPrompt: Codable, Equatable {
    var prompt: String
    var choices: [HarnessQuestionChoice]
    var allowText: Bool
}
struct HarnessQuestionBinding: Codable, Equatable {
    var questionId: String
    var revision: Int
    var target: HarnessQuestionTarget
}
struct HarnessQuestionAnswer: Codable, Equatable {
    @HarnessNullable var text: String? = nil
    @HarnessNullable var choiceId: String? = nil
    var answeredAt: String
}
struct HarnessQuestion: Codable, Equatable, Identifiable {
    var kind, id: String
    var revision: Int
    var target: HarnessQuestionTarget
    var question: HarnessQuestionPrompt
    var status, createdAt, expiresAt: String
    @HarnessNullable var answer: HarnessQuestionAnswer? = nil
    var binding: HarnessQuestionBinding { .init(questionId: id, revision: revision, target: target) }
}
struct HarnessAnswerRequest: Codable, Equatable {
    var binding: HarnessQuestionBinding
    var source: String
    @HarnessNullable var text: String? = nil
    @HarnessNullable var choiceId: String? = nil
}
struct HarnessVoiceAnswerRequest: Codable, Equatable {
    var binding: HarnessQuestionBinding
    var transcript: String
}
struct HarnessApproval: Codable, Equatable, Identifiable {
    var kind, id: String
    @HarnessNullable var roomId: String? = nil
    @HarnessNullable var runId: String? = nil
    @HarnessNullable var nodeId: String? = nil
    var taskId, interactionId: String
    var revision: Int
    var title, detail, status: String
    var reviewable: Bool
    @HarnessNullable var blockedReason: String? = nil
    var options: [HarnessQuestionChoice]
}

struct HarnessArtifactFile: Codable, Equatable, Identifiable {
    var path, sha256: String
    var bytes: Int
    var mediaType: String
    var id: String { path }
}
struct HarnessArtifact: Codable, Equatable, Identifiable {
    var version: Int
    var id, roomId, runId, nodeId, attemptId, planDigest, digest, createdAt: String
    var files: [HarnessArtifactFile]
    var inputDigests: [String]
    var verification, verificationSummary: String
}
struct HarnessWorkerAvailability: Codable, Equatable {
    var available: Bool
    @HarnessNullable var reason: String? = nil
}
struct HarnessState: Codable, Equatable {
    var version, sequence: Int
    var ready: Bool
    var defaultPolicy: HarnessRoomPolicy
    var worker: HarnessWorkerAvailability
    var rooms: [HarnessRoom]
    var plans: [HarnessPlan]
    var authorings: [HarnessAuthoring]
    var runs: [HarnessRun]
    var questions: [HarnessQuestion]
    var approvals: [HarnessApproval]
    var artifacts: [HarnessArtifact]
}
struct HarnessEvent: Codable, Equatable {
    var version, sequence: Int
    var at, roomId: String
    @HarnessNullable var runId: String? = nil
    var entityId: String
    var revision: Int
    var type: String
}
struct HarnessEvents: Codable, Equatable {
    var version: Int
    var events: [HarnessEvent]
    var nextSequence: Int
    var resetRequired: Bool
}

struct HarnessCreateRoomRequest: Encodable {
    var requestId, title, description: String
    var policy: HarnessRoomPolicy
}
struct HarnessUpdateRoomRequest: Encodable {
    var expectedRevision: Int
    var title: String? = nil
    var description: String? = nil
    var status: String? = nil
    var policy: HarnessRoomPolicy? = nil
}
struct HarnessAuthorPlanRequest: Encodable { var requestId: String; var expectedRoomRevision: Int; var goal: String }
struct HarnessUpdatePlanRequest: Encodable { var expectedRevision: Int; var draft: HarnessPlanDraft }
struct HarnessRevisionRequest: Encodable { var expectedRevision: Int }
struct HarnessStartRunRequest: Encodable { var requestId, planId: String; var expectedPlanRevision: Int; var planDigest: String }
struct HarnessRetryNodeRequest: Encodable { var expectedRevision: Int; var previousAttemptId: String }

@MainActor
protocol HarnessServing {
    func state() async throws -> HarnessState
    func events(after: Int, roomId: String?) async throws -> HarnessEvents
    func createRoom(_ input: HarnessCreateRoomRequest) async throws -> HarnessRoom
    func updateRoom(_ roomId: String, input: HarnessUpdateRoomRequest) async throws -> HarnessRoom
    func authorPlan(_ roomId: String, input: HarnessAuthorPlanRequest) async throws -> HarnessAuthoring
    func cancelAuthoring(_ roomId: String, authoringId: String, revision: Int) async throws -> HarnessAuthoring
    func updatePlan(_ roomId: String, planId: String, input: HarnessUpdatePlanRequest) async throws -> HarnessPlan
    func acceptPlan(_ roomId: String, planId: String, revision: Int) async throws -> HarnessPlan
    func startRun(_ roomId: String, input: HarnessStartRunRequest) async throws -> HarnessRun
    func controlRun(_ roomId: String, runId: String, action: String, revision: Int) async throws -> HarnessRun
    func retryNode(_ roomId: String, runId: String, nodeId: String, input: HarnessRetryNodeRequest) async throws -> HarnessRun
    func answerQuestion(_ input: HarnessAnswerRequest) async throws -> HarnessQuestion
    func answerVoice(_ input: HarnessVoiceAnswerRequest) async throws -> HarnessQuestion
    func artifactContent(_ artifact: HarnessArtifact, path: String) async throws -> Data
}
