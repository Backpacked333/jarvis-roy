import AVFoundation
import JarvisAudioSafety
import SoundAnalysis

struct VoiceDuplexSignal {
    var pcm = Data()
    var speech = false
    var echo = false
    var inputRMS = 0.0
    var playbackRMS = 0.0
}

@MainActor
protocol VoiceDuplexAudioServing: AnyObject {
    func start() throws
    func poll() throws -> VoiceDuplexSignal
    func play(_ data: Data, completed: @escaping () -> Void) throws
    func interruptPlayback()
    func stop()
}

enum VoiceAcousticError: LocalizedError {
    case unavailable
    var errorDescription: String? {
        "Hands-free voice is unavailable: Apple echo cancellation, local speech detection or a compatible mono microphone/output could not be maintained. Acoustic mode is off; use push-to-talk or text."
    }
}

@MainActor
final class VoiceDuplexAudio: VoiceDuplexAudioServing {
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var microphone = VoiceInputMailbox()
    private var reference = VoiceInputMailbox()
    private var outputMeter = VoiceOutputMeter()
    private var classifier: VoiceLocalSpeechClassifier?
    private var decision = VoiceSpeechDecision()
    private var near = VoicePCMWindow(limit: 3_200)
    private var far = VoicePCMWindow(limit: 32_000)
    private var capturedSamples = 0
    private var lastInputAt = 0.0
    private var epoch = 0
    private var configurationObserver: NSObjectProtocol?
    private var configurationChanged = false

    func start() throws {
        stop()
        let classifier = try VoiceLocalSpeechClassifier()
        let engine = AVAudioEngine(), player = AVAudioPlayerNode()
        self.engine = engine; self.player = player; self.classifier = classifier
        let microphone = VoiceInputMailbox(), reference = VoiceInputMailbox(), meter = VoiceOutputMeter()
        self.microphone = microphone; self.reference = reference; outputMeter = meter
        let inputConverter = JarvisPCMConverter(), outputConverter = JarvisPCMConverter()
        guard JarvisConfigureDuplex(engine, player, { buffer, _ in
            microphone.offer(inputConverter.convert(buffer), at: ProcessInfo.processInfo.systemUptime)
        }, { buffer, _ in
            reference.offer(outputConverter.convert(buffer), at: ProcessInfo.processInfo.systemUptime)
            if let samples = buffer.floatChannelData?[0] {
                meter.observe(UnsafeBufferPointer(start: samples, count: Int(buffer.frameLength) * buffer.stride), stride: buffer.stride, at: ProcessInfo.processInfo.systemUptime)
            }
        }), JarvisStartAudioEngine(engine), JarvisDuplexIsHealthy(engine) else {
            stop(); throw VoiceAcousticError.unavailable
        }
        lastInputAt = ProcessInfo.processInfo.systemUptime
        configurationChanged = false
        let ticket = epoch
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in if self?.epoch == ticket { self?.configurationChanged = true } }
        }
    }

    func poll() throws -> VoiceDuplexSignal {
        guard !configurationChanged, let engine, JarvisDuplexIsHealthy(engine), let classifier else { throw VoiceAcousticError.unavailable }
        let now = ProcessInfo.processInfo.systemUptime
        let (pcm, rms, _) = try microphone.drain()
        let (output, _, _) = try reference.drain()
        far.append(output); near.append(pcm)
        if !pcm.isEmpty { lastInputAt = now; capturedSamples += pcm.count / 2; try classifier.offer(pcm) }
        guard now - lastInputAt < 2 else { throw VoiceAcousticError.unavailable }
        let result = try classifier.result()
        let echo = VoiceEchoVeto.matches(near.bytes, reference: far.bytes)
        let speech = decision.accept(confidence: result.confidence, end: result.end,
                                     capturedSeconds: Double(capturedSamples) / 16_000, echo: echo, level: VoicePCM.rms(near.bytes))
        return VoiceDuplexSignal(pcm: pcm, speech: speech, echo: echo, inputRMS: rms, playbackRMS: outputMeter.read(at: now))
    }

    func play(_ data: Data, completed: @escaping () -> Void) throws {
        guard let engine, let player, JarvisDuplexIsHealthy(engine), !data.isEmpty, data.count % 2 == 0,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(data.count / 2)),
              let samples = buffer.floatChannelData?[0] else { throw VoiceAcousticError.unavailable }
        buffer.frameLength = buffer.frameCapacity
        data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            for i in 0..<Int(buffer.frameLength) { samples[i] = Float(Int16(bitPattern: UInt16(bytes[i * 2]) | UInt16(bytes[i * 2 + 1]) << 8)) / 32768 }
        }
        let ticket = epoch
        guard JarvisSchedulePlayback(player, buffer, { [weak self] in
            Task { @MainActor [weak self] in guard self?.epoch == ticket else { return }; completed() }
        }) else { throw VoiceAcousticError.unavailable }
    }

    func interruptPlayback() {
        if let player { JarvisStopPlayer(player) }
    }

    func stop() {
        epoch += 1
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
        configurationObserver = nil
        if let engine, let player {
            JarvisStopAudioEngine(engine, true)
            JarvisStopPlayback(engine, player, true)
        }
        classifier?.stop(); classifier = nil
        engine = nil; player = nil
        near.clear(); far.clear(); decision = VoiceSpeechDecision(); capturedSamples = 0
        microphone = VoiceInputMailbox(); reference = VoiceInputMailbox()
    }
}

// Apple's built-in on-device sound classifier, fed ONLY echo-cancelled microphone PCM.
// One bounded queue owns the analyzer; no unbounded async work from audio tap callbacks.
final class VoiceLocalSpeechClassifier: NSObject, SNResultsObserving, @unchecked Sendable {
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "jarvis.local-speech")
    private let analyzer: SNAudioStreamAnalyzer
    private let format: AVAudioFormat
    private var pending = Data()
    private var draining = false
    private var stopped = false
    private var failed = false
    private var position: AVAudioFramePosition = 0
    private var confidence = 0.0
    private var end = 0.0

    init(identifier: SNClassifierIdentifier = .version1) throws {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false) else { throw VoiceAcousticError.unavailable }
        self.format = format
        analyzer = SNAudioStreamAnalyzer(format: format)
        super.init()
        let request = try SNClassifySoundRequest(classifierIdentifier: identifier)
        guard request.knownClassifications.contains("speech") else { throw VoiceAcousticError.unavailable }
        let duration = CMTime(seconds: 0.5, preferredTimescale: 16_000)
        switch request.windowDurationConstraint {
        case .durationRange(let range):
            guard CMTimeCompare(duration, range.start) >= 0, CMTimeCompare(duration, CMTimeRangeGetEnd(range)) <= 0 else { throw VoiceAcousticError.unavailable }
        case .enumeratedDurations(let times):
            guard times.contains(where: { CMTimeCompare($0, duration) == 0 }) else { throw VoiceAcousticError.unavailable }
        @unknown default: throw VoiceAcousticError.unavailable
        }
        request.windowDuration = duration
        request.overlapFactor = 0.5
        try analyzer.add(request, withObserver: self)
    }

    func offer(_ pcm: Data) throws {
        lock.lock(); defer { lock.unlock() }
        guard !failed, !stopped, pending.count + pcm.count <= 16_000 else { failed = true; throw VoiceAcousticError.unavailable }
        pending.append(pcm)
        if !draining { draining = true; queue.async { [weak self] in self?.drain() } }
    }
    private func drain() {
        while true {
            lock.lock()
            if stopped || failed || pending.isEmpty { draining = false; lock.unlock(); return }
            let data = Data(pending.prefix(3_200)); pending.removeFirst(data.count)
            lock.unlock()
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(data.count / 2)), let values = buffer.floatChannelData?[0] else { markFailed(); return }
            buffer.frameLength = buffer.frameCapacity
            data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
                for i in 0..<Int(buffer.frameLength) { values[i] = Float(Int16(bitPattern: UInt16(bytes[2 * i]) | UInt16(bytes[2 * i + 1]) << 8)) / 32768 }
            }
            analyzer.analyze(buffer, atAudioFramePosition: position)
            position += AVAudioFramePosition(buffer.frameLength)
        }
    }
    func result() throws -> (confidence: Double, end: Double) {
        lock.lock(); defer { lock.unlock() }
        guard !failed, !stopped else { throw VoiceAcousticError.unavailable }
        return (confidence, end)
    }
    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { markFailed(); return }
        lock.lock(); defer { lock.unlock() }
        guard !stopped else { return }
        confidence = result.classifications.first(where: { $0.identifier == "speech" })?.confidence ?? 0
        end = CMTimeGetSeconds(CMTimeRangeGetEnd(result.timeRange))
    }
    func request(_ request: SNRequest, didFailWithError error: Error) { markFailed() }
    private func markFailed() { lock.lock(); failed = true; lock.unlock() }
    func stop() {
        lock.lock(); stopped = true; pending.removeAll(); lock.unlock()
        queue.async { [self] in analyzer.removeAllRequests() }
    }
}
