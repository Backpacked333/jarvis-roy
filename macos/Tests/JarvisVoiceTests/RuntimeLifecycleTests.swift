import Foundation
import XCTest
@testable import Jarvis

final class RuntimeLifecycleTests: XCTestCase {
    func testNewCapabilitiesDefaultOffAndExplicitLauncherConfigurationWins() throws {
        let name = "JarvisRuntimeTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = RuntimePreferences(defaults: defaults)
        let baseline = preferences.environment(inherited: [:])
        for flag in RuntimePreferences.flags.keys { XCTAssertEqual(baseline[flag], "0") }
        XCTAssertEqual(baseline["JARVIS_ENABLE_RESEARCH"], "0")
        defaults.set(true, forKey: "Jarvis.assistantEnabled")
        defaults.set(true, forKey: "Jarvis.knowledgeEnabled")
        XCTAssertEqual(preferences.environment(inherited: [:])["JARVIS_ENABLE_RESEARCH"], "0")
        defaults.set(true, forKey: "Jarvis.researchEnabled")
        XCTAssertEqual(preferences.environment(inherited: [:])["JARVIS_ENABLE_RESEARCH"], "1")
        defaults.set("configured/model", forKey: "Jarvis.model")
        XCTAssertEqual(preferences.environment(inherited: [:])["JARVIS_ENABLE_ASSISTANT"], "1")
        let explicit = preferences.environment(inherited: ["JARVIS_ENABLE_ASSISTANT": "0", "JARVIS_ENABLE_RESEARCH": "0", "JARVIS_MODEL": "launcher/model"])
        XCTAssertEqual(explicit["JARVIS_ENABLE_ASSISTANT"], "0")
        XCTAssertEqual(explicit["JARVIS_ENABLE_RESEARCH"], "0")
        XCTAssertEqual(explicit["JARVIS_MODEL"], "launcher/model")
    }

    func testNativeControlAuthorityNeverReachesReasoningRuntime() {
        let image = "sha256:" + String(repeating: "a", count: 64)
        let source = ["AI_GATEWAY_API_KEY": "gateway-fixture", "ELEVENLABS_API_KEY": "voice-fixture",
                      "JARVIS_NATIVE_TOKEN": "source-must-not-override", "UNRELATED_SECRET": "private-fixture",
                      "NODE_EXTRA_CA_CERTS": "/fixture/ca.pem", "HTTPS_PROXY": "http://fixture-proxy:8080",
                      "JARVIS_WORKER_PYTHON": "/fixture/python", "JARVIS_WORKER_IMAGE": image]
        let runtime = RuntimePreferences.childEnvironment(role: "runtime", source: source, localToken: "local-fixture",
            nativeToken: "native-fixture", dataDirectory: "/fixture/data", helper: "/fixture/helper")
        XCTAssertNil(runtime["JARVIS_NATIVE_TOKEN"])
        XCTAssertNil(runtime["ELEVENLABS_API_KEY"])
        XCTAssertNil(runtime["UNRELATED_SECRET"])
        XCTAssertNil(runtime["JARVIS_WORKER_PYTHON"])
        XCTAssertNil(runtime["JARVIS_WORKER_IMAGE"])
        XCTAssertEqual(runtime["JARVIS_LOCAL_TOKEN"], "local-fixture")
        XCTAssertEqual(runtime["HOST"], "127.0.0.1")
        XCTAssertEqual(runtime["PORT"], "39201")
        XCTAssertEqual(runtime["NODE_EXTRA_CA_CERTS"], "/fixture/ca.pem")
        XCTAssertEqual(runtime["HTTPS_PROXY"], "http://fixture-proxy:8080")
        let bridge = RuntimePreferences.childEnvironment(role: "bridge", source: source, localToken: "local-fixture",
            nativeToken: "native-fixture", dataDirectory: "/fixture/data", helper: nil)
        XCTAssertEqual(bridge["JARVIS_NATIVE_TOKEN"], "native-fixture")
        XCTAssertEqual(bridge["ELEVENLABS_API_KEY"], "voice-fixture")
        XCTAssertEqual(bridge["JARVIS_WORKER_PYTHON"], "/fixture/python")
        XCTAssertEqual(bridge["JARVIS_WORKER_IMAGE"], image)
        XCTAssertNil(bridge["UNRELATED_SECRET"])
        XCTAssertNil(bridge["HOST"])
    }

    func testWorkerImagePreferenceUsesExactImmutableReferenceAndLauncherPrecedence() throws {
        let name = "JarvisImageTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = RuntimePreferences(defaults: defaults)
        let image = "sha256:" + String(repeating: "a", count: 64)
        let registry = "registry.example:5000/research/analysis@sha256:" + String(repeating: "b", count: 64)
        XCTAssertNil(preferences.environment(inherited: [:])["JARVIS_WORKER_IMAGE"])
        defaults.set(" \(image)\n", forKey: "Jarvis.workerImage")
        XCTAssertEqual(preferences.environment(inherited: [:])["JARVIS_WORKER_IMAGE"], image)
        XCTAssertEqual(preferences.environment(inherited: ["JARVIS_WORKER_IMAGE": registry])["JARVIS_WORKER_IMAGE"], registry)
        for invalid in ["", "python:latest", "python:3.12", "sha256:abc", "sha256:" + String(repeating: "A", count: 64),
                        image + "\nother", String(repeating: "x", count: 190) + "@" + image] {
            defaults.set(invalid, forKey: "Jarvis.workerImage")
            XCTAssertNil(RuntimePreferences.validatedWorkerImage(invalid), invalid)
            XCTAssertNil(preferences.environment(inherited: [:])["JARVIS_WORKER_IMAGE"], invalid)
        }
        XCTAssertEqual(RuntimePreferences.validatedWorkerImage(registry), registry)
    }

    func testExternalLauncherWithoutNativeAuthorityCannotInventIt() {
        XCTAssertEqual(RuntimeConnection.configuredCredential(named: "JARVIS_NATIVE_TOKEN",
            environment: ["JARVIS_LOCAL_TOKEN": "external-local-token"], generated: "unshared-generated-token"), "")
        XCTAssertEqual(RuntimeConnection.configuredCredential(named: "JARVIS_NATIVE_TOKEN",
            environment: ["JARVIS_LOCAL_TOKEN": "external-local-token", "JARVIS_NATIVE_TOKEN": "external-native-token"],
            generated: "ignored"), "external-native-token")
        XCTAssertEqual(RuntimeConnection.configuredCredential(named: "JARVIS_NATIVE_TOKEN",
            environment: [:], generated: "fresh-native-token"), "fresh-native-token")
    }

    @MainActor
    func testEmptySettingsDoNotReplaceBuildLocation() {
        XCTAssertNil(RuntimeSupervisor.nonempty(""))
        XCTAssertNil(RuntimeSupervisor.nonempty(" \n"))
        XCTAssertEqual(RuntimeSupervisor.nonempty(" /Applications/Node/bin/node "), "/Applications/Node/bin/node")
    }

    func testBriefingScheduleUsesLocalDayAndNeverBroadensInvalidProjectScope() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: -5 * 3600))
        let formatter = ISO8601DateFormatter()
        let before = try XCTUnwrap(formatter.date(from: "2026-11-08T13:59:00Z"))
        let after = try XCTUnwrap(formatter.date(from: "2026-11-08T14:00:00Z"))
        XCTAssertNil(DailyBriefingPolicy.dueKey(now: before, hour: 9, minute: 0, projectID: "room-1", calendar: calendar))
        XCTAssertEqual(DailyBriefingPolicy.dueKey(now: after, hour: 9, minute: 0, projectID: "room-1", calendar: calendar), "room-1:2026-11-8")
        XCTAssertNil(DailyBriefingPolicy.dueKey(now: after, hour: 9, minute: 0, projectID: "../other", calendar: calendar))
        XCTAssertNil(DailyBriefingPolicy.dueKey(now: after, hour: 24, minute: 0, projectID: "room-1", calendar: calendar))
    }
}
