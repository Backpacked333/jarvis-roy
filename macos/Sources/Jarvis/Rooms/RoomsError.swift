import Foundation

enum RoomsError: LocalizedError, Equatable {
    case configuration, invalidResponse, unsupportedVersion, tooLarge, invalidPath, integrity
    case conflict(String), service(Int, String), invalid(String)

    var errorDescription: String? {
        switch self {
        case .configuration: return "Start Jarvis with scripts/run-macos.sh to connect the authenticated local service."
        case .invalidResponse: return "The local service returned an invalid or out-of-scope response."
        case .unsupportedVersion: return "This harness protocol is not supported. Update the app and runtime together."
        case .tooLarge: return "The response exceeds the safe download limit."
        case .invalidPath: return "The artifact path or identifier is not safe."
        case .integrity: return "The downloaded file does not match its immutable manifest. Nothing was opened."
        case .conflict(let detail): return "The target changed. Refresh and review it again. \(detail)"
        case .service(_, let detail), .invalid(let detail): return detail
        }
    }
}
