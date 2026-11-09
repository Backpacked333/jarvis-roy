import Foundation
import Darwin

struct ControlFailure: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

struct Request: Decodable {
    let version: Int
    let operation: String
    let bundleId: String?
    let action: String?
    let expectedProcessId: Int32?
    let expectedLaunchTimestamp: Double?
    let expectedTreeDigest: String?
    let path: [Int]?
    let text: String?
    let key: String?
    let modifiers: [String]?
    let windowId: UInt32?
    let calendarId: String?
    let start: String?
    let end: String?
    let limit: Int?
    let embeddingLanguage: String?
    let texts: [String]?

    func validatedBundleId() throws -> String {
        guard let id = bundleId, id.utf8.count <= 255,
              id.range(of: "^[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+$", options: .regularExpression) != nil else {
            throw ControlFailure("INVALID_REQUEST", "An explicit application bundle identifier is required.")
        }
        return id
    }
}

final class Deadline {
    private let end: TimeInterval
    init(seconds: TimeInterval = 10) { end = ProcessInfo.processInfo.systemUptime + seconds }
    func check() throws {
        if ProcessInfo.processInfo.systemUptime >= end {
            throw ControlFailure("TIMEOUT", "Native action exceeded its deadline. Inspect again before retrying; effects already performed cannot be rolled back.")
        }
    }
}

func boundedString(_ value: String, limit: Int = 256) -> String { String(value.prefix(limit)) }

// JSON consumers validate string length in UTF-16 code units. Preserve complete
// characters while keeping non-ASCII titles inside the same wire bound.
func boundedWireString(_ value: String, limit: Int) -> String {
    var result = ""
    var count = 0
    for character in value {
        let text = String(character)
        guard count + text.utf16.count <= limit else { break }
        result += text
        count += text.utf16.count
    }
    return result
}

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), data.count <= 524_288 else {
        FileHandle.standardOutput.write(Data("{\"ok\":false,\"error\":{\"code\":\"OUTPUT_LIMIT\",\"message\":\"Native response exceeded its bound.\"}}\n".utf8))
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

func readRequest() throws -> Request {
    var data = Data()
    while true {
        let next = FileHandle.standardInput.readData(ofLength: min(4096, 65_537 - data.count))
        if next.isEmpty { break }
        data.append(next)
        if data.count > 65_536 { throw ControlFailure("INPUT_LIMIT", "Request exceeds 65536 bytes.") }
    }
    guard let request = try? JSONDecoder().decode(Request.self, from: data), request.version == 1 else {
        throw ControlFailure("INVALID_REQUEST", "Expected one version-1 JSON request on stdin followed by EOF.")
    }
    return request
}
