import XCTest
@testable import Jarvis

final class AssistantExperienceTests: XCTestCase {
    func testSessionSwitchAndLateSuccessOnlyClearOriginalSessionDraft() {
        var drafts = AssistantSessionDrafts()
        drafts.edit("Private project A request", for: "session-a")
        let submitted = drafts.checkpoint(for: "session-a")
        drafts.edit("Project B draft", for: "session-b")
        XCTAssertEqual(drafts.text(for: "session-b"), "Project B draft")
        XCTAssertEqual(drafts.text(for: "session-a"), "Private project A request")
        drafts.admitted(submitted.text, from: submitted)
        XCTAssertEqual(drafts.text(for: "session-a"), "")
        XCTAssertEqual(drafts.text(for: "session-b"), "Project B draft")
    }

    func testLateFailureKeepsNewerTextAndNeverCopiesPrivateDraftAcrossSessions() {
        var drafts = AssistantSessionDrafts()
        let original = "Private project A request"
        drafts.edit(original, for: "session-a")
        drafts.edit("Project B draft", for: "session-b")
        drafts.edit("Newer project A correction", for: "session-a")
        drafts.retain(original, for: "session-a")
        XCTAssertEqual(drafts.text(for: "session-a"), "Newer project A correction\n\n— Retained turn —\nPrivate project A request")
        XCTAssertEqual(drafts.text(for: "session-b"), "Project B draft")
        drafts.retain("Another captured A turn", for: "session-a")
        XCTAssertFalse(drafts.text(for: "session-b").contains("A turn"))
    }

    func testRepeatedBusyCapturesStaySeparatedAndCannotReplaceOtherSessionDrafts() {
        var drafts = AssistantSessionDrafts()
        drafts.edit("First request", for: "session-a")
        let submitted = drafts.checkpoint(for: "session-a")
        drafts.retain("Second captured turn", for: "session-a", replacingSubmitted: submitted)
        drafts.retain("Third captured turn", for: "session-a", replacingSubmitted: submitted)
        drafts.admitted(submitted.text, from: submitted)
        XCTAssertEqual(drafts.text(for: "session-a"), "Second captured turn\n\n— Retained turn —\nThird captured turn")
        drafts.edit("Independent B draft", for: "session-b")
        drafts.retain("Captured B turn", for: "session-b", replacingSubmitted: submitted)
        XCTAssertEqual(drafts.text(for: "session-b"), "Independent B draft\n\n— Retained turn —\nCaptured B turn")
        XCTAssertFalse(drafts.text(for: "session-a").contains("B draft"))
    }

    func testLateSuccessCannotClearDraftEditedBackToSameText() {
        var drafts = AssistantSessionDrafts()
        drafts.edit("Original text", for: "session-a")
        let submitted = drafts.checkpoint(for: "session-a")
        drafts.edit("Edited text", for: "session-a")
        drafts.edit("Original text", for: "session-a")
        drafts.admitted(submitted.text, from: submitted)
        XCTAssertEqual(drafts.text(for: "session-a"), "Original text")
    }

    func testVoiceReadbackAndChallengeCannotResumeAfterNewerInvalidationOrNavigation() {
        func proposal(_ revision: Int, status: String, readback: String = "readback") -> AssistantProposal {
            AssistantProposal(version: 1, id: "proposal", sessionId: "session", turnId: "turn", revision: revision,
                digest: String(repeating: "a", count: 64),
                action: AssistantAction(taskId: "task", interactionId: "approval", revision: 1, optionId: "approve",
                    toolName: "mail", exactArguments: "{}", reviewText: "Review mail {}", voiceAllowed: true),
                status: status, challenge: status == "awaiting_confirmation" ? "confirm amber 1234" : nil,
                expiresAt: nil, nativeSessionId: "native", readbackId: readback,
                createdAt: "2026-11-08T00:00:00Z", updatedAt: "2026-11-08T00:00:00Z")
        }
        for status in ["reviewed", "reading", "awaiting_confirmation"] {
            let response = proposal(3, status: status)
            XCTAssertTrue(AssistantConfirmationPlayback.permits(response, current: response,
                activeProposalID: "proposal", selectedSessionID: "session", status: status))
            XCTAssertFalse(AssistantConfirmationPlayback.permits(response, current: proposal(4, status: "invalidated"),
                activeProposalID: "proposal", selectedSessionID: "session", status: status))
            XCTAssertFalse(AssistantConfirmationPlayback.permits(response, current: response,
                activeProposalID: nil, selectedSessionID: "session", status: status))
            XCTAssertFalse(AssistantConfirmationPlayback.permits(response, current: response,
                activeProposalID: "proposal", selectedSessionID: "different-session", status: status))
            XCTAssertFalse(AssistantConfirmationPlayback.permits(response, current: proposal(3, status: status, readback: "different-readback"),
                activeProposalID: "proposal", selectedSessionID: "session", status: status))
        }
    }

    func testCloudGrantExpiryAcceptsBackendFractionalDatesAndFailsClosed() {
        func grant(expiry: String?, revoked: String? = nil, cloud: Bool = true) -> KnowledgeGrant {
            KnowledgeGrant(version: 1, id: "grant", revision: 1, projectId: "project", resourceKind: "file",
                resourceId: "file", label: "Source", cloudAllowed: cloud, expiresAt: expiry, revokedAt: revoked)
        }
        let formatter = ISO8601DateFormatter()
        let now = formatter.date(from: "2026-11-08T12:00:00Z")!
        XCTAssertTrue(grant(expiry: "2026-11-08T12:00:01.000Z").allowsCloudUse(at: now))
        XCTAssertTrue(grant(expiry: "2026-11-08T12:00:01Z").allowsCloudUse(at: now))
        XCTAssertFalse(grant(expiry: "2026-11-08T12:00:00.000Z").allowsCloudUse(at: now))
        XCTAssertFalse(grant(expiry: "malformed").allowsCloudUse(at: now))
        XCTAssertFalse(grant(expiry: nil, revoked: "2026-11-08T11:00:00.000Z").allowsCloudUse(at: now))
        XCTAssertFalse(grant(expiry: nil, cloud: false).allowsCloudUse(at: now))
    }

    func testLateHTTPReplyCannotReopenCompletedTurnFromEventStream() {
        func turn(_ revision: Int, status: String) -> AssistantTurn {
            AssistantTurn(version: 1, id: "turn", sessionId: "session", revision: revision,
                text: "Check the result", intent: "continue", capturedFocus: .none,
                sessionRevision: 1, status: status, taskId: "task", conversationId: nil,
                error: nil, createdAt: "2026-11-08T00:00:00Z", updatedAt: "2026-11-08T00:00:00Z")
        }
        var turns: [AssistantTurn] = []
        XCTAssertTrue(AssistantRevisionMerge.upsert(turn(3, status: "completed"), in: &turns))
        XCTAssertFalse(AssistantRevisionMerge.upsert(turn(2, status: "running"), in: &turns))
        XCTAssertFalse(AssistantRevisionMerge.upsert(turn(3, status: "running"), in: &turns))
        XCTAssertEqual(turns.count, 1)
        XCTAssertEqual(turns[0].status, "completed")
        XCTAssertTrue(turns[0].isSettled)
    }

    func testLateReviewResponseCannotRestoreInvalidatedVoiceProposal() {
        let action = AssistantAction(taskId: "task", interactionId: "approval", revision: 1, optionId: "approve",
            toolName: "mail", exactArguments: "{}", reviewText: "Review mail {}", voiceAllowed: true)
        func proposal(_ revision: Int, status: String) -> AssistantProposal {
            AssistantProposal(version: 1, id: "proposal", sessionId: "session", turnId: "turn", revision: revision,
                digest: String(repeating: "a", count: 64), action: action, status: status,
                challenge: nil, expiresAt: nil, nativeSessionId: "native", readbackId: "readback",
                createdAt: "2026-11-08T00:00:00Z", updatedAt: "2026-11-08T00:00:00Z")
        }
        var proposals = [proposal(2, status: "reviewed")]
        XCTAssertTrue(AssistantRevisionMerge.upsert(proposal(4, status: "invalidated"), in: &proposals))
        XCTAssertFalse(AssistantRevisionMerge.upsert(proposal(3, status: "reading"), in: &proposals))
        XCTAssertEqual(proposals[0].status, "invalidated")
        XCTAssertEqual(proposals[0].revision, 4)
    }

    @MainActor
    func testFormattingOnlySpeechDrainsWithoutOpeningAProviderTurn() {
        let transport = FixtureVoiceTransport()
        let voice = VoiceController(audioOutputAvailable: { true }, transport: transport)
        defer { voice.stopListening() }
        voice.setCloudConsent(true)
        var receipts: [String] = []
        voice.onSpeechDrained = { receipts.append($0) }
        voice.speakTracked(" \n\n ", receiptID: "formatting", context: .init())
        XCTAssertEqual(receipts, ["formatting"])
        XCTAssertTrue(transport.frames.isEmpty)
        XCTAssertEqual(transport.connections, 0)
    }

    func testSpeechQueueKeepsOriginalContextAndSegmentsWithoutDroppingUnicode() throws {
        var queue = VoiceSpeechQueue()
        let context = HarnessVoiceContext(roomId: "room-a", conversationId: nil, question: nil)
        queue.begin(id: "turn-a", context: context)
        let text = String(repeating: "An equation 👩🏽‍🔬 and result. ", count: 500)
        try queue.append(id: "turn-a", text: text)
        try queue.end(id: "turn-a")
        var segments: [String] = []
        while let next = queue.next() { segments.append(next) }
        XCTAssertGreaterThan(segments.count, 1)
        XCTAssertTrue(segments.allSatisfy { $0.utf16.count <= 3_800 })
        XCTAssertEqual(segments.joined(), text)
        XCTAssertEqual(queue.context, context)
        XCTAssertTrue(queue.finished)
    }

    func testCancelledAndFinishedSpeechCannotAcceptLateText() throws {
        var queue = VoiceSpeechQueue()
        queue.begin(id: "old", context: .init())
        try queue.append(id: "old", text: "First sentence.")
        queue.cancel()
        queue.begin(id: "new", context: .init())
        XCTAssertThrowsError(try queue.append(id: "old", text: "Late speech."))
        try queue.append(id: "new", text: "Fresh speech.")
        try queue.end(id: "new")
        XCTAssertThrowsError(try queue.append(id: "new", text: "After end."))
        XCTAssertEqual(queue.next(), "Fresh speech.")
        XCTAssertNil(queue.next())
    }

    func testSpeechQueueLimitIsAtomic() throws {
        var queue = VoiceSpeechQueue()
        queue.begin(id: "turn", context: .init())
        try queue.append(id: "turn", text: "Kept.")
        XCTAssertThrowsError(try queue.append(id: "turn", text: String(repeating: "x", count: 32_000)))
        XCTAssertEqual(queue.acceptedCharacters, 5)
        XCTAssertEqual(queue.next(), "Kept.")
        XCTAssertNil(queue.next())
        XCTAssertThrowsError(try queue.append(id: "turn", text: "a" + String(repeating: "\u{0301}", count: 4_000)))
    }

    func testSentenceStreamSpeaksOnlyStableSentencesAndFlushesRemainder() {
        var stream = AssistantSentenceStream()
        XCTAssertEqual(stream.append("The result", final: false), "")
        XCTAssertEqual(stream.append("The result is 42. Here", final: false), "The result is 42.")
        XCTAssertEqual(stream.append("The result is 42. Here is why", final: false), "")
        XCTAssertEqual(stream.append("The result is 42. Here is why", final: true), " Here is why")
        XCTAssertEqual(stream.append("The result is 42. Here is why", final: true), "")
    }

    func testSentenceRewriteInvalidatesInsteadOfRepeatingOrSpeakingChangedPrefix() {
        var stream = AssistantSentenceStream()
        XCTAssertEqual(stream.append("Result A. ", final: false), "Result A.")
        XCTAssertEqual(stream.append("Result B.", final: true), "")
        XCTAssertTrue(stream.invalidated)
        XCTAssertEqual(stream.append("Result A. Another sentence.", final: true), "")
    }

    func testPartialDecimalDoesNotBecomeASpokenSentence() {
        var stream = AssistantSentenceStream()
        XCTAssertEqual(stream.append("The value is 3.", final: false), "")
        XCTAssertEqual(stream.append("The value is 3.14. Next", final: false), "The value is 3.14.")
    }

    func testLongAnswerKeepsNarrationShortWithoutTruncatingDisplayedText() {
        var stream = AssistantSentenceStream()
        let text = String(repeating: "A checked result with evidence. ", count: 200)
        let spoken = stream.append(text, final: true)
        XCTAssertTrue(stream.truncated)
        XCTAssertLessThan(spoken.count, 2_500)
        XCTAssertTrue(spoken.contains("complete result is on screen"))
        XCTAssertEqual(stream.observed, text)
        XCTAssertEqual(stream.append(text + " More.", final: true), "")
    }

    func testSSEParserHandlesFragmentedMultilineFramesAndHeartbeat() throws {
        var parser = AssistantSSEParser()
        let wire = ": heartbeat\r\n\r\nevent: assistant\ndata: {\"a\":\ndata: 1}\n\n"
        var payloads: [Data] = []
        for byte in wire.utf8 { if let data = try parser.accept(byte) { payloads.append(data) } }
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: payloads[0]) as? [String: Int], ["a": 1])
    }

    func testSSEParserRejectsUnboundedFrames() throws {
        var parser = AssistantSSEParser()
        for _ in 0...524_288 { _ = try parser.accept(120) }
        XCTAssertThrowsError(try parser.accept(120))
    }

    func testUnknownAssistantProtocolIsRejected() throws {
        let json = Data("{\"version\":2,\"sequence\":1,\"type\":\"session.updated\",\"data\":{}}".utf8)
        XCTAssertThrowsError(try AssistantEvent.decode(json))
    }

    func testDocumentPresentationPreservesExactSourceAndLocators() throws {
        let json = #"{"kind":"document","sourceVersionId":"source-v2","passages":[{"id":"passage-7","text":"Actual source passage.","locator":{"page":4,"lineStart":12,"lineEnd":15}}]}"#
        let value = try JSONDecoder().decode(AssistantPresentationContent.self, from: Data(json.utf8))
        XCTAssertEqual(value.kind, .document)
        XCTAssertEqual(value.sourceVersionId, "source-v2")
        XCTAssertEqual(value.passages?.first?.id, "passage-7")
        XCTAssertEqual(value.passages?.first?.locator.display, "Page 4 · Lines 12–15")
        XCTAssertEqual(value.passages?.first?.text, "Actual source passage.")
    }

    func testDraftAndCodeDiffRemainInspectablePresentations() throws {
        let draft = #"{"kind":"draft","format":"email","title":"Research update","body":"Please review this result."}"#
        let value = try JSONDecoder().decode(AssistantPresentationContent.self, from: Data(draft.utf8))
        XCTAssertEqual(value.kind, .draft)
        XCTAssertEqual(value.format, "email")
        XCTAssertEqual(value.body, "Please review this result.")
        let diff = #"{"kind":"code_diff","language":"swift","diff":"-let x = 1\n+let x = 2","verification":"unverified"}"#
        let changed = try JSONDecoder().decode(AssistantPresentationContent.self, from: Data(diff.utf8))
        XCTAssertEqual(changed.kind, .code_diff)
        XCTAssertEqual(changed.diff, "-let x = 1\n+let x = 2")
        XCTAssertEqual(changed.verification, "unverified")
    }

    func testPersistentVoiceConnectionKeepsSessionAndAdvancesGeneration() {
        var turn = VoiceTurnState()
        let first = turn.begin(.capture, context: .init(), reuseSession: true)
        let session = turn.sessionId
        turn.invalidate()
        let next = turn.begin(.playback, context: .init(), reuseSession: true)
        XCTAssertEqual(turn.sessionId, session)
        XCTAssertGreaterThan(next, first)
        turn.renewTransportSession()
        XCTAssertNotEqual(turn.sessionId, session)
    }

    func testExtendedDictationRemainsBoundedAndAllowsLongerPauses() {
        XCTAssertGreaterThan(VoiceCaptureMode.dictation.maximumSeconds, VoiceCaptureMode.conversation.maximumSeconds)
        XCTAssertLessThan(VoiceCaptureMode.dictation.maximumSeconds, 90)
        XCTAssertGreaterThan(VoiceCaptureMode.dictation.silenceSeconds, VoiceCaptureMode.conversation.silenceSeconds)
    }
}
