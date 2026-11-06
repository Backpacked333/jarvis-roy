import AVFoundation
import JarvisAudioSafety
import Speech
import SwiftUI

@MainActor
final class VoiceController: NSObject, ObservableObject, HarnessVoiceControlling {
    @Published private(set) var isListening = false
    @Published private(set) var isSpeaking = false
    @Published private(set) var isRequestingPermission = false
    @Published var transcript = ""
    @Published private(set) var error: String?
    @Published private(set) var wakeWordEnabled = false
    @Published private(set) var wakeStatus = "Wake listening is off"
    @Published private(set) var isCapturingCommand = false
    @Published private(set) var cloudConsentGranted = false
    @Published private(set) var state: HarnessVoiceState = .idle

    var onCommand: ((String) -> Void)?
    var onUtterance: ((HarnessVoiceUtterance) -> Void)?
    var onAudioLevels: ((HarnessAudioLevels) -> Void)?
    var onStateChange: ((HarnessVoiceState) -> Void)?
    var contextProvider: (() -> HarnessVoiceContext)?

    private let engine = AVAudioEngine()
    private let playbackEngine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let audioInputAvailable: () -> Bool
    private let audioOutputAvailable: () -> Bool
    private let transport: any VoiceSocketTransporting
    private let microphonePermission: (() async -> Bool)?
    private var turn = VoiceTurnState()
    private var wakeGate = WakeSessionGate()
    private var wakeRetry = WakeRetryPolicy()
    private var wakeTask: SFSpeechRecognitionTask?
    private var wakeRequest: SFSpeechAudioBufferRecognitionRequest?
    private var wakeRecognizer: SFSpeechRecognizer?
    private var monitor: Task<Void, Never>?
    private var wakeRestart: Task<Void, Never>?
    private var microphoneAuthorization: Task<Bool, Never>?
    private var speechAuthorization: Task<Bool, Never>?
    private var input: VoiceInputMailbox?
    private var meter = VoiceOutputMeter()
    private var hasInputTap = false
    private var hasOutputTap = false
    private var playbackBytes = 0
    private var inputSequence = 0
    private var sentInputBytes = 0
    private var captureStarted: TimeInterval = 0
    private var lastPlaybackAt: TimeInterval = 0
    private var replyContext: HarnessVoiceContext?
    private var fromWake = false
    private var observers: [NSObjectProtocol] = []

    init(audioInputAvailable: @escaping () -> Bool = { JarvisHasAudioInput() },
         audioOutputAvailable: @escaping () -> Bool = { JarvisHasAudioOutput() },
         transport: (any VoiceSocketTransporting)? = nil,
         microphonePermission: (() async -> Bool)? = nil) {
        self.audioInputAvailable = audioInputAvailable
        self.audioOutputAvailable = audioOutputAvailable
        self.transport = transport ?? VoiceSocketTransport()
        self.microphonePermission = microphonePermission
        super.init()
        self.transport.onFrame = { [weak self] frame in self?.receive(frame) }
        self.transport.onFailure = { [weak self] message in self?.fail(message) }
        for audioEngine in [engine, playbackEngine] {
            observers.append(NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: audioEngine, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self, self.hasInputTap || self.hasOutputTap else { return }
                    self.fail("Audio hardware changed. Re-select your devices and explicitly start a new voice turn. Typing still works.")
                }
            })
        }
    }

    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    func setCloudConsent(_ granted: Bool) {
        cloudConsentGranted = granted
        if !granted { stopListening() }
    }

    func startListening() async {
        let context = replyContext ?? contextProvider?() ?? HarnessVoiceContext()
        replyContext = nil
        await beginCapture(context: context, fromWake: false)
    }

    private func beginCapture(context: HarnessVoiceContext, fromWake: Bool) async {
        guard !Task.isCancelled else { return }
        cancelActive()
        guard audioInputAvailable() else {
            fail("No usable microphone was found. Connect an input device in System Settings → Sound, then explicitly enable listening again. Typing still works.")
            return
        }
        guard cloudConsentGranted else {
            fail("Voice is off. Explicitly allow this session to send microphone audio and spoken reply text to ElevenLabs. Do not speak passwords or API keys. Typing still works.")
            return
        }
        self.fromWake = fromWake
        let ticket = turn.begin(.capture, context: context)
        transcript = ""
        error = nil
        changeState(.connecting)
        wakeStatus = "Connecting · cloud microphone capture not yet active"
        do {
            let status = try await transport.status()
            guard current(ticket) else { if turn.current(ticket), Task.isCancelled { stopListening() }; return }
            guard status.status != "unavailable" else { fail(status.reason ?? "ElevenLabs is unavailable. Typing still works."); return }
            guard await authorizeMicrophone(ticket), current(ticket) else { if turn.current(ticket), Task.isCancelled { stopListening() }; return }
            try transport.connect()
            var frame = turn.frame("start")
            frame.context = context
            frame.cloudConsent = true
            try transport.send(frame)
            startMonitor(ticket)
        } catch { if current(ticket) { fail("The ElevenLabs bridge is unavailable. Start a new turn explicitly. Typing still works.") } }
    }

    private func authorizeMicrophone(_ ticket: Int) async -> Bool {
        isRequestingPermission = true
        defer { if turn.current(ticket) { isRequestingPermission = false } }
        let allowed: Bool
        if let microphonePermission { allowed = await microphonePermission() }
        else if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            if microphoneAuthorization == nil { microphoneAuthorization = Task { await AVCaptureDevice.requestAccess(for: .audio) } }
            allowed = await microphoneAuthorization!.value
        } else { allowed = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }
        guard current(ticket) else { return false }
        microphoneAuthorization = nil
        guard allowed else {
            fail("Microphone permission is off. Enable Jarvis in System Settings → Privacy & Security → Microphone. Typing still works.")
            return false
        }
        return true
    }

    private func startInput(_ ticket: Int) {
        guard current(ticket), cloudConsentGranted, !hasInputTap, !isSpeaking, turn.mode == .capture, !turn.committed else { return }
        guard audioInputAvailable() else { fail("The microphone became unavailable. Reconnect it and start a new turn. Typing still works."); return }
        let mailbox = VoiceInputMailbox()
        let converter = JarvisPCMConverter()
        input = mailbox
        let installed = JarvisInstallInputTap(engine) { buffer, _ in
            mailbox.offer(converter.convert(buffer), at: ProcessInfo.processInfo.systemUptime)
        }
        guard installed else { fail("The microphone format is unavailable or changed. Check System Settings → Sound. Typing still works."); return }
        hasInputTap = true
        guard JarvisStartAudioEngine(engine) else { fail("Could not safely start the microphone. Typing still works."); return }
        captureStarted = ProcessInfo.processInfo.systemUptime
        inputSequence = 0
        sentInputBytes = 0
        isListening = true
        isCapturingCommand = true
        wakeStatus = "Listening · audio sent to ElevenLabs · pauses while Jarvis speaks"
        changeState(.listening)
    }

    // Finish is a commit. Stop/mute/interrupt discard partial recognition instead.
    func finishListening() {
        guard turn.mode == .capture, isListening, !turn.committed else { return }
        JarvisStopAudioEngine(engine, hasInputTap)
        hasInputTap = false
        isListening = false
        isCapturingCommand = false
        do {
            while let input, input.pendingBytes > 0 { try pumpInput() }
            guard sentInputBytes >= 8_000 else { stopListening(); return }
            input = nil
            try turn.commit()
            try transport.send(turn.frame("commit"))
            changeState(.thinking)
            emitLevels()
        } catch { fail(error.localizedDescription) }
    }

    private func pumpInput() throws {
        guard let input else { return }
        let (data, level, _) = try input.drain()
        if !data.isEmpty {
            var frame = turn.frame("audio")
            frame.sequence = inputSequence
            frame.pcm = data.base64EncodedString()
            frame.sampleRate = 16_000
            try transport.send(frame)
            inputSequence += 1
            sentInputBytes += data.count
        }
        emitLevels(input: isListening ? level : 0)
    }

    func stopListening() {
        wakeGate.mute()
        wakeWordEnabled = false
        replyContext = nil
        cancelActive()
        wakeStatus = "Wake listening is off"
        changeState(.idle)
    }

    func interrupt() {
        cancelActive()
        wakeStatus = wakeWordEnabled ? "Wake paused · explicitly rearm or start listening" : "Voice interrupted · microphone off"
        changeState(.interrupted)
    }

    func speak(_ text: String) { speak(text, context: contextProvider?() ?? HarnessVoiceContext()) }

    func speak(_ text: String, context: HarnessVoiceContext) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        cancelActive()
        guard cloudConsentGranted else { fail("ElevenLabs voice is off until you explicitly allow cloud voice for this session. Typing still works."); return }
        guard audioOutputAvailable() else { fail("No usable audio output was found. Connect speakers or headphones. The reply remains available as text."); return }
        guard text.utf16.count <= 4_000 else { fail("This reply is too long for one voice turn. Read it as text or speak a shorter selection."); return }
        replyContext = context.question == nil ? nil : context
        let ticket = turn.begin(.playback, context: context)
        error = nil
        changeState(.connecting)
        wakeStatus = "Microphone paused while Jarvis speaks"
        monitor = Task { [weak self] in
            guard let self else { return }
            do {
                let status = try await self.transport.status()
                guard self.current(ticket) else { return }
                guard status.status != "unavailable" else { self.fail(status.reason ?? "ElevenLabs is unavailable. Read the reply as text."); return }
                try self.transport.connect()
                var frame = self.turn.frame("speak")
                frame.context = context
                frame.text = text
                frame.final = true
                try self.transport.send(frame)
                self.monitor = nil
                self.startMonitor(ticket)
            } catch { if self.current(ticket) { self.fail("ElevenLabs speech is unavailable. Read the reply as text; no fallback voice was used.") } }
        }
    }

    func stopSpeaking() { interrupt() }

    private func receive(_ frame: HarnessVoiceServerFrame) {
        guard turn.accepts(frame) else { return }
        do {
            guard frame.version == 1 else { throw VoiceTransportError.invalidFrame }
            switch frame.type {
            case "state":
                guard let state = frame.state else { throw VoiceTransportError.invalidFrame }
                if state == .unavailable { fail(frame.detail ?? "ElevenLabs is unavailable. Typing still works.") }
                else if state == .listening { startInput(turn.generation) }
                // Provider idle does not mean the native playback queue has drained.
            case "transcript":
                let utterance = try turn.transcript(frame)
                transcript = frame.text ?? ""
                if let utterance {
                    let legacyWake = fromWake
                    completeTurn()
                    if !utterance.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        if let onUtterance { onUtterance(utterance) }
                        else if legacyWake && utterance.context.question == nil { onCommand?(utterance.text) }
                    }
                }
            case "audio":
                if let data = try turn.audio(frame) { try play(data, ticket: turn.generation) }
            case "audio_end":
                try turn.endAudio()
                if playbackBytes == 0 { completeTurn() }
            case "error": fail(frame.message ?? "ElevenLabs voice failed. No fallback was used. Typing still works.")
            default: throw VoiceTransportError.invalidFrame
            }
        } catch { fail(error.localizedDescription) }
    }

    private func play(_ data: Data, ticket: Int) throws {
        guard !isListening, !hasInputTap, audioOutputAvailable() else { throw VoiceTransportError.disconnected }
        guard playbackBytes + data.count <= 96_000 else { throw VoiceTransportError.overflow }
        if !hasOutputTap {
            let meter = VoiceOutputMeter()
            self.meter = meter
            guard JarvisConfigurePlayback(playbackEngine, player, { buffer, _ in
                if let samples = buffer.floatChannelData?[0] {
                    meter.observe(UnsafeBufferPointer(start: samples, count: Int(buffer.frameLength) * buffer.stride), stride: buffer.stride, at: ProcessInfo.processInfo.systemUptime)
                }
            }) else { throw VoiceTransportError.disconnected }
            hasOutputTap = true
            guard JarvisStartAudioEngine(playbackEngine) else { throw VoiceTransportError.disconnected }
        }
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(data.count / 2)),
              let samples = buffer.floatChannelData?[0] else { throw VoiceTransportError.invalidFrame }
        buffer.frameLength = buffer.frameCapacity
        data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            for i in 0..<Int(buffer.frameLength) {
                samples[i] = Float(Int16(bitPattern: UInt16(bytes[i * 2]) | UInt16(bytes[i * 2 + 1]) << 8)) / 32768
            }
        }
        playbackBytes += data.count
        lastPlaybackAt = ProcessInfo.processInfo.systemUptime
        guard JarvisSchedulePlayback(player, buffer, { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.turn.current(ticket) else { return }
                self.playbackBytes -= data.count
                self.lastPlaybackAt = ProcessInfo.processInfo.systemUptime
                if self.turn.finalReceived && self.playbackBytes == 0 { self.completeTurn() }
            }
        }) else { throw VoiceTransportError.disconnected }
        isSpeaking = true
        changeState(.speaking)
    }

    private func startMonitor(_ ticket: Int) {
        let began = ProcessInfo.processInfo.systemUptime
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(20)) } catch { return }
                guard let self, self.current(ticket) else { return }
                let now = ProcessInfo.processInfo.systemUptime
                if now - began > 90 || self.state == .connecting && now - began > 10 {
                    self.fail("Voice timed out. Start a new turn explicitly. Nothing was replayed."); return
                }
                do {
                    if self.isListening, self.turn.mode == .capture {
                        guard self.audioInputAvailable() else { throw VoiceTransportError.disconnected }
                        try self.pumpInput()
                        if let input = self.input {
                            let lastVoice = input.voiceActivity
                            if now - self.captureStarted > 45 || (lastVoice != nil && now - lastVoice! > 1.2) || (lastVoice == nil && now - self.captureStarted > 8) { self.finishListening() }
                        }
                    }
                    if self.isSpeaking {
                        guard self.audioOutputAvailable(), self.playbackBytes == 0 || now - self.lastPlaybackAt < 3 else { throw VoiceTransportError.disconnected }
                        self.emitLevels(playback: self.meter.read(at: now))
                    }
                } catch { self.fail(error.localizedDescription); return }
            }
        }
    }

    private func completeTurn() {
        cancelActive()
        changeState(.idle)
        if wakeWordEnabled { scheduleWake(after: 0.6) }
        else { wakeStatus = "Voice idle · microphone off" }
    }

    private func cancelActive() {
        turn.invalidate()
        wakeGate.begin(.idle)
        monitor?.cancel(); monitor = nil
        wakeRestart?.cancel(); wakeRestart = nil
        transport.disconnect()
        JarvisStopAudioEngine(engine, hasInputTap)
        JarvisStopPlayback(playbackEngine, player, hasOutputTap)
        hasInputTap = false; hasOutputTap = false
        wakeRequest?.endAudio(); wakeRequest = nil
        wakeTask?.cancel(); wakeTask = nil; wakeRecognizer = nil
        input = nil; playbackBytes = 0
        isListening = false; isSpeaking = false; isCapturingCommand = false; isRequestingPermission = false
        emitLevels()
    }

    private func current(_ ticket: Int) -> Bool { turn.current(ticket) && !Task.isCancelled }
    private func changeState(_ state: HarnessVoiceState) { self.state = state; onStateChange?(state) }
    private func emitLevels(input: Double = 0, playback: Double = 0) {
        onAudioLevels?(.init(inputRMS: input, playbackRMS: playback, generation: turn.generation))
    }
    private func fail(_ message: String) {
        stopListening()
        error = String(message.prefix(2_000))
        wakeStatus = "Unavailable · \(error!)"
        changeState(.unavailable)
    }

    func setWakeWordEnabled(_ enabled: Bool) async {
        guard enabled else { stopListening(); return }
        guard !Task.isCancelled, !wakeWordEnabled else { return }
        cancelActive()
        guard audioInputAvailable() else { fail("No usable microphone was found. Connect an input device and explicitly enable wake listening again. Typing still works."); return }
        guard cloudConsentGranted else { fail("Allow ElevenLabs cloud voice before arming wake. The wake phrase stays on-device; only the subsequent active command is uploaded. Typing still works."); return }
        wakeWordEnabled = true
        wakeGate.enableWake()
        wakeRetry.reset()
        await beginWake()
    }

    private func beginWake() async {
        guard wakeWordEnabled, !isSpeaking, turn.mode == .idle, !Task.isCancelled else { return }
        let ticket = wakeGate.begin(.wake)
        isRequestingPermission = true
        let speechAllowed: Bool
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            if speechAuthorization == nil {
                speechAuthorization = Task { await withCheckedContinuation { continuation in SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) } } }
            }
            speechAllowed = await speechAuthorization!.value
        } else { speechAllowed = SFSpeechRecognizer.authorizationStatus() == .authorized }
        guard wakeGate.accepts(ticket), wakeWordEnabled, !Task.isCancelled else { return }
        speechAuthorization = nil
        guard speechAllowed else { fail("On-device wake recognition permission is off. Enable Speech Recognition or use push-to-talk. Typing still works."); return }
        let microphoneAllowed: Bool
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            if microphoneAuthorization == nil { microphoneAuthorization = Task { await AVCaptureDevice.requestAccess(for: .audio) } }
            microphoneAllowed = await microphoneAuthorization!.value
        } else { microphoneAllowed = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }
        guard wakeGate.accepts(ticket), wakeWordEnabled, !Task.isCancelled else { return }
        microphoneAuthorization = nil
        isRequestingPermission = false
        guard microphoneAllowed else { fail("Microphone permission is off. Enable it in System Settings → Privacy & Security. Typing still works."); return }
        guard audioInputAvailable(), let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            fail("On-device English wake recognition or microphone is unavailable. Use explicit push-to-talk; no cloud wake fallback is used."); return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .unspecified
        wakeRequest = request
        wakeRecognizer = recognizer
        guard JarvisInstallInputTap(engine, { buffer, _ in request.append(buffer) }) else { fail("Wake microphone format is unavailable. Typing still works."); return }
        hasInputTap = true
        wakeTask = recognizer.recognitionTask(with: request) { [weak self] result, failure in
            let woke = result.map { WakePhrase.command(in: $0.bestTranscription.formattedString) != nil } ?? false
            let final = result?.isFinal ?? false
            let failed = failure != nil
            Task { @MainActor [weak self] in
                guard let self, self.wakeGate.accepts(ticket), self.wakeWordEnabled else { return }
                if woke {
                    let context = self.replyContext ?? self.contextProvider?() ?? HarnessVoiceContext()
                    self.replyContext = nil
                    self.wakeRetry.reset()
                    // Discard Apple's transcript. The command starts only after Scribe is ready.
                    await self.beginCapture(context: context, fromWake: true)
                } else if final || failed {
                    guard let delay = self.wakeRetry.nextDelay() else { self.fail("On-device wake stopped after repeated failures. Explicitly rearm it or use text."); return }
                    self.scheduleWake(after: delay)
                }
            }
        }
        guard JarvisStartAudioEngine(engine) else { fail("Could not safely start on-device wake listening. Typing still works."); return }
        error = nil
        wakeStatus = "Armed · on-device wake only · say Hey Jarvis, then wait for Listening"
        changeState(.idle)
        monitor = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(40)) } catch { return }
            guard let self, self.wakeGate.accepts(ticket), self.wakeWordEnabled else { return }
            self.wakeRetry.reset()
            self.scheduleWake(after: 0.1)
        }
    }

    private func scheduleWake(after delay: TimeInterval) {
        cancelActive()
        guard wakeWordEnabled else { return }
        let ticket = wakeGate.generation
        wakeStatus = "Rearming on-device wake · cloud microphone off"
        wakeRestart = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self, self.wakeGate.canRestart(ticket), !Task.isCancelled else { return }
            await self.beginWake()
        }
    }
}
