import AVFoundation
import JarvisAudioSafety
import Speech
import SwiftUI

@MainActor
final class VoiceController: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published var isListening = false
    @Published var isSpeaking = false
    @Published var isRequestingPermission = false
    @Published var transcript = ""
    @Published var error: String?
    @Published private(set) var wakeWordEnabled = false
    @Published private(set) var wakeStatus = "Wake listening is off"
    @Published private(set) var isCapturingCommand = false

    var onCommand: ((String) -> Void)?

    private let engine = AVAudioEngine()
    private let audioInputAvailable: () -> Bool
    private let synthesizer = AVSpeechSynthesizer()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var hasTap = false
    private var gate = WakeSessionGate()
    private var retry = WakeRetryPolicy()
    private var capture = WakeCapture()
    private var sessionStartedAt: TimeInterval = 0
    private var monitorTask: Task<Void, Never>?
    private var restartTask: Task<Void, Never>?
    private var startupTask: Task<Void, Never>?
    private var speechAuthorization: Task<Bool, Never>?
    private var microphoneAuthorization: Task<Bool, Never>?
    private var spokenUtterance: AVSpeechUtterance?

    init(audioInputAvailable: @escaping () -> Bool = { JarvisHasAudioInput() }) {
        self.audioInputAvailable = audioInputAvailable
        super.init()
        synthesizer.delegate = self
    }

    func setWakeWordEnabled(_ enabled: Bool) async {
        guard enabled else {
            stopListening()
            return
        }
        guard !Task.isCancelled else { return }
        guard !gate.wakeEnabled else { return }
        suspendCapture()
        gate.enableWake()
        wakeWordEnabled = true
        retry.reset()
        error = nil
        if isSpeaking {
            wakeStatus = "Paused while Jarvis speaks"
            return
        }
        await beginSession(.wake)
    }

    func startListening() async {
        guard !Task.isCancelled else { return }
        guard gate.purpose != .pushToTalk else { return }
        cancelSpeech()
        suspendCapture()
        error = nil
        transcript = ""
        if gate.wakeEnabled { wakeStatus = "Paused for push-to-talk" }
        await beginSession(.pushToTalk)
    }

    // Full mute: no permission result, audio callback, or queued restart can rearm it.
    func stopListening() {
        gate.mute()
        suspendCapture()
        wakeWordEnabled = false
        wakeStatus = "Wake listening is off"
        retry.reset()
    }

    private func beginSession(_ purpose: WakeSessionGate.Purpose) async {
        guard !Task.isCancelled, !isSpeaking else { return }
        if purpose == .wake { guard gate.wakeEnabled else { return } }
        guard audioInputAvailable() else {
            fail("No usable microphone was found. Connect an input device in System Settings → Sound, then explicitly enable listening again. Typing still works.")
            return
        }
        let ticket = gate.begin(purpose)
        if purpose == .wake { wakeStatus = "Checking on-device speech access…" }
        let task = Task { [weak self] in
            guard let self, await self.authorize(ticket), self.isCurrent(ticket) else { return }
            self.startAudio(purpose, ticket: ticket)
        }
        startupTask = task
        await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        if gate.accepts(ticket) {
            startupTask = nil
            if task.isCancelled {
                stopListening()
            }
        }
    }

    private func authorize(_ ticket: UInt64) async -> Bool {
        guard isCurrent(ticket) else { return false }
        isRequestingPermission = true
        defer {
            if gate.accepts(ticket) { isRequestingPermission = false }
        }
        let speechAllowed: Bool
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            // Coalesce OS prompts across rapid off/on toggles without reviving old requests.
            if speechAuthorization == nil {
                speechAuthorization = Task {
                    await withCheckedContinuation { continuation in
                        SFSpeechRecognizer.requestAuthorization {
                            continuation.resume(returning: $0 == .authorized)
                        }
                    }
                }
            }
            speechAllowed = await speechAuthorization!.value
        } else {
            speechAllowed = SFSpeechRecognizer.authorizationStatus() == .authorized
        }
        guard isCurrent(ticket) else { return false }
        speechAuthorization = nil
        guard speechAllowed else {
            fail(
                "Speech recognition permission is off. Enable Jarvis in System Settings → Privacy & Security → Speech Recognition. Typing still works."
            )
            return false
        }

        let microphoneAllowed: Bool
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            if microphoneAuthorization == nil {
                microphoneAuthorization = Task { await AVCaptureDevice.requestAccess(for: .audio) }
            }
            microphoneAllowed = await microphoneAuthorization!.value
        } else {
            microphoneAllowed = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        }
        guard isCurrent(ticket) else { return false }
        microphoneAuthorization = nil
        guard microphoneAllowed else {
            fail("Microphone permission is off. Enable Jarvis in System Settings → Privacy & Security → Microphone. Typing still works.")
            return false
        }
        return true
    }

    private func startAudio(_ purpose: WakeSessionGate.Purpose, ticket: UInt64) {
        guard isCurrent(ticket), !isListening, !hasTap else { return }
        guard audioInputAvailable() else {
            fail("The microphone became unavailable. Reconnect an input device and try again. Typing still works.")
            return
        }
        let locale = purpose == .wake ? Locale(identifier: "en-US") : .current
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable,
            recognizer.supportsOnDeviceRecognition
        else {
            let language = purpose == .wake ? "English (US)" : "your current language"
            fail(
                "On-device speech recognition is unavailable for \(language). Enable the language's on-device speech support in macOS, then try again, or use text input. Jarvis does not fall back to cloud recognition."
            )
            return
        }
        self.recognizer = recognizer
        capture = WakeCapture()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = purpose == .wake ? .unspecified : .dictation
        self.request = request
        let activity = WakeAudioActivity()
        let tap: @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void = { buffer, _ in
            request.append(buffer)
            if let channel = buffer.floatChannelData?[0] {
                let stride = buffer.stride
                let samples = UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength) * stride)
                activity.observe(samples, stride: stride, at: ProcessInfo.processInfo.systemUptime)
            }
        }
        let installed = JarvisInstallInputTap(engine, tap)
        guard installed else {
            fail("The microphone's hardware format is unavailable or changed. Check System Settings → Sound and try again. Typing still works.")
            return
        }
        hasTap = true
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, failure in
            // Only copy value data across the framework callback's executor.
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failureCode = (failure as NSError?)?.code
            Task { @MainActor [weak self] in
                guard let self, self.isCurrent(ticket) else { return }
                if let failureCode {
                    self.recognitionFailed(code: failureCode, purpose: purpose)
                    return
                }
                if let text { self.received(text, isFinal: isFinal, purpose: purpose) }
            }
        }
        if JarvisStartAudioEngine(engine) {
            sessionStartedAt = ProcessInfo.processInfo.systemUptime
            isListening = true
            error = nil
            if purpose == .wake { wakeStatus = "Armed · say “Hey Jarvis” · on-device English" }
            monitorTask = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .milliseconds(150)) } catch { return }
                    guard let self, self.isCurrent(ticket) else { return }
                    self.poll(purpose, activity: activity)
                }
            }
        } else {
            fail(
                "Could not start the microphone. Check the selected input in System Settings → Sound, close other microphone apps, then try again. Typing still works."
            )
        }
    }

    private func received(_ text: String, isFinal: Bool, purpose: WakeSessionGate.Purpose) {
        if purpose == .pushToTalk {
            transcript = text
            if isFinal { finishPushToTalk() }
            return
        }
        guard purpose == .wake else { return }
        capture.receive(text, at: ProcessInfo.processInfo.systemUptime)
        isCapturingCommand = capture.isCapturing
        if isCapturingCommand { wakeStatus = "Listening for your command…" }
        if isFinal {
            let hadSpeech = capture.hasRecognizedSpeech
            let completion = capture.finish()
            // Rapid unsolicited finals count toward the bounded recovery budget.
            if !hadSpeech && ProcessInfo.processInfo.systemUptime - sessionStartedAt < 10 {
                recognitionFailed(code: nil, purpose: purpose)
            } else {
                completeWake(completion)
            }
        }
    }

    private func poll(_ purpose: WakeSessionGate.Purpose, activity: WakeAudioActivity) {
        let now = ProcessInfo.processInfo.systemUptime
        if purpose == .pushToTalk {
            if now - sessionStartedAt >= 55 { finishPushToTalk() }
            return
        }
        if let completion = capture.poll(at: now, lastVoiceAt: activity.lastVoiceAt) {
            completeWake(completion)
        } else if now - sessionStartedAt >= 45 {
            // Rotate before Apple's duration cap, including a command begun near the boundary.
            completeWake(capture.finish())
        }
    }

    private func completeWake(_ completion: WakeCapture.Completion?) {
        guard let completion else { return }
        retry.reset()
        scheduleWakeRestart(after: 0.25, status: "Rearming on-device listening…")
        if case .command(let command) = completion {
            let ticket = gate.generation
            transcript = command
            guard gate.canRestart(ticket) else { return }
            onCommand?(command)
        }
    }

    private func finishPushToTalk() {
        suspendCapture()
        if gate.wakeEnabled { scheduleWakeRestart(after: 0.25, status: "Rearming on-device listening…") }
    }

    private func recognitionFailed(code: Int?, purpose: WakeSessionGate.Purpose) {
        let detail = code.map { " (code \($0))" } ?? ""
        guard purpose == .wake else {
            fail("On-device recognition stopped\(detail). Try the microphone again or use text input.")
            return
        }
        guard let delay = retry.nextDelay() else {
            fail(
                "Wake listening stopped after \(retry.maximumFailures) repeated recognition failures\(detail). Check microphone and on-device English speech support, then explicitly turn wake listening on again. Typing still works."
            )
            return
        }
        error = "On-device recognition interrupted\(detail); retry \(retry.failures)/\(retry.maximumFailures - 1). No audio is uploaded."
        scheduleWakeRestart(after: delay, status: "Recognition interrupted · retrying in \(delay)s")
    }

    private func scheduleWakeRestart(after delay: TimeInterval, status: String) {
        suspendCapture()
        guard gate.wakeEnabled else { return }
        guard !isSpeaking else {
            wakeStatus = "Paused while Jarvis speaks"
            return
        }
        wakeStatus = status
        let ticket = gate.generation
        restartTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self, self.gate.canRestart(ticket), !self.isSpeaking, !Task.isCancelled else { return }
            self.restartTask = nil
            await self.beginSession(.wake)
        }
    }

    private func suspendCapture() {
        gate.begin(.idle)
        startupTask?.cancel()
        startupTask = nil
        restartTask?.cancel()
        restartTask = nil
        monitorTask?.cancel()
        monitorTask = nil
        JarvisStopAudioEngine(engine, hasTap)
        hasTap = false
        request?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        request = nil
        recognizer = nil
        capture = WakeCapture()
        isListening = false
        isCapturingCommand = false
        isRequestingPermission = false
    }

    private func isCurrent(_ ticket: UInt64) -> Bool {
        gate.accepts(ticket) && !Task.isCancelled
    }

    private func fail(_ message: String) {
        stopListening()
        error = message
        wakeStatus = "Unavailable · \(message)"
    }

    func speak(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            gate.purpose != .pushToTalk, !isCapturingCommand
        else { return }
        suspendCapture()
        cancelSpeech()
        let utterance = AVSpeechUtterance(string: String(text.prefix(2400)))
        utterance.voice = AVSpeechSynthesisVoice(language: "en-GB")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        spokenUtterance = utterance
        isSpeaking = true
        if gate.wakeEnabled { wakeStatus = "Paused while Jarvis speaks" }
        synthesizer.speak(utterance)
    }

    func stopSpeaking() {
        let wasSpeaking = isSpeaking
        cancelSpeech()
        if wasSpeaking, gate.wakeEnabled, gate.purpose == .idle {
            scheduleWakeRestart(after: 0.35, status: "Rearming after speech…")
        }
    }

    private func cancelSpeech() {
        spokenUtterance = nil
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
    }

    private func speechEnded(_ utterance: AVSpeechUtterance) {
        guard spokenUtterance === utterance else { return }
        spokenUtterance = nil
        isSpeaking = false
        if gate.wakeEnabled { scheduleWakeRestart(after: 0.35, status: "Rearming after speech…") }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in self?.speechEnded(utterance) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in self?.speechEnded(utterance) }
    }
}
