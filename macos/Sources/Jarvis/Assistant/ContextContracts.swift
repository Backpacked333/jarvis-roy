import Foundation

enum AssistantContextKind: String, Codable, CaseIterable, Hashable { case source, memory, history, checkpoint }
struct AssistantContextPin: Codable, Hashable {
    let kind: AssistantContextKind, id: String
    let revision: Int?
}
typealias AssistantContextCitation = AssistantContextSelection.Citation
struct AssistantContextScope: Decodable, Equatable {
    let projectId: String, conversationId: String?, taskId: String?
}
struct AssistantContextSelection: Decodable, Identifiable {
    struct Citation: Decodable {
        struct Locator: Decodable { let page: Int?, lineStart: Int, lineEnd: Int }
        let sourceVersionId: String, passageId: String, locator: Locator?
    }
    struct Provenance: Decodable { let origin: String, referenceId: String, revision: Int, memoryScope: String? }
    let id: String, kind: AssistantContextKind, projectId: String, conversationId: String?, taskId: String?
    let revision: Int, title: String, text: String, reasons: [String], citations: [Citation], provenance: Provenance
    let retrievalReasons: [String]?
    let originalSha256: String, originalBytes: Int, selectedBytes: Int, truncated: Bool, contentTrust: String, verification: String
    var pin: AssistantContextPin { AssistantContextPin(kind: kind, id: id, revision: revision) }
    var reasonText: String {
        reasons.map { reason in
            switch reason {
            case "pinned": return "Pinned for this context"
            case "query_match": return "Matches your question"
            case "retrieval_rank": return "Ranked by retrieval relevance"
            case "recent_history": return "Recent conversation history"
            case "checkpoint_continuity": return "Earlier work checkpoint"
            default: return reason.replacingOccurrences(of: "_", with: " ")
            }
        }.joined(separator: " · ")
    }
}
struct AssistantContextPacket: Decodable {
    struct CurrentTurn: Decodable { let taskId: String?, textSha256: String, provenance: String }
    struct Action: Decodable {
        let projectId: String, conversationId: String, taskId: String, status: String, pendingApprovals: Int
        let interactionId: String?, revision: Int?, toolName: String?, summary: String, argumentsSha256: String?, authority: String, provenance: String
    }
    struct Omissions: Decodable {
        let budget: Int, scope: Int, permission: Int, duplicate: Int, availableBeyondLimit: Int, pinsMissing: Int
        var total: Int { budget + scope + permission + duplicate + availableBeyondLimit + pinsMissing }
    }
    struct Usage: Decodable {
        let maxBytes: Int, maxTokens: Int, serializedBytes: Int, estimatedTokens: Int, estimator: String, framingTokens: Int
    }
    struct Retrieval: Decodable { let kind: AssistantContextKind, mode: String, warnings: [String] }
    let version: Int, id: String, scope: AssistantContextScope, purpose: String, query: String
    let currentTurn: CurrentTurn, selections: [AssistantContextSelection], activeActions: [Action], omitted: Omissions, usage: Usage
    let providerHistory: String, notice: String
    let retrieval: [Retrieval]
    private enum CodingKeys: CodingKey { case version, id, scope, purpose, query, currentTurn, selections, activeActions, omitted, usage, providerHistory, notice, retrieval }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        guard version == 1 else { throw AssistantClientError.invalidResponse }
        id = try c.decode(String.self, forKey: .id); scope = try c.decode(AssistantContextScope.self, forKey: .scope)
        purpose = try c.decode(String.self, forKey: .purpose); query = try c.decode(String.self, forKey: .query)
        currentTurn = try c.decode(CurrentTurn.self, forKey: .currentTurn); selections = try c.decode([AssistantContextSelection].self, forKey: .selections)
        activeActions = try c.decode([Action].self, forKey: .activeActions); omitted = try c.decode(Omissions.self, forKey: .omitted)
        usage = try c.decode(Usage.self, forKey: .usage); providerHistory = try c.decode(String.self, forKey: .providerHistory)
        notice = try c.decode(String.self, forKey: .notice)
        retrieval = try c.decodeIfPresent([Retrieval].self, forKey: .retrieval) ?? []
        guard ["local", "cloud"].contains(purpose), selections.count <= 32,
              usage.estimator == "utf8_bytes_upper_bound", usage.framingTokens == 32,
              usage.maxBytes > 0, usage.maxTokens > 0, providerHistory == "not_modified_by_assembler",
              currentTurn.provenance == "current_user_turn",
              usage.estimatedTokens >= 0, usage.estimatedTokens <= usage.maxTokens,
              usage.serializedBytes >= 0, usage.serializedBytes <= usage.maxBytes,
              selections.allSatisfy({ $0.projectId == scope.projectId && $0.contentTrust == "untrusted_data" && $0.verification == "not_independently_verified" }),
              activeActions.allSatisfy({ $0.projectId == scope.projectId && $0.authority == "reference_only" }) else { throw AssistantClientError.invalidResponse }
    }
}

struct KnowledgeEmbeddingIdentity: Decodable {
    let id: String, version: String, dimensions: Int, local: Bool
}
struct KnowledgeEmbeddingStatus: Decodable {
    let provider: KnowledgeEmbeddingIdentity?, local: Bool, available: Bool
}
struct KnowledgeSearchExplanation: Decodable {
    let lanes: [String], lexicalRank: Int?, vectorRank: Int?, bm25: Double?, cosine: Double?, rrf: Double
    let matchedTerms: [String], queryCoverage: Double
    var summary: String {
        let method = lanes.contains("vector") && lanes.contains("lexical") ? "Text and semantic match" : lanes.contains("vector") ? "Semantic match" : "Text match"
        return method + (matchedTerms.isEmpty ? "" : " · " + matchedTerms.prefix(8).joined(separator: ", "))
    }
}
struct KnowledgeRetrievalInfo: Decodable {
    struct Coverage: Decodable { let eligiblePassages: Int, indexedPassages: Int, pendingPassages: Int, scannedVectors: Int, vectorScanLimited: Bool }
    struct Diversity: Decodable { let maxPerSource: Int }
    let mode: String, terms: [String], vectorStatus: String, provider: KnowledgeEmbeddingIdentity?
    let coverage: Coverage, diversity: Diversity, warnings: [String]
}
