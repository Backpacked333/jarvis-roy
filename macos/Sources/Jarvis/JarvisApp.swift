import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct JarvisApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        Window("Jarvis", id: "main") {
            WorkspaceView(model: model, voice: model.voice)
                .frame(minWidth: 1050, minHeight: 720)
                .preferredColorScheme(.dark)
                .task { model.startObserving() }
                .onAppear { model.setApplicationActive(NSApp.isActive) }
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
    }
}
