import Combine
import Darwin
import Foundation

/// Paths inside `Jarvis.app` that app mode needs. Nothing here is ever written.
struct SupervisorResources: Equatable, Sendable {
    let resourcesDirectory: URL
    let node: URL
    let supervisorScript: URL
    let runtimeEntry: URL
    let helper: URL

    static func locate(resourceURL: URL?, bundleURL: URL,
                       isExecutable: (String) -> Bool, isFile: (String) -> Bool) -> SupervisorResources? {
        guard let resources = resourceURL?.standardizedFileURL else { return nil }
        let node = resources.appendingPathComponent("node/bin/node", isDirectory: false)
        let script = resources.appendingPathComponent("launcher/supervisor.mjs", isDirectory: false)
        let runtime = resources.appendingPathComponent("runtime/.output/server/index.mjs", isDirectory: false)
        let helper = bundleURL.standardizedFileURL
            .appendingPathComponent("Contents/Helpers/JarvisControl.app/Contents/MacOS/JarvisControl", isDirectory: false)
        guard isExecutable(node.path), isFile(script.path), isFile(runtime.path), isExecutable(helper.path) else { return nil }
        return SupervisorResources(resourcesDirectory: resources, node: node, supervisorScript: script,
                                   runtimeEntry: runtime, helper: helper)
    }

    static func discover() -> SupervisorResources? {
        let bundle = Bundle.main
        return locate(resourceURL: bundle.resourceURL, bundleURL: bundle.bundleURL,
                      isExecutable: { FileManager.default.isExecutableFile(atPath: $0) },
                      isFile: { path in
                          var directory: ObjCBool = false
                          return FileManager.default.fileExists(atPath: path, isDirectory: &directory) && !directory.boolValue
                      })
    }
}

struct SupervisorLaunchRequest: Equatable, Sendable {
    let executable: URL
    let arguments: [String]
    let environment: [String: String]
    let currentDirectory: URL
}

enum SupervisorProcessSignal: Sendable {
    case output(Data)
    case exit(Int32)
}

@MainActor
protocol SupervisorProcessHandle: AnyObject {
    func writeInput(_ data: Data) throws
    func closeInput()
    func terminate()
    func forceKill()
}

struct SupervisorLaunch {
    let handle: any SupervisorProcessHandle
    /// Ordered stdout chunks, then exactly one `.exit` after stdout reached end of file.
    let events: AsyncStream<SupervisorProcessSignal>
}

@MainActor
protocol SupervisorProcessLaunching: AnyObject {
    func launch(_ request: SupervisorLaunchRequest) throws -> SupervisorLaunch
}

/// Supervises the bundled `supervisor.mjs` in app mode. In launcher mode it does nothing.
@MainActor
final class ServiceSupervisor: ObservableObject {
    enum Phase: Equatable {
        case externallyManaged, needsSetup, starting, ready, failed(String), stopping, stopped

        /// True when the workspace (and its local-service clients) may be shown.
        var showsWorkspace: Bool { self == .externallyManaged || self == .ready }
    }

    enum SettingsError: LocalizedError {
        case invalid(String)
        var errorDescription: String? {
            switch self {
            case .invalid(let message): return message
            }
        }
    }

    static let missingBundleMessage = "This copy of Jarvis does not include its bundled local services. For a source build, quit and start Jarvis with scripts/run-macos.sh."
    static let unexpectedStopMessage = "Local services stopped unexpectedly. See the logs folder for details."

    /// Set by the app on appear so the application delegate can stop services before quitting.
    static weak var current: ServiceSupervisor?

    @Published private(set) var phase: Phase
    let isExternallySupervised: Bool
    let dataDirectory: URL
    let credentials: any CredentialStoring

    private let token: String
    private let launcher: any SupervisorProcessLaunching
    private let locateResources: () -> SupervisorResources?
    private let baseEnvironment: [String: String]
    private let stopTimeout: TimeInterval
    private var process: (any SupervisorProcessHandle)?
    private var listener: Task<Void, Never>?
    private var generation = 0
    private var lines = SupervisorLineBuffer()
    private var stopRequested = false
    private var terminating = false
    private var lastFailure: String?

    var isRunning: Bool { process != nil }
    var configURL: URL { StandaloneConfig.fileURL(in: dataDirectory) }
    var logsDirectory: URL { StandaloneConfig.logsDirectory(in: dataDirectory) }

    init(externallySupervised: Bool = LocalSession.isExternallySupervised,
         token: String = LocalSession.token,
         credentials: (any CredentialStoring)? = nil,
         launcher: (any SupervisorProcessLaunching)? = nil,
         dataDirectory: URL? = nil,
         baseEnvironment: [String: String]? = nil,
         stopTimeout: TimeInterval = 75,
         resources: (() -> SupervisorResources?)? = nil) {
        isExternallySupervised = externallySupervised
        self.token = token
        self.credentials = credentials ?? KeychainCredentialStore()
        self.launcher = launcher ?? FoundationSupervisorLauncher()
        self.dataDirectory = (dataDirectory ?? StandaloneConfig.defaultDataDirectory).standardizedFileURL
        self.baseEnvironment = baseEnvironment ?? ProcessInfo.processInfo.environment
        self.stopTimeout = stopTimeout
        locateResources = resources ?? { SupervisorResources.discover() }
        phase = externallySupervised ? .externallyManaged : .stopped
    }

    // MARK: Lifecycle

    func start() {
        guard !isExternallySupervised else { phase = .externallyManaged; return }
        guard process == nil, !stopRequested, !terminating else { return }
        guard let resources = locateResources() else { phase = .failed(Self.missingBundleMessage); return }
        guard credentials.contains(.aiGateway) else { phase = .needsSetup; return }
        let config: StandaloneConfig
        do {
            config = try StandaloneConfig.load(from: configURL)
        } catch {
            phase = .failed("Jarvis settings could not be read. Open Settings and save them again.")
            return
        }
        guard config.validationErrors.isEmpty else {
            phase = .failed("Saved settings are invalid. Open Settings to correct them.")
            return
        }
        var line: Data
        do {
            var secrets = try credentials.launchSecrets()
            let payload = try SupervisorPayload(token: token, secrets: secrets, config: config.launchConfig())
            secrets.removeAll()
            line = try payload.encodedLine()
        } catch SupervisorProtocolError.missingModelCredential {
            phase = .needsSetup
            return
        } catch let error as SupervisorProtocolError {
            phase = .failed(error.localizedDescription)
            return
        } catch {
            phase = .failed("Saved keys could not be read from the macOS Keychain.")
            return
        }
        defer { line.resetBytes(in: 0..<line.count) }
        do {
            try StandaloneConfig.ensurePrivateDirectory(dataDirectory)
        } catch {
            phase = .failed("Jarvis could not create its private data folder.")
            return
        }
        let request = Self.launchRequest(resources: resources, dataDirectory: dataDirectory,
                                         environment: Self.minimalEnvironment(from: baseEnvironment))
        generation += 1
        let current = generation
        lastFailure = nil
        lines.reset()
        phase = .starting
        let launch: SupervisorLaunch
        do {
            launch = try launcher.launch(request)
        } catch {
            phase = .failed("The bundled local services could not be launched.")
            return
        }
        process = launch.handle
        listen(launch.events, generation: current)
        do {
            try launch.handle.writeInput(line)
        } catch {
            let reason = "Local services did not accept their launch settings."
            lastFailure = reason
            phase = .failed(reason)
            launch.handle.closeInput()
            launch.handle.terminate()
        }
    }

    /// Closes the stdin lifeline, sends SIGTERM and waits (bounded) for the supervisor to exit.
    func stop() async {
        guard let handle = process else {
            switch phase {
            case .starting, .ready, .stopping: phase = .stopped
            default: break
            }
            return
        }
        if !stopRequested {
            stopRequested = true
            phase = .stopping
            handle.closeInput()
            handle.terminate()
        }
        let exited = await waitForExit(of: handle, timeout: stopTimeout)
        if !exited {
            handle.forceKill()
            _ = await waitForExit(of: handle, timeout: 5)
        }
        if isTracking(handle) {
            // It never reported its exit; stop tracking it so the app can still quit.
            process = nil
            listener?.cancel()
            listener = nil
            generation += 1
            lines.reset()
            phase = .stopped
        }
        stopRequested = false
    }

    func restart() async {
        await stop()
        start()
    }

    /// Called when the app quits: refuses every later start, so a restart that is already in
    /// flight cannot launch a new supervisor behind the quitting app. Follow with `stop()`.
    func beginTermination() {
        terminating = true
    }

    private func waitForExit(of handle: any SupervisorProcessHandle, timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(max(0, timeout))
        while isTracking(handle) {
            if Date() >= deadline { return false }
            do { try await Task.sleep(nanoseconds: 20_000_000) } catch { return !isTracking(handle) }
        }
        return true
    }

    private func isTracking(_ handle: any SupervisorProcessHandle) -> Bool {
        guard let process else { return false }
        return ObjectIdentifier(process) == ObjectIdentifier(handle)
    }

    private func listen(_ events: AsyncStream<SupervisorProcessSignal>, generation: Int) {
        listener?.cancel()
        listener = Task { @MainActor [weak self] in
            for await signal in events {
                guard let self else { return }
                self.receive(signal, generation: generation)
            }
        }
    }

    private func receive(_ signal: SupervisorProcessSignal, generation: Int) {
        guard generation == self.generation else { return }
        switch signal {
        case .output(let chunk):
            for line in lines.append(chunk) {
                if let event = SupervisorEvent(line: line) { apply(event) }
            }
        case .exit(let status):
            processExited(status: status)
        }
    }

    private func apply(_ event: SupervisorEvent) {
        switch event {
        case .starting, .stopped:
            break
        case .ready:
            if !stopRequested, phase == .starting { phase = .ready }
        case .failed(let reason):
            lastFailure = reason
            if !stopRequested { phase = .failed(reason) }
        case .stopping:
            if !stopRequested, phase == .ready || phase == .starting {
                phase = .failed(lastFailure ?? Self.unexpectedStopMessage)
            }
        }
    }

    private func processExited(status: Int32) {
        process = nil
        listener = nil
        lines.reset()
        if stopRequested {
            phase = .stopped
            return
        }
        switch phase {
        case .failed:
            break
        default:
            phase = .failed(lastFailure ?? "Local services stopped unexpectedly (exit status \(status)). See the logs folder for details.")
        }
    }

    // MARK: Settings

    func savedCredentialKeys() -> Set<CredentialKey> {
        Set(CredentialKey.allCases.filter { credentials.contains($0) })
    }

    func loadConfig() throws -> StandaloneConfig {
        try StandaloneConfig.load(from: configURL)
    }

    /// Validates everything first, then writes the config file and any newly typed keys.
    func saveSettings(_ config: StandaloneConfig, keys: [CredentialKey: String]) throws {
        let normalized = config.normalized()
        if let problem = normalized.validationErrors.first { throw SettingsError.invalid(problem) }
        var validated: [CredentialKey: String] = [:]
        for (key, raw) in keys where !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            validated[key] = try CredentialValue.validated(raw)
        }
        try normalized.save(to: configURL)
        for key in CredentialKey.allCases {
            if let value = validated[key] { try credentials.save(value, for: key) }
        }
        validated.removeAll()
    }

    func removeCredential(_ key: CredentialKey) throws {
        try credentials.delete(key)
    }

    // MARK: Launch inputs

    nonisolated static func minimalEnvironment(from source: [String: String]) -> [String: String] {
        var environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
        for key in ["HOME", "TMPDIR", "USER", "LOGNAME"] {
            if let value = source[key], !value.isEmpty, !StandaloneConfig.containsControlCharacters(value) {
                environment[key] = value
            }
        }
        if environment["HOME"] == nil { environment["HOME"] = NSHomeDirectory() }
        return environment
    }

    nonisolated static func launchRequest(resources: SupervisorResources, dataDirectory: URL,
                                          environment: [String: String]) -> SupervisorLaunchRequest {
        SupervisorLaunchRequest(
            executable: resources.node,
            arguments: [resources.supervisorScript.path,
                        "--resources", resources.resourcesDirectory.path,
                        "--data-dir", dataDirectory.standardizedFileURL.path,
                        "--helper", resources.helper.path],
            environment: environment,
            currentDirectory: dataDirectory)
    }
}

// MARK: Foundation process launcher

/// Delivers `.exit` only once the process terminated and stdout reached EOF, so the final
/// `failed` line is never overtaken by the exit. Falls back to the exit alone after 2 s.
private final class SupervisorExitLatch: @unchecked Sendable {
    private let lock = NSLock()
    private let continuation: AsyncStream<SupervisorProcessSignal>.Continuation
    private var outputEnded = false
    private var status: Int32?
    private var delivered = false

    init(_ continuation: AsyncStream<SupervisorProcessSignal>.Continuation) { self.continuation = continuation }

    func output(_ data: Data) { continuation.yield(.output(data)) }

    func endOfOutput() {
        lock.lock()
        outputEnded = true
        let ready = takeDeliverable(force: false)
        lock.unlock()
        if let ready { deliver(ready) }
    }

    func terminated(_ code: Int32) {
        lock.lock()
        status = code
        let ready = takeDeliverable(force: false)
        lock.unlock()
        if let ready {
            deliver(ready)
        } else {
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [self] in
                lock.lock()
                let late = takeDeliverable(force: true)
                lock.unlock()
                if let late { deliver(late) }
            }
        }
    }

    /// Must be called with the lock held.
    private func takeDeliverable(force: Bool) -> Int32? {
        guard !delivered, let status, outputEnded || force else { return nil }
        delivered = true
        return status
    }

    private func deliver(_ code: Int32) {
        continuation.yield(.exit(code))
        continuation.finish()
    }

    func abandon() { continuation.finish() }
}

@MainActor
final class FoundationSupervisorProcess: SupervisorProcessHandle {
    private let process: Process
    private let input: FileHandle
    private var inputClosed = false

    init(process: Process, input: FileHandle) {
        self.process = process
        self.input = input
    }

    func writeInput(_ data: Data) throws {
        guard !inputClosed else { throw CocoaError(.fileWriteUnknown) }
        try input.write(contentsOf: data)
    }

    func closeInput() {
        guard !inputClosed else { return }
        inputClosed = true
        try? input.close()
    }

    func terminate() {
        if process.isRunning { process.terminate() }
    }

    func forceKill() {
        let pid = process.processIdentifier
        if process.isRunning, pid > 0 { _ = Darwin.kill(pid, SIGKILL) }
    }
}

@MainActor
final class FoundationSupervisorLauncher: SupervisorProcessLaunching {
    init() {
        // A write to a supervisor that already exited must fail with EPIPE, not kill the app.
        signal(SIGPIPE, SIG_IGN)
    }

    func launch(_ request: SupervisorLaunchRequest) throws -> SupervisorLaunch {
        let process = Process()
        process.executableURL = request.executable
        process.arguments = request.arguments
        process.environment = request.environment
        process.currentDirectoryURL = request.currentDirectory
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice  // the supervisor writes its own log files

        let (events, continuation) = AsyncStream.makeStream(of: SupervisorProcessSignal.self)
        let latch = SupervisorExitLatch(continuation)
        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                latch.endOfOutput()
            } else {
                latch.output(data)
            }
        }
        process.terminationHandler = { finished in
            latch.terminated(finished.terminationStatus)
        }
        do {
            try process.run()
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            process.terminationHandler = nil
            latch.abandon()
            throw error
        }
        return SupervisorLaunch(handle: FoundationSupervisorProcess(process: process, input: input.fileHandleForWriting),
                                events: events)
    }
}
