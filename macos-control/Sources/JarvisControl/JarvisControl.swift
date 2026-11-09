import AppKit
import Foundation
import Darwin

@main
struct JarvisControl {
    @MainActor
    static func main() async {
        // Also bounds a stalled stdin reader or nonresponsive OS service.
        let watchdog = DispatchWorkItem { _exit(124) }
        DispatchQueue.global().asyncAfter(deadline: .now() + 11, execute: watchdog)
        do {
            let request = try readRequest()
            let requestingCalendarAccess = request.operation == "request_calendar_access"
            if requestingCalendarAccess {
                // An explicit settings action may wait for the operator's OS
                // permission decision. Ordinary reads retain their short bound.
                watchdog.cancel()
                DispatchQueue.global().asyncAfter(deadline: .now() + 92) {
                    emit(["ok": false, "error": ["code": "CALENDAR_PERMISSION_TIMEOUT",
                         "message": "Calendar permission request timed out. Respond to the macOS prompt, then explicitly retry calendar setup."]])
                    _exit(124)
                }
            }
            let deadline = Deadline(seconds: requestingCalendarAccess ? 90 : 10)
            let result: [String: Any]
            switch request.operation {
            case "read_screen": result = try await readScreen(deadline: deadline)
            case "list_windows": result = try await listWindows(request, deadline: deadline)
            case "read_window": result = try await readWindow(request, deadline: deadline)
            case "list_calendars": result = try listCalendars(deadline: deadline)
            case "list_calendar_events": result = try listCalendarEvents(request, deadline: deadline)
            case "request_calendar_access": result = try await requestCalendarAccess(deadline: deadline)
            case "inspect_app":
                try requireAccessibility()
                let app = try runningApplication(bundleId: request.validatedBundleId())
                result = try inspectApplication(app, deadline: deadline).response
            case "control_app":
                try requireAccessibility()
                result = try await controlApplication(request, deadline: deadline)
            default: throw ControlFailure("UNSUPPORTED_OPERATION", "Supported operations: read_screen, list_windows, read_window, list_calendars, list_calendar_events, request_calendar_access, inspect_app, control_app. There is no script interpreter.")
            }
            emit(["ok": true, "result": result])
        } catch let failure as ControlFailure {
            emit(["ok": false, "error": ["code": failure.code, "message": failure.message]])
        } catch {
            emit(["ok": false, "error": ["code": "NATIVE_FAILURE", "message": "The native operation failed. No successful effect is confirmed; check permissions and inspect again before retrying."]])
        }
    }
}
