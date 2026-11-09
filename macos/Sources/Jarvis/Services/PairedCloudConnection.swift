import Combine
import Foundation

private final class CloudRedirectRefusal: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor
final class PairedCloudConnection: ObservableObject {
    enum State: String { case unpaired, pairing, disconnected, connecting, connected, failed }
    static let shared = PairedCloudConnection()
    @Published private(set) var state: State = .unpaired
    @Published private(set) var detail = "Cloud companion is not paired."
    @Published private(set) var profile: PairedCloudProfile?
    private let profiles: RuntimeProfiles
    private let credentials = PairedDeviceCredentials()
    private let refusal = CloudRedirectRefusal()
    private var socket: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var connectionGeneration = 0
    private var serverEpoch = 0
    private var reconciled = Set<String>()
    private var reconciliationCursor = 0
    private var reconcilingGeneration: Int?
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil; configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 15; configuration.timeoutIntervalForResource = 30
        return URLSession(configuration: configuration, delegate: refusal, delegateQueue: nil)
    }()
    init(profiles: RuntimeProfiles? = nil) {
        let profiles = profiles ?? .shared
        self.profiles = profiles; profile = profiles.cloudProfile
        if profile != nil { state = .disconnected; detail = "Paired device is disconnected. Local history remains on this Mac." }
    }
    private func requireEnabled() throws {
        guard RuntimePreferences().environment(inherited: ProcessInfo.processInfo.environment)["JARVIS_ENABLE_CLOUD"] == "1" else { throw CloudConnectionFailure.disabled }
    }
    func pair(origin: String, bootstrapCredential: String, label: String) async {
        disconnect()
        let ticket = connectionGeneration
        state = .pairing
        do {
            try requireEnabled()
            let url = try CloudProfilePolicy.origin(origin), trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
            guard (1...120).contains(trimmed.utf16.count), (32...8192).contains(bootstrapCredential.utf8.count),
                  !bootstrapCredential.contains(where: { $0.isWhitespace || $0 == "\0" }) else { throw CloudConnectionFailure.configuration }
            let deviceID = UUID().uuidString
            let started = try await remoteJSON(url, path: "/v1/cloud/pairing/start", token: bootstrapCredential,
                                               body: ["deviceId": deviceID, "label": trimmed])
            guard ticket == connectionGeneration, started["version"] as? Int == 1,
                  let pairingID = started["pairingId"] as? String, let pairingToken = started["pairingToken"] as? String,
                  let expires = started["expiresAt"] as? String, CloudCommandEnvelope.date(expires).map({ $0 > Date() }) == true else { throw CloudConnectionFailure.protocolMismatch }
            let paired = try await remoteJSON(url, path: "/v1/cloud/pairing/complete", token: pairingToken,
                                              body: ["pairingId": pairingID, "deviceId": deviceID])
            guard ticket == connectionGeneration, paired["version"] as? Int == 1,
                  paired["deviceId"] as? String == deviceID, let generation = paired["generation"] as? Int, generation >= 0,
                  let token = paired["deviceToken"] as? String, let key = paired["receiptPublicKey"] as? String,
                  key.utf8.count <= 2048, key.contains("BEGIN PUBLIC KEY") else { throw CloudConnectionFailure.protocolMismatch }
            let value = PairedCloudProfile(version: 1, id: UUID().uuidString, origin: url.absoluteString, deviceId: deviceID,
                label: trimmed, generation: generation, receiptPublicKey: key, pairedAt: ISO8601DateFormatter().string(from: Date()))
            try credentials.save(token, profileID: value.id)
            do { try profiles.save(value) } catch { try? credentials.remove(profileID: value.id); throw error }
            profile = value; state = .disconnected; detail = "Device paired. Connect to verify the cloud service; existing local actions keep their original authority."
        } catch { if ticket == connectionGeneration { state = .failed; detail = safeMessage(error) } }
    }
    func connect() async {
        disconnect()
        let ticket = connectionGeneration
        do {
            try requireEnabled()
            guard let profile = profiles.cloudProfile, let token = try credentials.read(profileID: profile.id) else { throw CloudConnectionFailure.credentials }
            self.profile = profile; let origin = try CloudProfilePolicy.origin(profile.origin)
            let journal = try CloudReceiptJournal(profileID: profile.id)
            var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
            components.scheme = "wss"; components.path = "/v1/cloud/device/connect"
            components.queryItems = [URLQueryItem(name: "deviceId", value: profile.deviceId)]
            guard let endpoint = components.url else { throw CloudConnectionFailure.configuration }
            var request = URLRequest(url: endpoint); request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let socket = session.webSocketTask(with: request); socket.maximumMessageSize = 512 * 1024
            self.socket = socket; state = .connecting; detail = "Connecting the paired device over TLS…"; socket.resume()
            reader = Task { [weak self] in
                guard let self else { return }
                var activeProfile = profile
                do {
                    while !Task.isCancelled, ticket == self.connectionGeneration {
                        let message = try await socket.receive()
                        guard ticket == self.connectionGeneration, !Task.isCancelled else { return }
                        let data: Data
                        switch message { case .data(let value): data = value; case .string(let value): data = Data(value.utf8); @unknown default: throw CloudConnectionFailure.protocolMismatch }
                        guard data.count <= 512 * 1024, let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                              frame["version"] as? Int == 1 else { throw CloudConnectionFailure.protocolMismatch }
                        if frame["type"] as? String == "device.welcome" {
                            guard self.serverEpoch == 0, frame["deviceId"] as? String == profile.deviceId,
                                  let generation = frame["generation"] as? Int, generation > profile.generation, let epoch = frame["serverEpoch"] as? Int, epoch > 0,
                                  frame["receiptPublicKey"] as? String == profile.receiptPublicKey else { throw CloudConnectionFailure.protocolMismatch }
                            activeProfile = try profile.advancing(to: generation)
                            try self.profiles.save(activeProfile); self.profile = activeProfile
                            _ = try await self.localJSON("/v1/cloud/native-device", body: ["version": 1, "profileId": profile.id,
                                "origin": profile.origin, "deviceId": profile.deviceId, "generation": activeProfile.generation,
                                "serverEpoch": epoch, "receiptPublicKey": profile.receiptPublicKey])
                            guard ticket == self.connectionGeneration else { return }
                            self.serverEpoch = epoch; self.state = .connected; self.detail = "Paired cloud connection ready. Selected snapshots require their own retention grants."
                            self.startHeartbeat(activeProfile, journal: journal, epoch: epoch, socket: socket, ticket: ticket)
                            try await self.reconcile(journal, profile: activeProfile, epoch: epoch, socket: socket, ticket: ticket)
                        } else if frame["type"] as? String == "heartbeat.ack" {
                            guard frame["generation"] as? Int == activeProfile.generation, frame["serverEpoch"] as? Int == self.serverEpoch else { throw CloudConnectionFailure.protocolMismatch }
                        } else if frame["accepted"] as? Bool == true {
                            guard self.serverEpoch > 0, frame["duplicate"] is Bool, Set(frame.keys).isSubset(of: ["version", "accepted", "duplicate"]) else { throw CloudConnectionFailure.protocolMismatch }
                        } else {
                            guard self.serverEpoch > 0 else { throw CloudConnectionFailure.protocolMismatch }
                            let command = try CloudCommandEnvelope(frame, profile: activeProfile, epoch: self.serverEpoch)
                            let prepared = try journal.prepare(command)
                            var receipt = prepared.receipt
                            if prepared.dispatch {
                                if command.expiresAt <= Date() { receipt = try receipt.resolved(status: "failed", code: "stale") }
                                else {
                                    do {
                                        // The existing local execution authority validates the pinned cloud receipt
                                        // and exact live proposal. This connector never runs a tool itself.
                                        let reply = try await self.localJSON("/v1/cloud/native-command", body: ["version": 1, "profileId": profile.id, "command": command.object])
                                        guard reply["version"] as? Int == 1, let status = reply["status"] as? String, let code = reply["code"] as? String else { throw CloudConnectionFailure.protocolMismatch }
                                        receipt = try receipt.resolved(status: status, code: code)
                                    } catch { receipt = try receipt.resolved(status: "unknown", code: "unknown") }
                                }
                                guard ticket == self.connectionGeneration, !Task.isCancelled else { return }
                                try journal.finish(receipt)
                            }
                            guard ticket == self.connectionGeneration else { return }
                            try await socket.send(.string(String(decoding: try JSONEncoder().encode(receipt), as: UTF8.self)))
                        }
                    }
                } catch {
                    if ticket == self.connectionGeneration { self.disconnect(); self.state = .failed; self.detail = self.safeMessage(error) }
                }
            }
        } catch { state = .failed; detail = safeMessage(error) }
    }
    func disconnect() {
        connectionGeneration += 1; reader?.cancel(); reader = nil; heartbeat?.cancel(); heartbeat = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil; serverEpoch = 0; reconciled = []; reconciliationCursor = 0
        state = profile == nil ? .unpaired : .disconnected
        detail = profile == nil ? "Cloud companion is not paired." : "Cloud device disconnected. Unconfirmed commands are not replayed."
    }
    func forgetPairing() throws {
        disconnect()
        if let profile { try credentials.remove(profileID: profile.id) }
        try profiles.remove(); profile = nil; state = .unpaired; detail = "Local pairing removed. Revoke the device on the cloud service to invalidate its credential there."
    }
    func objectiveData(path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        try requireEnabled()
        guard let profile = profiles.cloudProfile, let token = try credentials.read(profileID: profile.id),
              let parts = URLComponents(string: path), parts.scheme == nil, parts.host == nil, parts.fragment == nil,
              parts.path.range(of: #"^/v1/cloud/objectives(?:/[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?:/(?:pause|resume|stop|answer|deliverable))?)?$"#, options: .regularExpression) != nil,
              ["GET", "POST"].contains(method),
              !parts.path.hasSuffix("/deliverable") || method == "GET" && (parts.queryItems ?? []).count == 1,
              (parts.queryItems ?? []).count <= 1,
              (parts.queryItems ?? []).allSatisfy({ $0.name == "projectId" && $0.value.map(CloudProfilePolicy.identifier) == true }) else { throw CloudConnectionFailure.configuration }
        let origin = try CloudProfilePolicy.origin(profile.origin)
        guard let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              url.host == origin.host, url.scheme == "https", url.port == origin.port else { throw CloudConnectionFailure.configuration }
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (stream, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw CloudConnectionFailure.transport }
        var data = Data()
        for try await byte in stream { try Task.checkCancellation(); guard data.count < 12 * 1024 * 1024 else { throw CloudConnectionFailure.protocolMismatch }; data.append(byte) }
        guard profiles.cloudProfile?.id == profile.id else { throw CloudConnectionFailure.configuration }
        return data
    }
    func setupData(path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        try requireEnabled()
        let allowed = method == "GET" && path == "/v1/cloud/setup/integrations/status" ||
            method == "POST" && ["/v1/cloud/setup/integrations/telegram/pair", "/v1/cloud/setup/integrations/google/connect", "/v1/cloud/setup/integrations/google/permissions", "/v1/cloud/setup/integrations/twilio/verify-owner"].contains(path)
        guard allowed, let profile = profiles.cloudProfile, let token = try credentials.read(profileID: profile.id) else { throw CloudConnectionFailure.configuration }
        let origin = try CloudProfilePolicy.origin(profile.origin)
        guard let endpoint = URL(string: path, relativeTo: origin)?.absoluteURL, endpoint.host == origin.host, endpoint.port == origin.port, endpoint.scheme == "https" else { throw CloudConnectionFailure.configuration }
        var request = URLRequest(url: endpoint); request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let result = try await json(request)
        guard profiles.cloudProfile?.id == profile.id else { throw CloudConnectionFailure.configuration }
        return try JSONSerialization.data(withJSONObject: result)
    }
    func conversationData(path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        try requireEnabled()
        guard let parts = URLComponents(string: path), parts.scheme == nil, parts.host == nil, parts.fragment == nil,
              parts.query == nil || method == "GET" && parts.path == "/v1/cloud/conversations" &&
                (parts.queryItems ?? []).count == 1 && (parts.queryItems ?? []).allSatisfy({ $0.name == "projectId" && $0.value.map(CloudProfilePolicy.identifier) == true }) else { throw CloudConnectionFailure.configuration }
        let collection = parts.path == "/v1/cloud/conversations" && ["GET", "POST"].contains(method)
        let createTask = parts.path == "/v1/cloud/tasks" && method == "POST"
        let readOne = method == "GET" && parts.path.range(of: #"^/v1/cloud/(?:conversations|tasks)/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"#, options: .regularExpression) != nil
        // The server accepts this route only for the exact current question card;
        // action approvals still require their separate bound review protocol.
        let answerQuestion = method == "POST" && parts.path.range(of: #"^/v1/cloud/tasks/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/respond$"#, options: .regularExpression) != nil
        guard collection || createTask || readOne || answerQuestion, let profile = profiles.cloudProfile,
              let token = try credentials.read(profileID: profile.id) else { throw CloudConnectionFailure.configuration }
        let origin = try CloudProfilePolicy.origin(profile.origin)
        guard let endpoint = URL(string: path, relativeTo: origin)?.absoluteURL, endpoint.host == origin.host, endpoint.port == origin.port,
              endpoint.scheme == "https" else { throw CloudConnectionFailure.configuration }
        var request = URLRequest(url: endpoint); request.httpMethod = method; request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (stream, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw CloudConnectionFailure.transport }
        var data = Data()
        for try await byte in stream { try Task.checkCancellation(); guard data.count < 12 * 1024 * 1024 else { throw CloudConnectionFailure.protocolMismatch }; data.append(byte) }
        guard profiles.cloudProfile?.id == profile.id else { throw CloudConnectionFailure.configuration }
        return data
    }
    func stopCloudWork() async throws {
        try requireEnabled()
        guard let profile = profiles.cloudProfile, let token = try credentials.read(profileID: profile.id) else { throw CloudConnectionFailure.credentials }
        let result = try await remoteJSON(try CloudProfilePolicy.origin(profile.origin), path: "/v1/cloud/stop", token: token, body: [:])
        guard profiles.cloudProfile?.id == profile.id, result["version"] as? Int == 1, result["stopped"] as? Bool == true else { throw CloudConnectionFailure.protocolMismatch }
    }
    func resumeCloudWork() async throws {
        try requireEnabled()
        guard let profile = profiles.cloudProfile, let token = try credentials.read(profileID: profile.id) else { throw CloudConnectionFailure.credentials }
        let result = try await remoteJSON(try CloudProfilePolicy.origin(profile.origin), path: "/v1/cloud/resume", token: token, body: [:])
        guard profiles.cloudProfile?.id == profile.id, result["version"] as? Int == 1, result["resumed"] as? Bool == true else { throw CloudConnectionFailure.protocolMismatch }
    }
    func beginOwnerEnrollment() async throws -> URL {
        try requireEnabled()
        guard let profile = profiles.cloudProfile, let token = try credentials.read(profileID: profile.id) else { throw CloudConnectionFailure.credentials }
        let origin = try CloudProfilePolicy.origin(profile.origin)
        let result = try await remoteJSON(origin, path: "/v1/cloud/enrollment/start", token: token, body: [:])
        guard profiles.cloudProfile?.id == profile.id, result["version"] as? Int == 1,
              let invitation = result["enrollmentToken"] as? String, invitation.range(of: #"^[A-Za-z0-9_-]{32,8192}$"#, options: .regularExpression) != nil,
              let expires = result["expiresAt"] as? String, CloudCommandEnvelope.date(expires).map({ $0 > Date() && $0.timeIntervalSinceNow <= 310 }) == true,
              let raw = result["url"] as? String, let parts = URLComponents(string: raw),
              parts.scheme == "https", parts.host == origin.host, parts.port == origin.port,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.path == "/v1/cloud/enroll",
              parts.fragment == "token=\(invitation)", let url = parts.url else { throw CloudConnectionFailure.protocolMismatch }
        return url
    }
    private func reconcile(_ journal: CloudReceiptJournal, profile: PairedCloudProfile, epoch: Int,
                           socket: URLSessionWebSocketTask, ticket: Int) async throws {
        guard ticket == connectionGeneration, reconcilingGeneration != ticket else { return }
        reconcilingGeneration = ticket
        defer { if reconcilingGeneration == ticket { reconcilingGeneration = nil } }
        let candidates = journal.receipts(deviceID: profile.deviceId).filter { $0.status == "unknown" || !reconciled.contains($0.commandId) }
        guard !candidates.isEmpty else { return }
        let start = reconciliationCursor % candidates.count, count = min(candidates.count, 16)
        reconciliationCursor = (start + count) % candidates.count
        for offset in 0..<count {
            var receipt = candidates[(start + offset) % candidates.count]
            guard ticket == connectionGeneration, !Task.isCancelled else { return }
            if receipt.status == "unknown" {
                // Observation is separate from dispatch. An absent or uncertain local
                // receipt never authorizes retry, including after an app crash.
                let result: [String: Any]
                do { result = try await localJSON("/v1/cloud/native-command-result", body: ["version": 1, "profileId": profile.id,
                    "commandId": receipt.commandId, "commandDigest": receipt.commandDigest,
                    "originalGeneration": receipt.generation, "originalServerEpoch": receipt.serverEpoch]) }
                catch { return }
                guard ticket == connectionGeneration, !Task.isCancelled else { return }
                guard result["version"] as? Int == 1, let status = result["status"] as? String,
                      let code = result["code"] as? String else { throw CloudConnectionFailure.protocolMismatch }
                receipt = try receipt.resolved(status: status, code: code)
                if receipt.status == "unknown" { continue }
                try journal.finish(receipt)
            }
            let frame: [String: Any] = ["version": 1, "type": "reconcile", "id": UUID().uuidString,
                "commandId": receipt.commandId, "deviceId": profile.deviceId, "generation": profile.generation,
                "serverEpoch": epoch, "originalGeneration": receipt.generation, "originalServerEpoch": receipt.serverEpoch,
                "commandDigest": receipt.commandDigest, "status": receipt.status, "code": receipt.code]
            try await socket.send(.string(String(decoding: try JSONSerialization.data(withJSONObject: frame), as: UTF8.self)))
            guard ticket == connectionGeneration else { return }
            reconciled.insert(receipt.commandId)
        }
    }
    private func startHeartbeat(_ profile: PairedCloudProfile, journal: CloudReceiptJournal, epoch: Int, socket: URLSessionWebSocketTask, ticket: Int) {
        heartbeat = Task { [weak self] in
            while !Task.isCancelled, let self, ticket == self.connectionGeneration {
                do {
                    try await Task.sleep(for: .seconds(20))
                    guard ticket == self.connectionGeneration else { return }
                    let frame: [String: Any] = ["version": 1, "type": "heartbeat", "deviceId": profile.deviceId, "generation": profile.generation, "serverEpoch": epoch]
                    try await socket.send(.string(String(decoding: try JSONSerialization.data(withJSONObject: frame), as: UTF8.self)))
                    try await self.reconcile(journal, profile: profile, epoch: epoch, socket: socket, ticket: ticket)
                } catch { return }
            }
        }
    }
    private func remoteJSON(_ origin: URL, path: String, token: String, body: [String: Any]) async throws -> [String: Any] {
        guard path.hasPrefix("/v1/cloud/"), !token.contains(where: { $0.isWhitespace || $0 == "\0" }), token.utf8.count <= 8192,
              let url = URL(string: path, relativeTo: origin)?.absoluteURL, url.host == origin.host, url.scheme == "https", url.port == origin.port else { throw CloudConnectionFailure.configuration }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 15
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization"); request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await json(request)
    }
    private func localJSON(_ path: String, body: [String: Any]) async throws -> [String: Any] {
        guard ["/v1/cloud/native-device", "/v1/cloud/native-command", "/v1/cloud/native-command-result"].contains(path),
              RuntimeConnection.localToken.count >= 32, RuntimeConnection.nativeToken.count >= 32,
              let url = URL(string: path, relativeTo: RuntimeConnection.baseURL)?.absoluteURL else { throw CloudConnectionFailure.configuration }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 30
        request.setValue("Bearer \(RuntimeConnection.localToken)", forHTTPHeaderField: "Authorization")
        request.setValue(RuntimeConnection.nativeToken, forHTTPHeaderField: "x-jarvis-native-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await json(request)
    }
    private func json(_ request: URLRequest) async throws -> [String: Any] {
        let (stream, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw CloudConnectionFailure.transport }
        var data = Data()
        for try await byte in stream { guard data.count < 512 * 1024 else { throw CloudConnectionFailure.protocolMismatch }; data.append(byte) }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CloudConnectionFailure.protocolMismatch }
        return object
    }
    private func safeMessage(_ error: Error) -> String {
        (error as? CloudConnectionFailure)?.errorDescription ?? CloudConnectionFailure.transport.errorDescription!
    }
}
