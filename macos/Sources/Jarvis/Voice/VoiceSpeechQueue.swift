import Foundation

enum VoiceCaptureMode: String, CaseIterable, Identifiable {
    case conversation, dictation
    var id: String { rawValue }
    var title: String { self == .conversation ? "Conversation" : "Extended dictation" }
    var silenceSeconds: TimeInterval { self == .conversation ? 1.2 : 4 }
    var maximumSeconds: TimeInterval { self == .conversation ? 45 : 75 }
}

/// Text is admitted before playback. The UI retains the complete document even
/// when a spoken stream exceeds its independent bounded queue.
struct VoiceSpeechQueue {
    private(set) var streamID: String?
    private(set) var context = HarnessVoiceContext()
    private(set) var finished = false
    private(set) var acceptedCharacters = 0
    private var segments: [String] = []

    mutating func begin(id: String, context: HarnessVoiceContext) {
        self = VoiceSpeechQueue()
        streamID = id
        self.context = context
    }

    mutating func append(id: String, text: String) throws {
        guard streamID == id, !finished, acceptedCharacters + text.utf16.count <= 32_000 else {
            throw VoiceTransportError.overflow
        }
        let chunks = Self.split(text)
        guard segments.count + chunks.count <= 32, chunks.allSatisfy({ $0.utf16.count <= 3_800 }) else { throw VoiceTransportError.overflow }
        acceptedCharacters += text.utf16.count
        segments.append(contentsOf: chunks)
    }

    mutating func end(id: String) throws {
        guard streamID == id, !finished else { throw VoiceTransportError.invalidFrame }
        finished = true
    }

    mutating func next() -> String? { segments.isEmpty ? nil : segments.removeFirst() }
    var isEmpty: Bool { segments.isEmpty }
    mutating func cancel() { self = VoiceSpeechQueue() }

    static func split(_ text: String, maximum: Int = 3_800) -> [String] {
        guard maximum > 0 else { return [] }
        var result: [String] = []
        var buffer = "", count = 0
        // Character boundaries preserve graphemes; UTF-16 limits match native
        // validation and remain below the provider's 4,000-character envelope.
        for character in text {
            let length = String(character).utf16.count
            if count + length > maximum, !buffer.isEmpty {
                result.append(buffer); buffer = ""; count = 0
            }
            buffer.append(character); count += length
        }
        if !buffer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { result.append(buffer) }
        return result
    }
}
