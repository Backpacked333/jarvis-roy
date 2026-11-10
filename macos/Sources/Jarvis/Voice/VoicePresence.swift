import Foundation

/// The words shown beside the voice control. They describe what the voice
/// service reports, in plain language, and never imply more than it reports.
enum VoicePresence {
    static func label(state: HarnessVoiceState, consent: Bool, dictationPaused: Bool = false) -> String {
        guard consent else { return "Voice off" }
        if dictationPaused { return "Dictation paused" }
        switch state {
        case .connecting: return "Connecting"
        case .listening: return "Listening"
        case .thinking: return "Thinking"
        case .speaking: return "Speaking"
        case .idle: return "Ready"
        case .interrupted: return "Paused"
        case .unavailable: return "Voice unavailable"
        }
    }

    static func symbol(state: HarnessVoiceState, consent: Bool) -> String {
        guard consent else { return "mic.slash" }
        switch state {
        case .listening: return "waveform"
        case .speaking: return "speaker.wave.2.fill"
        case .unavailable: return "mic.slash"
        default: return "mic.fill"
        }
    }

    /// What pressing the single microphone control does next.
    enum MicAction: Equatable { case askConsent, finish, interruptAndListen, listen }
    static func micAction(consent: Bool, listening: Bool, dictationActive: Bool, speaking: Bool) -> MicAction {
        guard consent else { return .askConsent }
        if listening || dictationActive { return .finish }
        return speaking ? .interruptAndListen : .listen
    }

    static func micHelp(_ action: MicAction) -> String {
        switch action {
        case .askConsent: return "Talk to Jarvis. You will be asked before any audio leaves this Mac."
        case .finish: return "Finish and send what you said"
        case .interruptAndListen: return "Interrupt Jarvis and speak"
        case .listen: return "Talk to Jarvis"
        }
    }

    /// The speech model as the voice service reported it, or nil before the
    /// service has reported one.
    static func modelLabel(_ reported: String?) -> String? {
        guard let value = reported?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty, value.utf16.count <= 80 else { return nil }
        return value
    }
}

/// The disclosures shown before cloud voice and hands-free are enabled. Every
/// entry point presents these exact words.
enum VoiceDisclosure {
    static let cloudTitle = "Allow ElevenLabs voice for this session?"
    static let cloudMessage = "Active command microphone audio is uploaded to ElevenLabs Scribe, and spoken reply text goes to Eleven v4 Turbo. Provider charges apply. Never speak passwords or API keys. This permission resets when Jarvis quits; there is no fallback voice. Hands-free capture requires its own opt-in."
    static let cloudAllow = "Allow cloud voice"
    static let handsFreeTitle = "Enable hands-free conversation?"
    static let handsFreeMessage = "During replies, your microphone runs locally with echo cancellation and speech detection. Detected interruption starts a fresh ElevenLabs capture. After a reply or exact clarification finishes playing, a bounded cloud answer window opens automatically; silence closes it after eight seconds. Completed speech is submitted only to the captured conversation or question. Spoken yes never approves sensitive actions. Mute stops capture and disables hands-free. Wake listening is separate. Unsupported hardware fails closed."
    static let handsFreeAllow = "Enable hands-free"
}
