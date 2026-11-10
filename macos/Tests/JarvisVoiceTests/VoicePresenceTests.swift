import Foundation
import XCTest
@testable import Jarvis

final class VoicePresenceTests: XCTestCase {
    func testLabelsAreHumanAndNeverImplyVoiceWithoutConsent() {
        for state in [HarnessVoiceState.connecting, .listening, .thinking, .speaking, .idle, .interrupted, .unavailable] {
            XCTAssertEqual(VoicePresence.label(state: state, consent: false), "Voice off")
            XCTAssertEqual(VoicePresence.symbol(state: state, consent: false), "mic.slash")
        }
        XCTAssertEqual(VoicePresence.label(state: .connecting, consent: true), "Connecting")
        XCTAssertEqual(VoicePresence.label(state: .listening, consent: true), "Listening")
        XCTAssertEqual(VoicePresence.label(state: .thinking, consent: true), "Thinking")
        XCTAssertEqual(VoicePresence.label(state: .speaking, consent: true), "Speaking")
        XCTAssertEqual(VoicePresence.label(state: .idle, consent: true), "Ready")
        XCTAssertEqual(VoicePresence.label(state: .interrupted, consent: true), "Paused")
        XCTAssertEqual(VoicePresence.label(state: .unavailable, consent: true), "Voice unavailable")
        XCTAssertEqual(VoicePresence.label(state: .idle, consent: true, dictationPaused: true), "Dictation paused")
    }

    func testMicrophoneAsksForConsentBeforeAnythingElse() {
        XCTAssertEqual(VoicePresence.micAction(consent: false, listening: false, dictationActive: false, speaking: false), .askConsent)
        XCTAssertEqual(VoicePresence.micAction(consent: false, listening: true, dictationActive: true, speaking: true), .askConsent)
        XCTAssertEqual(VoicePresence.micAction(consent: true, listening: false, dictationActive: false, speaking: false), .listen)
        XCTAssertEqual(VoicePresence.micAction(consent: true, listening: true, dictationActive: false, speaking: false), .finish)
        XCTAssertEqual(VoicePresence.micAction(consent: true, listening: false, dictationActive: true, speaking: false), .finish)
        XCTAssertEqual(VoicePresence.micAction(consent: true, listening: false, dictationActive: false, speaking: true), .interruptAndListen)
    }

    func testDisclosuresKeepTheirExactWording() {
        XCTAssertEqual(VoiceDisclosure.cloudTitle, "Allow ElevenLabs voice for this session?")
        XCTAssertEqual(VoiceDisclosure.cloudAllow, "Allow cloud voice")
        XCTAssertEqual(VoiceDisclosure.cloudMessage, "Active command microphone audio is uploaded to ElevenLabs Scribe, and spoken reply text goes to Eleven v4 Turbo. Provider charges apply. Never speak passwords or API keys. This permission resets when Jarvis quits; there is no fallback voice. Hands-free capture requires its own opt-in.")
        XCTAssertEqual(VoiceDisclosure.handsFreeTitle, "Enable hands-free conversation?")
        XCTAssertEqual(VoiceDisclosure.handsFreeAllow, "Enable hands-free")
        XCTAssertEqual(VoiceDisclosure.handsFreeMessage, "During replies, your microphone runs locally with echo cancellation and speech detection. Detected interruption starts a fresh ElevenLabs capture. After a reply or exact clarification finishes playing, a bounded cloud answer window opens automatically; silence closes it after eight seconds. Completed speech is submitted only to the captured conversation or question. Spoken yes never approves sensitive actions. Mute stops capture and disables hands-free. Wake listening is separate. Unsupported hardware fails closed.")
    }

    func testModelLabelShowsOnlyWhatTheServiceReported() {
        XCTAssertNil(VoicePresence.modelLabel(nil))
        XCTAssertNil(VoicePresence.modelLabel("  "))
        XCTAssertNil(VoicePresence.modelLabel(String(repeating: "m", count: 81)))
        XCTAssertEqual(VoicePresence.modelLabel(" eleven_v4_turbo "), "eleven_v4_turbo")
    }

    @MainActor
    func testReportedVoiceModelComesFromTheProviderStatus() async {
        let wire = FixtureVoiceTransport()
        wire.availability.model = "eleven_fixture_model"
        let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: wire, microphonePermission: { true })
        defer { voice.stopListening() }
        XCTAssertNil(voice.reportedVoiceModel, "Nothing is claimed before the service reports")
        voice.setCloudConsent(true)
        await voice.startListening()
        XCTAssertEqual(wire.statusCalls, 1)
        XCTAssertEqual(voice.reportedVoiceModel, "eleven_fixture_model")
    }

    @MainActor
    func testMicrophoneCannotCaptureBeforeConsent() async {
        let wire = FixtureVoiceTransport()
        let voice = VoiceController(audioInputAvailable: { true }, audioOutputAvailable: { true }, transport: wire, microphonePermission: { true })
        let model = AppModel(client: SnapshotRuntime(), voice: voice)
        defer { model.shutdown() }
        await model.startManualListening()
        XCTAssertFalse(voice.cloudConsentGranted)
        XCTAssertFalse(voice.isListening)
        XCTAssertEqual(wire.connections, 0)
        XCTAssertTrue(wire.frames.isEmpty)
        XCTAssertEqual(wire.statusCalls, 0)
    }
}
