import Foundation

struct VoicePlaybackDrain {
    private(set) var pendingBytes = 0
    private(set) var receivedAudio = false
    private(set) var providerEnded = false
    var finished: Bool { providerEnded && pendingBytes == 0 }
    mutating func scheduled(_ bytes: Int) throws {
        guard !providerEnded, bytes > 0, pendingBytes + bytes <= 96_000 else { throw VoiceTransportError.overflow }
        pendingBytes += bytes
        receivedAudio = true
    }
    mutating func played(_ bytes: Int) throws {
        guard bytes > 0, bytes <= pendingBytes else { throw VoiceTransportError.invalidFrame }
        pendingBytes -= bytes
    }
    mutating func end() { providerEnded = true }
}

struct VoicePCMWindow {
    private(set) var bytes = Data()
    let limit: Int
    mutating func append(_ data: Data) {
        bytes.append(data)
        if bytes.count > limit { bytes = Data(bytes.suffix(limit)) }
    }
    mutating func clear() { bytes.removeAll(keepingCapacity: false) }
}

// A conservative residual-echo veto, not a replacement for Apple's AEC or speech classifier.
enum VoiceEchoVeto {
    static func matches(_ input: Data, reference: Data) -> Bool {
        let sampleCount = min(input.count / 2, 1_600)
        guard sampleCount >= 320, reference.count >= sampleCount * 2 else { return false }
        func samples(_ data: Data) -> [Double] {
            data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
                stride(from: 0, to: bytes.count - 1, by: 2).map {
                    Double(Int16(bitPattern: UInt16(bytes[$0]) | UInt16(bytes[$0 + 1]) << 8)) / 32768
                }
            }
        }
        let near = Array(samples(input).suffix(sampleCount))
        let far = samples(reference)
        let energy = stride(from: 0, to: sampleCount, by: 4).reduce(0.0) { $0 + near[$1] * near[$1] }
        guard energy > 0.0001 else { return false }
        for offset in stride(from: 0, through: far.count - sampleCount, by: 8) {
            var cross = 0.0, farEnergy = 0.0
            for i in stride(from: 0, to: sampleCount, by: 4) { cross += near[i] * far[offset + i]; farEnergy += far[offset + i] * far[offset + i] }
            if farEnergy > 0.0001, abs(cross) / sqrt(energy * farEnergy) > 0.72 { return true }
        }
        return false
    }
}

struct VoiceSpeechDecision {
    private var lastEnd = 0.0
    private var consecutive = 0
    mutating func accept(confidence: Double, end: Double, capturedSeconds: Double, echo: Bool, level: Double) -> Bool {
        if echo || level < 0.008 { consecutive = 0 }
        guard end.isFinite, confidence.isFinite, end > lastEnd else { return false }
        let continuous = end - lastEnd <= 0.4
        lastEnd = end
        guard !echo, level >= 0.008, capturedSeconds - end >= -0.05, capturedSeconds - end <= 0.5, confidence >= 0.85 else {
            consecutive = 0; return false
        }
        consecutive = continuous ? consecutive + 1 : 1
        return consecutive >= 2
    }
}

struct VoiceHandsFreeTurn {
    private(set) var context = HarnessVoiceContext()
    private(set) var generation = -1
    private(set) var consumed = false
    private(set) var preRoll = VoicePCMWindow(limit: 32_000)
    mutating func begin(context: HarnessVoiceContext, generation: Int) {
        self.context = context; self.generation = generation; consumed = false; preRoll.clear()
    }
    mutating func observe(_ pcm: Data, echo: Bool) {
        if echo { preRoll.clear() } else { preRoll.append(pcm) }
    }
    mutating func interrupt(generation: Int, speech: Bool) -> (HarnessVoiceContext, Data)? {
        guard self.generation == generation, !consumed, speech else { return nil }
        consumed = true
        let bytes = preRoll.bytes
        preRoll.clear()
        return (context, bytes)
    }
    mutating func answer(generation: Int, drain: VoicePlaybackDrain) -> HarnessVoiceContext? {
        guard self.generation == generation, !consumed, context.question != nil, drain.finished, drain.receivedAudio else { return nil }
        consumed = true; preRoll.clear()
        return context
    }
    mutating func cancel() { generation = -1; consumed = true; preRoll.clear() }
}
