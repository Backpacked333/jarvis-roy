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
        JarvisTheme.applyStoredAppearance()
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
    @StateObject private var chrome = WorkspaceChrome()
    @AppStorage(JarvisTheme.legendsKey) private var legendsMode = false

    var body: some Scene {
        WindowGroup("Jarvis", id: "main") {
            JarvisSceneHost(model: model, chrome: chrome, delegate: delegate)
        }
        .defaultSize(width: 1280, height: 840)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .newItem) {
                Button("New conversation") { Task { await model.startNewConversation() } }
                    .keyboardShortcut("n", modifiers: .command)
                Button("Stop all work") { Task { await model.stopAll() } }
                    .keyboardShortcut(".", modifiers: .command)
            }
            CommandGroup(after: .sidebar) {
                Button(chrome.sidebarVisible ? "Hide Sidebar" : "Show Sidebar") { chrome.sidebarVisible.toggle() }
                    .keyboardShortcut("s", modifiers: [.control, .command])
                Button(chrome.inspectorVisible ? "Hide Activity" : "Show Activity") { chrome.inspectorVisible.toggle() }
                    .keyboardShortcut("i", modifiers: [.option, .command])
                Toggle("Legends Mode", isOn: $legendsMode)
                    .keyboardShortcut("l", modifiers: [.shift, .command])
                Divider()
            }
            CommandMenu("Go") {
                Button("Jump to…") { chrome.paletteVisible.toggle() }
                    .keyboardShortcut("k", modifiers: .command)
                Divider()
                ForEach(WorkspaceTab.allCases) { tab in
                    Button(tab.title) { model.tab = tab }
                        .keyboardShortcut(KeyEquivalent(Character(String(tab.shortcutNumber))), modifiers: .command)
                        .disabled(tab == .assistant && !AssistantFeatures.assistant)
                }
            }
        }
        MenuBarExtra("Jarvis", systemImage: "waveform.circle") {
            JarvisMenu(model: model, summon: { delegate.summon?() })
        }
        Settings { JarvisSettingsView(assistant: model.assistant).jarvisThemed() }
    }
}

private struct JarvisSceneHost: View {
    @ObservedObject var model: AppModel
    @ObservedObject var chrome: WorkspaceChrome
    let delegate: AppDelegate
    @ObservedObject private var supervisor = RuntimeSupervisor.shared
    @Environment(\.openWindow) private var openWindow
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("Jarvis.onboardingCompleted") private var onboardingCompleted = false
    @State private var setupVisible = false

    var body: some View {
        WorkspaceView(model: model, voice: model.voice, chrome: chrome)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if supervisor.state != .ready { SupervisorStatusBar(supervisor: supervisor) }
            }
            .frame(minWidth: 980, minHeight: 680)
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
        .onChange(of: scenePhase) { _, phase in model.setApplicationActive(phase == .active) }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.willSleepNotification)) { _ in model.muteVoice() }
        .jarvisWorkspaceRoot()
    }
}

/// Shown along the bottom of the window while the local services are starting or have failed.
private struct SupervisorStatusBar: View {
    @ObservedObject var supervisor: RuntimeSupervisor
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 10) {
            if supervisor.state == .starting { ProgressView().controlSize(.small) }
            else { Image(systemName: supervisor.state == .failed ? "exclamationmark.triangle.fill" : "bolt.horizontal.circle").foregroundStyle(supervisor.state == .failed ? theme.danger : theme.warning) }
            Text(supervisor.detail).font(.system(size: 12)).foregroundStyle(theme.text).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            SettingsLink { Label("Settings", systemImage: "gearshape") }.buttonStyle(.jarvisCompact)
            if supervisor.state == .failed {
                Button("Retry") { Task { await supervisor.start() } }.buttonStyle(.jarvisCompactPrimary)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(theme.panel)
        .overlay(alignment: .top) { Rectangle().fill(theme.line).frame(height: 1) }
    }
}

private struct JarvisMenu: View {
    @ObservedObject var model: AppModel
    let summon: () -> Void
    @ObservedObject private var supervisor = RuntimeSupervisor.shared
    @Environment(\.openWindow) private var openWindow
    @AppStorage(JarvisTheme.legendsKey) private var legendsMode = false

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
        Toggle("Legends Mode", isOn: $legendsMode)
        SettingsLink { Text("Settings…") }
        Button("Quit Jarvis") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}
