import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    var summon: (() -> Void)?
    private var quickSummon: QuickSummonController?
    func configureSummon(model: AppModel, openWorkspace: @escaping () -> Void) {
        if quickSummon == nil { quickSummon = QuickSummonController(model: model, openWorkspace: openWorkspace) }
        summon = { [weak self] in self?.quickSummon?.show() }
    }
    var stopObservation: (() -> Void)?
    var muteVoice: (() -> Void)?
    private let shortcut = SummonShortcut()
    private var sleepObserver: NSObjectProtocol?
    private var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        shortcut.action = { [weak self] in
            self?.summon?()
            NSApp.activate(ignoringOtherApps: true)
        }
        shortcut.register()
        sleepObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification,
            object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.muteVoice?(); PairedCloudConnection.shared.disconnect() }
            }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !quitting else { return .terminateLater }
        quitting = true
        PairedCloudConnection.shared.disconnect()
        stopObservation?()
        DailyBriefingCoordinator.shared.stop()
        shortcut.unregister()
        if let sleepObserver { NSWorkspace.shared.notificationCenter.removeObserver(sleepObserver) }
        Task {
            await RuntimeSupervisor.shared.shutdown()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

@main
struct JarvisApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = AppModel()

    init() {
        // Must run before any preference is read, including by the model created for the first window.
        RuntimePreferences.registerFirstRunDefaults()
        JarvisFonts.registerBundledFonts()
    }

    var body: some Scene {
        // One window. A group would open a second copy from the menu bar and run its start-up work again.
        Window("Jarvis", id: "main") {
            JarvisSceneHost(model: model, delegate: delegate)
        }
        .defaultSize(width: 1440, height: 900)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .newItem) {
                Button("New conversation") { Task { await model.startNewConversation() } }
                    .keyboardShortcut("n", modifiers: .command)
                Button("Stop all work") { Task { await model.stopAll() } }
                    .keyboardShortcut(".", modifiers: .command)
            }
            CommandMenu("Go") {
                ForEach(Array(WorkspaceTab.available(assistant: AssistantFeatures.assistant).enumerated()), id: \.element) { index, tab in
                    Button(tab.title) { model.tab = tab }
                        .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                }
            }
        }
        MenuBarExtra("Jarvis", systemImage: "waveform.circle") {
            JarvisMenu(model: model, summon: { delegate.summon?() })
        }
        Settings { JarvisSettingsView(assistant: model.assistant) }
    }
}

private struct JarvisSceneHost: View {
    @ObservedObject var model: AppModel
    let delegate: AppDelegate
    @ObservedObject private var supervisor = RuntimeSupervisor.shared
    @Environment(\.openWindow) private var openWindow
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("Jarvis.onboardingCompleted") private var onboardingCompleted = false
    @State private var setupVisible = false

    var body: some View {
        VStack(spacing: 0) {
            if let notice = ReadinessNotice.current(state: supervisor.state, detail: supervisor.detail, failureLog: supervisor.failureLog,
                // The app knows what it gave the services; with the developer launcher only the bridge can say.
                providerConfigured: supervisor.externallyManaged ? model.providerConfigured : supervisor.providerConfigured) {
                ReadinessBanner(notice: notice, addKey: { setupVisible = true },
                                retry: { Task { await supervisor.start() } },
                                diagnostics: { supervisor.diagnosticsReport() })
            }
            HUDShell(model: model, voice: model.voice)
        }
        // The handoff's minimum: below this the deck's columns no longer fit beside the core.
        .frame(minWidth: 1280, minHeight: 800)
        .preferredColorScheme(.dark)
        .task {
            await supervisor.start()
            if supervisor.state == .ready { model.startObserving() }
        }
        .sheet(isPresented: $setupVisible) { GuidedSetupView(app: model) }
        .onAppear {
            setupVisible = !onboardingCompleted
            delegate.configureSummon(model: model) { openWindow(id: "main") }
            delegate.stopObservation = { model.shutdown() }
            delegate.muteVoice = { model.muteVoice() }
            DailyBriefingCoordinator.shared.start { projectID in
                await model.prepareDailyBriefing(projectID: projectID)
            }
            model.setApplicationActive(NSApp.isActive)
        }
        .onChange(of: supervisor.state) { _, state in
            if state == .ready { model.startObserving() }
        }
        .onChange(of: model.setupRequested) { _, requested in
            if requested { setupVisible = true; model.setupRequested = false }
        }
        .onChange(of: scenePhase) { _, phase in model.setApplicationActive(phase == .active) }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.willSleepNotification)) { _ in model.muteVoice() }
    }
}

private struct JarvisMenu: View {
    @ObservedObject var model: AppModel
    let summon: () -> Void
    @ObservedObject private var supervisor = RuntimeSupervisor.shared
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text("Jarvis · \(supervisor.state.rawValue.capitalized)")
        Button("Quick conversation", action: summon).keyboardShortcut(" ", modifiers: [.control, .option])
        Button("Open Jarvis") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        Button("New conversation") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
            Task { await model.startNewConversation() }
        }
        Button("Mute voice") { model.muteVoice() }
        Button("Stop all work") { Task { await model.stopAll() } }
        Divider()
        SettingsLink { Text("Settings…") }
        Button("Quit Jarvis") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}
