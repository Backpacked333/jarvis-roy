import XCTest
@testable import Jarvis

final class VoiceTransportHandsFreeTests: XCTestCase {
    func testSystemSpeechClassifierLoadsLocallyWithSupportedWindow() throws {
        let classifier = try VoiceLocalSpeechClassifier()
        defer { classifier.stop() }
        let result = try classifier.result()
        XCTAssertEqual(result.confidence, 0)
        XCTAssertEqual(result.end, 0)
    }
    private func context() -> HarnessVoiceContext {
        var value = HarnessVoiceContext(); value.roomId = "original-room"
        value.question = .init(questionId: "question", revision: 4, target: .node(roomId: "original-room", runId: "run", nodeId: "node", attemptId: "attempt"))
        return value
    }

    private func conversationContext(_ id: String = "original-conversation") -> HarnessVoiceContext {
        var value = HarnessVoiceContext(); value.conversationId = id
        return value
    }

    func testProviderDoneIsNotPlaybackDrained() throws {
        var drain = VoicePlaybackDrain()
        try drain.scheduled(960); try drain.scheduled(960); drain.end()
        XCTAssertFalse(drain.finished)
        try drain.played(960); XCTAssertFalse(drain.finished)
        try drain.played(960); XCTAssertTrue(drain.finished)
        XCTAssertThrowsError(try drain.played(960))
        XCTAssertThrowsError(try drain.scheduled(960))
    }

    func testExactAnswerContextRequiresRealDrainedAudioAndConsumesOnce() throws {
        var turn = VoiceHandsFreeTurn(); turn.begin(context: context(), generation: 8)
        var drain = VoicePlaybackDrain(); drain.end()
        XCTAssertNil(turn.answer(generation: 8, drain: drain))
        drain = VoicePlaybackDrain(); try drain.scheduled(960); drain.end()
        XCTAssertNil(turn.answer(generation: 8, drain: drain))
        try drain.played(960)
        XCTAssertNil(turn.answer(generation: 7, drain: drain))
        XCTAssertEqual(turn.answer(generation: 8, drain: drain), context())
        XCTAssertNil(turn.answer(generation: 8, drain: drain))
    }

    func testConversationAnswerRequiresExactNonemptyCapturedScopeAndConsumesOnce() throws {
        var drain = VoicePlaybackDrain(); try drain.scheduled(960); drain.end(); try drain.played(960)
        var roomOnly = HarnessVoiceContext(); roomOnly.roomId = "room-only"
        for unbound in [HarnessVoiceContext(), roomOnly, conversationContext(""), conversationContext("   ")] {
            var turn = VoiceHandsFreeTurn(); turn.begin(context: unbound, generation: 8)
            XCTAssertNil(turn.answer(generation: 8, drain: drain))
        }
        var turn = VoiceHandsFreeTurn(); var selected = conversationContext()
        turn.begin(context: selected, generation: 8)
        selected.conversationId = "changed-conversation"
        XCTAssertNil(turn.answer(generation: 9, drain: drain))
        XCTAssertEqual(turn.answer(generation: 8, drain: drain), conversationContext())
        XCTAssertNil(turn.answer(generation: 8, drain: drain))
    }

    func testPreRollIsBoundedEchoClearedGenerationBoundAndSingleUse() {
        var turn = VoiceHandsFreeTurn(); turn.begin(context: context(), generation: 4)
        turn.observe(Data(repeating: 1, count: 40_000), echo: false)
        XCTAssertEqual(turn.preRoll.bytes.count, 32_000)
        turn.observe(Data(repeating: 2, count: 960), echo: true)
        XCTAssertTrue(turn.preRoll.bytes.isEmpty)
        let speech = Data(repeating: 3, count: 2_000)
        turn.observe(speech, echo: false)
        XCTAssertNil(turn.interrupt(generation: 3, speech: true))
        XCTAssertNil(turn.interrupt(generation: 4, speech: false))
        let action = turn.interrupt(generation: 4, speech: true)
        XCTAssertEqual(action?.0, context()); XCTAssertEqual(action?.1, speech)
        XCTAssertNil(turn.interrupt(generation: 4, speech: true))
        turn.cancel(); XCTAssertTrue(turn.preRoll.bytes.isEmpty)
    }

    func testVADRequiresFreshConsecutiveClassificationAndRejectsEchoSilenceAndDuplicates() {
        var decision = VoiceSpeechDecision()
        XCTAssertFalse(decision.accept(confidence: 1, end: 1, capturedSeconds: 1, echo: true, level: 0.2))
        XCTAssertFalse(decision.accept(confidence: 1, end: 1.25, capturedSeconds: 1.25, echo: false, level: 0))
        XCTAssertFalse(decision.accept(confidence: 0.2, end: 1.5, capturedSeconds: 1.5, echo: false, level: 0.2))
        XCTAssertFalse(decision.accept(confidence: 0.95, end: 1.75, capturedSeconds: 1.75, echo: false, level: 0.2))
        XCTAssertFalse(decision.accept(confidence: 0.95, end: 1.75, capturedSeconds: 1.75, echo: false, level: 0.2))
        XCTAssertTrue(decision.accept(confidence: 0.95, end: 2, capturedSeconds: 2, echo: false, level: 0.2))
        XCTAssertFalse(decision.accept(confidence: 1, end: 2.25, capturedSeconds: 3, echo: false, level: 0.2))
        XCTAssertFalse(decision.accept(confidence: .nan, end: 3, capturedSeconds: 3, echo: false, level: 0.2))
    }

    func testResidualEchoVetoRejectsCorrelatedPlaybackNotIndependentPCMFixture() {
        func noise(seed: UInt64) -> Data {
            var seed = seed, data = Data()
            for _ in 0..<3_200 {
                seed = seed &* 6_364_136_223_846_793_005 &+ 1
                let value = UInt16(truncatingIfNeeded: seed >> 32)
                data.append(UInt8(truncatingIfNeeded: value)); data.append(UInt8(truncatingIfNeeded: value >> 8))
            }
            return data
        }
        let playback = noise(seed: 1)
        XCTAssertTrue(VoiceEchoVeto.matches(Data(playback.suffix(3_200)), reference: playback))
        XCTAssertFalse(VoiceEchoVeto.matches(noise(seed: 9), reference: playback))
    }

    @MainActor
    private func eventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<200 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("Condition did not become true", file: file, line: line)
    }

    @MainActor
    private func server(_ wire: HandsFreeWire, for frame: HarnessVoiceClientFrame, type: String, extra: [String: Any] = [:]) throws {
        var value: [String: Any] = ["version": 1, "sessionId": frame.sessionId, "generation": frame.generation, "type": type]
        value.merge(extra) { _, rhs in rhs }
        wire.onFrame?(try JSONDecoder().decode(HarnessVoiceServerFrame.self, from: JSONSerialization.data(withJSONObject: value)))
    }

    @MainActor
    func testOptInRequiresCloudConsentPermissionAndWorkingAECNoRawFallback() async {
        let audio = HandsFreeAudio(), wire = HandsFreeWire()
        let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: wire, microphonePermission: { true }, duplex: audio)
        await voice.setHandsFreeEnabled(true)
        XCTAssertFalse(voice.handsFreeEnabled); XCTAssertEqual(audio.starts, 0)
        voice.setCloudConsent(true); audio.unavailable = true
        await voice.setHandsFreeEnabled(true)
        XCTAssertFalse(voice.handsFreeEnabled); XCTAssertEqual(voice.state, .unavailable)
        XCTAssertEqual(wire.frames.count, 0)
        let absent = VoiceController(audioInputAvailable: { false }, audioOutputAvailable: { true }, transport: wire, microphonePermission: { XCTFail("No permission prompt without device"); return true }, duplex: audio)
        absent.setCloudConsent(true); await absent.setHandsFreeEnabled(true)
        XCTAssertFalse(absent.handsFreeEnabled)
        audio.unavailable = false; await voice.setHandsFreeEnabled(true)
        XCTAssertTrue(voice.handsFreeEnabled)
        XCTAssertFalse(voice.wakeWordEnabled)
        XCTAssertTrue(voice.wakeStatus.contains("microphone off"))
        XCTAssertTrue(voice.wakeStatus.contains("wake listening is off"))
        XCTAssertNil(voice.capturedContext)
        voice.stopListening()
    }

    @MainActor
    func testQuestionAutoAnswerWaitsForPlaybackDrainKeepsContextAndExpiresWithoutSubmission() async throws {
        var time = 1.0
        let audio = HandsFreeAudio(), wire = HandsFreeWire()
        let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: wire, microphonePermission: { true }, duplex: audio, now: { time })
        voice.setCloudConsent(true); await voice.setHandsFreeEnabled(true)
        voice.speak("Which file?", context: context())
        await eventually { wire.frames.contains(where: { $0.type == "speak" }) }
        let spoken = try XCTUnwrap(wire.frames.first)
        try server(wire, for: spoken, type: "audio", extra: ["pcm": Data(repeating: 1, count: 960).base64EncodedString(), "sampleRate": 24_000, "sequence": 0])
        try server(wire, for: spoken, type: "audio_end")
        try server(wire, for: spoken, type: "state", extra: ["state": "idle"])
        XCTAssertEqual(voice.state, .speaking)
        XCTAssertEqual(wire.frames.count, 1)
        voice.contextProvider = { var changed = HarnessVoiceContext(); changed.roomId = "other-room"; return changed }
        audio.completions[0]()
        let start = try XCTUnwrap(wire.frames.last)
        XCTAssertEqual(start.type, "start"); XCTAssertEqual(start.context, context())
        XCTAssertNotEqual(start.sessionId, spoken.sessionId); XCTAssertGreaterThan(start.generation, spoken.generation)
        try server(wire, for: start, type: "state", extra: ["state": "listening"])
        XCTAssertTrue(voice.isListening)
        time = 9.1
        await eventually { voice.state == .idle }
        XCTAssertFalse(wire.frames.contains(where: { $0.type == "commit" }))
        XCTAssertFalse(voice.isListening)
        voice.stopListening()
    }

    @MainActor
    func testAcousticInterruptPreservesPreRollAndIgnoresLatePlaybackAndProviderFrames() async throws {
        let audio = HandsFreeAudio(), wire = HandsFreeWire()
        let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: wire, microphonePermission: { true }, duplex: audio)
        voice.setCloudConsent(true); await voice.setHandsFreeEnabled(true)
        voice.speak("A bound question", context: context())
        await eventually { !wire.frames.isEmpty }
        let old = wire.frames[0]
        try server(wire, for: old, type: "audio", extra: ["pcm": "AAA=", "sampleRate": 24_000, "sequence": 0])
        audio.signals.append(.init(pcm: Data(repeating: 1, count: 2_000), speech: true, echo: true))
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(wire.frames.count, 1)
        let speech = Data(repeating: 32, count: 3_200)
        audio.signals.append(.init(pcm: speech, speech: true))
        await eventually { wire.frames.contains(where: { $0.type == "start" }) }
        let start = try XCTUnwrap(wire.frames.last)
        XCTAssertEqual(start.context, context()); XCTAssertGreaterThan(audio.interrupts, 0)
        audio.completions[0]()
        try server(wire, for: old, type: "audio_end")
        XCTAssertEqual(voice.state, .connecting)
        try server(wire, for: start, type: "state", extra: ["state": "listening"])
        await eventually { wire.frames.contains(where: { $0.type == "audio" }) }
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(wire.frames.first(where: { $0.type == "audio" })?.pcm)), speech)
        voice.stopListening()
        let count = wire.frames.count
        audio.signals.append(.init(pcm: speech, speech: true)); audio.completions[0]()
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(voice.handsFreeEnabled); XCTAssertEqual(wire.frames.count, count)
    }

    @MainActor
    func testMuteRevokesLateHandsFreePermissionAndAECFailureStopsRearm() async {
        let audio = HandsFreeAudio(), wire = HandsFreeWire()
        var continuation: CheckedContinuation<Bool, Never>?
        let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: wire,
                                    microphonePermission: { await withCheckedContinuation { continuation = $0 } }, duplex: audio)
        voice.setCloudConsent(true)
        let task = Task { await voice.setHandsFreeEnabled(true) }
        await eventually { continuation != nil }
        voice.stopListening(); continuation?.resume(returning: true); await task.value
        XCTAssertEqual(audio.starts, 0); XCTAssertFalse(voice.handsFreeEnabled)

        let active = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: wire, microphonePermission: { true }, duplex: audio)
        active.setCloudConsent(true); await active.setHandsFreeEnabled(true)
        active.speak("question", context: context())
        await eventually { !wire.frames.isEmpty }
        audio.unavailable = true
        await eventually { active.state == .unavailable }
        XCTAssertFalse(active.handsFreeEnabled); XCTAssertFalse(active.isListening)
    }

    @MainActor
    func testExplicitFinishStopsCaptureThenDrainsInOrderAndOnlyFinalDispatches() async throws {
        let audio = HandsFreeAudio(), wire = HandsFreeWire()
        let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: wire, microphonePermission: { true }, duplex: audio)
        var utterances: [HarnessVoiceUtterance] = []
        voice.onUtterance = { utterances.append($0) }
        voice.setCloudConsent(true); await voice.setHandsFreeEnabled(true)
        voice.speak("Question", context: context())
        await eventually { !wire.frames.isEmpty }
        let spoken = wire.frames[0]
        try server(wire, for: spoken, type: "audio", extra: ["pcm": "AAA=", "sampleRate": 24_000, "sequence": 0])
        let pcm = Data(repeating: 12, count: 24_000)
        audio.signals.append(.init(pcm: pcm, speech: true))
        await eventually { wire.frames.contains(where: { $0.type == "start" }) }
        let start = try XCTUnwrap(wire.frames.last)
        try server(wire, for: start, type: "state", extra: ["state": "listening"])
        let stopped = audio.stops
        voice.finishListening()
        XCTAssertGreaterThan(audio.stops, stopped)
        XCTAssertFalse(voice.isListening)
        audio.signals.append(.init(pcm: Data(repeating: 99, count: 3_200), speech: true))
        await eventually { wire.frames.contains(where: { $0.type == "commit" }) }
        XCTAssertEqual(wire.frames.filter { $0.type == "commit" }.count, 1)
        let transmitted = wire.frames.filter { $0.type == "audio" }.reduce(into: Data()) { data, frame in data.append(Data(base64Encoded: frame.pcm!)!) }
        XCTAssertEqual(transmitted, pcm)
        let encodedContext = try JSONSerialization.jsonObject(with: JSONEncoder().encode(context()))
        try server(wire, for: start, type: "transcript", extra: ["text": "ye-", "final": false, "context": encodedContext])
        XCTAssertTrue(utterances.isEmpty)
        try server(wire, for: start, type: "transcript", extra: ["text": "yes", "final": true, "context": encodedContext])
        XCTAssertEqual(utterances.count, 1); XCTAssertEqual(utterances.first?.context, context())
        XCTAssertEqual(utterances.first?.text, "yes")
        XCTAssertEqual(voice.state, .idle)
        voice.stopListening()
    }

    @MainActor
    func testUnboundNarrationNeverOpensAnAmbientAnswerWindow() async throws {
        let audio = HandsFreeAudio(), wire = HandsFreeWire()
        let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: wire, microphonePermission: { true }, duplex: audio)
        voice.setCloudConsent(true); await voice.setHandsFreeEnabled(true)
        voice.speak("An ordinary reply", context: .init())
        await eventually { !wire.frames.isEmpty }
        let spoken = wire.frames[0]
        try server(wire, for: spoken, type: "audio", extra: ["pcm": "AAA=", "sampleRate": 24_000, "sequence": 0])
        audio.completions[0]()
        XCTAssertTrue(voice.isSpeaking)
        try server(wire, for: spoken, type: "audio_end")
        XCTAssertEqual(voice.state, .idle)
        XCTAssertEqual(wire.frames.count, 1)
        XCTAssertFalse(voice.isListening)
        voice.stopListening()
    }

    @MainActor
    func testConversationWindowRetainsCaptureAcrossSelectionChangeAndSilenceOrMuteNeverDispatches() async throws {
        for mute in [false, true] {
            var time = 1.0
            let audio = HandsFreeAudio(), wire = HandsFreeWire()
            let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: wire, microphonePermission: { true }, duplex: audio, now: { time })
            var received: [HarnessVoiceUtterance] = []
            voice.onUtterance = { received.append($0) }
            voice.setCloudConsent(true); await voice.setHandsFreeEnabled(true)
            let captured = conversationContext()
            voice.speak("Continue this conversation?", context: captured)
            XCTAssertEqual(voice.capturedContext, captured)
            await eventually { !wire.frames.isEmpty }
            let spoken = wire.frames[0]
            voice.contextProvider = { self.conversationContext("other-conversation") }
            try server(wire, for: spoken, type: "audio", extra: ["pcm": "AAA=", "sampleRate": 24_000, "sequence": 0])
            try server(wire, for: spoken, type: "audio_end")
            XCTAssertEqual(wire.frames.count, 1)
            audio.completions[0]()
            let start = try XCTUnwrap(wire.frames.last)
            XCTAssertEqual(start.type, "start"); XCTAssertEqual(start.context, captured)
            XCTAssertEqual(voice.capturedContext, captured)
            try server(wire, for: start, type: "state", extra: ["state": "listening"])
            XCTAssertTrue(voice.isListening)
            if mute { voice.stopListening() } else { time = 9.1; await eventually { voice.state == .idle } }
            XCTAssertNil(voice.capturedContext); XCTAssertFalse(voice.isListening)
            XCTAssertFalse(wire.frames.contains(where: { $0.type == "commit" }))
            XCTAssertTrue(received.isEmpty)
            let count = wire.frames.count
            audio.completions[0]()
            try server(wire, for: start, type: "state", extra: ["state": "listening"])
            XCTAssertEqual(wire.frames.count, count)
            XCTAssertFalse(voice.isListening)
            voice.stopListening()
        }
    }

    @MainActor
    func testConversationFinalDispatchesOnlyWithExactCapturedContext() async throws {
        for wrongContext in [false, true] {
            let audio = HandsFreeAudio(), wire = HandsFreeWire()
            let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: wire, microphonePermission: { true }, duplex: audio)
            var received: [HarnessVoiceUtterance] = []
            voice.onUtterance = { received.append($0) }
            voice.setCloudConsent(true); await voice.setHandsFreeEnabled(true)
            let captured = conversationContext()
            voice.speak("A reply", context: captured)
            await eventually { !wire.frames.isEmpty }
            let spoken = wire.frames[0]
            try server(wire, for: spoken, type: "audio", extra: ["pcm": "AAA=", "sampleRate": 24_000, "sequence": 0])
            try server(wire, for: spoken, type: "audio_end")
            audio.completions[0]()
            let start = try XCTUnwrap(wire.frames.last)
            try server(wire, for: start, type: "state", extra: ["state": "listening"])
            audio.signals.append(.init(pcm: Data(repeating: 12, count: 9_600), speech: true))
            await eventually { wire.frames.filter { $0.type == "audio" }.count == 3 }
            voice.finishListening()
            await eventually { wire.frames.contains(where: { $0.type == "commit" }) }
            let sentContext = wrongContext ? conversationContext("wrong-conversation") : captured
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(sentContext))
            try server(wire, for: start, type: "transcript", extra: ["text": "Continue", "final": true, "context": encoded])
            if wrongContext {
                XCTAssertTrue(received.isEmpty); XCTAssertEqual(voice.state, .unavailable)
            } else {
                XCTAssertEqual(received.count, 1); XCTAssertEqual(received.first?.context, captured)
                XCTAssertEqual(voice.state, .idle)
            }
            XCTAssertNil(voice.capturedContext)
            voice.stopListening()
        }
    }

    @MainActor
    func testMuteDuringPlaybackPreventsConversationRearmFromLateCompletion() async throws {
        let audio = HandsFreeAudio(), wire = HandsFreeWire()
        let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: wire, microphonePermission: { true }, duplex: audio)
        voice.setCloudConsent(true); await voice.setHandsFreeEnabled(true)
        voice.speak("A reply", context: conversationContext())
        await eventually { !wire.frames.isEmpty }
        let spoken = wire.frames[0]
        try server(wire, for: spoken, type: "audio", extra: ["pcm": "AAA=", "sampleRate": 24_000, "sequence": 0])
        try server(wire, for: spoken, type: "audio_end")
        voice.stopListening()
        XCTAssertFalse(voice.handsFreeEnabled); XCTAssertNil(voice.capturedContext)
        audio.completions[0]()
        XCTAssertEqual(wire.frames.count, 1); XCTAssertEqual(voice.state, .idle)
    }
}

@MainActor
private final class HandsFreeAudio: VoiceDuplexAudioServing {
    var starts = 0, interrupts = 0, stops = 0
    var unavailable = false
    var signals: [VoiceDuplexSignal] = []
    var completions: [() -> Void] = []
    func start() throws { starts += 1; if unavailable { throw VoiceAcousticError.unavailable } }
    func poll() throws -> VoiceDuplexSignal {
        if unavailable { throw VoiceAcousticError.unavailable }
        return signals.isEmpty ? .init() : signals.removeFirst()
    }
    func play(_ data: Data, completed: @escaping () -> Void) throws { completions.append(completed) }
    func interruptPlayback() { interrupts += 1 }
    func stop() { stops += 1 }
}

@MainActor
private final class HandsFreeWire: VoiceSocketTransporting {
    var onFrame: ((HarnessVoiceServerFrame) -> Void)?
    var onFailure: ((String) -> Void)?
    var frames: [HarnessVoiceClientFrame] = []
    func status() async throws -> HarnessVoiceStatus { .init(version: 1, provider: "elevenlabs", model: "eleven_v4_turbo", recognitionModel: "scribe_v2_realtime", status: "configured") }
    func connect() throws {}
    func send(_ frame: HarnessVoiceClientFrame) throws { frames.append(frame) }
    func disconnect() {}
}
