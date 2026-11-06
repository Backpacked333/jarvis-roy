import AppKit
import CoreGraphics
import ScreenCaptureKit
import Vision

@MainActor
func readScreen(deadline: Deadline) async throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else {
        throw ControlFailure("SCREEN_PERMISSION", "Screen Recording permission is not granted. Enable the signed Jarvis app/helper or launching terminal under System Settings → Privacy & Security → Screen & System Audio Recording (Screen Recording on macOS 14), then relaunch. Jarvis does not bypass or automatically grant permission.")
    }
    try deadline.check()
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
        throw ControlFailure("SCREEN_UNAVAILABLE", "The main display is unavailable. Unlock the Mac and connect a display before retrying.")
    }
    let configuration = SCStreamConfiguration()
    let scale = min(1.0, 4096.0 / Double(max(display.width, display.height)))
    configuration.width = max(1, Int(Double(display.width) * scale))
    configuration.height = max(1, Int(Double(display.height) * scale))
    configuration.showsCursor = false
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    try deadline.check()
    let recognition = VNRecognizeTextRequest()
    recognition.recognitionLevel = .accurate
    recognition.usesLanguageCorrection = false
    do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([recognition]) }
    catch { throw ControlFailure("OCR_FAILED", "Vision could not recognize text in the main display capture. No screenshot was saved.") }
    try deadline.check()
    var lines: [String] = []
    var remaining = 8192
    var truncated = false
    for observation in recognition.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string
        if text.count + 1 > remaining { truncated = true }
        let line = String(text.prefix(max(0, remaining - 1)))
        if !line.isEmpty { lines.append(line); remaining -= line.count + 1 }
        if remaining <= 1 { truncated = true; break }
    }
    return ["kind": "screen", "text": lines.joined(separator: "\n"), "truncated": truncated, "contentLabel": "UNTRUSTED SCREEN CONTENT"]
}
