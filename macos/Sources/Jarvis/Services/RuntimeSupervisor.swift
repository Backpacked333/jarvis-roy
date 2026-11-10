import AppKit
import Foundation
import Combine

struct RuntimeLocation: Codable {
    let runtimeDirectory: String
    let nodeExecutable: String
}

private final class RuntimeNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class RuntimeSupervisor: ObservableObject {
    enum State: String { case idle, starting, ready, failed, stopping, stopped }
    static let shared = RuntimeSupervisor()
    @Published private(set) var state: State = .idle
    @Published private(set) var detail = "Local services have not started."
    @Published private(set) var providerConfigured = false
    @Published private(set) var modelMetadataAvailable = false
    @Published private(set) var restartCount = 0
    /// The failing service's last redacted output lines, shown with a failed start so the cause is visible.
    @Published private(set) var failureLog: [String] = []
    /// Where the services' redacted output is kept; nil until the app has started them once.
    @Published private(set) var logDirectory: URL?
    let externallyManaged = RuntimeConnection.externallyManaged

    private var children: [String: Process] = [:]
    private var outputs: [Pipe] = []
    /// Write ends the app holds open and never writes to. If the app dies, they close and each service stops itself.
    private var lifelines: [Pipe] = []
    private var logs: RuntimeLogStore?
    private var generation = 0
    private var recoveryInProgress = false
    private var shutdownConfirmed = true
    private let diagnostics = RuntimeDiagnostics.shared
    private let noRedirect = RuntimeNoRedirect()
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 2
        configuration.timeoutIntervalForResource = 3
        return URLSession(configuration: configuration, delegate: noRedirect, delegateQueue: nil)
    }()

    func start() async {
        guard state != .starting && state != .ready && state != .stopping else { return }
        guard RuntimeConnection.localToken.count >= 32,
              externallyManaged || RuntimeConnection.nativeToken.count >= 32 else {
            fail("local_credentials_invalid", "A secure local connection could not be created. Relaunch Jarvis.")
            return
        }
        generation += 1
        let current = generation
        state = .starting
        failureLog = []
        detail = externallyManaged ? "Connecting to launcher-owned services…" : "Starting your local assistant…"
        diagnostics.record("startup_begin")
        do {
            if !externallyManaged {
                guard children.isEmpty else { throw StartupFailure.stillRunning }
                for port in [39201, 39202] {
                    if await portResponds(port) { throw StartupFailure.portInUse }
                }
                guard current == generation, state == .starting else { return }
                if !shutdownConfirmed {
                    // A forced stop is settled once its processes are reaped and both ports are silent.
                    // The bridge reconciles saved work on every start; nothing is replayed.
                    shutdownConfirmed = true
                    diagnostics.record("shutdown_recovered")
                }
                let location = try runtimeLocation()
                try await verifyNode(location.nodeExecutable)
                guard current == generation, state == .starting else { return }
                let catalogURL = URL(fileURLWithPath: location.runtimeDirectory).appendingPathComponent(".output/.eve/compile/model-metadata.json")
                if let data = try? Data(contentsOf: catalogURL),
                   let metadata = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    modelMetadataAvailable = metadata["fetchedAt"] is String
                }
                if !modelMetadataAvailable { diagnostics.record("model_catalog_missing") }
                var source = RuntimePreferences().environment(inherited: ProcessInfo.processInfo.environment)
                for credential in ProviderCredential.allCases where source[credential.rawValue] == nil {
                    source[credential.rawValue] = try ProviderCredentials().read(credential)
                }
                providerConfigured = !(source[ProviderCredential.gateway.rawValue] ?? "").isEmpty
                let secrets = [RuntimeConnection.localToken, RuntimeConnection.nativeToken]
                    + ProviderCredential.allCases.compactMap { source[$0.rawValue] }
                let data = source["JARVIS_DATA_DIR"] ?? FileManager.default.homeDirectoryForCurrentUser
                    .appendingPathComponent("Library/Application Support/JarvisRoy").path
                try FileManager.default.createDirectory(atPath: data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: data)
                let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/JarvisControl.app/Contents/MacOS/JarvisControl").path
                let venv = URL(fileURLWithPath: location.runtimeDirectory).appendingPathComponent("workers/.venv/bin/python").path
                if source["JARVIS_WORKER_PYTHON"] == nil && FileManager.default.isExecutableFile(atPath: venv) { source["JARVIS_WORKER_PYTHON"] = venv }
                if source["JARVIS_DOCKER_BINARY"] == nil {
                    source["JARVIS_DOCKER_BINARY"] = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker"].first(where: { FileManager.default.isExecutableFile(atPath: $0) })
                }
                let store = RuntimeLogStore(directory: URL(fileURLWithPath: data).appendingPathComponent("logs"), secrets: secrets)
                logs = store
                logDirectory = store.directory
                let runtimeURL = URL(fileURLWithPath: location.runtimeDirectory)
                let guardScript = runtimeURL.appendingPathComponent("service-guard.mjs").path
                let guarded = FileManager.default.fileExists(atPath: guardScript)
                for (role, entry) in [("runtime", ".output/server/index.mjs"), ("bridge", "bridge/server.ts")] {
                    let process = Process()
                    let entryPath = runtimeURL.appendingPathComponent(entry).path
                    process.executableURL = URL(fileURLWithPath: location.nodeExecutable)
                    process.arguments = guarded ? [guardScript, entryPath] : [entryPath]
                    process.currentDirectoryURL = runtimeURL
                    var environment = RuntimePreferences.childEnvironment(role: role, source: source,
                        localToken: RuntimeConnection.localToken, nativeToken: RuntimeConnection.nativeToken,
                        dataDirectory: data, helper: FileManager.default.isExecutableFile(atPath: helper) ? helper : nil)
                    // Service output is redacted and kept in a private, size-capped file so a failed start can be explained.
                    let pipe = Pipe()
                    pipe.fileHandleForReading.readabilityHandler = { handle in
                        let data = handle.availableData
                        if data.isEmpty {
                            handle.readabilityHandler = nil
                            store.finish(role: role)
                        } else {
                            store.append(data, role: role)
                        }
                    }
                    outputs.append(pipe)
                    process.standardOutput = pipe
                    process.standardError = pipe
                    if guarded {
                        let lifeline = Pipe()
                        lifelines.append(lifeline)
                        process.standardInput = lifeline
                        environment["JARVIS_LIFELINE"] = "stdin"
                    } else {
                        process.standardInput = FileHandle.nullDevice
                    }
                    process.environment = environment
                    process.terminationHandler = { [weak self] _ in
                        Task { @MainActor in await self?.childExited(role: role, generation: current) }
                    }
                    try process.run()
                    children[role] = process
                    store.note("Jarvis started this service.", role: role)
                    diagnostics.record("process_started", role: role)
                }
            }
            for _ in 0..<60 {
                guard current == generation, state == .starting else { return }
                if !externallyManaged && children.values.contains(where: { !$0.isRunning }) { throw StartupFailure.processExited }
                if await ready() {
                    guard current == generation, state == .starting else { return }
                    state = .ready
                    detail = externallyManaged ? "Connected to launcher-owned services." :
                        (providerConfigured ? "Local assistant is ready. Provider and hardware acceptance are checked when used."
                            : "Local services are running. Add a Vercel AI Gateway key so Jarvis can reason.")
                    diagnostics.record("startup_ready")
                    return
                }
                try await Task.sleep(nanoseconds: 500_000_000)
            }
            throw StartupFailure.readiness
        } catch {
            guard current == generation else { return }
            let exited = ["bridge", "runtime"].first { role in children[role].map { process in !process.isRunning } ?? false }
            // Give a service that just exited a moment to deliver its last output.
            if exited != nil { try? await Task.sleep(nanoseconds: 300_000_000) }
            await stopChildren()
            guard current == generation else { return }
            let message = (error as? LocalizedError)?.errorDescription ?? "Local services could not start. Check Node 24, the built runtime, and Keychain access in Settings."
            fail("startup_failed", message, log: recentOutput(preferring: exited))
        }
    }

    /// Call after provider credentials are saved or removed so the change is used without a manual restart.
    func credentialsChanged() async {
        guard !externallyManaged else {
            detail = "Quit and relaunch scripts/run-macos.sh to apply launcher configuration changes."
            return
        }
        guard state != .stopping else { return }
        await restart()
    }

    /// The last output of the service that failed, or of both when neither is known to have exited.
    private func recentOutput(preferring role: String?) -> [String] {
        guard let logs else { return [] }
        if let role { return logs.tail(role: role) }
        return ["bridge", "runtime"].flatMap { role in logs.tail(role: role, lines: 6).map { "\(role): \($0)" } }
    }

    /// A plain-text summary a person can paste into a bug report. It contains no credentials or conversation text.
    func diagnosticsReport() -> String {
        var lines = ["Jarvis diagnostics", "State: \(state.rawValue)", "Detail: \(detail)",
                     "Services managed by: \(externallyManaged ? "developer launcher" : "app")",
                     "Reasoning key saved: \(providerConfigured ? "yes" : "no")", "Automatic restarts: \(restartCount)"]
        if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String { lines.append("App version: \(version)") }
        lines.append("macOS: \(ProcessInfo.processInfo.operatingSystemVersionString)")
        if let logDirectory { lines.append("Logs: \(logDirectory.path)") }
        if !failureLog.isEmpty { lines.append("Last service output:"); lines += failureLog.map { "  \($0)" } }
        let events = diagnostics.entries.suffix(15).map { "  \($0.role) \($0.code)" }
        if !events.isEmpty { lines.append("Recent events:"); lines += events }
        return lines.joined(separator: "\n")
    }

    func restart() async {
        guard !externallyManaged else {
            detail = "Quit and relaunch scripts/run-macos.sh to apply launcher configuration changes."
            return
        }
        restartCount = 0
        await shutdown()
        // start() refuses to run while a port is still held, so an unconfirmed stop cannot produce two copies.
        await start()
    }

    func shutdown() async {
        guard state != .stopping else { return }
        generation += 1
        state = .stopping
        detail = "Stopping local services…"
        if !externallyManaged {
            // The bridge performs authoritative cancellation and worker reconciliation on SIGTERM.
            await stopChildren()
        }
        state = shutdownConfirmed ? .stopped : .failed
        detail = shutdownConfirmed ? "Local services stopped." : "A service had to be stopped forcibly. Retry to start again; saved work is reconciled, never replayed."
        diagnostics.record(shutdownConfirmed ? "shutdown_confirmed" : "shutdown_unconfirmed")
    }

    private func childExited(role: String, generation exitedGeneration: Int) async {
        guard generation == exitedGeneration, state == .ready, !recoveryInProgress else { return }
        diagnostics.record("process_exited", role: role)
        recoveryInProgress = true
        defer { recoveryInProgress = false }
        guard restartCount < 2 else {
            generation += 1
            await stopChildren()
            fail("restart_limit", "Local services stopped repeatedly. Review Settings and explicitly restart after resolving the cause.")
            return
        }
        restartCount += 1
        await shutdown()
        guard shutdownConfirmed else { return }
        detail = "Reconnecting and reconciling saved work. Actions are not replayed."
        diagnostics.record("restart_reconcile")
        try? await Task.sleep(nanoseconds: UInt64(restartCount) * 1_000_000_000)
        await start()
    }

    private func stopChildren() async {
        // Keep Eve alive while the bridge shuts down and confirms cancellation.
        for role in ["bridge", "runtime"] {
            guard let process = children[role] else { continue }
            process.terminationHandler = nil
            if process.isRunning { process.terminate() }
            let attempts = role == "bridge" ? 180 : 20
            for _ in 0..<attempts {
                if !process.isRunning { break }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            if process.isRunning {
                shutdownConfirmed = false
                kill(process.processIdentifier, SIGKILL)
                diagnostics.record("forced_process_stop", role: role)
            }
        }
        children.removeAll()
        for pipe in outputs { pipe.fileHandleForReading.readabilityHandler = nil }
        outputs.removeAll()
        lifelines.removeAll()
    }

    private func ready() async -> Bool {
        var request = URLRequest(url: RuntimeConnection.baseURL.appendingPathComponent("v1/state"))
        request.setValue("Bearer \(RuntimeConnection.localToken)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await session.data(for: request), data.count <= 8 * 1_024 * 1_024,
              (response as? HTTPURLResponse)?.statusCode == 200,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return value["ready"] as? Bool == true
    }

    private func portResponds(_ port: Int) async -> Bool {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!)
        request.timeoutInterval = 0.5
        return (try? await session.data(for: request)) != nil
    }

    private func runtimeLocation() throws -> RuntimeLocation {
        let preferences = UserDefaults.standard
        let manifest = Bundle.main.url(forResource: "runtime-location", withExtension: "json")
            .flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONDecoder().decode(RuntimeLocation.self, from: $0) }
        let directory = Self.nonempty(preferences.string(forKey: "Jarvis.runtimeDirectory")) ?? manifest?.runtimeDirectory ?? ""
        let node = Self.nonempty(preferences.string(forKey: "Jarvis.nodeExecutable")) ?? manifest?.nodeExecutable ?? ""
        guard directory.hasPrefix("/"), node.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.fileExists(atPath: directory + "/.output/server/index.mjs"),
              FileManager.default.fileExists(atPath: directory + "/bridge/server.ts"),
              FileManager.default.fileExists(atPath: directory + "/node_modules/eve/package.json") else { throw StartupFailure.installation }
        return RuntimeLocation(runtimeDirectory: directory, nodeExecutable: node)
    }

    static func nonempty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    private func verifyNode(_ executable: String) async throws {
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = ["--version"]
        process.environment = ["PATH": "/usr/bin:/bin"]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        try process.run()
        for _ in 0..<30 {
            if !process.isRunning { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        if process.isRunning { process.terminate(); throw StartupFailure.node }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        guard process.terminationStatus == 0, String(data: data, encoding: .utf8)?.hasPrefix("v24.") == true else { throw StartupFailure.node }
    }

    private func fail(_ code: String, _ message: String, log: [String] = []) {
        state = .failed
        detail = message
        failureLog = log
        diagnostics.record(code)
    }

    enum StartupFailure: LocalizedError {
        case installation, node, portInUse, processExited, readiness, stillRunning
        var errorDescription: String? {
            switch self {
            case .installation: return "The prepared runtime or Node executable is missing. Run scripts/setup-macos.sh from your checkout, or update the trusted paths in Settings. This source-build app keeps its runtime in the checkout."
            case .node: return "The configured executable must be a working Node.js 24 installation. Update its path in Settings."
            case .portInUse: return "Ports 39201 or 39202 are already in use. Quit any other copy of Jarvis or its developer launcher, then retry."
            case .processExited: return "A local service stopped while starting. Its last output is shown below."
            case .readiness: return "The local services did not become ready in time. Their last output is shown below."
            case .stillRunning: return "An existing service is still stopping. Wait for confirmed shutdown before restarting."
            }
        }
    }
}
