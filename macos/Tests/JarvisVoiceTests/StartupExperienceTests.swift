import AVFoundation
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
        // Registered defaults are process-wide, so this checks the values themselves rather than registering them here.
        XCTAssertEqual(RuntimePreferences.firstRunDefaults,
                       ["Jarvis.assistantEnabled": true, "Jarvis.knowledgeEnabled": true, "Jarvis.memoryEnabled": true])
        let preferences = Set(RuntimePreferences.flags.values)
        for key in RuntimePreferences.firstRunDefaults.keys { XCTAssertTrue(preferences.contains(key), key) }
        // Anything that acts on the Mac, reaches an account, leaves the Mac or spends unattended needs a deliberate choice.
        for flag in ["JARVIS_ENABLE_DESKTOP", "JARVIS_ENABLE_TERMINAL", "JARVIS_ENABLE_APPLE_SERVICES", "JARVIS_ENABLE_CLOUD",
                     "JARVIS_ENABLE_RESEARCH", "JARVIS_ENABLE_OBJECTIVES", "JARVIS_ENABLE_VOICE_APPROVAL",
                     "JARVIS_ENABLE_TELEGRAM", "JARVIS_ENABLE_GOOGLE", "JARVIS_ENABLE_PHONE"] {
            let preference = try XCTUnwrap(RuntimePreferences.flags[flag], flag)
            XCTAssertNil(RuntimePreferences.firstRunDefaults[preference], flag)
        }
        // A person's own choice always wins over a starting value.
        let name = "JarvisFirstRunTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set(false, forKey: "Jarvis.memoryEnabled")
        XCTAssertEqual(RuntimePreferences(defaults: defaults).environment(inherited: [:])["JARVIS_ENABLE_MEMORY"], "0")
        XCTAssertEqual(RuntimePreferences(defaults: defaults).environment(inherited: ["JARVIS_ENABLE_ASSISTANT": "0"])["JARVIS_ENABLE_ASSISTANT"], "0")
    }

    @MainActor
    func testPackagedAppPrefersItsOwnRuntimeAndSettingsCanStillOverride() throws {
        let resources = FileManager.default.temporaryDirectory.appendingPathComponent("jarvis-resources-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: resources) }
        XCTAssertNil(RuntimeSupervisor.bundledLocation(resources: nil))
        XCTAssertNil(RuntimeSupervisor.bundledLocation(resources: resources))
        let server = resources.appendingPathComponent("runtime/.output/server"), bin = resources.appendingPathComponent("node/bin")
        try FileManager.default.createDirectory(at: server, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try Data().write(to: server.appendingPathComponent("index.mjs"))
        // A runtime without its Node is not a usable bundle.
        XCTAssertNil(RuntimeSupervisor.bundledLocation(resources: resources))
        let node = bin.appendingPathComponent("node")
        try Data("#!/bin/sh\n".utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        let bundled = try XCTUnwrap(RuntimeSupervisor.bundledLocation(resources: resources))
        XCTAssertEqual(bundled.runtimeDirectory, resources.appendingPathComponent("runtime").path)
        XCTAssertEqual(bundled.nodeExecutable, node.path)

        let manifest = RuntimeLocation(runtimeDirectory: "/checkout/runtime", nodeExecutable: "/usr/local/bin/node")
        let packaged = RuntimeSupervisor.chooseLocation(overrideDirectory: " ", overrideNode: nil, bundled: bundled, manifest: manifest)
        XCTAssertTrue(packaged.bundled)
        XCTAssertEqual(packaged.location.runtimeDirectory, bundled.runtimeDirectory)
        XCTAssertEqual(packaged.location.nodeExecutable, bundled.nodeExecutable)
        let source = RuntimeSupervisor.chooseLocation(overrideDirectory: nil, overrideNode: nil, bundled: nil, manifest: manifest)
        XCTAssertFalse(source.bundled)
        XCTAssertEqual(source.location.runtimeDirectory, "/checkout/runtime")
        let overridden = RuntimeSupervisor.chooseLocation(overrideDirectory: "/dev/runtime", overrideNode: "/dev/node", bundled: bundled, manifest: manifest)
        XCTAssertFalse(overridden.bundled)
        XCTAssertEqual(overridden.location.runtimeDirectory, "/dev/runtime")
        XCTAssertEqual(overridden.location.nodeExecutable, "/dev/node")
        let nothing = RuntimeSupervisor.chooseLocation(overrideDirectory: nil, overrideNode: nil, bundled: nil, manifest: nil)
        XCTAssertEqual(nothing.location.runtimeDirectory, "")
    }

    @MainActor
    func testSetupChecklistReflectsWhatIsActuallyInTheWay() {
        XCTAssertEqual(GuidedSetupView.servicesCheck(.ready), .done)
        for state in [RuntimeSupervisor.State.idle, .starting, .stopping] { XCTAssertEqual(GuidedSetupView.servicesCheck(state), .working) }
        for state in [RuntimeSupervisor.State.failed, .stopped] { XCTAssertEqual(GuidedSetupView.servicesCheck(state), .failed) }

        XCTAssertEqual(GuidedSetupView.keyCheck(externallyManaged: false, supervisorHasKey: true, bridgeHasKey: nil), .done)
        XCTAssertEqual(GuidedSetupView.keyCheck(externallyManaged: false, supervisorHasKey: false, bridgeHasKey: true), .needed)
        // With the developer launcher only the bridge can say; before it has, nothing is claimed either way.
        XCTAssertEqual(GuidedSetupView.keyCheck(externallyManaged: true, supervisorHasKey: false, bridgeHasKey: nil), .optional)
        XCTAssertEqual(GuidedSetupView.keyCheck(externallyManaged: true, supervisorHasKey: false, bridgeHasKey: true), .done)
        XCTAssertEqual(GuidedSetupView.keyCheck(externallyManaged: true, supervisorHasKey: true, bridgeHasKey: false), .needed)

        // Voice stays optional until both its key and a voice are chosen; then the microphone decides.
        XCTAssertEqual(GuidedSetupView.voiceCheck(keySaved: false, voiceID: "voice", microphone: .authorized), .optional)
        XCTAssertEqual(GuidedSetupView.voiceCheck(keySaved: true, voiceID: "  ", microphone: .authorized), .optional)
        XCTAssertEqual(GuidedSetupView.voiceCheck(keySaved: true, voiceID: "voice", microphone: .authorized), .done)
        XCTAssertEqual(GuidedSetupView.voiceCheck(keySaved: true, voiceID: "voice", microphone: .notDetermined), .needed)
        XCTAssertEqual(GuidedSetupView.voiceCheck(keySaved: true, voiceID: "voice", microphone: .denied), .failed)
        XCTAssertEqual(GuidedSetupView.voiceCheck(keySaved: true, voiceID: "voice", microphone: .restricted), .failed)
    }

    func testTabsLeadWithTheConversationAndKeepTheOlderViewLast() {
        XCTAssertEqual(Set(WorkspaceTab.ordered), Set(WorkspaceTab.allCases))
        XCTAssertEqual(WorkspaceTab.ordered.count, WorkspaceTab.allCases.count)
        XCTAssertEqual(WorkspaceTab.available(assistant: true).first, .assistant)
        XCTAssertEqual(WorkspaceTab.available(assistant: true).last, .workspace)
        XCTAssertFalse(WorkspaceTab.available(assistant: false).contains(.assistant))
        XCTAssertEqual(WorkspaceTab.available(assistant: false).first, .today)
        // ⌘1 to ⌘9 is all the menu can offer.
        XCTAssertLessThanOrEqual(WorkspaceTab.ordered.count, 9)
        XCTAssertEqual(WorkspaceTab.workspace.title, "Classic threads")
        XCTAssertEqual(WorkspaceTab.assistant.title, "Assistant")
    }

    func testBundledFontsAreAvailableOnceRegistered() {
        JarvisFonts.registerBundledFonts()
        // A missing font silently becomes the system font, so its absence has to be asserted.
        XCTAssertEqual(JarvisFonts.availablePostScriptNames(), JarvisFonts.postScriptNames)
    }

    func testCoreModeFollowsTheRealVoiceStateAndADecisionWins() {
        XCTAssertEqual(CoreView.Mode(.idle, wakeArmed: false, decisionOnScreen: false), .standby)
        XCTAssertEqual(CoreView.Mode(.idle, wakeArmed: true, decisionOnScreen: false), .armed)
        XCTAssertEqual(CoreView.Mode(.connecting, wakeArmed: false, decisionOnScreen: false), .connecting)
        XCTAssertEqual(CoreView.Mode(.listening, wakeArmed: true, decisionOnScreen: false), .listening)
        XCTAssertEqual(CoreView.Mode(.thinking, wakeArmed: false, decisionOnScreen: false), .thinking)
        XCTAssertEqual(CoreView.Mode(.speaking, wakeArmed: false, decisionOnScreen: false), .speaking)
        XCTAssertEqual(CoreView.Mode(.interrupted, wakeArmed: false, decisionOnScreen: false), .stopped)
        XCTAssertEqual(CoreView.Mode(.unavailable, wakeArmed: false, decisionOnScreen: false), .unavailable)
        XCTAssertEqual(CoreView.Mode(.listening, wakeArmed: false, decisionOnScreen: true), .authorization)
    }

    func testBridgeStateDecodesWithAndWithoutProviderStatus() throws {
        let older = Data(#"{"ready":true,"model":"m","tasks":[],"conversations":[],"memories":[]}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(RuntimeState.self, from: older).providerConfigured)
        let newer = Data(#"{"ready":true,"model":"m","providerConfigured":false,"tasks":[],"conversations":[],"memories":[]}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(RuntimeState.self, from: newer).providerConfigured, false)
    }
}
