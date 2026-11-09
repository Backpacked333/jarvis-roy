import Foundation

@MainActor
protocol VoiceSocketTransporting: AnyObject {
    var onFrame: ((HarnessVoiceServerFrame) -> Void)? { get set }
    var onFailure: ((String) -> Void)? { get set }
    func status() async throws -> HarnessVoiceStatus
    func connect() throws
    func send(_ frame: HarnessVoiceClientFrame) throws
    func disconnect()
}

@MainActor
final class VoiceSocketTransport: VoiceSocketTransporting {
    var onFrame: ((HarnessVoiceServerFrame) -> Void)?
    var onFailure: ((String) -> Void)?
    private let token: String
    private let session: URLSession
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var sender: Task<Void, Never>?
    private var queued: [Data] = []
    private var queuedBytes = 0
    private var epoch = 0

    init(token: String = RuntimeConnection.localToken) {
        self.token = token
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 8
        // The authenticated socket spans multiple independently bounded turns.
        // Keep it alive through the bridge's ten-minute session lease.
        config.timeoutIntervalForResource = 660
        session = URLSession(configuration: config, delegate: VoiceNoRedirectDelegate(), delegateQueue: nil)
    }
    private func request(_ path: String, websocket: Bool = false) throws -> URLRequest {
        guard token.count >= 32, let url = URL(string: "\(websocket ? "ws" : "http")://127.0.0.1:39202\(path)") else { throw VoiceTransportError.configuration }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 8
        return request
    }
    func status() async throws -> HarnessVoiceStatus {
        let request = try request("/v1/voice/status")
        let (bytes, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, bytes.count <= 8_192 else { throw VoiceTransportError.configuration }
        let status = try JSONDecoder().decode(HarnessVoiceStatus.self, from: bytes)
        guard status.version == 1, status.provider == "elevenlabs", status.model == "eleven_v4_turbo", status.recognitionModel == "scribe_v2_realtime",
              ["configured", "connected", "unavailable"].contains(status.status) else { throw VoiceTransportError.invalidFrame }
        return status
    }
    func connect() throws {
        if socket != nil { return }
        disconnect()
        let socket = session.webSocketTask(with: try request("/v1/voice/stream", websocket: true))
        socket.maximumMessageSize = 32_768
        self.socket = socket
        let ticket = epoch
        socket.resume()
        receiver = Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    guard let self, self.epoch == ticket else { return }
                    guard case .string(let string) = message, let data = string.data(using: .utf8), data.count <= 32_768 else { throw VoiceTransportError.invalidFrame }
                    let frame = try JSONDecoder().decode(HarnessVoiceServerFrame.self, from: data)
                    guard frame.version == 1 else { throw VoiceTransportError.invalidFrame }
                    self.onFrame?(frame)
                }
            } catch {
                guard let self, self.epoch == ticket, !Task.isCancelled else { return }
                self.failure(VoiceTransportError.disconnected.localizedDescription)
            }
        }
    }
    func send(_ frame: HarnessVoiceClientFrame) throws {
        guard socket != nil else { throw VoiceTransportError.disconnected }
        let data = try JSONEncoder().encode(frame)
        guard data.count <= 32_768, queuedBytes + data.count <= 44_000, queued.count < 100 else { throw VoiceTransportError.overflow }
        queued.append(data)
        queuedBytes += data.count
        guard sender == nil else { return }
        let ticket = epoch
        sender = Task { [weak self] in
            guard let self else { return }
            do {
                while !Task.isCancelled, self.epoch == ticket, let socket = self.socket, !self.queued.isEmpty {
                    let data = self.queued.removeFirst()
                    // Bytes remain reserved while URLSession is sending, not just while in our array.
                    try await socket.send(.string(String(decoding: data, as: UTF8.self)))
                    guard self.epoch == ticket else { return }
                    self.queuedBytes -= data.count
                }
                if self.epoch == ticket { self.sender = nil }
            } catch {
                guard self.epoch == ticket, !Task.isCancelled else { return }
                self.failure(VoiceTransportError.disconnected.localizedDescription)
            }
        }
    }
    private func failure(_ message: String) {
        disconnect()
        onFailure?(message)
    }
    func disconnect() {
        epoch += 1
        receiver?.cancel(); receiver = nil
        sender?.cancel(); sender = nil
        queued = []; queuedBytes = 0
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
    }
}

private final class VoiceNoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
