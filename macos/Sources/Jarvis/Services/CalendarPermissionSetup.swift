import Foundation
import Combine

/// Invoked only from the user's explicit Settings button. Account reads never call this.
@MainActor
final class CalendarPermissionSetup: ObservableObject {
    @Published private(set) var isRequesting = false
    @Published private(set) var detail = "Calendar reads require Full Access for the JarvisControl helper."

    func request() async {
        guard !isRequesting else { return }
        isRequesting = true
        defer { isRequesting = false }
        let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/JarvisControl.app/Contents/MacOS/JarvisControl")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            detail = "Rebuild the Jarvis app to install its Calendar permission helper."
            return
        }
        let process = Process(), input = Pipe(), output = Pipe()
        process.executableURL = executable
        process.arguments = []
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
                               "HOME": FileManager.default.homeDirectoryForCurrentUser.path]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        detail = "Respond to the macOS Calendar permission prompt."
        do {
            try process.run()
            try input.fileHandleForWriting.write(contentsOf: Data("{\"version\":1,\"operation\":\"request_calendar_access\"}\n".utf8))
            try input.fileHandleForWriting.close()
            for _ in 0..<380 {
                if !process.isRunning { break }
                try await Task.sleep(nanoseconds: 250_000_000)
            }
            if process.isRunning {
                process.terminate()
                detail = "Calendar permission remains unconfirmed. Respond to the system prompt, then retry setup explicitly."
                return
            }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            guard data.count <= 8_192, let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                detail = "The Calendar helper returned an invalid setup result. Rebuild the app and retry."
                return
            }
            if envelope["ok"] as? Bool == true, let result = envelope["result"] as? [String: Any], result["kind"] as? String == "calendar_access" {
                detail = result["canRead"] as? Bool == true
                    ? "Calendar access is authorized. Select individual calendars in a read grant before Jarvis uses their content."
                    : "Calendar access is not authorized. Review JarvisControl in System Settings → Privacy & Security → Calendars."
            } else {
                detail = "Calendar setup was not confirmed. Review the system permission prompt or Calendar privacy settings, then retry explicitly."
            }
        } catch {
            if process.isRunning { process.terminate() }
            detail = "Calendar permission setup failed. Rebuild the bundled helper and retry from Settings."
        }
    }
}
