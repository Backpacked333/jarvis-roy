import AppKit
import Foundation
import Darwin

@main
struct JarvisControl {
    @MainActor
    static func main() async {
        // Also bounds a stalled stdin reader or nonresponsive OS service.
        DispatchQueue.global().asyncAfter(deadline: .now() + 11) { _exit(124) }
        do {
            let request = try readRequest()
            let deadline = Deadline()
            let result: [String: Any]
            switch request.operation {
            case "read_screen": result = try await readScreen(deadline: deadline)
            case "inspect_app":
                try requireAccessibility()
                let app = try runningApplication(bundleId: request.validatedBundleId())
                result = try inspectApplication(app, deadline: deadline).response
            case "control_app":
                try requireAccessibility()
                result = try await controlApplication(request, deadline: deadline)
            default: throw ControlFailure("UNSUPPORTED_OPERATION", "Supported operations: read_screen, inspect_app, control_app. There is no script interpreter.")
            }
            emit(["ok": true, "result": result])
        } catch let failure as ControlFailure {
            emit(["ok": false, "error": ["code": failure.code, "message": failure.message]])
        } catch {
            emit(["ok": false, "error": ["code": "NATIVE_FAILURE", "message": "The native operation failed. No successful effect is confirmed; check permissions and inspect again before retrying."]])
        }
    }
}
