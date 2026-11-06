import AVFoundation
import Speech
import SwiftUI

@MainActor
final class VoiceController: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published var isListening = false
    @Published var isSpeaking = false
    @Published var isRequestingPermission = false
    @Published var transcript = ""
    @Published var error: String?
    private let engine = AVAudioEngine()
    private let synthesizer = AVSpeechSynthesizer()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var hasTap = false
    private var generation = 0
    private var timeout: Task<Void, Never>?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func startListening() async {
        guard !isListening, !isRequestingPermission else { return }
        stopSpeaking()
        error = nil
        generation += 1
        let current = generation
        isRequestingPermission = true
        defer { isRequestingPermission = false }
        let authorized = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
        guard current == generation else { return }
        guard authorized else {
            error = "Speech recognition permission is off. Enable Jarvis in System Settings → Privacy & Security → Speech Recognition. Typing still works."
            return
        }
        let microphone = await AVCaptureDevice.requestAccess(for: .audio)
        guard current == generation else { return }
        guard microphone else {
            error = "Microphone permission is off. Enable Jarvis in System Settings → Privacy & Security → Microphone."
            return
        }
        guard let recognizer = SFSpeechRecognizer(locale: .current), recognizer.isAvailable,
              recognizer.supportsOnDeviceRecognition else {
            error = "On-device speech recognition is unavailable for your current language. No audio was sent to a cloud service. Use text input instead."
            return
        }
        self.recognizer = recognizer
        transcript = ""
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        self.request = request
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            error = "No usable microphone was found. Connect a microphone and try again."
            self.request = nil
            return
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        hasTap = true
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, failure in
            Task { @MainActor in
                guard let self, self.generation == current else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    if result.isFinal { self.stopListening() }
                }
                if let failure, self.isListening {
                    self.error = failure.localizedDescription
                    self.stopListening()
                }
            }
        }
        do {
            engine.prepare()
            try engine.start()
            isListening = true
            timeout = Task { [weak self] in
                try? await Task.sleep(for: .seconds(55))
                guard !Task.isCancelled else { return }
                self?.stopListening()
            }
        } catch {
            self.error = "Could not start the microphone: \(error.localizedDescription)"
            stopListening()
        }
    }

    func stopListening() {
        generation += 1
        timeout?.cancel()
        timeout = nil
        engine.stop()
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
        request?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        request = nil
        isListening = false
    }

    func speak(_ text: String) {
        guard !isListening, !isRequestingPermission else { return }
        stopSpeaking()
        guard !text.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: String(text.prefix(2400)))
        utterance.voice = AVSpeechSynthesisVoice(language: "en-GB")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        isSpeaking = true
        synthesizer.speak(utterance)
    }

    func stopSpeaking() {
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = self.synthesizer.isSpeaking }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = self.synthesizer.isSpeaking }
    }
}
