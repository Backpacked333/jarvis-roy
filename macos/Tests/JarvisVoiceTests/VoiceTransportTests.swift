import XCTest
import AVFoundation
import JarvisAudioSafety

@testable import Jarvis

final class VoiceTransportTests: XCTestCase {
    private func frame(_ state: VoiceTurnState, type: String, extra: [String: Any] = [:]) throws -> HarnessVoiceServerFrame {
        var value: [String: Any] = ["version": 1, "sessionId": state.sessionId, "generation": state.generation, "type": type]
        value.merge(extra) { _, rhs in rhs }
        return try JSONDecoder().decode(HarnessVoiceServerFrame.self, from: JSONSerialization.data(withJSONObject: value))
    }
    private func contextObject(_ context: HarnessVoiceContext) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(context)) as? [String: Any])
    }

    func testPCM16UsesLittleEndianSignedSamplesAndRealRMS() throws {
        let data = Data([0, 0, 0, 64, 0, 192, 0, 128])
        XCTAssertEqual(try VoicePCM.decode(data.base64EncodedString()), data)
        XCTAssertEqual(VoicePCM.rms(data), sqrt(1.5 / 4), accuracy: 0.00001)
        for pcm in ["", "a===", "AA==", "AA A=", Data(repeating: 0, count: 16_002).base64EncodedString()] {
            XCTAssertThrowsError(try VoicePCM.decode(pcm))
        }
    }

    func testAudioSequenceRejectsGapDuplicateAndWrongFormat() throws {
        var state = VoiceTurnState()
        state.begin(.playback, context: .init())
        let audio = Data([0, 1, 0, 2]).base64EncodedString()
        let good = try frame(state, type: "audio", extra: ["pcm": audio, "sampleRate": 24_000, "sequence": 0])
        XCTAssertNotNil(try state.audio(good))
        XCTAssertThrowsError(try state.audio(good))
        XCTAssertThrowsError(try state.audio(frame(state, type: "audio", extra: ["pcm": audio, "sampleRate": 24_000, "sequence": 2])))
        XCTAssertThrowsError(try state.audio(frame(state, type: "audio", extra: ["pcm": audio, "sampleRate": 16_000, "sequence": 1])))
        try state.endAudio()
        XCTAssertThrowsError(try state.audio(frame(state, type: "audio", extra: ["pcm": audio, "sampleRate": 24_000, "sequence": 1])))
    }

    func testInterruptReconnectAndStopDiscardOldGenerationAndSession() throws {
        var state = VoiceTurnState()
        let prior = state.begin(.playback, context: .init())
        let oldFrame = try frame(state, type: "audio", extra: ["pcm": "AAA=", "sampleRate": 24_000, "sequence": 0])
        state.invalidate()
        XCTAssertFalse(state.current(prior))
        XCTAssertNil(try state.audio(oldFrame))
        let oldSession = state.sessionId
        state.begin(.capture, context: .init())
        XCTAssertNotEqual(state.sessionId, oldSession)
        XCTAssertFalse(state.accepts(oldFrame))
        XCTAssertFalse(state.committed)
    }

    func testCommittedTranscriptKeepsExactQuestionAndRoomAndEmitsOnce() throws {
        var context = HarnessVoiceContext()
        context.roomId = "room-a"
        context.question = .init(questionId: "question-a", revision: 2, target: .node(roomId: "room-a", runId: "run-a", nodeId: "node-a", attemptId: "attempt-a"))
        var state = VoiceTurnState()
        state.begin(.capture, context: context)
        let partial = try frame(state, type: "transcript", extra: ["text": "yes", "final": false, "context": contextObject(context)])
        XCTAssertNil(try state.transcript(partial))
        let final = try frame(state, type: "transcript", extra: ["text": "yes", "final": true, "context": contextObject(context)])
        XCTAssertThrowsError(try state.transcript(final))
        try state.commit()
        let utterance = try XCTUnwrap(state.transcript(final))
        XCTAssertEqual(utterance.context, context)
        XCTAssertEqual(utterance.context.question?.questionId, "question-a")
        XCTAssertThrowsError(try state.transcript(final))
    }

    func testCrossRoomTranscriptIsNotRetargeted() throws {
        var state = VoiceTurnState()
        var context = HarnessVoiceContext(); context.roomId = "room-a"
        state.begin(.capture, context: context)
        try state.commit()
        context.roomId = "room-b"
        XCTAssertThrowsError(try state.transcript(frame(state, type: "transcript", extra: ["text": "yes", "final": true, "context": contextObject(context)])))
    }

    func testAudioMailboxBoundsMemoryAndSignalsDeviceConversionFailure() throws {
        let mailbox = VoiceInputMailbox()
        mailbox.offer(Data(repeating: 64, count: 32_000), at: 10)
        XCTAssertEqual(mailbox.pendingBytes, 32_000)
        let (chunk, rms, activity) = try mailbox.drain()
        XCTAssertEqual(chunk.count, 3_200)
        XCTAssertGreaterThan(rms, 0)
        XCTAssertEqual(activity, 10)
        mailbox.offer(Data(repeating: 64, count: 3_202), at: 11)
        XCTAssertThrowsError(try mailbox.drain())
        let failed = VoiceInputMailbox()
        failed.offer(nil, at: 0)
        XCTAssertThrowsError(try failed.drain())
    }

    func testOutputMeterUsesSamplesAndFallsToZeroWithoutRenderedAudio() {
        let meter = VoiceOutputMeter()
        [Float]([0.5, -0.5]).withUnsafeBufferPointer { meter.observe($0, stride: 1, at: 1) }
        XCTAssertEqual(meter.read(at: 1.1), 0.5, accuracy: 0.001)
        XCTAssertEqual(meter.read(at: 1.3), 0)
    }

    func testRealConverterDownmixesStereo48kToMono16kPCMAndRejectsFormatChanges() throws {
        let converter = JarvisPCMConverter()
        let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: false))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4_800))
        buffer.frameLength = 4_800
        for channel in 0..<2 { for index in 0..<4_800 { buffer.floatChannelData![channel][index] = 0.1 } }
        let converted = converter.convert(buffer)
        let pcm = try XCTUnwrap(converted, "PCM conversion failed with code \(converter.failureCode)")
        XCTAssertGreaterThan(pcm.count, 0)
        XCTAssertLessThanOrEqual(pcm.count, 3_264)
        XCTAssertEqual(pcm.count % 2, 0)
        XCTAssertGreaterThan(VoicePCM.rms(pcm), 0.01)
        let changed = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44_100, channels: 1, interleaved: false))
        let changedBuffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: changed, frameCapacity: 1_024))
        changedBuffer.frameLength = 1_024
        XCTAssertNil(converter.convert(changedBuffer))
    }

    @MainActor
    func testConsentAndNoKeyFailBeforeMicrophonePermissionsOrSocketConnect() async {
        let fake = FixtureVoiceTransport()
        var permissions = 0
        let voice = VoiceController(audioInputAvailable: { true }, transport: fake, microphonePermission: { permissions += 1; return true })
        await voice.startListening()
        XCTAssertEqual(fake.connections, 0)
        XCTAssertEqual(fake.statusCalls, 0)
        XCTAssertEqual(permissions, 0)
        XCTAssertEqual(voice.state, .unavailable)
        voice.setCloudConsent(true)
        fake.availability.status = "unavailable"
        fake.availability.reason = "No ElevenLabs key configured"
        await voice.startListening()
        XCTAssertEqual(permissions, 0)
        XCTAssertEqual(fake.connections, 0)
        XCTAssertTrue(voice.error?.contains("No ElevenLabs key") == true)
    }

    @MainActor
    func testCaptureContextIsFrozenBeforeAsyncStatusAndRoomSwitch() async throws {
        let fake = FixtureVoiceTransport()
        var continuation: CheckedContinuation<HarnessVoiceStatus, Never>?
        fake.statusHandler = { await withCheckedContinuation { continuation = $0 } }
        let voice = VoiceController(audioInputAvailable: { true }, transport: fake, microphonePermission: { true })
        voice.setCloudConsent(true)
        var selected = HarnessVoiceContext(); selected.roomId = "room-a"
        voice.contextProvider = { selected }
        let task = Task { await voice.startListening() }
        while continuation == nil { await Task.yield() }
        selected.roomId = "room-b"
        continuation?.resume(returning: fake.availability)
        await task.value
        XCTAssertEqual(fake.frames.first?.context?.roomId, "room-a")
        XCTAssertEqual(fake.frames.first?.cloudConsent, true)
        voice.stopListening()
    }

    @MainActor
    func testMuteInvalidatesLatePermissionResultAndRequiresNewExplicitTurn() async {
        let fake = FixtureVoiceTransport()
        var continuation: CheckedContinuation<Bool, Never>?
        let voice = VoiceController(audioInputAvailable: { true }, transport: fake, microphonePermission: { await withCheckedContinuation { continuation = $0 } })
        voice.setCloudConsent(true)
        let task = Task { await voice.startListening() }
        while continuation == nil { await Task.yield() }
        voice.stopListening()
        continuation?.resume(returning: true)
        await task.value
        XCTAssertFalse(voice.isListening)
        XCTAssertFalse(voice.isRequestingPermission)
        XCTAssertEqual(fake.connections, 0)
        XCTAssertEqual(voice.state, .idle)
    }

    @MainActor
    func testDeviceLossAndProviderFailureNeverStartFallbackOrReplay() async {
        let fake = FixtureVoiceTransport()
        var device = true
        let voice = VoiceController(audioInputAvailable: { device }, transport: fake, microphonePermission: { true })
        voice.setCloudConsent(true)
        await voice.startListening()
        XCTAssertEqual(fake.connections, 1)
        device = false
        let start = fake.frames[0]
        let message = """
        {"version":1,"sessionId":"\(start.sessionId)","generation":\(start.generation),"type":"state","state":"listening","detail":null}
        """
        fake.onFrame?(try! JSONDecoder().decode(HarnessVoiceServerFrame.self, from: Data(message.utf8)))
        XCTAssertEqual(voice.state, .unavailable)
        XCTAssertFalse(voice.isListening)
        XCTAssertEqual(fake.connections, 1)
        XCTAssertFalse(voice.wakeWordEnabled)
        fake.onFailure?("Provider disconnected")
        XCTAssertEqual(fake.connections, 1)
        voice.stopListening()
    }

    @MainActor
    func testMissingOutputAndConsentRevocationDrainPlaybackWithoutAppleTTS() {
        let fake = FixtureVoiceTransport()
        let voice = VoiceController(audioOutputAvailable: { false }, transport: fake)
        voice.setCloudConsent(true)
        voice.speak("A fixture response", context: .init())
        XCTAssertEqual(voice.state, .unavailable)
        XCTAssertFalse(voice.isSpeaking)
        XCTAssertEqual(fake.connections, 0)
        voice.setCloudConsent(false)
        XCTAssertEqual(voice.state, .idle)
        XCTAssertFalse(voice.cloudConsentGranted)
    }

    @MainActor
    func testLocalSocketRequiresLaunchToken() {
        let transport = VoiceSocketTransport(token: "")
        XCTAssertThrowsError(try transport.connect())
        transport.disconnect()
    }
}

@MainActor
final class FixtureVoiceTransport: VoiceSocketTransporting {
    var onFrame: ((HarnessVoiceServerFrame) -> Void)?
    var onFailure: ((String) -> Void)?
    var availability = HarnessVoiceStatus(version: 1, provider: "elevenlabs", model: "eleven_v4_turbo", recognitionModel: "scribe_v2_realtime", status: "configured")
    var statusHandler: (() async -> HarnessVoiceStatus)?
    var frames: [HarnessVoiceClientFrame] = []
    var connections = 0
    var disconnections = 0
    var statusCalls = 0
    func status() async throws -> HarnessVoiceStatus { statusCalls += 1; return await statusHandler?() ?? availability }
    func connect() throws { connections += 1 }
    func send(_ frame: HarnessVoiceClientFrame) throws { frames.append(frame) }
    func disconnect() { disconnections += 1 }
}
