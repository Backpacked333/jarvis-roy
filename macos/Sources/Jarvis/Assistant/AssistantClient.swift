import Foundation

enum AssistantClientError: LocalizedError {
    case disabled, configuration, invalidResponse, service(String)
    var errorDescription: String? {
        switch self {
        case .disabled: return "Enable the assistant workspace in Settings and restart the runtime."
        case .configuration: return "The local runtime is not configured. Open Settings to start it."
        case .invalidResponse: return "The assistant protocol changed or exceeded its limit. Update the app and runtime together."
        case .service(let message): return message
        }
    }
}

enum AssistantFeatures {
    static func enabled(_ name: String, preference: String) -> Bool {
        if let value = ProcessInfo.processInfo.environment[name] { return value == "1" }
        return UserDefaults.standard.bool(forKey: preference)
    }
    static var assistant: Bool { enabled("JARVIS_ENABLE_ASSISTANT", preference: "Jarvis.assistantEnabled") }
    static var knowledge: Bool { enabled("JARVIS_ENABLE_KNOWLEDGE", preference: "Jarvis.knowledgeEnabled") }
    static var research: Bool { enabled("JARVIS_ENABLE_RESEARCH", preference: "Jarvis.researchEnabled") }
    static var memory: Bool { enabled("JARVIS_ENABLE_MEMORY", preference: "Jarvis.memoryEnabled") }
    static var semanticRetrieval: Bool { enabled("JARVIS_ENABLE_SEMANTIC_RETRIEVAL", preference: "Jarvis.semanticRetrievalEnabled") }
    static var voiceApproval: Bool { enabled("JARVIS_ENABLE_VOICE_APPROVAL", preference: "Jarvis.voiceApprovalEnabled") }
}

@MainActor
final class AssistantClient {
    private let session: URLSession
    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration, delegate: AssistantRedirectRefusal(), delegateQueue: nil)
    }
    private func request(_ path: String, method: String, body: [String: Any]?, native: Bool) throws -> URLRequest {
        guard RuntimeConnection.localToken.count >= 32,
              let url = URL(string: path, relativeTo: RuntimeConnection.baseURL)?.absoluteURL,
              url.host == "127.0.0.1", url.port == 39202, url.scheme == "http" else { throw AssistantClientError.configuration }
        var request = URLRequest(url: url)
        request.httpMethod = method; request.timeoutInterval = 30
        request.setValue("Bearer \(RuntimeConnection.localToken)", forHTTPHeaderField: "Authorization")
        if native {
            guard RuntimeConnection.nativeToken.count >= 32 else { throw AssistantClientError.configuration }
            request.setValue(RuntimeConnection.nativeToken, forHTTPHeaderField: "x-jarvis-native-token")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }
    func data(_ path: String, method: String = "GET", body: [String: Any]? = nil, native: Bool = true,
              maximum: Int = 12 * 1_024 * 1_024) async throws -> Data {
        let (stream, response) = try await session.bytes(for: request(path, method: method, body: body, native: native))
        guard let http = response as? HTTPURLResponse else { throw AssistantClientError.invalidResponse }
        var bytes = Data()
        for try await byte in stream {
            guard bytes.count < maximum else { throw AssistantClientError.invalidResponse }
            bytes.append(byte)
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = (try? JSONDecoder().decode([String: String].self, from: bytes))?["error"]
            throw AssistantClientError.service(error ?? "Local service error (\(http.statusCode)).")
        }
        return bytes
    }
    func value<T: Decodable>(_ type: T.Type, path: String, method: String = "GET", body: [String: Any]? = nil,
                             maximum: Int = 12 * 1_024 * 1_024) async throws -> T {
        try JSONDecoder().decode(type, from: await data(path, method: method, body: body, maximum: maximum))
    }
    func events(after sequence: Int, receive: @escaping @MainActor (AssistantEvent) async -> Void) async throws {
        var request = try request("/v1/assistant/events?after=\(sequence)", method: "GET", body: nil, native: true)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 300
        let (stream, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.value(forHTTPHeaderField: "Content-Type")?.contains("text/event-stream") == true else { throw AssistantClientError.invalidResponse }
        var parser = AssistantSSEParser()
        for try await byte in stream {
            try Task.checkCancellation()
            if let data = try parser.accept(byte) { await receive(try AssistantEvent.decode(data)) }
        }
    }
}

private final class AssistantRedirectRefusal: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

extension Encodable {
    func assistantJSONObject() throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as? [String: Any] else { throw AssistantClientError.invalidResponse }
        return value
    }
}
