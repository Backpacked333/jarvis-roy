import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    var summon: (() -> Void)?
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
                Task { @MainActor in self?.muteVoice?() }
            }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !quitting else { return .terminateLater }
        quitting = true
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

    var body: some Scene {
        WindowGroup("Jarvis", id: "main") {
            JarvisSceneHost(model: model, delegate: delegate)
        }
        .defaultSize(width: 1280, height: 840)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .newItem) {
                Button("New conversation") { Task { await model.newConversation() } }
                    .keyboardShortcut("n", modifiers: .command)
                Button("Stop all work") { Task { await model.stopAll() } }
                    .keyboardShortcut(".", modifiers: .command)
            }
        }
        MenuBarExtra("Jarvis", systemImage: "waveform.circle") {
            JarvisMenu(model: model)
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

    var body: some View {
        VStack(spacing: 0) {
            if supervisor.state != .ready {
                HStack {
                    if supervisor.state == .starting { ProgressView().controlSize(.small) }
                    Text(supervisor.detail).font(.callout).textSelection(.enabled)
                    Spacer()
                    SettingsLink { Label("Settings", systemImage: "gearshape") }
                    if supervisor.state == .failed {
                        Button("Retry") { Task { await supervisor.start() } }
                    }
                }.padding().background(.regularMaterial)
            }
            WorkspaceView(model: model, voice: model.voice)
        }
        .frame(minWidth: 1050, minHeight: 720)
        .preferredColorScheme(.dark)
        .task {
            await supervisor.start()
            if supervisor.state == .ready { model.startObserving() }
        }
        .onAppear {
            delegate.summon = { openWindow(id: "main") }
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
    }
}

private struct JarvisMenu: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var supervisor = RuntimeSupervisor.shared
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text("Jarvis · \(supervisor.state.rawValue.capitalized)")
        Button("Open Jarvis") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }.keyboardShortcut(" ", modifiers: [.control, .option])
        Button("New conversation") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
            Task { await model.newConversation() }
        }
        Button("Mute voice") { model.muteVoice() }
        Button("Stop all work") { Task { await model.stopAll() } }
        Divider()
        SettingsLink { Text("Settings…") }
        Button("Quit Jarvis") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}
