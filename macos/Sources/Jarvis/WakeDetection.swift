import Foundation

enum WakePhrase {
    // Anchoring prevents incidental mentions later in room transcription becoming commands.
    private static let prefix = try! NSRegularExpression(
        pattern: #"^[\s\p{P}]*hey[\s\p{P}]+jarvis(?![\p{L}\p{N}\p{M}_]|['’][\p{L}\p{N}])(?=$|[\s\p{P}])[\s\p{P}]*"#,
        options: [.caseInsensitive]
    )

    static func command(in transcription: String) -> String? {
        let range = NSRange(transcription.startIndex..., in: transcription)
        guard let match = prefix.firstMatch(in: transcription, range: range),
            let matchedRange = Range(match.range, in: transcription)
        else { return nil }
        return String(transcription[matchedRange.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct WakeCapture {
    enum Completion: Equatable {
        case command(String)
        case empty
    }

    private(set) var isCapturing = false
    private(set) var isFinished = false
    private(set) var command = ""
    private(set) var hasRecognizedSpeech = false
    private var beganAt: TimeInterval = 0
    private var changedAt: TimeInterval = 0
    private var backgroundAt: TimeInterval = 0

    let silenceDuration: TimeInterval
    let emptyWakeDuration: TimeInterval
    let maximumDuration: TimeInterval

    init(
        silenceDuration: TimeInterval = 1.5, emptyWakeDuration: TimeInterval = 5,
        maximumDuration: TimeInterval = 20
    ) {
        self.silenceDuration = silenceDuration
        self.emptyWakeDuration = emptyWakeDuration
        self.maximumDuration = maximumDuration
    }

    mutating func receive(_ transcription: String, at now: TimeInterval) {
        guard !isFinished else { return }
        if !transcription.isEmpty { hasRecognizedSpeech = true }
        guard let suffix = WakePhrase.command(in: transcription) else {
            // A revised hypothesis must still contain the wake prefix before it can be sent.
            if isCapturing { command = "" }
            backgroundAt = now
            return
        }
        if !isCapturing {
            isCapturing = true
            beganAt = now
            changedAt = now
        }
        if command != suffix {
            command = suffix
            changedAt = now
        }
    }

    mutating func poll(at now: TimeInterval, lastVoiceAt: TimeInterval?) -> Completion? {
        guard !isFinished else { return nil }
        if !isCapturing {
            // Discard a completed background utterance so the next one can start with a wake prefix.
            let lastActivity = max(backgroundAt, lastVoiceAt ?? backgroundAt)
            return hasRecognizedSpeech && now - lastActivity >= silenceDuration ? finish() : nil
        }
        if now - beganAt >= maximumDuration { return finish() }
        if command.isEmpty {
            return now - beganAt >= emptyWakeDuration ? finish() : nil
        }
        let lastActivity = max(changedAt, lastVoiceAt ?? changedAt)
        return now - lastActivity >= silenceDuration ? finish() : nil
    }

    mutating func finish() -> Completion? {
        guard !isFinished else { return nil }
        isFinished = true
        isCapturing = false
        return command.isEmpty ? .empty : .command(command)
    }
}

// Permission callbacks cannot dismiss an OS prompt; invalidating its ticket makes it inert.
struct WakeSessionGate {
    enum Purpose { case idle, pushToTalk, wake }

    private(set) var wakeEnabled = false
    private(set) var generation: UInt64 = 0
    private(set) var purpose: Purpose = .idle

    mutating func enableWake() {
        wakeEnabled = true
    }

    @discardableResult
    mutating func begin(_ purpose: Purpose) -> UInt64 {
        generation &+= 1
        self.purpose = purpose
        return generation
    }

    mutating func mute() {
        wakeEnabled = false
        begin(.idle)
    }

    func accepts(_ ticket: UInt64) -> Bool {
        ticket == generation
    }

    func canRestart(_ ticket: UInt64) -> Bool {
        accepts(ticket) && wakeEnabled && purpose == .idle
    }
}

struct WakeRetryPolicy {
    private(set) var failures = 0
    let maximumFailures = 5

    mutating func nextDelay() -> TimeInterval? {
        failures += 1
        guard failures < maximumFailures else { return nil }
        return min(pow(2, Double(failures - 1)) * 0.5, 8)
    }

    mutating func reset() { failures = 0 }
}

final class WakeAudioActivity: @unchecked Sendable {
    private let lock = NSLock()
    private var voiceAt: TimeInterval?
    private let minimumRMS: Float = 0.008

    var lastVoiceAt: TimeInterval? {
        lock.lock()
        defer { lock.unlock() }
        return voiceAt
    }

    func observe(_ samples: UnsafeBufferPointer<Float>, stride: Int = 1, at now: TimeInterval) {
        guard !samples.isEmpty, stride > 0 else { return }
        var energy: Float = 0
        var count = 0
        for index in Swift.stride(from: 0, to: samples.count, by: stride) {
            energy += samples[index] * samples[index]
            count += 1
        }
        guard energy / Float(count) >= minimumRMS * minimumRMS else { return }
        lock.lock()
        voiceAt = now
        lock.unlock()
    }
}
