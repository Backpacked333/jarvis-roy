import Foundation
import XCTest
@testable import Jarvis

final class StartupExperienceTests: XCTestCase {
    func testServiceOutputIsRedactedBeforeItIsStoredOrShown() {
        let key = "vck_3fA9xQ7LmN2pR8sT4uV6wY0zB1cD5eF7gH9jK"
        let line = RuntimeLogRedaction.redact("request failed Authorization: Bearer \(key) under /Users/roy/Library/Application Support/JarvisRoy")
        XCTAssertFalse(line.contains(key))
        XCTAssertTrue(line.contains("/Users/roy/Library/Application Support/JarvisRoy"))
        XCTAssertEqual(RuntimeLogRedaction.redact("token=abc12345 next"), "token=[redacted] next")
        XCTAssertFalse(RuntimeLogRedaction.redact(#"{"apiKey":"shortsecret"}"#).contains("shortsecret"))
        XCTAssertEqual(RuntimeLogRedaction.redact("saw my-short-secret here", secrets: ["my-short-secret"]), "saw [redacted] here")
        XCTAssertEqual(RuntimeLogRedaction.redact("Jarvis bridge listening on http://127.0.0.1:39202"), "Jarvis bridge listening on http://127.0.0.1:39202")
        XCTAssertEqual(RuntimeLogRedaction.redact("a\u{1B}[31mb\u{07}"), "a [31mb ")
        XCTAssertEqual(RuntimeLogRedaction.redact(String(repeating: "word ", count: 1_000)).count, RuntimeLogRedaction.maximumLineLength + 1)
    }

    func testOutputIsSplitIntoBoundedCompleteLines() {
        var buffer = RuntimeLogLineBuffer()
        XCTAssertEqual(buffer.append(Data("one\ntw".utf8)), ["one"])
        XCTAssertEqual(buffer.append(Data("o\r\n\nthree".utf8)), ["two"])
        XCTAssertEqual(buffer.flush(), ["three"])
        XCTAssertEqual(buffer.flush(), [])
        XCTAssertEqual(buffer.append(Data(repeating: 0x41, count: RuntimeLogLineBuffer.maximumPartialBytes + 1)).count, 1)
    }

    func testLogFilesArePrivateRedactedAndSizeCapped() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("jarvis-log-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = RuntimeLogStore(directory: directory, secrets: ["loopback-secret-value"])
        store.append(Data("starting with loopback-secret-value\npartial".utf8), role: "bridge")
        store.finish(role: "bridge")
        XCTAssertEqual(store.tail(role: "bridge"), ["starting with [redacted]", "partial"])
        XCTAssertEqual(store.tail(role: "runtime"), [])
        let url = store.fileURL(role: "bridge")
        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(text.contains("loopback-secret-value"))
        XCTAssertTrue(text.contains("starting with [redacted]"))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)

        for _ in 0..<300 { store.append(Data((String(repeating: "x y ", count: 500) + "\n").utf8), role: "bridge") }
        XCTAssertEqual(store.tail(role: "bridge", lines: 100).count, RuntimeLogStore.recentLineLimit)
        let size = try XCTUnwrap((try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue)
        XCTAssertGreaterThan(size, 0)
        XCTAssertLessThanOrEqual(size, RuntimeLogStore.maximumFileBytes)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("bridge.previous.log").path))
    }

    func testReadinessNoticeNamesTheOneThingInTheWay() throws {
        XCTAssertNil(ReadinessNotice.current(state: .ready, detail: "", providerConfigured: true))
        // Unknown is not the same as missing: never claim a key is absent before the service has said so.
        XCTAssertNil(ReadinessNotice.current(state: .ready, detail: "", providerConfigured: nil))
        let key = try XCTUnwrap(ReadinessNotice.current(state: .ready, detail: "", providerConfigured: false))
        XCTAssertEqual(key.kind, .needsKey)
        XCTAssertEqual(ReadinessNotice.current(state: .idle, detail: "ignored", providerConfigured: nil)?.kind, .working)
        XCTAssertEqual(ReadinessNotice.current(state: .starting, detail: "Starting…", providerConfigured: false)?.message, "Starting…")
        XCTAssertEqual(ReadinessNotice.current(state: .stopping, detail: "Stopping…", providerConfigured: true)?.kind, .working)
        XCTAssertEqual(ReadinessNotice.current(state: .stopped, detail: "Stopped.", providerConfigured: true)?.kind, .failed)
        let failed = try XCTUnwrap(ReadinessNotice.current(state: .failed, detail: "Port in use.", failureLog: ["line one"], providerConfigured: false))
        XCTAssertEqual(failed.kind, .failed)
        XCTAssertEqual(failed.message, "Port in use.")
        XCTAssertEqual(failed.log, ["line one"])
    }

    func testEveryApprovalButtonObeysOneRule() {
        XCTAssertTrue(ApprovalGate.allows(optionID: "approve", reviewable: true, pending: false, connected: true))
        XCTAssertTrue(ApprovalGate.allows(optionID: "approve", reviewable: nil, pending: false, connected: true))
        XCTAssertFalse(ApprovalGate.allows(optionID: "approve", reviewable: false, pending: false, connected: true))
        XCTAssertTrue(ApprovalGate.allows(optionID: "deny", reviewable: false, pending: false, connected: true))
        for option in ["approve", "deny"] {
            XCTAssertFalse(ApprovalGate.allows(optionID: option, reviewable: true, pending: true, connected: true))
            XCTAssertFalse(ApprovalGate.allows(optionID: option, reviewable: true, pending: false, connected: false))
        }
    }

    func testFirstRunTurnsOnOnlyTheConversationExperience() throws {
        let name = "JarvisFirstRunTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        RuntimePreferences.registerFirstRunDefaults(in: defaults)
        let environment = RuntimePreferences(defaults: defaults).environment(inherited: [:])
        let on: Set<String> = ["JARVIS_ENABLE_ASSISTANT", "JARVIS_ENABLE_KNOWLEDGE", "JARVIS_ENABLE_MEMORY"]
        for flag in RuntimePreferences.flags.keys { XCTAssertEqual(environment[flag], on.contains(flag) ? "1" : "0", flag) }
        // Anything that acts on the Mac, reaches an account, leaves the Mac or spends unattended needs a deliberate choice.
        for flag in ["JARVIS_ENABLE_DESKTOP", "JARVIS_ENABLE_TERMINAL", "JARVIS_ENABLE_APPLE_SERVICES", "JARVIS_ENABLE_CLOUD",
                     "JARVIS_ENABLE_RESEARCH", "JARVIS_ENABLE_OBJECTIVES", "JARVIS_ENABLE_VOICE_APPROVAL"] {
            XCTAssertEqual(environment[flag], "0", flag)
        }
        // A person's own choice always wins over the starting values.
        defaults.set(false, forKey: "Jarvis.memoryEnabled")
        XCTAssertEqual(RuntimePreferences(defaults: defaults).environment(inherited: [:])["JARVIS_ENABLE_MEMORY"], "0")
        XCTAssertEqual(RuntimePreferences(defaults: defaults).environment(inherited: ["JARVIS_ENABLE_ASSISTANT": "0"])["JARVIS_ENABLE_ASSISTANT"], "0")
    }

    func testBridgeStateDecodesWithAndWithoutProviderStatus() throws {
        let older = Data(#"{"ready":true,"model":"m","tasks":[],"conversations":[],"memories":[]}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(RuntimeState.self, from: older).providerConfigured)
        let newer = Data(#"{"ready":true,"model":"m","providerConfigured":false,"tasks":[],"conversations":[],"memories":[]}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(RuntimeState.self, from: newer).providerConfigured, false)
    }
}
