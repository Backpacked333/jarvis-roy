import Foundation

enum VoiceTransportError: LocalizedError {
    case invalidFrame, overflow, configuration, disconnected
    var errorDescription: String? {
        switch self {
        case .invalidFrame: return "Voice format or sequence changed. Start a fresh turn. Typing still works."
        case .overflow: return "Voice exceeded the two-second audio buffer. The turn was stopped, not replayed."
        case .configuration: return "Start Jarvis with its authenticated local bridge. Typing still works."
        case .disconnected: return "Voice disconnected. Start a new turn explicitly; no audio or text was replayed."
        }
    }
}

struct VoiceTurnState {
    enum Mode { case idle, capture, playback }
    private(set) var sessionId = UUID().uuidString
    private(set) var generation = 0
    private(set) var context = HarnessVoiceContext()
    private(set) var mode: Mode = .idle
    private(set) var committed = false
    private(set) var finalReceived = false
    private var nextAudio = 0

    @discardableResult
    mutating func begin(_ mode: Mode, context: HarnessVoiceContext, reuseSession: Bool = false) -> Int {
        generation += 1
        if !reuseSession { sessionId = UUID().uuidString }
        self.context = context
        self.mode = mode
        committed = false
        finalReceived = false
        nextAudio = 0
        return generation
    }
    mutating func renewTransportSession() { sessionId = UUID().uuidString }
    mutating func invalidate() { generation += 1; mode = .idle; committed = false; finalReceived = true }
    mutating func commit() throws {
        guard mode == .capture, !committed else { throw VoiceTransportError.invalidFrame }
        committed = true
    }
    func current(_ ticket: Int) -> Bool { ticket == generation && mode != .idle }
    func accepts(_ frame: HarnessVoiceServerFrame) -> Bool { frame.sessionId == sessionId && frame.generation == generation && mode != .idle }
    mutating func transcript(_ frame: HarnessVoiceServerFrame) throws -> HarnessVoiceUtterance? {
        guard accepts(frame) else { return nil }
        guard frame.version == 1, frame.type == "transcript", mode == .capture,
              let text = frame.text, text.count <= 16_000, frame.context == context,
              let final = frame.final, !finalReceived else { throw VoiceTransportError.invalidFrame }
        guard final else { return nil }
        guard committed else { throw VoiceTransportError.invalidFrame }
        finalReceived = true
        return HarnessVoiceUtterance(text: text, context: context, sessionId: sessionId, generation: generation)
    }
    mutating func audio(_ frame: HarnessVoiceServerFrame) throws -> Data? {
        guard accepts(frame) else { return nil }
        guard frame.version == 1, frame.type == "audio", mode == .playback, !finalReceived,
              frame.sampleRate == 24_000, frame.sequence == nextAudio, let pcm = frame.pcm else { throw VoiceTransportError.invalidFrame }
        let data = try VoicePCM.decode(pcm)
        nextAudio += 1
        return data
    }
    mutating func endAudio() throws {
        guard mode == .playback, !finalReceived else { throw VoiceTransportError.invalidFrame }
        finalReceived = true
    }
    func frame(_ type: String) -> HarnessVoiceClientFrame { .init(sessionId: sessionId, generation: generation, type: type) }
}

enum VoicePCM {
    static func decode(_ base64: String) throws -> Data {
        guard base64.utf8.count <= 21_336, let data = Data(base64Encoded: base64),
              data.count > 0, data.count <= 16_000, data.count % 2 == 0,
              data.base64EncodedString() == base64 else { throw VoiceTransportError.invalidFrame }
        return data
    }
    static func rms(_ data: Data) -> Double {
        guard !data.isEmpty, data.count % 2 == 0 else { return 0 }
        var energy = 0.0
        data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            for offset in stride(from: 0, to: bytes.count, by: 2) {
                let sample = Double(Int16(bitPattern: UInt16(bytes[offset]) | UInt16(bytes[offset + 1]) << 8)) / 32768
                energy += sample * sample
            }
        }
        return min(1, sqrt(energy / Double(data.count / 2)))
    }
}

// The audio thread writes a bounded mailbox, not an unbounded queue of MainActor tasks.
final class VoiceInputMailbox: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()
    private var overflow = false
    private var level = 0.0
    private var lastVoiceAt: TimeInterval?
    func offer(_ data: Data?, at time: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        guard let data, data.count % 2 == 0, bytes.count + data.count <= 32_000 else { overflow = true; return }
        bytes.append(data)
        level = VoicePCM.rms(data)
        if level >= 0.008 { lastVoiceAt = time }
    }
    func drain() throws -> (Data, Double, TimeInterval?) {
        lock.lock(); defer { lock.unlock() }
        guard !overflow else { throw VoiceTransportError.overflow }
        let amount = min(bytes.count, 3_200)
        let data = Data(bytes.prefix(amount))
        bytes.removeFirst(amount)
        return (data, data.isEmpty ? 0 : level, lastVoiceAt)
    }
    var pendingBytes: Int { lock.lock(); defer { lock.unlock() }; return bytes.count }
    var voiceActivity: TimeInterval? { lock.lock(); defer { lock.unlock() }; return lastVoiceAt }
}

final class VoiceOutputMeter: @unchecked Sendable {
    private let lock = NSLock()
    private var level = 0.0
    private var sampledAt: TimeInterval = 0
    private var firstActiveAt: TimeInterval?
    func observe(_ samples: UnsafeBufferPointer<Float>, stride step: Int, at time: TimeInterval) {
        guard !samples.isEmpty, step > 0 else { return }
        var energy = 0.0
        var count = 0
        for index in stride(from: 0, to: samples.count, by: step) { energy += Double(samples[index] * samples[index]); count += 1 }
        lock.lock(); defer { lock.unlock() }
        level = min(1, sqrt(energy / Double(count)))
        sampledAt = time
        // Render callback time, not physical speaker output or acoustic audibility.
        if firstActiveAt == nil, level >= 0.001, time.isFinite { firstActiveAt = time }
    }
    func read(at time: TimeInterval) -> Double {
        lock.lock(); defer { lock.unlock() }
        return time - sampledAt < 0.2 ? level : 0
    }
    var firstActiveRenderTime: TimeInterval? { lock.lock(); defer { lock.unlock() }; return firstActiveAt }
}
