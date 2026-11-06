import XCTest

@testable import Jarvis

final class WakeDetectionTests: XCTestCase {
    @MainActor
    func testMissingAudioInputFailsBeforePermissionsAndStaysMuted() async {
        let voice = VoiceController(audioInputAvailable: { false })
        for _ in 0..<2 {
            await voice.setWakeWordEnabled(true)
            XCTAssertFalse(voice.wakeWordEnabled)
            XCTAssertFalse(voice.isListening)
            XCTAssertFalse(voice.isRequestingPermission)
            XCTAssertTrue(voice.error?.contains("No usable microphone") == true)
            voice.stopListening()
            XCTAssertEqual(voice.wakeStatus, "Wake listening is off")
        }
    }

    @MainActor
    func testPushToTalkAlsoRejectsMissingInputWithoutStartingPermissionRequest() async {
        let voice = VoiceController(audioInputAvailable: { false })
        await voice.startListening()
        XCTAssertFalse(voice.isListening)
        XCTAssertFalse(voice.isRequestingPermission)
        XCTAssertFalse(voice.wakeWordEnabled)
        XCTAssertTrue(voice.error?.contains("Typing still works") == true)
    }

    func testWakePrefixAcceptsCasePunctuationAndWhitespace() {
        for phrase in [
            "Hey Jarvis, turn on the lights", "HEY, JARVIS! turn on the lights",
            "  “Hey—Jarvis”: turn on the lights  ", "hey\njarvis turn on the lights",
        ] {
            XCTAssertEqual(WakePhrase.command(in: phrase), "turn on the lights", phrase)
        }
    }

    func testWakePhraseAloneHasEmptySuffix() {
        XCTAssertEqual(WakePhrase.command(in: "Hey Jarvis!"), "")
        XCTAssertEqual(WakePhrase.command(in: "hey jarvis"), "")
    }

    func testPrefixRequiresWholeWords() {
        for phrase in [
            "HeyJarvis open notes", "Hey Jarvisian open notes", "Hey Jarvis2 open notes",
            "Hey Jarvis's notes", "Hey Jarvis’s notes", "Heyy Jarvis open notes",
            "Hey Jarvisé open notes", "hey jarvis_please",
        ] {
            XCTAssertNil(WakePhrase.command(in: phrase), phrase)
        }
    }

    func testIncidentalAndNonEnglishMentionsDoNotWake() {
        for phrase in [
            "I said hey Jarvis yesterday", "okay hey Jarvis open notes", "Jarvis open notes",
            "bonjour Jarvis", "hey, computer", "", "room conversation",
        ] {
            XCTAssertNil(WakePhrase.command(in: phrase), phrase)
        }
    }

    func testSuffixPreservesCommandCaseAndPunctuation() {
        XCTAssertEqual(WakePhrase.command(in: "Hey Jarvis, what is Roy’s schedule?"), "what is Roy’s schedule?")
        XCTAssertEqual(WakePhrase.command(in: "hey jarvis: find https://example.com/a?q=1"), "find https://example.com/a?q=1")
    }

    func testBackgroundTranscriptionIsNeverRetainedOrSubmitted() {
        var capture = WakeCapture()
        capture.receive("room conversation with private contents", at: 10)
        XCTAssertFalse(capture.isCapturing)
        XCTAssertEqual(capture.command, "")
        XCTAssertEqual(capture.poll(at: 100, lastVoiceAt: nil), .empty)
        XCTAssertNil(capture.finish())
    }

    func testWakeThenCommandUsesLatestHypothesis() {
        var capture = WakeCapture()
        capture.receive("Hey Jarvis", at: 10)
        XCTAssertTrue(capture.isCapturing)
        capture.receive("Hey Jarvis, open", at: 10.2)
        capture.receive("Hey Jarvis, open Notes", at: 10.7)
        XCTAssertEqual(capture.finish(), .command("open Notes"))
    }

    func testSilentSessionNeverStartsCapturing() {
        var capture = WakeCapture()
        XCTAssertNil(capture.poll(at: 100, lastVoiceAt: nil))
        XCTAssertFalse(capture.hasRecognizedSpeech)
        XCTAssertEqual(capture.finish(), .empty)
    }

    func testBackgroundSilenceAllowsNextUtteranceToWake() {
        var capture = WakeCapture()
        capture.receive("unrelated room conversation", at: 10)
        XCTAssertNil(capture.poll(at: 11, lastVoiceAt: 10))
        XCTAssertEqual(capture.poll(at: 11.5, lastVoiceAt: 10), .empty)
        capture = WakeCapture()
        capture.receive("Hey Jarvis, open Notes", at: 12)
        XCTAssertEqual(capture.finish(), .command("open Notes"))
    }

    func testPunctuationOnlyPostWakeContentDoesNotBecomeCommand() {
        var capture = WakeCapture()
        capture.receive("Hey Jarvis... !?", at: 10)
        XCTAssertEqual(capture.finish(), .empty)
    }

    func testFinalResultAfterTimeoutCannotSubmitAgain() {
        var capture = WakeCapture()
        capture.receive("Hey Jarvis, open Notes", at: 10)
        XCTAssertEqual(capture.poll(at: 30, lastVoiceAt: 30), .command("open Notes"))
        capture.receive("Hey Jarvis, open Notes and Mail", at: 31)
        XCTAssertNil(capture.finish())
        XCTAssertEqual(capture.command, "open Notes")
    }

    func testRepeatedPartialsDoNotExtendSilenceOrEmitTwice() {
        var capture = WakeCapture()
        capture.receive("Hey Jarvis, open Notes", at: 10)
        capture.receive("Hey Jarvis, open Notes", at: 11)
        XCTAssertEqual(capture.poll(at: 11.5, lastVoiceAt: nil), .command("open Notes"))
        XCTAssertNil(capture.finish())
        capture.receive("Hey Jarvis, open Notes", at: 12)
        XCTAssertNil(capture.poll(at: 20, lastVoiceAt: nil))
        XCTAssertFalse(capture.isCapturing)
    }

    func testAudioActivityDelaysSilenceEvenWithoutNewWords() {
        var capture = WakeCapture()
        capture.receive("Hey Jarvis, open Notes", at: 10)
        XCTAssertNil(capture.poll(at: 12, lastVoiceAt: 11.5))
        XCTAssertEqual(capture.poll(at: 13, lastVoiceAt: 11.5), .command("open Notes"))
    }

    func testOldAudioDoesNotOverrideTranscriptProgress() {
        var capture = WakeCapture()
        capture.receive("Hey Jarvis, open Notes", at: 10)
        XCTAssertNil(capture.poll(at: 11, lastVoiceAt: 1))
        XCTAssertEqual(capture.poll(at: 11.5, lastVoiceAt: 1), .command("open Notes"))
    }

    func testEmptyWakeReturnsToArmedWithoutCommandAfterGracePeriod() {
        var capture = WakeCapture()
        capture.receive("Hey Jarvis", at: 10)
        XCTAssertNil(capture.poll(at: 14.9, lastVoiceAt: nil))
        XCTAssertEqual(capture.poll(at: 15, lastVoiceAt: nil), .empty)
        XCTAssertNil(capture.finish())
    }

    func testCommandCanArriveDuringEmptyWakeGracePeriod() {
        var capture = WakeCapture()
        capture.receive("Hey Jarvis", at: 10)
        capture.receive("Hey Jarvis, open Notes", at: 14)
        XCTAssertNil(capture.poll(at: 15, lastVoiceAt: 14))
        XCTAssertEqual(capture.poll(at: 15.5, lastVoiceAt: 14), .command("open Notes"))
    }

    func testMaximumDurationBoundsContinuousSpeechAndNoise() {
        var capture = WakeCapture()
        capture.receive("Hey Jarvis, plan the week", at: 10)
        XCTAssertNil(capture.poll(at: 29.9, lastVoiceAt: 29.9))
        XCTAssertEqual(capture.poll(at: 30, lastVoiceAt: 30), .command("plan the week"))
        XCTAssertNil(capture.poll(at: 31, lastVoiceAt: 31))
    }

    func testRevisedHypothesisWithoutWakePrefixCannotSubmit() {
        var capture = WakeCapture()
        capture.receive("Hey Jarvis, open Notes", at: 10)
        capture.receive("they just opened notes", at: 10.5)
        XCTAssertEqual(capture.command, "")
        XCTAssertEqual(capture.finish(), .empty)
    }

    func testDistinctSessionsMaySubmitSameIntentAgain() {
        for _ in 0..<2 {
            var capture = WakeCapture()
            capture.receive("Hey Jarvis, what time is it?", at: 10)
            XCTAssertEqual(capture.finish(), .command("what time is it?"))
            XCTAssertNil(capture.finish())
        }
    }

    func testInitialLaunchAlwaysStartsMuted() {
        let gate = WakeSessionGate()
        XCTAssertFalse(gate.wakeEnabled)
        XCTAssertEqual(gate.purpose, .idle)
        XCTAssertFalse(gate.canRestart(gate.generation))
    }

    func testMuteInvalidatesPendingSpeechOrMicrophoneAuthorization() {
        var gate = WakeSessionGate()
        gate.enableWake()
        let pendingAuthorization = gate.begin(.wake)
        gate.mute()
        XCTAssertFalse(gate.accepts(pendingAuthorization))
        XCTAssertFalse(gate.wakeEnabled)
        XCTAssertEqual(gate.purpose, .idle)
    }

    func testMuteInvalidatesQueuedRetryAndSpeechCompletionRearm() {
        var gate = WakeSessionGate()
        gate.enableWake()
        gate.begin(.wake)
        let queuedRestart = gate.begin(.idle)
        XCTAssertTrue(gate.canRestart(queuedRestart))
        gate.mute()
        XCTAssertFalse(gate.canRestart(queuedRestart))
        XCTAssertFalse(gate.canRestart(gate.generation))
    }

    func testMuteInvalidatesPendingPushToTalkAuthorization() {
        var gate = WakeSessionGate()
        let pendingAuthorization = gate.begin(.pushToTalk)
        gate.mute()
        XCTAssertFalse(gate.accepts(pendingAuthorization))
        XCTAssertFalse(gate.wakeEnabled)
    }

    func testNewSessionInvalidatesOldRecognitionAndRetryCallbacks() {
        var gate = WakeSessionGate()
        gate.enableWake()
        let oldRecognition = gate.begin(.wake)
        let oldRetry = gate.begin(.idle)
        let newRecognition = gate.begin(.wake)
        XCTAssertFalse(gate.accepts(oldRecognition))
        XCTAssertFalse(gate.canRestart(oldRetry))
        XCTAssertTrue(gate.accepts(newRecognition))
    }

    func testOffOnToggleCannotRevivePreviousCallbacks() {
        var gate = WakeSessionGate()
        gate.enableWake()
        let old = gate.begin(.wake)
        gate.mute()
        gate.enableWake()
        let current = gate.begin(.wake)
        XCTAssertFalse(gate.accepts(old))
        XCTAssertTrue(gate.accepts(current))
    }

    func testSpeechPauseInvalidatesRecognitionButPreservesOptIn() {
        var gate = WakeSessionGate()
        gate.enableWake()
        let recognition = gate.begin(.wake)
        let paused = gate.begin(.idle)
        XCTAssertFalse(gate.accepts(recognition))
        XCTAssertTrue(gate.wakeEnabled)
        XCTAssertTrue(gate.canRestart(paused))
    }

    func testPushToTalkSupersedesWakeWithoutAllowingQueuedRestart() {
        var gate = WakeSessionGate()
        gate.enableWake()
        let restart = gate.begin(.idle)
        let manual = gate.begin(.pushToTalk)
        XCTAssertFalse(gate.canRestart(restart))
        XCTAssertFalse(gate.canRestart(manual))
        XCTAssertTrue(gate.wakeEnabled)
        let resumed = gate.begin(.idle)
        XCTAssertTrue(gate.canRestart(resumed))
    }

    func testRetryBackoffStopsAfterFiveFailures() {
        var retry = WakeRetryPolicy()
        XCTAssertEqual(retry.nextDelay(), 0.5)
        XCTAssertEqual(retry.nextDelay(), 1)
        XCTAssertEqual(retry.nextDelay(), 2)
        XCTAssertEqual(retry.nextDelay(), 4)
        XCTAssertNil(retry.nextDelay())
        XCTAssertNil(retry.nextDelay())
        retry.reset()
        XCTAssertEqual(retry.nextDelay(), 0.5)
    }

    func testAudioEnergyMeterIgnoresSilenceAndQuietNoise() {
        let activity = WakeAudioActivity()
        [Float](repeating: 0, count: 100).withUnsafeBufferPointer { activity.observe($0, at: 1) }
        [Float](repeating: 0.001, count: 100).withUnsafeBufferPointer { activity.observe($0, at: 2) }
        XCTAssertNil(activity.lastVoiceAt)
        [Float](repeating: -0.02, count: 100).withUnsafeBufferPointer { activity.observe($0, at: 3) }
        XCTAssertEqual(activity.lastVoiceAt, 3)
        [Float](repeating: 0, count: 100).withUnsafeBufferPointer { activity.observe($0, at: 4) }
        XCTAssertEqual(activity.lastVoiceAt, 3)
    }

    func testAudioEnergyMeterHandlesEmptyAndInterleavedBuffers() {
        let activity = WakeAudioActivity()
        [Float]().withUnsafeBufferPointer { activity.observe($0, at: 1) }
        [Float]([0, 1, 0, 1]).withUnsafeBufferPointer { activity.observe($0, stride: 2, at: 2) }
        XCTAssertNil(activity.lastVoiceAt)
        [Float]([0.1, 0, -0.1, 0]).withUnsafeBufferPointer { activity.observe($0, stride: 2, at: 3) }
        XCTAssertEqual(activity.lastVoiceAt, 3)
    }
}
