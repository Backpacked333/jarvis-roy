import Foundation

enum VoicePausePolicy {
    static func seconds(mode: VoiceCaptureMode, defaults: UserDefaults = .standard) -> TimeInterval {
        let key = mode == .conversation ? "Jarvis.conversationPauseSeconds" : "Jarvis.dictationPauseSeconds"
        let configured = defaults.object(forKey: key) as? Double
        return clamped(configured ?? mode.silenceSeconds, mode: mode)
    }
    static func clamped(_ value: Double, mode: VoiceCaptureMode) -> Double {
        guard value.isFinite else { return mode.silenceSeconds }
        return mode == .conversation ? min(4, max(0.6, value)) : min(15, max(3, value))
    }
}

/// Provider captures are short; one explicit dictation retains its initial
/// utterance identity and focus across independently fenced capture generations.
struct VoiceDictation {
    let id = UUID()
    let root: HarnessVoiceUtterance
    let startedAt: TimeInterval
    private(set) var text = ""
    private(set) var segments = 0
    static let maximumCharacters = 16_000
    static let maximumSeconds: TimeInterval = 480
    mutating func append(_ utterance: HarnessVoiceUtterance) throws {
        guard utterance.context == root.context, segments < 16 else { throw VoiceTransportError.invalidFrame }
        let addition = utterance.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let combined = text.isEmpty ? addition : addition.isEmpty ? text : text + "\n\n" + addition
        guard combined.utf16.count <= Self.maximumCharacters else { throw VoiceTransportError.overflow }
        text = combined; segments += 1
    }
    func mayContinue(at now: TimeInterval) -> Bool {
        now >= startedAt && now - startedAt < Self.maximumSeconds && segments < 16 && text.utf16.count < Self.maximumCharacters
    }
    var utterance: HarnessVoiceUtterance {
        .init(text: text, context: root.context, sessionId: root.sessionId, generation: root.generation)
    }
    func preview(_ partial: String) -> String { text.isEmpty ? partial : partial.isEmpty ? text : text + "\n\n" + partial }
}

/// A successful preflight is reused briefly; server-side validation remains
/// authoritative on every generation. Failure/disconnect always clears it.
struct VoiceProviderPreflight {
    private var checkedAt: TimeInterval?
    mutating func verified(at time: TimeInterval) { if time.isFinite { checkedAt = time } }
    mutating func reset() { checkedAt = nil }
    func reusable(at time: TimeInterval) -> Bool {
        guard let checkedAt else { return false }
        return time.isFinite && time >= checkedAt && time - checkedAt < 30
    }
}
