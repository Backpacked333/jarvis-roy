import SwiftUI

/// A scrolling page with one readable column.
struct PageScroll<Content: View>: View {
    var maxWidth: CGFloat = 860
    @ViewBuilder var content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) { content() }
                .padding(.horizontal, 32).padding(.top, 12).padding(.bottom, 32)
                .frame(maxWidth: maxWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Capabilities

struct CapabilitiesPage: View {
    @ObservedObject var model: AppModel
    @Environment(\.theme) private var theme

    var body: some View {
        PageScroll {
            PageHeader(title: "Capabilities", subtitle: "Optional capabilities stay off until you set them up. Turn features on in Settings, or set the variables below in your terminal and relaunch with scripts/run-macos.sh.") {
                SettingsLink { Label("Open Settings", systemImage: "gearshape") }.buttonStyle(.jarvisPrimary)
            }
            if let error = model.capabilityError {
                NoticeBanner(message: "Capability status unavailable: \(error)", icon: "exclamationmark.triangle", tone: .warning)
            }
            if let state = model.capabilityState {
                if !state.notice.isEmpty {
                    NoticeBanner(message: state.notice, icon: "info.circle", tone: .info)
                }
                ForEach(state.capabilities) { capability in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(capability.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(theme.text)
                            Spacer(minLength: 8)
                            StatusPill(label: capability.stateLabel, color: stateColor(capability.state))
                        }
                        Text(capability.detail).font(.system(size: 13)).foregroundStyle(theme.muted).lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                        if !capability.setup.isEmpty {
                            Text(capability.setup).font(.system(size: 12, design: .monospaced)).foregroundStyle(theme.text)
                                .textSelection(.enabled)
                                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                .background(theme.trough, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                    }
                    .jarvisCard()
                }
            } else if model.capabilityError == nil {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Reading the runtime configuration…").font(.system(size: 13)).foregroundStyle(theme.muted)
                }
            }
            VStack(alignment: .leading, spacing: 10) {
                Link(destination: URL(string: "x-apple.systempreferences:com.apple.preference.security")!) {
                    Label("Open macOS Privacy & Security", systemImage: "arrow.up.forward.app")
                }
                .buttonStyle(.jarvisSecondary)
                Text("Permission declarations do not grant access. macOS may attribute helper/Automation requests to the launching terminal; grant only the identity you recognize. See README for provider setup and limitations.")
                    .font(.system(size: 12)).foregroundStyle(theme.muted).lineSpacing(2)
            }
        }
    }

    private func stateColor(_ state: String) -> Color {
        switch state {
        case "available", "ready", "connected": return theme.success
        case "off", "unsupported", "requires_macos": return theme.muted
        default: return theme.warning
        }
    }
}

// MARK: - Privacy

struct PrivacyPage: View {
    @Environment(\.theme) private var theme

    var body: some View {
        PageScroll {
            PageHeader(title: "An assistant, not an open door", subtitle: "What Jarvis can reach, what leaves this Mac, and how to stop it.")
            VStack(spacing: 0) {
                row("Microphone", icon: "mic", text: "Off by default. Opt in to Hey Jarvis for rolling on-device English-US recognition, not a low-power wake model. Automatic command submission needs an idle selected thread and empty draft; otherwise text stays for review. Thread changes mute capture. Background speech is not submitted. Hardware/language support and capture gaps apply.")
                divider
                row("Cloud reasoning", icon: "cloud", text: "Submitted text, recalled memories, and tool results go to the configured model through Vercel AI Gateway. This is not an offline assistant. Your API key stays in the local runtime, not task history.")
                divider
                row("Desktop & account access", icon: "hand.raised", text: "Optional screen/app control, terminal, Mail, Calendar, iMessage sends and supported Home Assistant actions require setup and runtime approval. Approved screen/account content can enter cloud model context. Terminal runs with your user privileges, NOT in a security sandbox. Exact tool arguments must be visible; redacted, missing or oversized actions are deny-only.")
                divider
                row("Stopping work", icon: "stop.circle", text: "Stop all ends speech and asks the agent runtime to cancel active work. Check task status for confirmation. An action already completed—such as opening a page—cannot be undone.")
                divider
                row("Stored on this Mac", icon: "internaldrive", text: "Task history, approved notes, and saved memories remain in the local Jarvis data directory and runtime workflow store. Deleting a memory does not remove past mentions from task history. See the README for full deletion instructions.")
                divider
                row("Preview boundaries", icon: "info.circle", text: "Follow-ups continue the selected conversation. Separate threads have separate model history, but explicitly saved memories are global. Live research requires your Tavily configuration. The analyst drafts from supplied evidence, with no private tools. iMessage is send-only. This is an ad-hoc signed source-build preview, not a signed installer or notarized distribution.")
            }
            .jarvisSurface(.panel, radius: 16)
        }
    }

    private var divider: some View { Rectangle().fill(theme.line).frame(height: 1).padding(.leading, 62) }

    private func row(_ title: String, icon: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon).font(.system(size: 15, weight: .medium)).foregroundStyle(theme.accentText)
                .frame(width: 30, height: 30).background(theme.accentSoft, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(theme.text)
                Text(text).font(.system(size: 13)).foregroundStyle(theme.muted).lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(18)
    }
}

// MARK: - Saved memories (when reviewed memory is off)

struct SavedMemoryPage: View {
    @ObservedObject var model: AppModel
    @Environment(\.theme) private var theme
    @State private var memoryToDelete: MemoryEntry?

    var body: some View {
        PageScroll {
            PageHeader(title: "Memory", subtitle: "Only preferences you explicitly ask Jarvis to remember are saved here, after approval. They live on this Mac and may be sent to the cloud model when recalled.")
            if model.memories.isEmpty {
                EmptyStateView(icon: "brain.head.profile", title: "No saved memories yet",
                               detail: "Ask Jarvis to remember a preference in Chat. You approve each one before it is saved.") {
                    Button("Go to Chat") { model.tab = .workspace }.buttonStyle(.jarvisSecondary)
                }
                .jarvisSurface(.panel, radius: 16)
            }
            ForEach(model.memories) { entry in
                HStack(alignment: .top, spacing: 14) {
                    Text(entry.text).font(.system(size: 14)).foregroundStyle(theme.text).lineSpacing(3)
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    Button { memoryToDelete = entry } label: { Image(systemName: "trash") }
                        .buttonStyle(JarvisIconButtonStyle(tint: theme.danger))
                        .help("Delete this memory").accessibilityLabel("Delete memory")
                        .disabled(model.pendingActions.contains(entry.id))
                }
                .jarvisCard()
            }
        }
        .alert("Delete this memory?", isPresented: Binding(
            get: { memoryToDelete != nil },
            set: { if !$0 { memoryToDelete = nil } }
        ), presenting: memoryToDelete) { entry in
            Button("Cancel", role: .cancel) { memoryToDelete = nil }
            Button("Delete", role: .destructive) {
                Task { await model.act(key: entry.id, path: "v1/memories/\(entry.id)", method: "DELETE") }
                memoryToDelete = nil
            }
        } message: { _ in
            Text("This removes the saved preference. It does not erase mentions in previous task history.")
        }
    }
}
