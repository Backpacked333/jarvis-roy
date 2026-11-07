import AppKit
import SwiftUI

private enum SetupPalette {
    static let background = Color(red: 0.035, green: 0.047, blue: 0.063)
    static let panel = Color(red: 0.061, green: 0.075, blue: 0.094)
    static let line = Color.white.opacity(0.075)
    static let cyan = Color(red: 0.40, green: 0.88, blue: 0.91)
    static let muted = Color(red: 0.52, green: 0.59, blue: 0.65)
    static let amber = Color(red: 0.97, green: 0.73, blue: 0.39)
}

private func displayPath(_ url: URL) -> String {
    let home = NSHomeDirectory()
    let path = url.path
    if !home.isEmpty, path == home || path.hasPrefix(home + "/") { return "~" + String(path.dropFirst(home.count)) }
    return path
}

/// First-run, starting, stopping and failure screens shown instead of the workspace in app mode.
struct SetupView: View {
    @ObservedObject var supervisor: ServiceSupervisor

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                content
            }
            .padding(40)
            .frame(maxWidth: 780, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(SetupPalette.background)
    }

    @ViewBuilder private var content: some View {
        switch supervisor.phase {
        case .needsSetup:
            header("Set up Jarvis", "Jarvis runs its agent services on this Mac and uses Vercel AI Gateway for cloud reasoning. Add your AI Gateway key to begin; everything else is optional and can be changed later in Jarvis → Settings.")
            privacyNote
            StandaloneSettingsForm(supervisor: supervisor, purpose: .firstRun)
        case .starting:
            progress("Starting local services…", "Jarvis is starting its local agent runtime and bridge on 127.0.0.1. This usually takes a few seconds.")
        case .stopping:
            progress("Stopping local services…", "Jarvis is asking room workers and the agent runtime to shut down cleanly. This can take up to a minute.")
        case .failed(let reason):
            failure(reason)
        case .stopped:
            stopped
        case .ready, .externallyManaged:
            progress("Connecting…", "Local services are ready.")
        }
    }

    private func header(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.system(size: 32, weight: .light))
            Text(detail).font(.system(size: 14)).foregroundStyle(SetupPalette.muted).lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var privacyNote: some View {
        Label("Keys are saved in the macOS Keychain on this Mac only, are never shown again, and are passed only to Jarvis's own local services when they start.",
              systemImage: "lock.shield")
            .font(.system(size: 12)).foregroundStyle(SetupPalette.cyan)
            .padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(SetupPalette.cyan.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }

    private func progress(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 14) {
                ProgressView().controlSize(.small)
                Text(title).font(.system(size: 24, weight: .light))
            }
            Text(detail).font(.system(size: 13)).foregroundStyle(SetupPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 80)
    }

    private func failure(_ reason: String) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("Local services are not running", systemImage: "exclamationmark.triangle")
                .font(.system(size: 26, weight: .light)).foregroundStyle(SetupPalette.amber)
            Text(reason).font(.system(size: 14)).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            logsPanel
            HStack(spacing: 12) {
                Button("Retry") { Task { await supervisor.restart() } }
                    .keyboardShortcut(.defaultAction)
                SettingsLink { Text("Settings…") }
            }
        }
        .padding(.top, 40)
    }

    private var stopped: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Local services are stopped").font(.system(size: 26, weight: .light))
            Text("Start them to use Jarvis. Settings changes take effect on the next start.")
                .font(.system(size: 13)).foregroundStyle(SetupPalette.muted)
            HStack(spacing: 12) {
                Button("Start") { supervisor.start() }.keyboardShortcut(.defaultAction)
                SettingsLink { Text("Settings…") }
            }
        }
        .padding(.top, 40)
    }

    private var logsPanel: some View {
        let logs = supervisor.logsDirectory
        return VStack(alignment: .leading, spacing: 10) {
            Text("Logs (runtime.log and bridge.log)").font(.system(size: 12, weight: .medium))
            Text(displayPath(logs)).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                .foregroundStyle(SetupPalette.muted)
            Button("Reveal in Finder") { reveal(logs) }
                .disabled(!FileManager.default.fileExists(atPath: logs.path))
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(SetupPalette.panel, in: RoundedRectangle(cornerRadius: 10))
    }

    private func reveal(_ url: URL) {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}

/// The Settings scene (⌘,). App mode edits the native settings; launcher mode is read-only.
struct StandaloneSettingsView: View {
    @ObservedObject var supervisor: ServiceSupervisor

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("Jarvis settings").font(.system(size: 26, weight: .light))
                if supervisor.isExternallySupervised {
                    Text("This Jarvis was started by scripts/run-macos.sh, which owns the local services and their configuration. Set the documented variables in your terminal, then quit Jarvis and rerun the script. Nothing here changes that session.")
                        .font(.system(size: 13)).foregroundStyle(SetupPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("Keys are saved in the macOS Keychain on this Mac only and are never shown again. Changes take effect when services restart. Settings cannot be changed from chat or the local API.")
                        .font(.system(size: 13)).foregroundStyle(SetupPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    StandaloneSettingsForm(supervisor: supervisor, purpose: .settings)
                }
            }
            .padding(32)
            .frame(maxWidth: 720, alignment: .leading)
        }
        .frame(minWidth: 640, minHeight: 560)
        .background(SetupPalette.background)
        .preferredColorScheme(.dark)
    }
}

struct StandaloneSettingsForm: View {
    enum Purpose { case firstRun, settings }

    @ObservedObject var supervisor: ServiceSupervisor
    let purpose: Purpose
    @State private var config = StandaloneConfig()
    @State private var keyInputs: [CredentialKey: String] = [:]
    @State private var savedKeys: Set<CredentialKey> = []
    @State private var loadWarning: String?
    @State private var actionError: String?
    @State private var notice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let loadWarning { message(loadWarning, icon: "exclamationmark.triangle", color: SetupPalette.amber) }
            section("Model") {
                keyField(.aiGateway, required: true)
                field("Model (provider/model)", text: $config.model, prompt: StandaloneConfig.defaultModel)
            }
            section("Live research — optional") {
                keyField(.tavily, required: false)
                caption("Public web research through Tavily. Without a key, research tools stay off.")
            }
            section("Home Assistant — optional") {
                field("Home Assistant URL", text: $config.homeAssistantURL, prompt: "https://homeassistant.example:8123")
                keyField(.homeAssistant, required: false)
                Toggle("Allow plain HTTP on the local network", isOn: $config.allowHomeAssistantHTTP).toggleStyle(.switch)
                caption("HTTPS is required unless this is on; plain HTTP is accepted only for a private or loopback IP address. Every read and control still needs your approval.")
            }
            section("Cloud voice — optional") {
                keyField(.elevenLabs, required: false)
                field("ElevenLabs voice ID", text: $config.elevenLabsVoiceID, prompt: "Voice ID")
                caption("Audio is sent to ElevenLabs only after you give cloud voice consent in a session.")
            }
            section("Capabilities — optional") {
                Toggle("Desktop: screen reading and app control", isOn: $config.enableDesktop).toggleStyle(.switch)
                Toggle("Terminal commands", isOn: $config.enableTerminal).toggleStyle(.switch)
                if config.enableTerminal {
                    message("Terminal commands run with your user privileges and are NOT in a security sandbox. Each command still needs your explicit approval.",
                            icon: "exclamationmark.octagon", color: SetupPalette.amber)
                }
                Toggle("Mail, Calendar and iMessage", isOn: $config.enableAppleServices).toggleStyle(.switch)
                caption("Enabling a capability here does not grant any macOS permission. macOS asks separately (System Settings → Privacy & Security), and every action still needs your approval in Jarvis.")
            }
            section("Room workers — optional") {
                field("Worker image (pinned digest)", text: $config.workerImage, prompt: "python@sha256:…")
                field("Worker Python", text: $config.workerPython, prompt: "Default: <data folder>/workers-venv/bin/python")
                field("Docker binary", text: $config.dockerBinary, prompt: "Default: first standard Docker install found")
                caption("Leave Python and Docker empty to use the defaults when present. Workers run offline in Docker without credentials.")
            }
            let errors = draftErrors
            if !errors.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(errors, id: \.self) { error in
                        Label(error, systemImage: "exclamationmark.circle").font(.system(size: 12)).foregroundStyle(SetupPalette.amber)
                    }
                }
            }
            if let actionError { message(actionError, icon: "xmark.octagon", color: SetupPalette.amber) }
            if let notice { message(notice, icon: "checkmark.circle", color: SetupPalette.cyan) }
            actions(disabled: !errors.isEmpty)
        }
        .onAppear(perform: load)
    }

    @ViewBuilder private func actions(disabled: Bool) -> some View {
        HStack(spacing: 12) {
            switch purpose {
            case .firstRun:
                Button("Save & Start") { save(thenStart: true) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(disabled)
            case .settings:
                Button("Save") { save(thenStart: false) }
                    .disabled(disabled)
                Button("Save & Restart services") { save(thenStart: true) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(disabled || supervisor.phase == .stopping)
            }
        }
    }

    private var draftErrors: [String] {
        var errors = config.normalized().validationErrors
        for key in CredentialKey.allCases {
            if let problem = CredentialValue.problem(keyInputs[key] ?? "") { errors.append("\(key.title): \(problem)") }
        }
        let typedGateway = (keyInputs[.aiGateway] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !savedKeys.contains(.aiGateway), typedGateway.isEmpty {
            errors.append("A Vercel AI Gateway API key is required.")
        }
        return errors
    }

    private func load() {
        savedKeys = supervisor.savedCredentialKeys()
        do {
            config = try supervisor.loadConfig()
            loadWarning = nil
        } catch {
            config = StandaloneConfig()
            loadWarning = "Saved settings could not be read. Saving will replace them with the values below."
        }
    }

    private func save(thenStart: Bool) {
        actionError = nil
        notice = nil
        do {
            try supervisor.saveSettings(config, keys: keyInputs)
            keyInputs = [:]
            config = config.normalized()
            savedKeys = supervisor.savedCredentialKeys()
            if thenStart {
                Task { await supervisor.restart() }
            } else {
                notice = "Saved. Changes take effect when services restart."
            }
        } catch {
            keyInputs = [:]
            savedKeys = supervisor.savedCredentialKeys()
            actionError = "Not saved: \(error.localizedDescription)"
        }
    }

    private func remove(_ key: CredentialKey) {
        actionError = nil
        notice = nil
        do {
            try supervisor.removeCredential(key)
            notice = "\(key.title) removed. Restart services to apply."
        } catch {
            actionError = "Could not remove the key: \(error.localizedDescription)"
        }
        savedKeys = supervisor.savedCredentialKeys()
    }

    private func binding(_ key: CredentialKey) -> Binding<String> {
        Binding(get: { keyInputs[key] ?? "" }, set: { keyInputs[key] = $0 })
    }

    private func keyField(_ key: CredentialKey, required: Bool) -> some View {
        let saved = savedKeys.contains(key)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text(key.title).font(.system(size: 13, weight: .medium))
                Spacer()
                if saved {
                    Label("Saved in Keychain", systemImage: "checkmark.seal").font(.system(size: 11)).foregroundStyle(SetupPalette.cyan)
                    Button("Remove") { remove(key) }.controlSize(.small)
                } else {
                    Text(required ? "Required" : "Not set").font(.system(size: 11))
                        .foregroundStyle(required ? SetupPalette.amber : SetupPalette.muted)
                }
            }
            SecureField(saved ? "Enter a new key to replace the saved one" : "Paste key", text: binding(key))
                .textFieldStyle(.roundedBorder)
        }
    }

    private func field(_ title: String, text: Binding<String>, prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 12)).foregroundStyle(SetupPalette.muted)
            TextField(prompt, text: text)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text).font(.system(size: 11)).foregroundStyle(SetupPalette.muted)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func message(_ text: String, icon: String, color: Color) -> some View {
        Label(text, systemImage: icon).font(.system(size: 12)).foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(color.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.system(size: 15, weight: .medium))
            content()
        }
        .padding(20).frame(maxWidth: .infinity, alignment: .leading)
        .background(SetupPalette.panel, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(SetupPalette.line, lineWidth: 1))
    }
}
