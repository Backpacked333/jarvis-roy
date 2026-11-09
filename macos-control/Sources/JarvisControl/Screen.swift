import AppKit
import CoreGraphics
import ScreenCaptureKit
import Vision

func requireScreenCapture() throws {
    guard CGPreflightScreenCaptureAccess() else {
        throw ControlFailure("SCREEN_PERMISSION", "Screen Recording permission is not granted. Enable the signed Jarvis app/helper or launching terminal under System Settings → Privacy & Security → Screen & System Audio Recording (Screen Recording on macOS 14), then relaunch. Jarvis does not bypass or automatically grant permission.")
    }
}

struct WindowScope: Equatable {
    let bundleId: String
    let windowId: UInt32
    let processId: Int32
    let launchTimestamp: Double

    init(_ request: Request) throws {
        bundleId = try request.validatedBundleId()
        guard let id = request.windowId, id > 0,
              let pid = request.expectedProcessId, pid > 0,
              let launched = request.expectedLaunchTimestamp, launched.isFinite, launched > 0 else {
            throw ControlFailure("INVALID_REQUEST", "A window read requires the exact windowId, expectedProcessId and expectedLaunchTimestamp returned by list_windows.")
        }
        windowId = id; processId = pid; launchTimestamp = launched
    }

    func validate(bundleId: String?, windowId: UInt32, processId: Int32, launchTimestamp: Double?) throws {
        guard self.bundleId == bundleId, self.windowId == windowId,
              self.processId == processId, self.launchTimestamp == launchTimestamp else {
            throw ControlFailure("WINDOW_CHANGED", "The selected window or application identity changed. List windows again; no other window or main display was captured.")
        }
    }
}

@MainActor
func listWindows(_ request: Request, deadline: Deadline) async throws -> [String: Any] {
    let bundleId = try request.validatedBundleId()
    try requireScreenCapture()
    let app = try runningApplication(bundleId: bundleId)
    let pid = app.processIdentifier
    let launched = app.launchDate!.timeIntervalSince1970
    try deadline.check()
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    try deadline.check()
    let current = try runningApplication(bundleId: bundleId)
    guard current.processIdentifier == pid, current.launchDate?.timeIntervalSince1970 == launched else {
        throw ControlFailure("WINDOW_CHANGED", "The selected application restarted while listing windows. List windows again.")
    }
    let matches = content.windows.filter {
        $0.owningApplication?.bundleIdentifier == bundleId && $0.owningApplication?.processID == pid && $0.windowID > 0 &&
        $0.frame.origin.x.isFinite && $0.frame.origin.y.isFinite &&
        $0.frame.width.isFinite && $0.frame.height.isFinite && $0.frame.width > 0 && $0.frame.height > 0
    }.sorted { $0.windowID < $1.windowID }
    let windows: [[String: Any]] = matches.prefix(100).map { window in
        ["windowId": window.windowID, "title": boundedWireString(window.title ?? "", limit: 512),
         "onScreen": window.isOnScreen,
         "frame": ["x": window.frame.origin.x, "y": window.frame.origin.y,
                   "width": window.frame.width, "height": window.frame.height]]
    }
    return ["kind": "windows", "bundleId": bundleId, "processId": pid, "launchTimestamp": launched,
            "windows": windows, "truncated": matches.count > windows.count]
}

@MainActor
private func scopedWindow(_ scope: WindowScope, deadline: Deadline) async throws -> SCWindow {
    try deadline.check()
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    try deadline.check()
    let app = try runningApplication(bundleId: scope.bundleId)
    let matches = content.windows.filter { $0.windowID == scope.windowId }
    guard matches.count == 1, let window = matches.first, let owner = window.owningApplication else {
        throw ControlFailure("WINDOW_UNAVAILABLE", "The exact selected window is no longer available. List windows again; no fallback capture was made.")
    }
    try scope.validate(bundleId: owner.bundleIdentifier, windowId: window.windowID,
                       processId: owner.processID, launchTimestamp: app.launchDate?.timeIntervalSince1970)
    guard app.processIdentifier == owner.processID else {
        throw ControlFailure("WINDOW_CHANGED", "The selected window no longer belongs to the observed application process.")
    }
    return window
}

@MainActor
func readWindow(_ request: Request, deadline: Deadline) async throws -> [String: Any] {
    let scope = try WindowScope(request)
    try requireScreenCapture()
    let window = try await scopedWindow(scope, deadline: deadline)
    guard window.frame.width.isFinite, window.frame.height.isFinite,
          window.frame.width > 0, window.frame.height > 0 else {
        throw ControlFailure("WINDOW_UNAVAILABLE", "The selected window has no capturable area.")
    }
    let configuration = SCStreamConfiguration()
    let scale = min(2.0, 4096.0 / Double(max(window.frame.width, window.frame.height)))
    configuration.width = max(1, Int(Double(window.frame.width) * scale))
    configuration.height = max(1, Int(Double(window.frame.height) * scale))
    configuration.showsCursor = false
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    // Revalidate after capture and before returning content; closing/replacing the
    // selected window cannot silently substitute a different window or display.
    _ = try await scopedWindow(scope, deadline: deadline)
    let recognized = try recognizeText(image, deadline: deadline)
    return ["kind": "window", "bundleId": scope.bundleId, "windowId": scope.windowId,
            "processId": scope.processId, "launchTimestamp": scope.launchTimestamp,
            "text": recognized.text, "truncated": recognized.truncated, "contentLabel": "UNTRUSTED WINDOW CONTENT"]
}

@MainActor
func readScreen(deadline: Deadline) async throws -> [String: Any] {
    try requireScreenCapture()
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
    let recognized = try recognizeText(image, deadline: deadline)
    return ["kind": "screen", "text": recognized.text, "truncated": recognized.truncated, "contentLabel": "UNTRUSTED SCREEN CONTENT"]
}

func recognizeText(_ image: CGImage, deadline: Deadline) throws -> (text: String, truncated: Bool) {
    try deadline.check()
    let recognition = VNRecognizeTextRequest()
    recognition.recognitionLevel = .accurate
    recognition.usesLanguageCorrection = false
    do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([recognition]) }
    catch { throw ControlFailure("OCR_FAILED", "Vision could not recognize text in the selected capture. No screenshot was saved.") }
    try deadline.check()
    var lines: [String] = []
    var remaining = 8192
    var truncated = false
    for observation in recognition.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string
        if text.utf16.count + 1 > remaining { truncated = true }
        let line = boundedWireString(text, limit: max(0, remaining - 1))
        if !line.isEmpty { lines.append(line); remaining -= line.utf16.count + 1 }
        if remaining <= 1 { truncated = true; break }
    }
    return (lines.joined(separator: "\n"), truncated)
}
