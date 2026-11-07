import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var terminating = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// In app mode, keep the app alive until the bundled services stopped (bounded at 75 s, above the supervisor's 65 s worst-case ordered stop).
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let supervisor = ServiceSupervisor.current else { return .terminateNow }
        supervisor.beginTermination()
        guard !terminating else { return .terminateLater }
        guard supervisor.isRunning else { return .terminateNow }
        terminating = true
        Task { @MainActor in
            await supervisor.stop()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

/// Shows the workspace only while its local services are available; otherwise setup/status.
struct JarvisRootView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var supervisor: ServiceSupervisor

    var body: some View {
        Group {
            if supervisor.phase.showsWorkspace {
                WorkspaceView(model: model, voice: model.voice)
                    .task { model.startObserving() }
            } else {
                SetupView(supervisor: supervisor)
            }
        }
        // Leaving the workspace (services stopping, failed or restarting) must not leave the
        // microphone or spoken attention running behind the setup screen.
        .onChange(of: supervisor.phase.showsWorkspace) { _, shows in
            if !shows { model.muteVoice() }
        }
    }
}

@main
struct JarvisApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = AppModel()
    @StateObject private var supervisor = ServiceSupervisor()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        Window("Jarvis", id: "main") {
            JarvisRootView(model: model, supervisor: supervisor)
                .frame(minWidth: 1050, minHeight: 720)
                .preferredColorScheme(.dark)
                .onAppear {
                    ServiceSupervisor.current = supervisor
                    model.setApplicationActive(NSApp.isActive)
                    supervisor.start()
                }
                .onChange(of: scenePhase) { _, phase in model.setApplicationActive(phase == .active) }
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in model.shutdown() }
                .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.willSleepNotification)) { _ in model.muteVoice() }
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

        // Provides Jarvis → Settings… (⌘,). Editable in app mode; a read-only note in launcher mode.
        Settings {
            StandaloneSettingsView(supervisor: supervisor)
        }
    }
}
