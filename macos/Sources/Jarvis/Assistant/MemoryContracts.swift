import Foundation

struct AssistantMemoryScope: Codable, Equatable {
    enum Kind: String, Codable { case global, project }
    let kind: Kind
    let projectId: String?
    static let personal = AssistantMemoryScope(kind: .global, projectId: nil)
    static func project(_ id: String) -> Self { Self(kind: .project, projectId: id) }
    var title: String { kind == .global ? "Personal memory" : "Project memory" }
}

struct AssistantMemoryReference: Codable {
    enum Kind: String, Codable { case knowledge, conversation, legacy }
    let type: Kind
    let projectId: String?, sourceVersionId: String?, passageId: String?, conversationId: String?, turnId: String?, memoryId: String?
    private enum CodingKeys: CodingKey { case type, projectId, sourceVersionId, passageId, conversationId, turnId, memoryId }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        switch type {
        case .knowledge:
            try c.encode(projectId, forKey: .projectId); try c.encode(sourceVersionId, forKey: .sourceVersionId)
            try c.encodeIfPresent(passageId, forKey: .passageId)
        case .conversation:
            try c.encode(projectId, forKey: .projectId); try c.encode(conversationId, forKey: .conversationId)
            try c.encodeIfPresent(turnId, forKey: .turnId)
        case .legacy: try c.encode(memoryId, forKey: .memoryId)
        }
    }
    var label: String {
        switch type {
        case .knowledge: return "Source \(sourceVersionId ?? "")" + (passageId.map { " · passage \($0)" } ?? "")
        case .conversation: return "Conversation \(conversationId ?? "")" + (turnId.map { " · turn \($0)" } ?? "")
        case .legacy: return "Imported preference \(memoryId ?? "")"
        }
    }
}
struct AssistantMemoryProvenance: Codable {
    enum Origin: String, Codable { case explicit_user, inferred }
    let origin: Origin, references: [AssistantMemoryReference]
}
enum AssistantMemoryKind: String, Codable, CaseIterable, Identifiable {
    case preference, fact, goal, person, routine, decision
    var id: String { rawValue }
}
struct AssistantMemoryAssertion: Codable, Equatable {
    let entityId: String, property: String, value: String, validFrom: String?, validTo: String?, observedAt: String
    private enum CodingKeys: CodingKey { case entityId, property, value, validFrom, validTo, observedAt }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(entityId, forKey: .entityId); try c.encode(property, forKey: .property); try c.encode(value, forKey: .value)
        try c.encode(validFrom, forKey: .validFrom); try c.encode(validTo, forKey: .validTo); try c.encode(observedAt, forKey: .observedAt)
    }
}
struct AssistantMemoryInput: Encodable {
    var kind: AssistantMemoryKind, scope: AssistantMemoryScope, text: String, provenance: AssistantMemoryProvenance
    var confidence: Double, pinned: Bool, expiresAt: String?, cloudAllowed: Bool
    var assertion: AssistantMemoryAssertion? = nil
    private enum CodingKeys: CodingKey { case kind, scope, text, provenance, confidence, pinned, expiresAt, cloudAllowed, assertion }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind); try c.encode(scope, forKey: .scope); try c.encode(text, forKey: .text)
        try c.encode(provenance, forKey: .provenance); try c.encode(confidence, forKey: .confidence)
        try c.encode(pinned, forKey: .pinned); try c.encode(expiresAt, forKey: .expiresAt); try c.encode(cloudAllowed, forKey: .cloudAllowed)
        try c.encodeIfPresent(assertion, forKey: .assertion)
    }
}
struct AssistantMemoryRecord: Codable, AssistantRevisioned {
    enum Status: String, Codable { case proposed, active, superseded, archived }
    let version: Int, id: String, revision: Int, digest: String
    let kind: AssistantMemoryKind, scope: AssistantMemoryScope, text: String, provenance: AssistantMemoryProvenance
    let confidence: Double, pinned: Bool, expiresAt: String?, cloudAllowed: Bool, status: Status
    let createdAt: String, updatedAt: String, supersededBy: String?
    let assertion: AssistantMemoryAssertion?
    private enum CodingKeys: CodingKey { case version, id, revision, digest, kind, scope, text, provenance, confidence, pinned, expiresAt, cloudAllowed, status, createdAt, updatedAt, supersededBy, assertion }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        guard version == 1 else { throw AssistantClientError.invalidResponse }
        id = try c.decode(String.self, forKey: .id); revision = try c.decode(Int.self, forKey: .revision)
        digest = try c.decode(String.self, forKey: .digest); kind = try c.decode(AssistantMemoryKind.self, forKey: .kind)
        scope = try c.decode(AssistantMemoryScope.self, forKey: .scope); text = try c.decode(String.self, forKey: .text)
        provenance = try c.decode(AssistantMemoryProvenance.self, forKey: .provenance); confidence = try c.decode(Double.self, forKey: .confidence)
        pinned = try c.decode(Bool.self, forKey: .pinned); expiresAt = try c.decodeIfPresent(String.self, forKey: .expiresAt)
        cloudAllowed = try c.decode(Bool.self, forKey: .cloudAllowed); status = try c.decode(Status.self, forKey: .status)
        createdAt = try c.decode(String.self, forKey: .createdAt); updatedAt = try c.decode(String.self, forKey: .updatedAt)
        supersededBy = try c.decodeIfPresent(String.self, forKey: .supersededBy)
        assertion = try c.decodeIfPresent(AssistantMemoryAssertion.self, forKey: .assertion)
        guard revision > 0, digest.count == 64, RoomsStateRules.isDigest(digest), confidence.isFinite, (0...1).contains(confidence),
              scope.kind != .project || scope.projectId != nil else { throw AssistantClientError.invalidResponse }
    }
    func encode(to encoder: Encoder) throws {
        try input.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(version, forKey: .version); try c.encode(id, forKey: .id); try c.encode(revision, forKey: .revision)
        try c.encode(digest, forKey: .digest); try c.encode(status, forKey: .status)
        try c.encode(createdAt, forKey: .createdAt); try c.encode(updatedAt, forKey: .updatedAt); try c.encode(supersededBy, forKey: .supersededBy)
    }
    var input: AssistantMemoryInput {
        AssistantMemoryInput(kind: kind, scope: scope, text: text, provenance: provenance,
            confidence: confidence, pinned: pinned, expiresAt: expiresAt, cloudAllowed: cloudAllowed, assertion: assertion)
    }
    var expired: Bool { expiresAt.map { (RoomsStateRules.date($0) ?? .distantPast) <= Date() } ?? false }
    func matchesReview(_ other: AssistantMemoryRecord) -> Bool {
        id == other.id && revision == other.revision && digest == other.digest && scope == other.scope && status == .proposed && other.status == .proposed
    }
}

enum MemoryWorkspaceScope: String, CaseIterable, Identifiable {
    case personal, project
    var id: String { rawValue }
    func contains(_ entry: AssistantMemoryRecord, projectID: String?) -> Bool {
        self == .personal ? entry.scope == .personal : projectID.map { entry.scope == .project($0) } ?? false
    }
}
