import Foundation

@MainActor
protocol RuntimeServing {
    func request(_ path: String, method: String, body: [String: String]?) async throws -> Data
    func state() async throws -> RuntimeState
    func capabilities() async throws -> CapabilityState
}

struct RuntimeClient: RuntimeServing {
    private let base = URL(string: "http://127.0.0.1:39202")!
    private let token = ProcessInfo.processInfo.environment["JARVIS_LOCAL_TOKEN"] ?? ""

    enum ClientError: LocalizedError {
        case configuration, response(String)
        var errorDescription: String? {
            switch self {
            case .configuration: return "Start Jarvis using scripts/run-macos.sh to connect its local agent service."
            case .response(let message): return message
            }
        }
    }

    func request(_ path: String, method: String = "GET", body: [String: String]? = nil) async throws -> Data {
        guard token.count >= 32 else { throw ClientError.configuration }
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ClientError.response("The local service returned an invalid response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let payload = try? JSONDecoder().decode([String: String].self, from: data)
            throw ClientError.response(payload?["error"] ?? "Local service error (\(http.statusCode)).")
        }
        return data
    }

    func state() async throws -> RuntimeState {
        try JSONDecoder().decode(RuntimeState.self, from: await request("v1/state"))
    }

    func capabilities() async throws -> CapabilityState {
        try JSONDecoder().decode(CapabilityState.self, from: await request("v1/capabilities"))
    }
}
