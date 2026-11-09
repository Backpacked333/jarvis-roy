import Foundation
import XCTest
@testable import Jarvis

final class MemoryContextTests: XCTestCase {
    private func memory(version: Int = 1, revision: Int = 1, digest: String = String(repeating: "a", count: 64),
                        scope: [String: Any] = ["kind": "global"], status: String = "proposed") throws -> AssistantMemoryRecord {
        let object: [String: Any] = ["version": version, "id": "memory-1", "revision": revision, "digest": digest,
            "kind": "preference", "scope": scope, "text": "Explain the assumptions first.",
            "provenance": ["origin": "explicit_user", "references": []], "confidence": 1,
            "pinned": false, "expiresAt": NSNull(), "cloudAllowed": false, "status": status,
            "createdAt": "2026-11-09T00:00:00.000Z", "updatedAt": "2026-11-09T00:00:00.000Z", "supersededBy": NSNull()]
        return try JSONDecoder().decode(AssistantMemoryRecord.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testMemoryInputKeepsRequiredNullsAndDoesNotInventProjectScope() throws {
        let raw = #"{"type":"conversation","projectId":null,"conversationId":"conversation-1"}"#
        let reference = try JSONDecoder().decode(AssistantMemoryReference.self, from: Data(raw.utf8))
        let input = AssistantMemoryInput(kind: .preference, scope: .personal, text: "Keep explanations concise.",
            provenance: AssistantMemoryProvenance(origin: .explicit_user, references: [reference]),
            confidence: 1, pinned: true, expiresAt: nil, cloudAllowed: false)
        let object = try input.assistantJSONObject()
        XCTAssertTrue(object["expiresAt"] is NSNull)
        XCTAssertEqual(object["cloudAllowed"] as? Bool, false)
        let scope = try XCTUnwrap(object["scope"] as? [String: String])
        XCTAssertEqual(scope, ["kind": "global"])
        let provenance = try XCTUnwrap(object["provenance"] as? [String: Any])
        let references = try XCTUnwrap(provenance["references"] as? [[String: Any]])
        XCTAssertTrue(references[0]["projectId"] is NSNull)
        XCTAssertNil(references[0]["sourceVersionId"])
    }

    func testMemoryReviewBindsExactRevisionDigestScopeAndPendingStatus() throws {
        let captured = try memory()
        XCTAssertTrue(captured.matchesReview(try memory()))
        XCTAssertFalse(captured.matchesReview(try memory(revision: 2)))
        XCTAssertFalse(captured.matchesReview(try memory(digest: String(repeating: "b", count: 64))))
        XCTAssertFalse(captured.matchesReview(try memory(scope: ["kind": "project", "projectId": "project-a"])))
        XCTAssertFalse(captured.matchesReview(try memory(status: "active")))
        XCTAssertThrowsError(try memory(version: 2))
        XCTAssertThrowsError(try memory(digest: String(repeating: "z", count: 64)))
    }

    func testMemoryListAndExportScopeCannotMixPersonalOrOtherProjects() throws {
        let personal = try memory(), a = try memory(scope: ["kind": "project", "projectId": "project-a"])
        let b = try memory(scope: ["kind": "project", "projectId": "project-b"])
        let selected = [personal, a, b].filter { MemoryWorkspaceScope.project.contains($0, projectID: "project-a") }
        XCTAssertEqual(selected.count, 1)
        XCTAssertEqual(selected[0].scope, .project("project-a"))
        XCTAssertTrue(MemoryWorkspaceScope.personal.contains(personal, projectID: "project-a"))
        XCTAssertFalse(MemoryWorkspaceScope.project.contains(personal, projectID: "project-a"))
        XCTAssertFalse(MemoryWorkspaceScope.project.contains(a, projectID: nil))
        let encoded = try JSONEncoder().encode(a)
        let roundTrip = try JSONDecoder().decode(AssistantMemoryRecord.self, from: encoded)
        XCTAssertEqual(roundTrip.scope, a.scope)
        XCTAssertEqual(roundTrip.digest, a.digest)
        XCTAssertFalse(roundTrip.cloudAllowed)
    }

    private func packet(version: Int = 1, selectionProject: String = "project-a", tokens: Int = 1_056) throws -> AssistantContextPacket {
        let object: [String: Any] = [
            "version": version, "id": String(repeating: "a", count: 64),
            "scope": ["projectId": "project-a", "conversationId": NSNull(), "taskId": NSNull()],
            "purpose": "local", "query": "Find assumptions",
            "currentTurn": ["taskId": NSNull(), "textSha256": String(repeating: "b", count: 64), "provenance": "current_user_turn"],
            "selections": [["id": "passage-1", "kind": "source", "projectId": selectionProject,
                "conversationId": NSNull(), "taskId": NSNull(), "revision": 2, "title": "Evidence", "text": "Assumptions matter.",
                "reasons": ["query_match", "retrieval_rank"], "retrievalReasons": ["Matched assumptions"], "citations": [["sourceVersionId": "source-v2", "passageId": "passage-1", "locator": ["page": 4, "lineStart": 2, "lineEnd": 3]]],
                "provenance": ["origin": "original_source", "referenceId": "source-v2", "revision": 2],
                "originalSha256": String(repeating: "c", count: 64), "originalBytes": 18, "selectedBytes": 18,
                "truncated": false, "contentTrust": "untrusted_data", "verification": "not_independently_verified"]],
            "activeActions": [], "omitted": ["budget": 1, "scope": 0, "permission": 2, "duplicate": 0, "availableBeyondLimit": 0, "pinsMissing": 1],
            "usage": ["maxBytes": 4096, "maxTokens": 4096, "serializedBytes": 1024, "estimatedTokens": tokens, "estimator": "utf8_bytes_upper_bound", "framingTokens": 32],
            "providerHistory": "not_modified_by_assembler", "notice": "A bounded context preview.",
            "retrieval": [["kind": "source", "mode": "lexical", "warnings": ["Local semantic retrieval is unavailable."]]],
        ]
        return try JSONDecoder().decode(AssistantContextPacket.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testContextPacketPreservesCitationReasonsAndExactPinRevision() throws {
        let result = try packet()
        XCTAssertEqual(result.selections[0].citations[0].locator?.page, 4)
        XCTAssertEqual(result.selections[0].citations[0].sourceVersionId, "source-v2")
        XCTAssertEqual(result.selections[0].pin.revision, 2)
        XCTAssertEqual(result.selections[0].pin.kind, .source)
        XCTAssertTrue(result.selections[0].reasonText.contains("Matches your question"))
        XCTAssertEqual(result.omitted.permission, 2)
        XCTAssertEqual(result.omitted.pinsMissing, 1)
        XCTAssertEqual(result.usage.estimatedTokens, 1_056)
        XCTAssertEqual(result.selections[0].retrievalReasons, ["Matched assumptions"])
        XCTAssertEqual(result.retrieval[0].mode, "lexical")
        XCTAssertEqual(result.retrieval[0].warnings.count, 1)
        XCTAssertThrowsError(try packet(version: 2))
        XCTAssertThrowsError(try packet(selectionProject: "different-project"))
        XCTAssertThrowsError(try packet(tokens: 5_000))
    }
}
