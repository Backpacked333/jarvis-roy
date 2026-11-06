import Foundation

enum HarnessVoiceState: String, Codable {
    case connecting, listening, thinking, speaking, idle, interrupted, unavailable
}

struct HarnessVoiceContext: Codable, Equatable {
    @HarnessNullable var roomId: String? = nil
    @HarnessNullable var conversationId: String? = nil
    @HarnessNullable var question: HarnessQuestionBinding? = nil
}
struct HarnessVoiceStatus: Codable, Equatable {
    var version: Int
    var provider, model, recognitionModel, status: String
    @HarnessNullable var reason: String? = nil
}
struct HarnessVoiceClientFrame: Encodable {
    var version = 1
    var sessionId: String
    var generation: Int
    var type: String
    var context: HarnessVoiceContext? = nil
    var cloudConsent: Bool? = nil
    var sequence: Int? = nil
    var pcm: String? = nil
    var sampleRate: Int? = nil
    var text: String? = nil
    var final: Bool? = nil
}
struct HarnessVoiceServerFrame: Decodable {
    var version: Int
    var sessionId: String
    var generation: Int
    var type: String
    var state: HarnessVoiceState?
    var detail: String?
    var text: String?
    var final: Bool?
    var context: HarnessVoiceContext?
    var sequence: Int?
    var pcm: String?
    var sampleRate: Int?
    var code: String?
    var message: String?
    var retryable: Bool?
}
struct HarnessVoiceUtterance: Equatable {
    var text: String
    var context: HarnessVoiceContext
    var sessionId: String
    var generation: Int
}
struct HarnessAudioLevels: Equatable {
    var inputRMS: Double
    var playbackRMS: Double
    var generation: Int
}

@MainActor
protocol HarnessVoiceControlling: AnyObject {
    var onUtterance: ((HarnessVoiceUtterance) -> Void)? { get set }
    var onAudioLevels: ((HarnessAudioLevels) -> Void)? { get set }
    var onStateChange: ((HarnessVoiceState) -> Void)? { get set }
    var contextProvider: (() -> HarnessVoiceContext)? { get set }
    func speak(_ text: String, context: HarnessVoiceContext)
    func interrupt()
    func startListening() async
    func stopListening()
}
