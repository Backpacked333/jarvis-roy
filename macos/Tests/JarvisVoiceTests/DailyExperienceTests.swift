import XCTest
@testable import Jarvis

final class DailyExperienceTests: XCTestCase {
    func testPublicResearchQueryRequiresSeparateConsentAndNeverUsesPrivateGoal() {
        var selection = ObjectiveEvidenceSelection()
        selection.publicQuery = "public scholarly terms"
        XCTAssertFalse(selection.valid)
        XCTAssertNil(selection.parameters["publicQuery"])
        selection.sourceIDs = ["source-two", "source-one"]
        XCTAssertEqual(selection.parameters["sourceVersionIds"] as? [String], ["source-one", "source-two"])
        selection.publicSearchAllowed = true
        XCTAssertTrue(selection.valid)
        XCTAssertEqual(selection.parameters["publicQuery"] as? String, "public scholarly terms")
        XCTAssertEqual(selection.parameters["providers"] as? [String], ["arxiv", "crossref"])
        XCTAssertNil(selection.parameters["goal"])
        selection.publicQuery = String(repeating: "x", count: 401)
        XCTAssertFalse(selection.valid)
        XCTAssertNil(selection.parameters["publicQuery"])
    }
    private func presentation(_ id: String, revision: Int) throws -> AssistantPresentation {
        let object: [String: Any] = ["version": 1, "id": id, "sessionId": "session-a", "turnId": "turn-a", "revision": revision,
            "title": "Evidence", "capturedFocus": ["kind": "conversation", "conversationId": "project-a", "roomId": NSNull()],
            "content": ["kind": "text", "markdown": "Revision \(revision)"], "createdAt": "2026-11-09T00:00:00Z", "updatedAt": "2026-11-09T00:00:00Z"]
        return try JSONDecoder().decode(AssistantPresentation.self, from: JSONSerialization.data(withJSONObject: object))
    }
    func testManualNavigationHoldsExactRevisionUntilExplicitFollow() throws {
        var state = PresentationNavigation()
        let first = try presentation("first", revision: 1), updated = try presentation("first", revision: 2), next = try presentation("next", revision: 1)
        state.select(first, automatic: true)
        state.select(first)
        state.select(updated, automatic: true)
        state.select(next, automatic: true)
        XCTAssertEqual(state.current?.id, "first")
        XCTAssertEqual(state.current?.revision, 1)
        XCTAssertFalse(state.following)
        state.follow(next)
        XCTAssertTrue(state.following)
        XCTAssertEqual(state.current?.id, "next")
        state.back()
        XCTAssertFalse(state.following)
        XCTAssertEqual(state.current?.revision, 1)
        state.select(updated, automatic: true)
        XCTAssertEqual(state.current?.revision, 1)
        state.reset()
        XCTAssertNil(state.current)
        XCTAssertFalse(state.canGoBack)
    }
    func testSelectionEncodingContainsOnlyExactAnchorCoordinates() throws {
        let passage = try AssistantVisualSelection(kind: .document_passage, passageId: "passage-2").assistantJSONObject()
        XCTAssertEqual(Set(passage.keys), ["kind", "passageId"])
        XCTAssertEqual(passage["passageId"] as? String, "passage-2")
        let cell = try AssistantVisualSelection(kind: .table_cell, row: 2, column: 1).assistantJSONObject()
        XCTAssertEqual(Set(cell.keys), ["kind", "row", "column"])
        XCTAssertEqual(cell["row"] as? Int, 2)
    }
    func testSegmentedDictationPreservesInitialIdentityAndRejectsOtherContext() throws {
        let focus = HarnessVoiceContext(roomId: nil, conversationId: "private-project", question: nil)
        let initial = HarnessVoiceUtterance(text: "", context: focus, sessionId: "original-session", generation: 7)
        var dictation = VoiceDictation(root: initial, startedAt: 10)
        try dictation.append(.init(text: "First segment.", context: focus, sessionId: "next-session", generation: 10))
        try dictation.append(.init(text: "Correction: the second paper.", context: focus, sessionId: "third-session", generation: 13))
        XCTAssertEqual(dictation.utterance.text, "First segment.\n\nCorrection: the second paper.")
        XCTAssertEqual(dictation.utterance.sessionId, "original-session")
        XCTAssertEqual(dictation.utterance.generation, 7)
        XCTAssertEqual(dictation.utterance.context, focus)
        XCTAssertTrue(dictation.mayContinue(at: 489))
        XCTAssertFalse(dictation.mayContinue(at: 490))
        XCTAssertFalse(dictation.mayContinue(at: 9))
        XCTAssertThrowsError(try dictation.append(.init(text: "Unrelated", context: .init(roomId: "other"), sessionId: "other", generation: 15)))
        XCTAssertEqual(dictation.segments, 2)
    }
    func testDictationAdmissionIsAtomicAtUTF16Limit() throws {
        let root = HarnessVoiceUtterance(text: "", context: .init(), sessionId: "s", generation: 1)
        var dictation = VoiceDictation(root: root, startedAt: 0)
        try dictation.append(.init(text: String(repeating: "😀", count: 8_000), context: .init(), sessionId: "s", generation: 1))
        XCTAssertEqual(dictation.text.utf16.count, 16_000)
        XCTAssertFalse(dictation.mayContinue(at: 2))
        XCTAssertThrowsError(try dictation.append(.init(text: "More", context: .init(), sessionId: "s", generation: 2)))
        XCTAssertEqual(dictation.text.utf16.count, 16_000)
        XCTAssertEqual(dictation.segments, 1)
    }
    func testVoicePreflightCacheExpiresAndNeverAcceptsClockRollback() {
        var cache = VoiceProviderPreflight()
        XCTAssertFalse(cache.reusable(at: 10))
        cache.verified(at: 10)
        XCTAssertTrue(cache.reusable(at: 39.999))
        XCTAssertFalse(cache.reusable(at: 40))
        XCTAssertFalse(cache.reusable(at: 9))
        XCTAssertFalse(cache.reusable(at: .nan))
        cache.reset()
        XCTAssertFalse(cache.reusable(at: 11))
    }
    func testPausePreferencesRemainWithinCaptureSafetyBounds() {
        XCTAssertEqual(VoicePausePolicy.clamped(-5, mode: .conversation), 0.6)
        XCTAssertEqual(VoicePausePolicy.clamped(90, mode: .conversation), 4)
        XCTAssertEqual(VoicePausePolicy.clamped(.infinity, mode: .dictation), 4)
        XCTAssertEqual(VoicePausePolicy.clamped(90, mode: .dictation), 15)
    }
    func testEquationDocumentEscapesScriptBoundaryAndDisablesTrustAndNetwork() throws {
        let html = try EquationDocument.make(latex: "</script><script>fetch('https://private.example')</script>", script: "/* trusted bundle */", nonce: "abc123")
        XCTAssertFalse(html.contains("<script>fetch"))
        XCTAssertTrue(html.contains("\\u003c/script\\u003e"))
        XCTAssertTrue(html.contains("trust:false"))
        XCTAssertTrue(html.contains("connect-src 'none'"))
        XCTAssertTrue(html.contains("default-src 'none'"))
        XCTAssertTrue(html.contains("maxExpand:500"))
        XCTAssertThrowsError(try EquationDocument.make(latex: "x", script: "", nonce: "\" unsafe-inline"))
    }
    func testDiffHeadersAreNotMistakenForAddedOrRemovedCode() {
        XCTAssertEqual(PresentationDiffLine.kind("+++ b/file.swift"), .header)
        XCTAssertEqual(PresentationDiffLine.kind("--- a/file.swift"), .header)
        XCTAssertEqual(PresentationDiffLine.kind("+let x = 2"), .addition)
        XCTAssertEqual(PresentationDiffLine.kind("-let x = 1"), .removal)
    }
    func testArtifactPreviewRejectsExecutableAndOversizedContent() {
        XCTAssertTrue(ArtifactPreviewPolicy.allowsInline(mediaType: "application/pdf", bytes: 8 * 1_024 * 1_024))
        XCTAssertFalse(ArtifactPreviewPolicy.allowsInline(mediaType: "application/pdf", bytes: 8 * 1_024 * 1_024 + 1))
        XCTAssertFalse(ArtifactPreviewPolicy.allowsInline(mediaType: "text/plain", bytes: 1_024 * 1_024 + 1))
        XCTAssertFalse(ArtifactPreviewPolicy.allowsInline(mediaType: "application/x-executable", bytes: 100))
        XCTAssertFalse(ArtifactPreviewPolicy.allowsInline(mediaType: "image/png", bytes: -1))
    }
    func testWorkingSetDecodesUnversionedPinsWithoutInventingRevision() throws {
        let raw = #"{"version":1,"projectId":"project-a","revision":0,"pins":[{"kind":"source","id":"passage-a"}],"goal":null,"updatedAt":null}"#
        let set = try JSONDecoder().decode(AssistantWorkingSet.self, from: Data(raw.utf8))
        XCTAssertNil(set.pins[0].revision)
        let encoded = try set.pins[0].assistantJSONObject()
        XCTAssertNil(encoded["revision"])
    }
    @MainActor
    func testStopSpeakingDoesNotDiscardIndependentDictationCapture() async {
        let transport = FixtureVoiceTransport()
        let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: transport, microphonePermission: { true })
        defer { voice.stopListening() }
        voice.captureMode = .dictation; voice.setCloudConsent(true)
        await voice.startListening()
        let context = voice.capturedContext
        voice.stopSpeaking()
        XCTAssertTrue(voice.dictationActive)
        XCTAssertEqual(voice.capturedContext, context)
        voice.speak("Background update", context: .init())
        XCTAssertTrue(voice.dictationActive)
        XCTAssertFalse(transport.frames.contains { $0.type == "speak" })
    }
    @MainActor
    func testContinuousTurnsReuseProviderPreflightButMuteRequiresFreshCheck() async {
        let transport = FixtureVoiceTransport()
        let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: transport, microphonePermission: { true }, now: { 10 })
        defer { voice.stopListening() }
        voice.continuousConnectionEnabled = true; voice.setCloudConsent(true)
        await voice.startListening()
        let first = transport.frames.last
        await voice.startListening()
        let second = transport.frames.last
        XCTAssertEqual(transport.statusCalls, 1)
        XCTAssertEqual(first?.sessionId, second?.sessionId)
        XCTAssertGreaterThan(second?.generation ?? 0, first?.generation ?? 0)
        voice.stopListening()
        await voice.startListening()
        XCTAssertEqual(transport.statusCalls, 2)
        XCTAssertNotEqual(transport.frames.last?.sessionId, second?.sessionId)
    }
    @MainActor
    func testConfirmationCaptureNeverStartsExtendedDictation() async {
        let transport = FixtureVoiceTransport()
        let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: transport, microphonePermission: { true })
        defer { voice.stopListening() }
        voice.captureMode = .dictation
        voice.setCloudConsent(true)
        await voice.startConfirmationListening()
        XCTAssertFalse(voice.dictationActive)
        XCTAssertEqual(transport.frames.last?.type, "start")
    }
}
