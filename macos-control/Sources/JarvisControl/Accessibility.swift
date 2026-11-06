import AppKit
import ApplicationServices
import CryptoKit

func requireAccessibility() throws {
    guard AXIsProcessTrusted() else {
        throw ControlFailure("ACCESSIBILITY_PERMISSION", "Accessibility permission is not granted. Enable the signed Jarvis app/helper or launching terminal in System Settings → Privacy & Security → Accessibility, then relaunch. No permission bypass is attempted.")
    }
}

@MainActor
func runningApplication(bundleId: String) throws -> NSRunningApplication {
    let matches = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).filter { !$0.isTerminated }
    guard matches.count == 1, let app = matches.first, app.bundleIdentifier == bundleId, app.launchDate != nil else {
        throw ControlFailure("APP_UNAVAILABLE", "The explicit bundleId must identify exactly one running application. Focus/launch it first; multiple instances and apps without a launch identity are refused.")
    }
    return app
}

func attribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
    var result: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &result)
    return try checkedAttributeValue(result, name: name, status: status)
}

func checkedAttributeValue(_ result: CFTypeRef?, name: String, status: AXError) throws -> CFTypeRef? {
    if status == .noValue || status == .attributeUnsupported { return nil }
    // Some native controls advertise AXDescription but fail to provide it.
    if name == kAXDescriptionAttribute && status == .failure { return nil }
    guard status == .success else {
        throw ControlFailure("AX_UNAVAILABLE", "The application could not read \(name) (Accessibility error \(status.rawValue)). Check Accessibility permission, focus the app, and inspect again. Not every app supports these controls.")
    }
    return result
}

func stringAttribute(_ element: AXUIElement, _ name: String) throws -> String {
    guard let value = try attribute(element, name) else { return "" }
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number.stringValue }
    return ""
}

func sha(_ value: Data) -> String { SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined() }

func children(_ element: AXUIElement) throws -> (items: [AXUIElement], count: Int) {
    var count: CFIndex = 0
    let status = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
    if status == .noValue || status == .attributeUnsupported { return ([], 0) }
    guard status == .success, count >= 0 else { throw ControlFailure("AX_TREE_CHANGED", "The accessible tree changed or is unavailable. Inspect again.") }
    if count == 0 { return ([], 0) }
    var values: CFArray?
    guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, min(count, 100), &values) == .success,
          let raw = values as? [AXUIElement] else {
        throw ControlFailure("AX_TREE_CHANGED", "The accessible children changed or are unavailable. Inspect again.")
    }
    return (raw, count)
}

struct ObservedNode {
    let element: AXUIElement
    let path: [Int]
    let role: String
    let label: String
    let value: String
    let secure: Bool
    let fingerprint: String
    var id: String { "root" + path.map { "/\($0)" }.joined() }
    var response: [String: Any] {
        ["elementId": id, "path": path, "role": boundedString(role), "label": boundedString(label), "value": boundedString(value), "secure": secure]
    }
}

struct Inspection {
    let bundleId: String
    let pid: Int32
    let launchTimestamp: Double
    let nodes: [ObservedNode]
    let truncated: Bool
    let digests: ObservationDigests
    var response: [String: Any] {
        ["kind": "inspection", "bundleId": bundleId, "processId": pid, "launchTimestamp": launchTimestamp,
         "treeDigest": digests.tree, "elements": nodes.map { node in
             var result = node.response
             result["validationDigest"] = digests.forTarget(node.path)
             return result
         }, "truncated": truncated]
    }
}

struct ObservationDigests {
    let tree: String
    let content: String
    private let menuPaths: [[Int]]

    init(elements: [(path: [Int], role: String, fingerprint: String)]) {
        let menus = elements.filter { ["AXMenuBar", "AXMenu", "AXMenuItem"].contains($0.role) }.map { $0.path }
        menuPaths = menus
        tree = sha(Data(elements.map { $0.fingerprint }.joined(separator: ":").utf8))
        // Menus update independently of document controls, even while the app is idle.
        let contentElements = elements.filter { element in !menus.contains { element.path.starts(with: $0) } }
        content = sha(Data(contentElements.map { $0.fingerprint }.joined(separator: ":").utf8))
    }

    func forTarget(_ path: [Int]) -> String {
        menuPaths.contains { path.starts(with: $0) } ? tree : content
    }
}

func geometry(_ element: AXUIElement) throws -> [Double] {
    var position = CGPoint.zero
    var size = CGSize.zero
    if let raw = try attribute(element, kAXPositionAttribute), CFGetTypeID(raw) == AXValueGetTypeID() {
        let value = unsafeBitCast(raw, to: AXValue.self)
        if AXValueGetType(value) == .cgPoint { AXValueGetValue(value, .cgPoint, &position) }
    }
    if let raw = try attribute(element, kAXSizeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() {
        let value = unsafeBitCast(raw, to: AXValue.self)
        if AXValueGetType(value) == .cgSize { AXValueGetValue(value, .cgSize, &size) }
    }
    return [Double(position.x), Double(position.y), Double(size.width), Double(size.height)]
}

func observeNode(_ element: AXUIElement, path: [Int], childCount: Int) throws -> ObservedNode {
    let role = try stringAttribute(element, kAXRoleAttribute)
    let subrole = try stringAttribute(element, kAXSubroleAttribute)
    let secure = subrole == "AXSecureTextField" || role == "AXSecureTextField"
    let title = try stringAttribute(element, kAXTitleAttribute)
    let label = try stringAttribute(element, kAXDescriptionAttribute)
    let value: String
    if secure { value = "[SECURE VALUE OMITTED]" }
    else { value = try stringAttribute(element, kAXValueAttribute) }
    let identifier = try stringAttribute(element, kAXIdentifierAttribute)
    let enabled = try stringAttribute(element, kAXEnabledAttribute)
    let fingerprint = try JSONSerialization.data(withJSONObject: [
        "path": path, "role": role, "subrole": subrole, "title": sha(Data(title.utf8)), "label": sha(Data(label.utf8)),
        "value": sha(Data(value.utf8)), "identifier": sha(Data(identifier.utf8)), "children": childCount,
        "enabled": enabled, "geometry": try geometry(element)
    ], options: [.sortedKeys])
    return ObservedNode(element: element, path: path, role: role, label: title.isEmpty ? label : title,
                        value: value, secure: secure, fingerprint: sha(fingerprint))
}

@MainActor
func inspectApplication(_ app: NSRunningApplication, deadline: Deadline) throws -> Inspection {
    guard !app.isTerminated, let bundleId = app.bundleIdentifier, let launch = app.launchDate else {
        throw ControlFailure("APP_CHANGED", "Application identity changed; inspect again.")
    }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.5)
    var nodes: [ObservedNode] = []
    var truncated = false
    func visit(_ element: AXUIElement, path: [Int]) throws {
        try deadline.check()
        if nodes.count >= 200 { truncated = true; return }
        let childList = try children(element)
        nodes.append(try observeNode(element, path: path, childCount: childList.count))
        if childList.count > childList.items.count { truncated = true }
        if path.count >= 8 { if childList.count > 0 { truncated = true }; return }
        for (index, child) in childList.items.enumerated() {
            if nodes.count >= 200 { truncated = true; break }
            // Cyclic or repeated AX references are not safe action targets.
            if nodes.contains(where: { CFEqual($0.element, child) }) { truncated = true; continue }
            try visit(child, path: path + [index])
        }
    }
    try visit(root, path: [])
    guard !app.isTerminated else { throw ControlFailure("APP_CHANGED", "The application exited while reading its tree. Inspect again.") }
    return Inspection(bundleId: bundleId, pid: app.processIdentifier, launchTimestamp: launch.timeIntervalSince1970,
                      nodes: nodes, truncated: truncated,
                      digests: ObservationDigests(elements: nodes.map { (path: $0.path, role: $0.role, fingerprint: $0.fingerprint) }))
}

func resolve(_ root: AXUIElement, path: [Int], deadline: Deadline) throws -> AXUIElement {
    var element = root
    for index in path {
        try deadline.check()
        let list = try children(element)
        guard index >= 0, index < list.items.count else { throw ControlFailure("STALE_TARGET", "The element path changed. Inspect again.") }
        element = list.items[index]
    }
    return element
}

@MainActor
func verifyIdentity(_ app: NSRunningApplication, _ request: Request, requireFrontmost: Bool = true) throws {
    guard !app.isTerminated, app.bundleIdentifier == request.bundleId,
          app.processIdentifier == request.expectedProcessId,
          app.launchDate?.timeIntervalSince1970 == request.expectedLaunchTimestamp else {
        throw ControlFailure("STALE_APP", "The application restarted or changed identity. Inspect again.")
    }
    guard !requireFrontmost || NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
        throw ControlFailure("APP_NOT_FRONTMOST", "Focus the explicit app, then inspect it again before controlling an element. Jarvis will not send keys to a different app.")
    }
}

@MainActor
func activateApprovedApplication(_ app: NSRunningApplication, deadline: Deadline) async throws {
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return }
    guard app.activate(options: [.activateAllWindows]) else {
        throw ControlFailure("FOCUS_FAILED", "The approved application did not accept activation. No element action was performed.")
    }
    for _ in 0..<20 {
        try deadline.check()
        guard !app.isTerminated else { throw ControlFailure("APP_CHANGED", "The approved application exited during activation. Inspect again.") }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return }
        try await Task.sleep(nanoseconds: 50_000_000)
    }
    throw ControlFailure("FOCUS_FAILED", "The approved application did not become frontmost. No element action was performed.")
}

@MainActor
func controlApplication(_ request: Request, deadline: Deadline) async throws -> [String: Any] {
    let bundleId = try request.validatedBundleId()
    if request.action == "focus" {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
            throw ControlFailure("APP_NOT_INSTALLED", "No installed application matches that bundleId.")
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        let app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
        try deadline.check()
        guard app.bundleIdentifier == bundleId, !app.isTerminated else { throw ControlFailure("APP_CHANGED", "The launched app did not match the requested bundleId.") }
        try await activateApprovedApplication(app, deadline: deadline)
        return ["kind": "control", "action": "focus", "bundleId": bundleId]
    }
    guard let action = request.action, ["click", "set_text", "press_key"].contains(action),
          let path = request.path, path.count <= 8, path.allSatisfy({ $0 >= 0 && $0 < 100 }),
          let expectedDigest = request.expectedTreeDigest, expectedDigest.count == 64 else {
        throw ControlFailure("INVALID_TARGET", "An observation-bound element path, process identity and tree digest are required.")
    }
    let app = try runningApplication(bundleId: bundleId)
    try verifyIdentity(app, request, requireFrontmost: false)
    try await activateApprovedApplication(app, deadline: deadline)
    try verifyIdentity(app, request)
    let inspection = try inspectApplication(app, deadline: deadline)
    guard let node = inspection.nodes.first(where: { $0.path == path }), !node.secure,
          inspection.digests.forTarget(path) == expectedDigest else {
        throw ControlFailure("STALE_TARGET", "The target's validation scope changed or is secure. Window controls require unchanged non-menu content; menu targets require the full tree. The approved app may have been activated, but no element action was performed. Inspect again.")
    }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.5)
    let target = try resolve(root, path: path, deadline: deadline)
    let current = try observeNode(target, path: path, childCount: children(target).count)
    guard CFEqual(target, node.element), current.fingerprint == node.fingerprint, !current.secure else {
        throw ControlFailure("STALE_TARGET", "The target changed during validation. Inspect again; no action was performed.")
    }
    var targetPid: pid_t = 0
    guard AXUIElementGetPid(target, &targetPid) == .success, targetPid == app.processIdentifier else {
        throw ControlFailure("STALE_TARGET", "The target belongs to a different process. Inspect again.")
    }
    try deadline.check()
    try verifyIdentity(app, request)
    switch action {
    case "click":
        var actions: CFArray?
        guard AXUIElementCopyActionNames(target, &actions) == .success,
              let names = actions as? [String], names.contains(kAXPressAction) else {
            throw ControlFailure("UNSUPPORTED_CONTROL", "This element does not support AXPress. Jarvis does not fall back to coordinate clicks.")
        }
        guard AXUIElementPerformAction(target, kAXPressAction as CFString) == .success else {
            throw ControlFailure("ACTION_FAILED", "The app did not confirm AXPress. Inspect again before retrying; an effect may already have occurred.")
        }
    case "set_text":
        guard let text = request.text, text.utf16.count <= 4096, !text.contains("\0") else { throw ControlFailure("INVALID_TEXT", "Text must be at most 4096 UTF-16 units without NUL.") }
        var settable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(target, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else {
            throw ControlFailure("UNSUPPORTED_CONTROL", "The observed element does not expose a settable AXValue.")
        }
        guard AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, text as CFString) == .success else {
            throw ControlFailure("ACTION_FAILED", "The app did not confirm setting text. Inspect again before retrying.")
        }
    case "press_key":
        try pressKey(request, target: target, app: app)
    default: throw ControlFailure("UNSUPPORTED_ACTION", "Unsupported action.")
    }
    return ["kind": "control", "action": action, "bundleId": bundleId]
}

@MainActor
func pressKey(_ request: Request, target: AXUIElement, app: NSRunningApplication) throws {
    let keys: [String: CGKeyCode] = ["return": 36, "tab": 48, "escape": 53, "space": 49, "backspace": 51,
        "delete": 117, "left": 123, "right": 124, "up": 126, "down": 125, "home": 115, "end": 119,
        "page_up": 116, "page_down": 121]
    guard let key = request.key, let code = keys[key], let modifiers = request.modifiers,
          modifiers.count <= 4, modifiers.allSatisfy({ ["command", "shift", "option", "control"].contains($0) }) else {
        throw ControlFailure("UNSUPPORTED_KEY", "Use a supported named key and command/shift/option/control modifiers.")
    }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.5)
    guard let focused = try attribute(root, kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, target) else {
        throw ControlFailure("TARGET_NOT_FOCUSED", "The observed target is not the app's focused element. Click/focus it and inspect again; keys will not be sent to another control.")
    }
    var flags: CGEventFlags = []
    if modifiers.contains("command") { flags.insert(.maskCommand) }
    if modifiers.contains("shift") { flags.insert(.maskShift) }
    if modifiers.contains("option") { flags.insert(.maskAlternate) }
    if modifiers.contains("control") { flags.insert(.maskControl) }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
        throw ControlFailure("KEY_FAILED", "Could not create the requested key events.")
    }
    down.flags = flags
    up.flags = flags
    try verifyIdentity(app, request)
    down.postToPid(app.processIdentifier)
    up.postToPid(app.processIdentifier)
}
