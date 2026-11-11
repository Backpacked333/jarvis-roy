import SwiftUI
import AppKit

/// Window-level interface state shared by the shell, the menu commands and the command palette.
@MainActor
final class WorkspaceChrome: ObservableObject {
    @Published var sidebarVisible = true
    @Published var inspectorVisible = true
    @Published var paletteVisible = false
}

extension WorkspaceTab {
    /// The name shown in the interface. The conversation page is called Chat.
    var title: String { self == .workspace ? "Chat" : rawValue }

    var summary: String {
        switch self {
        case .today: return "Goals, decisions and what needs you"
        case .assistant: return "Conversation with evidence alongside"
        case .rooms: return "Scoped workspaces with isolated workers"
        case .workspace: return "Talk, hand off tasks, approve actions"
        case .capabilities: return "What Jarvis can do on this Mac"
        case .memory: return "What Jarvis remembers for you"
        case .privacy: return "What leaves this Mac, and when"
        }
    }

    /// The ⌘-number that jumps to this page.
    var shortcutNumber: Int { (WorkspaceTab.allCases.firstIndex(of: self) ?? 0) + 1 }
}

/// The main window: a floating glass sidebar, a top bar and the selected page over a shared backdrop.
struct WorkspaceView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var voice: VoiceController
    @ObservedObject var chrome: WorkspaceChrome
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var cloudDisclosure = false
    @State private var handsFreeDisclosure = false
    @State private var dismissedNotices: Set<String> = []
    @AppStorage("Jarvis.assistantEnabled") private var assistantPreference = false
    @AppStorage("Jarvis.memoryEnabled") private var memoryPreference = false

    private var assistantAvailable: Bool { _ = assistantPreference; return AssistantFeatures.assistant }
    private var memoryAvailable: Bool { _ = memoryPreference; return AssistantFeatures.memory }

    var body: some View {
        ZStack {
            JarvisBackdrop()
            HStack(spacing: 0) {
                if chrome.sidebarVisible {
                    SidebarView(model: model, rooms: model.rooms, assistantAvailable: assistantAvailable)
                        .frame(width: 256)
                        .padding(.leading, 8).padding(.vertical, 8)
                        .transition(.move(edge: .leading).combined(with: .opacity))
                }
                VStack(spacing: 0) {
                    topBar
                    notices
                    VoiceCaptureBar(model: model, voice: voice)
                    page.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            if chrome.paletteVisible {
                CommandPalette(model: model, chrome: chrome, assistantAvailable: assistantAvailable)
                    .transition(.opacity)
            }
        }
        // Lay out from the very top of the window; the sidebar and top bar leave room for the traffic lights.
        .ignoresSafeArea(.container, edges: .top)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.22), value: chrome.sidebarVisible)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: chrome.paletteVisible)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.35), value: theme.mode)
        .confirmationDialog("Allow ElevenLabs voice for this session?", isPresented: $cloudDisclosure, titleVisibility: .visible) {
            Button("Allow cloud voice") { voice.setCloudConsent(true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Active command microphone audio is uploaded to ElevenLabs Scribe, and spoken reply text goes to Eleven v4 Turbo. Provider charges apply. Never speak passwords or API keys. This permission resets when Jarvis quits; there is no fallback voice. Hands-free capture requires its own opt-in.")
        }
        .confirmationDialog("Enable hands-free conversation?", isPresented: $handsFreeDisclosure, titleVisibility: .visible) {
            Button("Enable hands-free") { Task { await voice.setHandsFreeEnabled(true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("During replies, your microphone runs locally with echo cancellation and speech detection. Detected interruption starts a fresh ElevenLabs capture. After a reply or exact clarification finishes playing, a bounded cloud answer window opens automatically; silence closes it after eight seconds. Completed speech is submitted only to the captured conversation or question. Spoken yes never approves sensitive actions. Mute stops capture and disables hands-free. Wake listening is separate. Unsupported hardware fails closed.")
        }
    }

    // MARK: Top bar

    private var topBar: some View {
        HStack(spacing: 10) {
            Button { chrome.sidebarVisible.toggle() } label: { Image(systemName: "sidebar.leading") }
                .buttonStyle(.jarvisIcon)
                .help(chrome.sidebarVisible ? "Hide sidebar (⌃⌘S)" : "Show sidebar (⌃⌘S)")
                .accessibilityLabel(chrome.sidebarVisible ? "Hide sidebar" : "Show sidebar")
            VStack(alignment: .leading, spacing: 1) {
                Text(pageTitle).font(.system(size: 15, weight: .semibold)).foregroundStyle(theme.text).lineLimit(1)
                Text(model.tab.summary).font(.system(size: 11)).foregroundStyle(theme.muted).lineLimit(1)
            }
            Spacer(minLength: 12)
            if model.tab == .rooms, AssistantFeatures.assistant, model.rooms.selectedRoom != nil {
                Button { Task { await model.discussSelectedRoom() } } label: {
                    Label("Discuss this room", systemImage: "bubble.left.and.text.bubble.right")
                }.buttonStyle(.jarvisCompact)
            }
            Button { chrome.paletteVisible = true } label: {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                    Text("Jump to…")
                    KeyHint(keys: "⌘K")
                }
            }
            .buttonStyle(.jarvisCompact)
            .help("Search pages, conversations and actions (⌘K)")
            VoiceControl(model: model, voice: voice, cloudDisclosure: $cloudDisclosure, handsFreeDisclosure: $handsFreeDisclosure)
            if model.tab == .workspace {
                Button { chrome.inspectorVisible.toggle() } label: { Image(systemName: "sidebar.trailing") }
                    .buttonStyle(JarvisIconButtonStyle(active: chrome.inspectorVisible))
                    .help(chrome.inspectorVisible ? "Hide activity (⌥⌘I)" : "Show activity (⌥⌘I)")
                    .accessibilityLabel(chrome.inspectorVisible ? "Hide activity" : "Show activity")
            }
            Button { Task { await model.stopAll() } } label: { Label("Stop all", systemImage: "stop.fill") }
                .buttonStyle(JarvisButtonStyle(kind: .danger, compact: true))
                .disabled(model.pendingActions.contains("stop-all"))
                .help("Stop voice and request cancellation of all work (⌘.). Completed actions cannot be undone.")
        }
        // Clear the window's traffic lights when the sidebar is hidden.
        .padding(.leading, chrome.sidebarVisible ? 10 : 84)
        .padding(.trailing, 14)
        .frame(height: 54)
    }

    private var pageTitle: String {
        switch model.tab {
        case .workspace: return model.selectedConversation?.title ?? "Chat"
        case .rooms: return model.rooms.selectedRoom?.title ?? "Rooms"
        default: return model.tab.title
        }
    }

    // MARK: Notices

    private struct Notice: Identifiable {
        let id: String
        let message: String
        let icon: String
        let tone: NoticeBanner.Tone
        var working = false
        var dismiss: (() -> Void)? = nil
    }

    private var activeNotices: [Notice] {
        var items: [Notice] = []
        if !model.isConnected {
            items.append(Notice(id: "connection", message: model.connectionError ?? "Connecting to the local agent service…",
                                icon: "network", tone: .warning, working: model.connectionError == nil))
        }
        if let error = model.error {
            items.append(Notice(id: "error:" + error, message: error, icon: "exclamationmark.triangle", tone: .danger,
                                dismiss: { model.error = nil }))
        }
        if let error = voice.error, !dismissedNotices.contains("voice:" + error) {
            items.append(Notice(id: "voice:" + error, message: error, icon: "mic.badge.xmark", tone: .warning,
                                dismiss: { dismissedNotices.insert("voice:" + error) }))
        }
        if let notice = model.voiceNotice, !dismissedNotices.contains("notice:" + notice) {
            items.append(Notice(id: "notice:" + notice, message: notice, icon: "waveform", tone: .info,
                                dismiss: { dismissedNotices.insert("notice:" + notice) }))
        }
        return items
    }

    @ViewBuilder private var notices: some View {
        let items = activeNotices
        if !items.isEmpty {
            VStack(spacing: 6) {
                ForEach(items) { item in
                    NoticeBanner(message: item.message, icon: item.icon, tone: item.tone, working: item.working, onDismiss: item.dismiss)
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 8)
        }
    }

    // MARK: Pages

    @ViewBuilder private var page: some View {
        switch model.tab {
        case .today: TodayWorkspaceView(app: model, assistant: model.assistant)
        case .assistant: AssistantWorkspaceView(model: model, assistant: model.assistant, voice: voice)
        case .rooms:
            RoomsWorkspaceView(model: model.rooms, onVoiceContext: { _ in },
                onSpeakQuestion: { model.speakQuestion($0) },
                onReviewApproval: { approval in Task { await model.reviewApproval(approval) } },
                observationOwnership: .application)
        case .workspace: ChatView(model: model, voice: voice, chrome: chrome)
        case .capabilities: CapabilitiesPage(model: model)
        case .memory:
            if memoryAvailable {
                MemoryWorkspaceView(projectID: model.assistant.selectedSession?.focus.projectID, client: model.assistant.client)
                    .id(model.assistant.selectedSession?.focus.projectID ?? "personal")
            } else { SavedMemoryPage(model: model) }
        case .privacy: PrivacyPage()
        }
    }
}
