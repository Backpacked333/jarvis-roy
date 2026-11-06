import Foundation
import CryptoKit

@MainActor
protocol RoomsHTTPTransport {
    func send(_ request: URLRequest, limit: Int) async throws -> (Data, HTTPURLResponse)
}

private final class RoomsNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class RoomsURLTransport: RoomsHTTPTransport {
    private let session: URLSession
    private let delegate = RoomsNoRedirect()

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        configuration.httpMaximumConnectionsPerHost = 3
        session = URLSession(configuration: configuration)
    }

    func send(_ request: URLRequest, limit: Int) async throws -> (Data, HTTPURLResponse) {
        try await Self.read(request, limit: limit, session: session, delegate: delegate)
    }

    nonisolated private static func read(_ request: URLRequest, limit: Int, session: URLSession,
                                         delegate: RoomsNoRedirect) async throws -> (Data, HTTPURLResponse) {
        let (stream, response) = try await session.bytes(for: request, delegate: delegate)
        guard let response = response as? HTTPURLResponse, response.url == request.url else {
            stream.task.cancel()
            throw RoomsError.invalidResponse
        }
        guard response.expectedContentLength <= Int64(limit) else {
            stream.task.cancel()
            throw RoomsError.tooLarge
        }
        var data = Data()
        do {
            for try await byte in stream {
                guard data.count < limit else { throw RoomsError.tooLarge }
                data.append(byte)
                if data.count.isMultiple(of: 16_384) { try Task.checkCancellation() }
            }
        } catch {
            stream.task.cancel()
            throw error
        }
        return (data, response)
    }
}

@MainActor
struct HarnessClient: HarnessServing {
    private struct WireVersion: Decodable { let version: Int }
    private let token: String
    private let transport: any RoomsHTTPTransport
    private let base = "http://127.0.0.1:39202/v1/harness"

    init(token: String = ProcessInfo.processInfo.environment["JARVIS_LOCAL_TOKEN"] ?? "",
         transport: (any RoomsHTTPTransport)? = nil) {
        self.token = token
        self.transport = transport ?? RoomsURLTransport()
    }

    private func segment(_ value: String) throws -> String {
        guard value.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$", options: .regularExpression) != nil else {
            throw RoomsError.invalidPath
        }
        return value
    }

    private func roomPath(_ id: String) throws -> String { "/rooms/\(try segment(id))" }
    private func planPath(_ roomId: String, _ planId: String) throws -> String {
        "\(try roomPath(roomId))/plans/\(try segment(planId))"
    }
    private func runPath(_ roomId: String, _ runId: String) throws -> String {
        "\(try roomPath(roomId))/runs/\(try segment(runId))"
    }

    private func request(_ path: String, method: String = "GET", body: Data? = nil,
                         query: [URLQueryItem] = [], limit: Int = 8 * 1_024 * 1_024) async throws -> Data {
        guard token.count >= 32, !token.contains(where: { $0.isWhitespace }) else { throw RoomsError.configuration }
        guard var components = URLComponents(string: base + path) else { throw RoomsError.invalidPath }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw RoomsError.invalidPath }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let body {
            guard body.count <= 256 * 1_024 else { throw RoomsError.tooLarge }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await transport.send(request, limit: limit)
        guard data.count <= limit, response.url == url else { throw RoomsError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let envelope = try? JSONDecoder().decode([String: String].self, from: data)
            let detail = String((envelope?["error"] ?? "Local service error (\(response.statusCode)).")
                .replacingOccurrences(of: token, with: "[redacted]").prefix(2_000))
            if response.statusCode == 409 { throw RoomsError.conflict(detail) }
            throw RoomsError.service(response.statusCode, detail)
        }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data, versioned: Bool = true) throws -> T {
        if versioned {
            guard try JSONDecoder().decode(WireVersion.self, from: data).version == 1 else { throw RoomsError.unsupportedVersion }
        }
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw RoomsError.invalidResponse }
    }

    func state() async throws -> HarnessState {
        let value = try decode(HarnessState.self, await request("/state"))
        try RoomsStateRules.validate(value)
        return value
    }

    func events(after: Int, roomId: String?) async throws -> HarnessEvents {
        guard after >= 0 else { throw RoomsError.invalidResponse }
        var query = [URLQueryItem(name: "after", value: String(after))]
        if let roomId { query.append(.init(name: "roomId", value: try segment(roomId))) }
        let value = try decode(HarnessEvents.self, await request("/events", query: query, limit: 2 * 1_024 * 1_024))
        guard value.events.count <= 1_000, value.nextSequence >= 0,
              value.events.allSatisfy({ $0.version == 1 && $0.sequence <= value.nextSequence && $0.sequence >= 0 }) else {
            throw RoomsError.invalidResponse
        }
        return value
    }

    func createRoom(_ input: HarnessCreateRoomRequest) async throws -> HarnessRoom {
        try decode(HarnessRoom.self, await request("/rooms", method: "POST", body: JSONEncoder().encode(input)))
    }
    func updateRoom(_ roomId: String, input: HarnessUpdateRoomRequest) async throws -> HarnessRoom {
        try decode(HarnessRoom.self, await request(roomPath(roomId), method: "PATCH", body: JSONEncoder().encode(input)))
    }
    func authorPlan(_ roomId: String, input: HarnessAuthorPlanRequest) async throws -> HarnessAuthoring {
        try decode(HarnessAuthoring.self, await request("\(roomPath(roomId))/author", method: "POST", body: JSONEncoder().encode(input)), versioned: false)
    }
    func cancelAuthoring(_ roomId: String, authoringId: String, revision: Int) async throws -> HarnessAuthoring {
        try decode(HarnessAuthoring.self, await request("\(roomPath(roomId))/authorings/\(segment(authoringId))/cancel", method: "POST", body: JSONEncoder().encode(HarnessRevisionRequest(expectedRevision: revision))), versioned: false)
    }
    func updatePlan(_ roomId: String, planId: String, input: HarnessUpdatePlanRequest) async throws -> HarnessPlan {
        try decode(HarnessPlan.self, await request(planPath(roomId, planId), method: "PUT", body: JSONEncoder().encode(input)))
    }
    func acceptPlan(_ roomId: String, planId: String, revision: Int) async throws -> HarnessPlan {
        try decode(HarnessPlan.self, await request("\(planPath(roomId, planId))/accept", method: "POST", body: JSONEncoder().encode(HarnessRevisionRequest(expectedRevision: revision))))
    }
    func startRun(_ roomId: String, input: HarnessStartRunRequest) async throws -> HarnessRun {
        try decode(HarnessRun.self, await request("\(roomPath(roomId))/runs", method: "POST", body: JSONEncoder().encode(input)))
    }
    func controlRun(_ roomId: String, runId: String, action: String, revision: Int) async throws -> HarnessRun {
        guard ["pause", "resume", "cancel"].contains(action) else { throw RoomsError.invalid("Unknown run control.") }
        return try decode(HarnessRun.self, await request("\(runPath(roomId, runId))/\(action)", method: "POST", body: JSONEncoder().encode(HarnessRevisionRequest(expectedRevision: revision))))
    }
    func retryNode(_ roomId: String, runId: String, nodeId: String, input: HarnessRetryNodeRequest) async throws -> HarnessRun {
        try decode(HarnessRun.self, await request("\(runPath(roomId, runId))/nodes/\(segment(nodeId))/retry", method: "POST", body: JSONEncoder().encode(input)))
    }
    func answerQuestion(_ input: HarnessAnswerRequest) async throws -> HarnessQuestion {
        try decode(HarnessQuestion.self, await request("/questions/\(segment(input.binding.questionId))/answer", method: "POST", body: JSONEncoder().encode(input)), versioned: false)
    }
    func answerVoice(_ input: HarnessVoiceAnswerRequest) async throws -> HarnessQuestion {
        try decode(HarnessQuestion.self, await request("/questions/\(segment(input.binding.questionId))/voice-answer", method: "POST", body: JSONEncoder().encode(input)), versioned: false)
    }
    func artifactContent(_ artifact: HarnessArtifact, path: String) async throws -> Data {
        guard artifact.version == 1, RoomsStateRules.safePath(path), RoomsStateRules.isDigest(artifact.digest),
              let file = artifact.files.first(where: { $0.path == path }), RoomsStateRules.isDigest(file.sha256),
              file.bytes >= 0, file.bytes <= 64 * 1_024 * 1_024 else { throw RoomsError.invalidPath }
        let endpoint = "\(try runPath(artifact.roomId, artifact.runId))/artifacts/\(try segment(artifact.id))/content"
        let data = try await request(endpoint, query: [.init(name: "path", value: path), .init(name: "digest", value: artifact.digest)], limit: max(file.bytes, 8_192))
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard data.count == file.bytes, hash == file.sha256 else { throw RoomsError.integrity }
        return data
    }
}
