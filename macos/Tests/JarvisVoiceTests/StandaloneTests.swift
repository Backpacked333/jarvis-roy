import Foundation
import XCTest
@testable import Jarvis

@MainActor
private final class FakeSupervisorProcess: SupervisorProcessHandle {
    private let continuation: AsyncStream<SupervisorProcessSignal>.Continuation
    var written: [Data] = []
    var inputClosed = false
    var terminateCalls = 0
    var killCalls = 0
    var writeFailure: Error?
    var exitsOnTerminate = true

    init(_ continuation: AsyncStream<SupervisorProcessSignal>.Continuation) { self.continuation = continuation }

    func writeInput(_ data: Data) throws {
        if let writeFailure { throw writeFailure }
        written.append(data)
    }
    func closeInput() { inputClosed = true }
    func terminate() {
        terminateCalls += 1
        if exitsOnTerminate {
            emit(#"{"event":"stopping"}"#)
            emit(#"{"event":"stopped","clean":true}"#)
            finish(status: 0)
        }
    }
    func forceKill() {
        killCalls += 1
        finish(status: 137)
    }
    func emit(_ line: String) { continuation.yield(.output(Data((line + "\n").utf8))) }
    func emitRaw(_ bytes: String) { continuation.yield(.output(Data(bytes.utf8))) }
    func finish(status: Int32) {
        continuation.yield(.exit(status))
        continuation.finish()
    }
}

@MainActor
private final class FakeSupervisorLauncher: SupervisorProcessLaunching {
    var requests: [SupervisorLaunchRequest] = []
    var processes: [FakeSupervisorProcess] = []
    var failure: Error?
    var configure: ((FakeSupervisorProcess) -> Void)?

    func launch(_ request: SupervisorLaunchRequest) throws -> SupervisorLaunch {
        if let failure { throw failure }
        requests.append(request)
        let (events, continuation) = AsyncStream.makeStream(of: SupervisorProcessSignal.self)
        let process = FakeSupervisorProcess(continuation)
        configure?(process)
        processes.append(process)
        return SupervisorLaunch(handle: process, events: events)
    }
}

private struct FakeLaunchError: Error {}

final class StandaloneTests: XCTestCase {
    private var directories: [URL] = []

    override func tearDown() {
        for directory in directories { try? FileManager.default.removeItem(at: directory) }
        directories = []
        super.tearDown()
    }

    private func temporaryDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("jarvis-standalone-\(UUID().uuidString)", isDirectory: true)
        directories.append(url)
        return url
    }

    private static let validToken = String(repeating: "ab", count: 32)
    private static let digest = String(repeating: "0123456789abcdef", count: 4)

    private func jsonObject(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: Token

    func testGeneratedTokenIsFreshLowercaseHex() throws {
        let first = try XCTUnwrap(LocalSession.generateToken())
        let second = try XCTUnwrap(LocalSession.generateToken())
        XCTAssertEqual(first.count, 64)
        XCTAssertNotNil(first.range(of: "^[0-9a-f]{64}$", options: .regularExpression))
        XCTAssertNotEqual(first, second)
        XCTAssertTrue(LocalSession.isValidToken(first))
        XCTAssertFalse(LocalSession.isValidToken(first.uppercased()))
        XCTAssertFalse(LocalSession.isValidToken(String(first.dropLast())))
        XCTAssertFalse(LocalSession.isValidToken(String(first.dropLast()) + "g"))
        XCTAssertFalse(LocalSession.isValidToken(""))
    }

    // MARK: Config

    func testConfigEncodesExactSpecKeysAndRoundTrips() throws {
        let config = StandaloneConfig()
        let object = try jsonObject(try config.encoded())
        XCTAssertEqual(Set(object.keys), ["version", "model", "enableDesktop", "enableTerminal", "enableAppleServices",
                                          "homeAssistantURL", "allowHomeAssistantHTTP", "elevenLabsVoiceID", "workerImage",
                                          "workerPython", "dockerBinary"])
        XCTAssertEqual(object["version"] as? Int, 1)
        XCTAssertEqual(object["model"] as? String, "openai/gpt-4.1-mini")
        XCTAssertEqual(try StandaloneConfig.decode(try config.encoded()), config)

        let spec = #"{"version":1,"model":"openai/gpt-4.1-mini","enableDesktop":false,"enableTerminal":false,"enableAppleServices":false,"homeAssistantURL":"","allowHomeAssistantHTTP":false,"elevenLabsVoiceID":"","workerImage":"","workerPython":"","dockerBinary":""}"#
        XCTAssertEqual(try StandaloneConfig.decode(Data(spec.utf8)), StandaloneConfig())

        var custom = StandaloneConfig()
        custom.enableTerminal = true
        custom.homeAssistantURL = "https://ha.example:8123"
        custom.workerImage = "python@sha256:\(Self.digest)"
        XCTAssertEqual(try StandaloneConfig.decode(try custom.encoded()), custom)
    }

    func testConfigDecodeDefaultsMissingKeysAndRejectsUnknownVersion() throws {
        let partial = try StandaloneConfig.decode(Data(#"{"version":1,"enableTerminal":true,"futureKey":"x"}"#.utf8))
        XCTAssertTrue(partial.enableTerminal)
        XCTAssertEqual(partial.model, StandaloneConfig.defaultModel)
        XCTAssertFalse(partial.enableDesktop)
        XCTAssertEqual(partial.dockerBinary, "")

        XCTAssertThrowsError(try StandaloneConfig.decode(Data(#"{"version":2}"#.utf8))) { error in
            XCTAssertEqual(error as? StandaloneConfigError, .unsupportedVersion)
        }
        XCTAssertThrowsError(try StandaloneConfig.decode(Data(#"{"model":"openai/gpt-4.1-mini"}"#.utf8)))
        XCTAssertThrowsError(try StandaloneConfig.decode(Data(#"{"version":1,"enableTerminal":"yes"}"#.utf8)))
        XCTAssertThrowsError(try StandaloneConfig.decode(Data("not json".utf8)))
    }

    func testConfigSaveIsPrivateAndLoadHandlesMissingFile() throws {
        let directory = temporaryDirectory().appendingPathComponent("JarvisRoy", isDirectory: true)
        let url = StandaloneConfig.fileURL(in: directory)
        XCTAssertEqual(try StandaloneConfig.load(from: url), StandaloneConfig())

        var config = StandaloneConfig()
        config.enableAppleServices = true
        config.elevenLabsVoiceID = "voice_123"
        try config.save(to: url)
        XCTAssertEqual(try StandaloneConfig.load(from: url), config)

        let fileMode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)
        let directoryMode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber)
        XCTAssertEqual(fileMode.intValue & 0o777, 0o600)
        XCTAssertEqual(directoryMode.intValue & 0o777, 0o700)

        config.enableAppleServices = false
        try config.save(to: url)
        XCTAssertEqual(try StandaloneConfig.load(from: url), config)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(leftovers, [StandaloneConfig.fileName])
    }

    func testConfigLoadRefusesSymlinksAndOversizedFiles() throws {
        let directory = temporaryDirectory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let real = directory.appendingPathComponent("real.json")
        try StandaloneConfig().save(to: real)
        let link = directory.appendingPathComponent("link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        XCTAssertThrowsError(try StandaloneConfig.load(from: link)) { error in
            XCTAssertEqual(error as? StandaloneConfigError, .unsafeFile)
        }
        let large = directory.appendingPathComponent("large.json")
        try Data(repeating: 0x20, count: StandaloneConfig.maximumFileBytes + 1).write(to: large)
        XCTAssertThrowsError(try StandaloneConfig.load(from: large)) { error in
            XCTAssertEqual(error as? StandaloneConfigError, .tooLarge)
        }
    }

    func testConfigValidation() {
        XCTAssertEqual(StandaloneConfig().validationErrors, [])

        func errors(_ change: (inout StandaloneConfig) -> Void) -> [String] {
            var config = StandaloneConfig()
            change(&config)
            return config.validationErrors
        }
        // Model
        XCTAssertEqual(errors { $0.model = "anthropic/claude-sonnet-4.5" }, [])
        XCTAssertEqual(errors { $0.model = "  openai/gpt-4.1-mini  " }, [])
        XCTAssertEqual(errors { $0.model = "" }.count, 1)
        XCTAssertEqual(errors { $0.model = "gpt-4" }.count, 1)
        XCTAssertEqual(errors { $0.model = "openai/gpt 4" }.count, 1)
        XCTAssertEqual(errors { $0.model = "openai/gpt-4\nX=1" }.count, 1)
        XCTAssertEqual(errors { $0.model = "a/b/c" }.count, 1)
        // Home Assistant
        XCTAssertEqual(errors { $0.homeAssistantURL = "https://ha.example:8123" }, [])
        XCTAssertEqual(errors { $0.homeAssistantURL = "https://ha.example/" }, [])
        XCTAssertEqual(errors { $0.homeAssistantURL = "http://192.168.1.5:8123"; $0.allowHomeAssistantHTTP = true }, [])
        XCTAssertEqual(errors { $0.homeAssistantURL = "http://192.168.1.5:8123" }.count, 1)
        XCTAssertEqual(errors { $0.homeAssistantURL = "ftp://ha.example" }.count, 1)
        XCTAssertEqual(errors { $0.homeAssistantURL = "https://user:pass@ha.example" }.count, 1)
        XCTAssertEqual(errors { $0.homeAssistantURL = "https://ha.example/api" }.count, 1)
        XCTAssertEqual(errors { $0.homeAssistantURL = "https://ha.example?x=1" }.count, 1)
        XCTAssertEqual(errors { $0.homeAssistantURL = "https://ha.example#frag" }.count, 1)
        XCTAssertEqual(errors { $0.homeAssistantURL = "ha.example" }.count, 1)
        // Voice ID
        XCTAssertEqual(errors { $0.elevenLabsVoiceID = "JBFqnCBsd6RMkjVDRZzb" }, [])
        XCTAssertEqual(errors { $0.elevenLabsVoiceID = "bad id" }.count, 1)
        // Worker image
        XCTAssertEqual(errors { $0.workerImage = "python@sha256:\(Self.digest)" }, [])
        XCTAssertEqual(errors { $0.workerImage = "python:3.12" }.count, 1)
        XCTAssertEqual(errors { $0.workerImage = "python@sha256:\(Self.digest.uppercased())" }.count, 1)
        XCTAssertEqual(errors { $0.workerImage = "python@sha256:abc" }.count, 1)
        // Paths
        XCTAssertEqual(errors { $0.workerPython = "/opt/venv/bin/python"; $0.dockerBinary = "/usr/local/bin/docker" }, [])
        XCTAssertEqual(errors { $0.workerPython = "venv/bin/python" }.count, 1)
        XCTAssertEqual(errors { $0.dockerBinary = "docker" }.count, 1)
        XCTAssertEqual(errors { $0.dockerBinary = "/usr/bin/docker\0" }.count, 1)
        XCTAssertEqual(errors { $0.version = 2 }.count, 1)
    }

    func testLaunchConfigEmitsOnlyNonEmptyValuesAndEnabledFlags() {
        XCTAssertEqual(StandaloneConfig().launchConfig(), ["JARVIS_MODEL": "openai/gpt-4.1-mini"])

        var config = StandaloneConfig()
        config.model = " openai/gpt-4.1 "
        config.enableDesktop = true
        config.enableTerminal = true
        config.enableAppleServices = true
        config.homeAssistantURL = "http://10.0.0.2:8123"
        config.allowHomeAssistantHTTP = true
        config.elevenLabsVoiceID = "voice"
        config.workerImage = "python@sha256:\(Self.digest)"
        config.workerPython = "/venv/bin/python"
        config.dockerBinary = "/usr/local/bin/docker"
        let launch = config.launchConfig()
        XCTAssertEqual(launch, [
            "JARVIS_MODEL": "openai/gpt-4.1",
            "JARVIS_ENABLE_DESKTOP": "1",
            "JARVIS_ENABLE_TERMINAL": "1",
            "JARVIS_ENABLE_APPLE_SERVICES": "1",
            "HOME_ASSISTANT_URL": "http://10.0.0.2:8123",
            "JARVIS_ALLOW_HOME_ASSISTANT_HTTP": "1",
            "ELEVENLABS_VOICE_ID": "voice",
            "JARVIS_WORKER_IMAGE": "python@sha256:\(Self.digest)",
            "JARVIS_WORKER_PYTHON": "/venv/bin/python",
            "JARVIS_DOCKER_BINARY": "/usr/local/bin/docker",
        ])
        XCTAssertTrue(Set(launch.keys).isSubset(of: Set(SupervisorPayload.configKeys)))

        config.enableTerminal = false
        config.allowHomeAssistantHTTP = false
        config.homeAssistantURL = "   "
        let reduced = config.launchConfig()
        XCTAssertNil(reduced["JARVIS_ENABLE_TERMINAL"])
        XCTAssertNil(reduced["JARVIS_ALLOW_HOME_ASSISTANT_HTTP"])
        XCTAssertNil(reduced["HOME_ASSISTANT_URL"])
    }

    // MARK: Supervisor protocol

    func testPayloadIsOneCompactLineWithOnlyAllowlistedKeys() throws {
        let payload = try SupervisorPayload(
            token: Self.validToken,
            secrets: ["AI_GATEWAY_API_KEY": "gw-key", "TAVILY_API_KEY": "", "PATH": "/evil", "ELEVENLABS_API_KEY": "el\"key/x"],
            config: ["JARVIS_MODEL": "openai/gpt-4.1-mini", "JARVIS_ENABLE_TERMINAL": "1", "NODE_OPTIONS": "--inspect", "HOME_ASSISTANT_URL": ""])
        let line = try payload.encodedLine()
        XCTAssertEqual(line.last, 0x0A)
        XCTAssertEqual(line.filter { $0 == 0x0A }.count, 1)
        XCTAssertFalse(line.contains(0x0D))
        let object = try jsonObject(line.dropLast())
        XCTAssertEqual(Set(object.keys), ["version", "token", "secrets", "config"])
        XCTAssertEqual(object["version"] as? Int, 1)
        XCTAssertEqual(object["token"] as? String, Self.validToken)
        XCTAssertEqual(object["secrets"] as? [String: String], ["AI_GATEWAY_API_KEY": "gw-key", "ELEVENLABS_API_KEY": "el\"key/x"])
        XCTAssertEqual(object["config"] as? [String: String], ["JARVIS_MODEL": "openai/gpt-4.1-mini", "JARVIS_ENABLE_TERMINAL": "1"])
        XCTAssertEqual(Set(SupervisorPayload.secretKeys), ["AI_GATEWAY_API_KEY", "TAVILY_API_KEY", "HOME_ASSISTANT_TOKEN", "ELEVENLABS_API_KEY"])
        XCTAssertEqual(SupervisorPayload.configKeys.count, 10)
    }

    func testPayloadFailsClosed() {
        let secrets = ["AI_GATEWAY_API_KEY": "gw-key"]
        XCTAssertThrowsError(try SupervisorPayload(token: "short", secrets: secrets, config: [:])) {
            XCTAssertEqual($0 as? SupervisorProtocolError, .invalidToken)
        }
        XCTAssertThrowsError(try SupervisorPayload(token: Self.validToken, secrets: ["TAVILY_API_KEY": "t"], config: [:])) {
            XCTAssertEqual($0 as? SupervisorProtocolError, .missingModelCredential)
        }
        XCTAssertThrowsError(try SupervisorPayload(token: Self.validToken, secrets: ["AI_GATEWAY_API_KEY": ""], config: [:])) {
            XCTAssertEqual($0 as? SupervisorProtocolError, .missingModelCredential)
        }
        XCTAssertThrowsError(try SupervisorPayload(token: Self.validToken, secrets: ["AI_GATEWAY_API_KEY": "a\nb"], config: [:])) {
            XCTAssertEqual($0 as? SupervisorProtocolError, .invalidValue)
        }
        XCTAssertThrowsError(try SupervisorPayload(token: Self.validToken, secrets: secrets, config: ["JARVIS_MODEL": "x\0y"])) {
            XCTAssertEqual($0 as? SupervisorProtocolError, .invalidValue)
        }
        let huge = String(repeating: "k", count: SupervisorPayload.maximumBytes)
        XCTAssertThrowsError(try SupervisorPayload(token: Self.validToken, secrets: ["AI_GATEWAY_API_KEY": huge], config: [:]).encodedLine()) {
            XCTAssertEqual($0 as? SupervisorProtocolError, .tooLarge)
        }
    }

    func testEventDecoding() {
        XCTAssertEqual(SupervisorEvent(line: #"{"event":"starting"}"#), .starting)
        XCTAssertEqual(SupervisorEvent(line: #"{"event":"ready"}"#), .ready)
        XCTAssertEqual(SupervisorEvent(line: #"{"event":"stopping"}"#), .stopping)
        XCTAssertEqual(SupervisorEvent(line: #"{"event":"stopped","clean":true}"#), .stopped(clean: true))
        XCTAssertEqual(SupervisorEvent(line: #"{"event":"stopped","clean":false}"#), .stopped(clean: false))
        XCTAssertEqual(SupervisorEvent(line: #"{"event":"stopped"}"#), .stopped(clean: false))
        XCTAssertEqual(SupervisorEvent(line: #"{"event":"failed","reason":"Another Jarvis instance appears to be running."}"#),
                       .failed("Another Jarvis instance appears to be running."))
        XCTAssertEqual(SupervisorEvent(line: #"{"event":"failed"}"#), .failed(SupervisorEvent.fallbackReason))
        XCTAssertEqual(SupervisorEvent(line: "{\"event\":\"ready\"}\r"), .ready)

        for malformed in ["", "not json", "{}", "[]", #"{"event":1}"#, #"{"event":"launch"}"#,
                          #"{"event":"failed","reason":5}"#, "{\"event\":\"ready\"", "null"] {
            XCTAssertNil(SupervisorEvent(line: malformed), malformed)
        }
        let oversized = #"{"event":"failed","reason":""# + String(repeating: "a ", count: SupervisorEvent.maximumLineBytes) + #""}"#
        XCTAssertNil(SupervisorEvent(line: oversized))
    }

    func testFailureReasonsAreSanitizedAndCapped() throws {
        let secret = "sk-" + String(repeating: "Z", count: 40)
        let event = SupervisorEvent(line: #"{"event":"failed","reason":"bad\nkey \#(secret)\u0007 here"}"#)
        guard case .failed(let reason) = try XCTUnwrap(event) else { return XCTFail("expected failed") }
        XCTAssertFalse(reason.contains(secret))
        XCTAssertTrue(reason.contains("[redacted]"))
        XCTAssertFalse(reason.contains("\n"))
        XCTAssertEqual(reason, "bad key [redacted] here")

        let long = SupervisorEvent.sanitize(String(repeating: "word ", count: 200))
        XCTAssertEqual(long.count, SupervisorEvent.maximumReasonLength)
        XCTAssertTrue(long.hasSuffix("…"))
        XCTAssertEqual(SupervisorEvent.sanitize(" \n\t "), SupervisorEvent.fallbackReason)
    }

    func testLineBufferSplitsChunksAndDropsOversizedLines() {
        var buffer = SupervisorLineBuffer(limit: 32)
        XCTAssertEqual(buffer.append(Data(#"{"event":"#.utf8)), [])
        XCTAssertEqual(buffer.append(Data("\"ready\"}\n\n{\"a\"".utf8)).map { String(decoding: $0, as: UTF8.self) }, [#"{"event":"ready"}"#])
        XCTAssertEqual(buffer.append(Data(":1}\n".utf8)).map { String(decoding: $0, as: UTF8.self) }, [#"{"a":1}"#])
        XCTAssertEqual(buffer.append(Data(String(repeating: "x", count: 40).utf8)), [])
        XCTAssertEqual(buffer.append(Data("yyy\nok\n".utf8)).map { String(decoding: $0, as: UTF8.self) }, ["ok"])
    }

    // MARK: Credentials

    @MainActor
    func testInMemoryCredentialStoreSemantics() throws {
        let store = InMemoryCredentialStore()
        XCTAssertFalse(store.contains(.aiGateway))
        XCTAssertEqual(try store.launchSecrets(), [:])
        try store.save("  gw-key \n", for: .aiGateway)
        try store.save("tv", for: .tavily)
        XCTAssertTrue(store.contains(.aiGateway))
        XCTAssertEqual(try store.launchSecrets(), ["AI_GATEWAY_API_KEY": "gw-key", "TAVILY_API_KEY": "tv"])
        try store.delete(.tavily)
        try store.delete(.tavily)
        XCTAssertFalse(store.contains(.tavily))
        XCTAssertEqual(try store.launchSecrets(), ["AI_GATEWAY_API_KEY": "gw-key"])

        XCTAssertThrowsError(try store.save("   ", for: .elevenLabs)) { XCTAssertEqual($0 as? CredentialError, .empty) }
        XCTAssertThrowsError(try store.save("a\nb", for: .elevenLabs)) { XCTAssertEqual($0 as? CredentialError, .invalidCharacters) }
        XCTAssertThrowsError(try store.save("a\0b", for: .elevenLabs)) { XCTAssertEqual($0 as? CredentialError, .invalidCharacters) }
        XCTAssertThrowsError(try store.save(String(repeating: "k", count: 4_097), for: .elevenLabs)) {
            XCTAssertEqual($0 as? CredentialError, .tooLong)
        }
        XCTAssertFalse(store.contains(.elevenLabs))
        try store.save(String(repeating: "k", count: 4_096), for: .elevenLabs)
        XCTAssertTrue(store.contains(.elevenLabs))
        XCTAssertEqual(CredentialKey.allCases.map(\.rawValue), ["AI_GATEWAY_API_KEY", "TAVILY_API_KEY", "HOME_ASSISTANT_TOKEN", "ELEVENLABS_API_KEY"])
        XCTAssertNil(CredentialValue.problem(""))
        XCTAssertNotNil(CredentialValue.problem("a\rb"))
    }

    // MARK: Launch inputs

    func testMinimalEnvironmentPassesOnlyOSContext() {
        let environment = ServiceSupervisor.minimalEnvironment(from: [
            "HOME": "/Users/me", "TMPDIR": "/var/folders/x/", "USER": "me", "LOGNAME": "me", "LANG": "fr_FR.UTF-8",
            "PATH": "/opt/evil/bin", "AI_GATEWAY_API_KEY": "secret", "JARVIS_LOCAL_TOKEN": "token", "NODE_OPTIONS": "--inspect",
        ])
        XCTAssertEqual(environment, ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/Users/me", "TMPDIR": "/var/folders/x/",
                                     "USER": "me", "LOGNAME": "me", "LANG": "en_US.UTF-8"])
        XCTAssertNotNil(ServiceSupervisor.minimalEnvironment(from: [:])["HOME"])
    }

    func testResourceDiscoveryAndLaunchRequest() throws {
        let resources = URL(fileURLWithPath: "/Applications/Jarvis.app/Contents/Resources")
        let bundle = URL(fileURLWithPath: "/Applications/Jarvis.app")
        XCTAssertNil(SupervisorResources.locate(resourceURL: nil, bundleURL: bundle, isExecutable: { _ in true }, isFile: { _ in true }))
        XCTAssertNil(SupervisorResources.locate(resourceURL: resources, bundleURL: bundle,
                                                isExecutable: { !$0.hasSuffix("JarvisControl") }, isFile: { _ in true }))
        XCTAssertNil(SupervisorResources.locate(resourceURL: resources, bundleURL: bundle,
                                                isExecutable: { _ in true }, isFile: { !$0.hasSuffix("index.mjs") }))
        let found = try XCTUnwrap(SupervisorResources.locate(resourceURL: resources, bundleURL: bundle,
                                                             isExecutable: { _ in true }, isFile: { _ in true }))
        XCTAssertEqual(found.node.path, "/Applications/Jarvis.app/Contents/Resources/node/bin/node")
        XCTAssertEqual(found.supervisorScript.path, "/Applications/Jarvis.app/Contents/Resources/launcher/supervisor.mjs")
        XCTAssertEqual(found.runtimeEntry.path, "/Applications/Jarvis.app/Contents/Resources/runtime/.output/server/index.mjs")
        XCTAssertEqual(found.helper.path, "/Applications/Jarvis.app/Contents/Helpers/JarvisControl.app/Contents/MacOS/JarvisControl")

        let data = URL(fileURLWithPath: "/Users/me/Library/Application Support/JarvisRoy")
        let request = ServiceSupervisor.launchRequest(resources: found, dataDirectory: data, environment: ["PATH": "/usr/bin"])
        XCTAssertEqual(request.executable, found.node)
        XCTAssertEqual(request.arguments, [
            "/Applications/Jarvis.app/Contents/Resources/launcher/supervisor.mjs",
            "--resources", "/Applications/Jarvis.app/Contents/Resources",
            "--data-dir", "/Users/me/Library/Application Support/JarvisRoy",
            "--helper", "/Applications/Jarvis.app/Contents/Helpers/JarvisControl.app/Contents/MacOS/JarvisControl",
        ])
        XCTAssertEqual(request.currentDirectory, data)
        XCTAssertEqual(request.environment, ["PATH": "/usr/bin"])
    }

    // MARK: Service supervisor

    private static let fakeResources = SupervisorResources(
        resourcesDirectory: URL(fileURLWithPath: "/fake/Jarvis.app/Contents/Resources"),
        node: URL(fileURLWithPath: "/fake/Jarvis.app/Contents/Resources/node/bin/node"),
        supervisorScript: URL(fileURLWithPath: "/fake/Jarvis.app/Contents/Resources/launcher/supervisor.mjs"),
        runtimeEntry: URL(fileURLWithPath: "/fake/Jarvis.app/Contents/Resources/runtime/.output/server/index.mjs"),
        helper: URL(fileURLWithPath: "/fake/Jarvis.app/Contents/Helpers/JarvisControl.app/Contents/MacOS/JarvisControl"))

    @MainActor
    private func makeSupervisor(store: InMemoryCredentialStore? = nil,
                                launcher: FakeSupervisorLauncher? = nil,
                                externallySupervised: Bool = false,
                                stopTimeout: TimeInterval = 5,
                                resources: SupervisorResources? = StandaloneTests.fakeResources) -> ServiceSupervisor {
        ServiceSupervisor(externallySupervised: externallySupervised, token: Self.validToken,
                          credentials: store ?? InMemoryCredentialStore([.aiGateway: "gw-key"]),
                          launcher: launcher ?? FakeSupervisorLauncher(), dataDirectory: temporaryDirectory(),
                          baseEnvironment: ["HOME": "/Users/me", "AI_GATEWAY_API_KEY": "leak"],
                          stopTimeout: stopTimeout, resources: { resources })
    }

    @MainActor
    private func eventually(_ condition: () -> Bool) async {
        for _ in 0..<2_000 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    @MainActor
    func testExternallySupervisedStartsNothing() {
        let launcher = FakeSupervisorLauncher()
        let supervisor = makeSupervisor(launcher: launcher, externallySupervised: true)
        XCTAssertEqual(supervisor.phase, .externallyManaged)
        XCTAssertTrue(supervisor.phase.showsWorkspace)
        supervisor.start()
        XCTAssertEqual(supervisor.phase, .externallyManaged)
        XCTAssertTrue(launcher.requests.isEmpty)
    }

    @MainActor
    func testNeedsSetupWithoutModelKeyAndFailsHonestlyWithoutBundle() {
        let launcher = FakeSupervisorLauncher()
        let supervisor = makeSupervisor(store: InMemoryCredentialStore([.tavily: "tv"]), launcher: launcher)
        XCTAssertEqual(supervisor.phase, .stopped)
        supervisor.start()
        XCTAssertEqual(supervisor.phase, .needsSetup)
        XCTAssertFalse(supervisor.phase.showsWorkspace)
        XCTAssertTrue(launcher.requests.isEmpty)

        let unbundled = makeSupervisor(launcher: launcher, resources: nil)
        unbundled.start()
        XCTAssertEqual(unbundled.phase, .failed(ServiceSupervisor.missingBundleMessage))
        XCTAssertTrue(ServiceSupervisor.missingBundleMessage.contains("scripts/run-macos.sh"))
        XCTAssertTrue(launcher.requests.isEmpty)
    }

    @MainActor
    func testStartsThenReadyAndStopClosesStdinThenTerminates() async throws {
        let launcher = FakeSupervisorLauncher()
        let store = InMemoryCredentialStore([.aiGateway: "gw-key", .homeAssistant: "ha-token"])
        let supervisor = makeSupervisor(store: store, launcher: launcher)
        var config = StandaloneConfig()
        config.enableDesktop = true
        try config.save(to: supervisor.configURL)

        supervisor.start()
        XCTAssertEqual(supervisor.phase, .starting)
        XCTAssertTrue(supervisor.isRunning)
        let request = try XCTUnwrap(launcher.requests.first)
        XCTAssertEqual(request.executable, Self.fakeResources.node)
        XCTAssertNil(request.environment["AI_GATEWAY_API_KEY"])
        XCTAssertEqual(request.environment["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin")
        XCTAssertFalse(request.arguments.contains { $0.contains("gw-key") || $0.contains(Self.validToken) })

        let process = try XCTUnwrap(launcher.processes.first)
        XCTAssertEqual(process.written.count, 1)
        let line = try XCTUnwrap(process.written.first)
        XCTAssertEqual(line.last, 0x0A)
        let payload = try jsonObject(line.dropLast())
        XCTAssertEqual(payload["token"] as? String, Self.validToken)
        XCTAssertEqual(payload["secrets"] as? [String: String], ["AI_GATEWAY_API_KEY": "gw-key", "HOME_ASSISTANT_TOKEN": "ha-token"])
        XCTAssertEqual(payload["config"] as? [String: String], ["JARVIS_MODEL": "openai/gpt-4.1-mini", "JARVIS_ENABLE_DESKTOP": "1"])
        XCTAssertFalse(process.inputClosed)

        supervisor.start()
        XCTAssertEqual(launcher.requests.count, 1, "a second start while running must not spawn again")

        process.emit(#"{"event":"starting"}"#)
        process.emitRaw(#"{"event":"rea"#)
        process.emitRaw("dy\"}\n")
        await eventually { supervisor.phase == .ready }
        XCTAssertEqual(supervisor.phase, .ready)
        XCTAssertTrue(supervisor.phase.showsWorkspace)

        await supervisor.stop()
        XCTAssertTrue(process.inputClosed)
        XCTAssertEqual(process.terminateCalls, 1)
        XCTAssertEqual(process.killCalls, 0)
        XCTAssertEqual(supervisor.phase, .stopped)
        XCTAssertFalse(supervisor.isRunning)
    }

    @MainActor
    func testFailedEventAndUnexpectedExitFailHonestly() async throws {
        let launcher = FakeSupervisorLauncher()
        let supervisor = makeSupervisor(launcher: launcher)
        supervisor.start()
        let first = try XCTUnwrap(launcher.processes.last)
        first.emit("garbage that is not json")
        first.emit(#"{"event":"failed","reason":"Another Jarvis instance appears to be running."}"#)
        first.emit(#"{"event":"stopping"}"#)
        first.emit(#"{"event":"stopped","clean":true}"#)
        first.finish(status: 1)
        await eventually { !supervisor.isRunning }
        XCTAssertEqual(supervisor.phase, .failed("Another Jarvis instance appears to be running."))

        await supervisor.restart()
        XCTAssertEqual(launcher.requests.count, 2)
        XCTAssertEqual(supervisor.phase, .starting)
        let second = try XCTUnwrap(launcher.processes.last)
        second.emit(#"{"event":"ready"}"#)
        await eventually { supervisor.phase == .ready }
        second.finish(status: 9)
        await eventually { !supervisor.isRunning }
        guard case .failed(let reason) = supervisor.phase else { return XCTFail("expected failure, got \(supervisor.phase)") }
        XCTAssertTrue(reason.contains("unexpectedly"))
        XCTAssertFalse(supervisor.phase.showsWorkspace)
    }

    @MainActor
    func testLaunchAndWriteFailuresAndForcedKill() async throws {
        let failing = FakeSupervisorLauncher()
        failing.failure = FakeLaunchError()
        let unlaunchable = makeSupervisor(launcher: failing)
        unlaunchable.start()
        guard case .failed = unlaunchable.phase else { return XCTFail("expected failure") }
        XCTAssertFalse(unlaunchable.isRunning)

        let rejecting = FakeSupervisorLauncher()
        rejecting.configure = { $0.writeFailure = FakeLaunchError() }
        let rejected = makeSupervisor(launcher: rejecting)
        rejected.start()
        let process = try XCTUnwrap(rejecting.processes.first)
        XCTAssertTrue(process.inputClosed)
        XCTAssertEqual(process.terminateCalls, 1)
        await eventually { !rejected.isRunning }
        guard case .failed = rejected.phase else { return XCTFail("expected failure") }

        let stubborn = FakeSupervisorLauncher()
        stubborn.configure = { $0.exitsOnTerminate = false }
        let supervisor = makeSupervisor(launcher: stubborn, stopTimeout: 0.05)
        supervisor.start()
        let hung = try XCTUnwrap(stubborn.processes.first)
        await supervisor.stop()
        XCTAssertTrue(hung.inputClosed)
        XCTAssertEqual(hung.terminateCalls, 1)
        XCTAssertEqual(hung.killCalls, 1)
        XCTAssertEqual(supervisor.phase, .stopped)
        XCTAssertFalse(supervisor.isRunning)
    }

    @MainActor
    func testTerminationRefusesRestartsAlreadyInFlight() async throws {
        let launcher = FakeSupervisorLauncher()
        launcher.configure = { $0.exitsOnTerminate = false }
        let supervisor = makeSupervisor(launcher: launcher)
        supervisor.start()
        let process = try XCTUnwrap(launcher.processes.first)
        process.emit(#"{"event":"ready"}"#)
        await eventually { supervisor.phase == .ready }

        let restart = Task { @MainActor in await supervisor.restart() }
        await eventually { supervisor.phase == .stopping }
        supervisor.beginTermination()
        process.finish(status: 0)
        await restart.value
        XCTAssertEqual(launcher.requests.count, 1, "a restart in flight must not relaunch once the app is quitting")
        XCTAssertEqual(supervisor.phase, .stopped)
        XCTAssertFalse(supervisor.isRunning)
        supervisor.start()
        XCTAssertEqual(launcher.requests.count, 1)
    }

    @MainActor
    func testSaveSettingsValidatesBeforeWriting() throws {
        let store = InMemoryCredentialStore()
        let supervisor = makeSupervisor(store: store)
        var invalid = StandaloneConfig()
        invalid.workerImage = "python:latest"
        XCTAssertThrowsError(try supervisor.saveSettings(invalid, keys: [.aiGateway: "gw-key"]))
        XCTAssertFalse(store.contains(.aiGateway))
        XCTAssertFalse(FileManager.default.fileExists(atPath: supervisor.configURL.path))

        XCTAssertThrowsError(try supervisor.saveSettings(StandaloneConfig(), keys: [.aiGateway: "a\nb"]))
        XCTAssertFalse(store.contains(.aiGateway))

        var valid = StandaloneConfig()
        valid.enableTerminal = true
        valid.model = " openai/gpt-4.1 "
        try supervisor.saveSettings(valid, keys: [.aiGateway: " gw-key ", .tavily: "   "])
        XCTAssertEqual(supervisor.savedCredentialKeys(), [.aiGateway])
        XCTAssertEqual(try store.launchSecrets(), ["AI_GATEWAY_API_KEY": "gw-key"])
        let loaded = try supervisor.loadConfig()
        XCTAssertTrue(loaded.enableTerminal)
        XCTAssertEqual(loaded.model, "openai/gpt-4.1")
        try supervisor.removeCredential(.aiGateway)
        XCTAssertEqual(supervisor.savedCredentialKeys(), [])
    }
}
