import AppKit
import AVFoundation
import SwiftUI

struct IntegrationReadiness: Decodable {
    struct Telegram: Decodable { let configured: Bool, paired: Bool, ownerChatId: String? }
    struct Google: Decodable {
        struct Account: Decodable, Identifiable { let id: String, email: String, projectId: String, labels: [String], calendars: [String], consents: [String]; let retentionAllowed: Bool?, cloudAllowed: Bool?, revision: Int? }
        let configured: Bool, accounts: [Account]
    }
    struct Twilio: Decodable { let configured: Bool, ownerNumber: String?, ownerVerified: Bool }
    let version: Int, enabled: Bool, stopped: Bool, telegram: Telegram, google: Google, twilio: Twilio
}

@MainActor
struct GuidedSetupView: View {
    @ObservedObject var app: AppModel
    @ObservedObject private var runtime = RuntimeSupervisor.shared
    @ObservedObject private var cloud = PairedCloudConnection.shared
    @ObservedObject private var profiles = RuntimeProfiles.shared
    @AppStorage("Jarvis.onboardingCompleted") private var completed = false
    @AppStorage("Jarvis.assistantEnabled") private var assistantEnabled = false
    @AppStorage("Jarvis.knowledgeEnabled") private var knowledgeEnabled = false
    @AppStorage("Jarvis.memoryEnabled") private var memoryEnabled = false
    @AppStorage("Jarvis.researchEnabled") private var researchEnabled = false
    @AppStorage("Jarvis.objectivesEnabled") private var objectivesEnabled = false
    @AppStorage("Jarvis.cloudEnabled") private var cloudEnabled = false
    @Environment(\.dismiss) private var dismiss
    @State private var step = 0
    @AppStorage("Jarvis.voiceID") private var voiceID = ""
    @State private var gatewayCredential = ""
    @State private var voiceCredential = ""
    @State private var voiceKeySaved = false
    @State private var microphone = AVAuthorizationStatus.notDetermined
    @State private var capabilitiesChanged = false
    @State private var cloudOrigin = ""
    @State private var cloudBootstrap = ""
    @State private var deviceLabel = "My Mac"
    @State private var notice: String?
    @State private var error: String?
    @State private var integrations: IntegrationReadiness?
    @State private var accountBusy = false
    @State private var pairingCode: String?
    @State private var pairingExpiry: String?
    @State private var googleConsent = "read"
    @State private var labels = "INBOX"
    @State private var calendars = "primary"
    @State private var retainAccountContent = false
    @State private var useAccountContentInCloud = false
    @State private var cloudProjectID: String
    init(app: AppModel, cloudProjectID: String? = nil) {
        self.app = app; _cloudProjectID = State(initialValue: cloudProjectID ?? UUID().uuidString)
    }
    private var projectID: String? { cloudProjectID.isEmpty ? nil : cloudProjectID }
    private let steps = [("This Mac", "desktopcomputer"), ("Cloud · optional", "cloud"), ("Accounts · optional", "person.crop.circle"), ("First conversation", "waveform")]

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center) {
                Image(systemName: "waveform.circle.fill").font(.system(size: 30)).foregroundStyle(JarvisTheme.Colors.accent).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Set up Jarvis").font(.system(size: JarvisTheme.TextSize.title, weight: .semibold))
                    Text("One step at a time. You can come back here from Today.").font(.system(size: JarvisTheme.TextSize.label)).foregroundStyle(JarvisTheme.Colors.muted)
                }
                Spacer()
                Button("Done") { completed = true; clearSecrets(); dismiss() }.keyboardShortcut(.cancelAction)
            }.padding(.horizontal, JarvisTheme.Space.xl).padding(.vertical, JarvisTheme.Space.l)
            Rectangle().fill(JarvisTheme.Colors.line).frame(height: 1)
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: JarvisTheme.Space.s) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { index, entry in
                        Button { step = index } label: {
                            Label(entry.0, systemImage: entry.1).font(.system(size: JarvisTheme.TextSize.body, weight: .medium))
                                .foregroundStyle(step == index ? JarvisTheme.Colors.accent : JarvisTheme.Colors.muted)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                                .background(step == index ? JarvisTheme.Colors.accent.opacity(0.09) : Color.clear, in: RoundedRectangle(cornerRadius: JarvisTheme.Radius.control))
                                .contentShape(RoundedRectangle(cornerRadius: JarvisTheme.Radius.control))
                        }.buttonStyle(.plain).accessibilityAddTraits(step == index ? .isSelected : [])
                    }
                    Spacer()
                    SettingsLink { Label("All settings", systemImage: "gearshape") }
                }.padding(JarvisTheme.Space.l).frame(width: 220).background(JarvisTheme.Colors.panel.opacity(0.5))
                Rectangle().fill(JarvisTheme.Colors.line).frame(width: 1)
                ScrollView {
                    VStack(alignment: .leading, spacing: JarvisTheme.Space.l) {
                        if let error {
                            Label(error, systemImage: "exclamationmark.triangle.fill").font(.system(size: JarvisTheme.TextSize.label))
                                .foregroundStyle(JarvisTheme.Colors.warning).textSelection(.enabled)
                        }
                        if let notice { Text(notice).font(.system(size: JarvisTheme.TextSize.label)).foregroundStyle(JarvisTheme.Colors.muted) }
                        switch step {
                        case 0: localSetup
                        case 1: cloudSetup
                        case 2: accountSetup
                        default: conversationSetup
                        }
                    }.padding(JarvisTheme.Space.xl).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(minWidth: 520)
            }
        }.frame(width: 900, height: 690)
            .background(JarvisTheme.Colors.background)
            .foregroundStyle(JarvisTheme.Colors.text)
            .buttonStyle(.jarvis)
            .toggleStyle(.switch)
            .tint(JarvisTheme.Colors.accent)
            .preferredColorScheme(.dark)
            .onAppear { refreshLocalChecks() }
            .onDisappear { clearSecrets() }
            .onChange(of: profiles.cloudProfile?.id) { _, _ in integrations = nil; pairingCode = nil; pairingExpiry = nil; error = nil }
            .onChange(of: step) { _, _ in error = nil; notice = nil; clearSecrets(); refreshLocalChecks() }
            .onChange(of: [assistantEnabled, knowledgeEnabled, memoryEnabled, researchEnabled, objectivesEnabled]) { _, _ in capabilitiesChanged = true }
    }

    /// The state of the two things Jarvis cannot work without, and of optional voice.
    static func servicesCheck(_ state: RuntimeSupervisor.State) -> JarvisCheckState {
        switch state {
        case .ready: return .done
        case .idle, .starting, .stopping: return .working
        case .failed, .stopped: return .failed
        }
    }
    /// With the developer launcher only the bridge knows whether it was given a key; nil means it has not said yet.
    static func keyCheck(externallyManaged: Bool, supervisorHasKey: Bool, bridgeHasKey: Bool?) -> JarvisCheckState {
        if externallyManaged { return bridgeHasKey == true ? .done : bridgeHasKey == false ? .needed : .optional }
        return supervisorHasKey ? .done : .needed
    }
    static func voiceCheck(keySaved: Bool, voiceID: String, microphone: AVAuthorizationStatus) -> JarvisCheckState {
        guard keySaved, !voiceID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .optional }
        switch microphone {
        case .authorized: return .done
        case .denied, .restricted: return .failed
        default: return .needed
        }
    }

    private var keyState: JarvisCheckState {
        Self.keyCheck(externallyManaged: runtime.externallyManaged, supervisorHasKey: runtime.providerConfigured, bridgeHasKey: app.providerConfigured)
    }
    private var readyToTalk: Bool { runtime.state == .ready && keyState != .needed }

    private func refreshLocalChecks() {
        voiceKeySaved = ProviderCredentials().isSaved(.voice)
        microphone = AVCaptureDevice.authorizationStatus(for: .audio)
    }

    private var localSetup: some View {
        VStack(alignment: .leading, spacing: JarvisTheme.Space.l) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Get Jarvis ready on this Mac").font(.system(size: JarvisTheme.TextSize.title, weight: .medium))
                Text("Jarvis needs two things before it can answer: its local services running, and a model key. Everything else is optional.")
                    .font(.system(size: JarvisTheme.TextSize.body)).foregroundStyle(JarvisTheme.Colors.muted).fixedSize(horizontal: false, vertical: true)
            }
            JarvisCard {
                JarvisCheckRow(state: Self.servicesCheck(runtime.state), title: "Local services", detail: runtime.detail) {
                    if runtime.state == .failed || runtime.state == .stopped {
                        Button("Retry") { Task { await runtime.start() } }.padding(.top, 4)
                    }
                }
            }
            JarvisCard(tint: keyState == .needed ? JarvisTheme.Colors.warning : nil) {
                JarvisCheckRow(state: keyState, title: "Model key",
                               detail: keyState == .done ? "A Vercel AI Gateway key is saved. A saved key is not proof the provider accepts it; Jarvis tells you if it is rejected."
                                   : keyState == .optional ? "The developer launcher supplies the key from its own environment."
                                   : "Jarvis reasons through the Vercel AI Gateway. Create a key there, paste it here, and it is stored in your Keychain.") {
                    if !runtime.externallyManaged {
                        HStack(spacing: JarvisTheme.Space.s) {
                            SecureField(keyState == .done ? "Paste a new key to replace the saved one" : "Vercel AI Gateway key", text: $gatewayCredential)
                                .textFieldStyle(.roundedBorder).onSubmit { saveCredentials() }
                            Button("Save key") { saveCredentials() }.buttonStyle(.jarvis(.primary)).disabled(gatewayCredential.isEmpty)
                        }.padding(.top, 4)
                        if let url = URL(string: "https://vercel.com/ai-gateway") {
                            Link("Create a key at vercel.com/ai-gateway", destination: url).font(.system(size: JarvisTheme.TextSize.label))
                        }
                    }
                }
            }
            JarvisCard {
                JarvisCheckRow(state: Self.voiceCheck(keySaved: voiceKeySaved, voiceID: voiceID, microphone: microphone), title: "Voice · optional",
                               detail: "Speaking and listening use ElevenLabs. Add its key and a voice ID to talk with Jarvis; typing works without them. Audio is only captured after you accept the voice disclosure in a conversation.") {
                    if !runtime.externallyManaged {
                        HStack(spacing: JarvisTheme.Space.s) {
                            SecureField(voiceKeySaved ? "ElevenLabs key · saved" : "ElevenLabs key", text: $voiceCredential).textFieldStyle(.roundedBorder)
                            TextField("Voice ID", text: $voiceID).textFieldStyle(.roundedBorder).frame(width: 190)
                            Button("Save") { saveCredentials() }.disabled(voiceCredential.isEmpty)
                        }.padding(.top, 4)
                    }
                    HStack(spacing: JarvisTheme.Space.s) {
                        Text(microphoneSummary).font(.system(size: JarvisTheme.TextSize.label)).foregroundStyle(JarvisTheme.Colors.muted)
                        if microphone == .notDetermined {
                            Button("Allow microphone") { Task { _ = await AVCaptureDevice.requestAccess(for: .audio); refreshLocalChecks() } }
                        } else if microphone == .denied, let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                            Button("Open Microphone settings") { NSWorkspace.shared.open(url) }
                        }
                    }
                }
            }
            JarvisCard {
                Text("WHAT JARVIS CAN USE").jarvisEyebrow()
                Toggle("Conversations with sources, tables, code and drafts", isOn: $assistantEnabled)
                Toggle("Your documents, per project, with explicit read grants", isOn: $knowledgeEnabled)
                Toggle("Memory you review before it is kept", isOn: $memoryEnabled)
                Toggle("Research runs with a budget you approve", isOn: $researchEnabled)
                Toggle("Long-running objectives on Today", isOn: $objectivesEnabled)
                Text("Screen control, terminal commands, Mail, Calendar and Messages stay off until you turn them on in Settings, and each action still asks first.")
                    .font(.system(size: JarvisTheme.TextSize.caption)).foregroundStyle(JarvisTheme.Colors.muted).fixedSize(horizontal: false, vertical: true)
                if capabilitiesChanged {
                    HStack(spacing: JarvisTheme.Space.s) {
                        Button("Apply and restart services") { capabilitiesChanged = false; Task { await runtime.restart() } }
                            .disabled(runtime.externallyManaged || runtime.state == .starting || runtime.state == .stopping)
                        Text(runtime.externallyManaged ? "Relaunch the developer launcher to apply." : "Changes take effect after a restart; nothing in progress is replayed.")
                            .font(.system(size: JarvisTheme.TextSize.caption)).foregroundStyle(JarvisTheme.Colors.muted)
                    }
                }
            }
            HStack(spacing: JarvisTheme.Space.s) {
                Button("Start a conversation") { completed = true; clearSecrets(); dismiss(); Task { await app.startNewConversation() } }
                    .buttonStyle(.jarvis(.primary)).disabled(!readyToTalk).keyboardShortcut(.defaultAction)
                Button("Pair a cloud companion…") { step = 1 }.buttonStyle(.jarvis(.quiet))
                if !readyToTalk {
                    Text(runtime.state != .ready ? "Available once local services are ready." : "Available once a model key is saved.")
                        .font(.system(size: JarvisTheme.TextSize.caption)).foregroundStyle(JarvisTheme.Colors.warning)
                }
            }
        }
    }
    private var microphoneSummary: String {
        switch microphone {
        case .authorized: return "Microphone: allowed."
        case .denied: return "Microphone: blocked in System Settings."
        case .restricted: return "Microphone: restricted on this Mac."
        default: return "Microphone: macOS will ask the first time."
        }
    }
    private var cloudSetup: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Carry work beyond this Mac").font(.title2)
            Text("Pair an already deployed Jarvis cloud service. Local conversations, pending actions, and private files keep their original authority; pairing does not upload them.").foregroundStyle(.secondary)
            Toggle("Enable the cloud companion", isOn: $cloudEnabled)
            setupStatus("Paired connection", value: cloud.state.rawValue.capitalized, detail: cloud.detail)
            if let profile = profiles.cloudProfile {
                Text(profile.label).font(.headline)
                Text(profile.origin).font(.caption.monospaced()).textSelection(.enabled)
                HStack {
                    Button("Connect") { Task { await cloud.connect() } }.disabled(!cloudEnabled || [.pairing, .connecting].contains(cloud.state))
                    Button("Disconnect") { cloud.disconnect() }
                    Button("Set up owner passkey") {
                        Task { do { let url = try await cloud.beginOwnerEnrollment(); NSWorkspace.shared.open(url) } catch { self.error = error.localizedDescription } }
                    }
                    Button("Use cloud Today") { do { try profiles.select(.cloud); app.tab = .today } catch { self.error = error.localizedDescription } }
                        .disabled(!cloudEnabled)
                    Button("Use local Today") { do { try profiles.select(.local) } catch { self.error = error.localizedDescription } }
                }
            } else {
                TextField("Cloud HTTPS origin, e.g. https://jarvis.example.com", text: $cloudOrigin)
                TextField("Name for this device", text: $deviceLabel)
                SecureField("One-time deployment enrollment credential", text: $cloudBootstrap)
                Button("Pair this Mac") {
                    let secret = cloudBootstrap; cloudBootstrap = ""
                    Task { await cloud.pair(origin: cloudOrigin, bootstrapCredential: secret, label: deviceLabel) }
                }.disabled(!cloudEnabled || cloudOrigin.isEmpty || cloudBootstrap.isEmpty || cloud.state == .pairing)
            }
            Text("Sensitive cloud actions require a fresh, action-specific owner passkey review. Phone and Telegram conversations cannot replace it with a generic yes.").font(.caption).foregroundStyle(.secondary)
            Text("No cloud server yet? Finish local setup now. Deploy the prepared cloud package with your own TLS endpoint before pairing. This screen does not provision a server or buy services.").font(.caption).foregroundStyle(.secondary)
            Button("Next: optional accounts") { step = 2 }
        }
    }
    private var accountSetup: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connect only what you need").font(.title2)
            Text("Provider credentials and webhook endpoints are configured on your deployment. Jarvis shows verified account state here; optional services stay pending until configured.").foregroundStyle(.secondary)
            Button(accountBusy ? "Checking…" : "Check account readiness") { Task { await refreshIntegrations() } }.disabled(accountBusy)
            if let state = integrations {
                setupStatus("Google", value: state.google.configured ? "OAuth configured" : "Pending deployment setup", detail: "Select a project, Gmail labels, and calendars before opening the provider's consent screen.")
                ForEach(state.google.accounts) { account in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(account.email).font(.headline)
                        Text("\(account.labels.joined(separator: ", ")) · \(account.calendars.joined(separator: ", "))").font(.caption)
                        Text(account.consents.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                        Text(account.retentionAllowed == true ? (account.cloudAllowed == true ? "Retention and cloud reasoning allowed" : "Retained; excluded from cloud reasoning") : "Provider connected; content retention off").font(.caption).foregroundStyle(.secondary)
                        HStack {
                            if account.cloudAllowed == true { Button("Stop cloud reasoning") { Task { await reducePermissions(account, retain: account.retentionAllowed == true) } } }
                            if account.retentionAllowed == true { Button("Stop retention") { Task { await reducePermissions(account, retain: false) } } }
                        }.disabled(accountBusy || account.revision == nil)
                    }
                }
                Picker("Permission", selection: $googleConsent) { Text("Read selected sources").tag("read"); Text("Send reviewed Gmail").tag("gmail_send"); Text("Write reviewed Calendar events").tag("calendar_write") }
                TextField("Gmail label IDs, separated by commas", text: $labels)
                TextField("Calendar IDs, separated by commas", text: $calendars)
                TextField("Cloud project ID", text: $cloudProjectID)
                Text("Use the cloud project selected in Today, or keep this new project. Local conversations are not copied.").font(.caption).foregroundStyle(.secondary)
                Toggle("Retain selected account content in the cloud deployment", isOn: $retainAccountContent)
                    .onChange(of: retainAccountContent) { _, retained in if !retained { useAccountContentInCloud = false } }
                Toggle("Allow selected content in cloud model reasoning", isOn: $useAccountContentInCloud).disabled(!retainAccountContent)
                Button("Connect Google in browser") { Task { await connectGoogle() } }.disabled(accountBusy || !state.google.configured || projectID == nil)
                Divider()
                setupStatus("Telegram", value: state.telegram.paired ? "Owner paired" : state.telegram.configured ? "Ready to pair" : "Pending deployment setup", detail: "Pair your exact Telegram owner chat using an expiring code.")
                Button("Create pairing code") { Task { await pairTelegram() } }.disabled(accountBusy || !state.telegram.configured)
                if let pairingCode { Text(pairingCode).font(.title2.monospaced()).textSelection(.enabled); Text("Send this code to your configured Jarvis bot before \(pairingExpiry ?? "expiry").").font(.caption).foregroundStyle(.secondary) }
                Divider()
                setupStatus("Phone", value: state.twilio.ownerVerified ? "Owner verified" : state.twilio.configured ? "Needs owner verification" : "Pending deployment setup", detail: state.twilio.ownerNumber ?? "No owner number configured.")
                Button("Verify configured owner number") { Task { await verifyPhone() } }.disabled(accountBusy || !state.twilio.configured || projectID == nil)
            } else { Text("Check readiness to see which integrations are configured. A missing service is reported as unavailable; local conversations remain usable.").font(.callout).foregroundStyle(.secondary) }
            Button("Next: try Jarvis") { step = 3 }
        }
    }
    private var conversationSetup: some View {
        VStack(alignment: .leading, spacing: JarvisTheme.Space.l) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Start with one real question").font(.system(size: JarvisTheme.TextSize.title, weight: .medium))
                Text("Ask something you actually want answered. To ground it in your own material, import a document for that conversation's project and ask for an explanation with evidence.")
                    .font(.system(size: JarvisTheme.TextSize.body)).foregroundStyle(JarvisTheme.Colors.muted).fixedSize(horizontal: false, vertical: true)
            }
            JarvisCard {
                Text("GOOD TO KNOW").jarvisEyebrow()
                Label("Control–Option–Space opens a small Jarvis panel from anywhere", systemImage: "keyboard")
                Label("Command–Period stops all work", systemImage: "stop.circle")
                Label("Anything that acts on your Mac or an account shows an approval card first", systemImage: "hand.raised")
                Label("Closing the window keeps Jarvis available in the menu bar; Quit stops it", systemImage: "menubar.rectangle")
            }.font(.system(size: JarvisTheme.TextSize.body))
            HStack(spacing: JarvisTheme.Space.s) {
                Button("Start a conversation") { completed = true; clearSecrets(); dismiss(); Task { await app.startNewConversation() } }
                    .buttonStyle(.jarvis(.primary)).disabled(!readyToTalk).keyboardShortcut(.defaultAction)
                if !readyToTalk {
                    Button("Finish setup on this Mac") { step = 0 }.buttonStyle(.jarvis(.quiet))
                    Text(runtime.state != .ready ? "Local services are not ready yet." : "A model key is still needed.")
                        .font(.system(size: JarvisTheme.TextSize.caption)).foregroundStyle(JarvisTheme.Colors.warning)
                }
            }
            Text("Voice has only been exercised in automated tests so far. Try speakers, headphones and interruptions on this Mac before relying on hands-free use.")
                .font(.system(size: JarvisTheme.TextSize.caption)).foregroundStyle(JarvisTheme.Colors.muted).fixedSize(horizontal: false, vertical: true)
        }
    }
    private func setupStatus(_ title: String, value: String, detail: String) -> some View {
        JarvisCard(padding: 14) {
            HStack { Text(title).font(.system(size: JarvisTheme.TextSize.heading, weight: .medium)); Spacer(); Text(value).font(.system(size: JarvisTheme.TextSize.caption)).foregroundStyle(JarvisTheme.Colors.accent) }
            Text(detail).font(.system(size: JarvisTheme.TextSize.label)).foregroundStyle(JarvisTheme.Colors.muted).fixedSize(horizontal: false, vertical: true)
        }
    }
    private func clearSecrets() { gatewayCredential = ""; voiceCredential = ""; cloudBootstrap = "" }
    private func saveCredentials() {
        do {
            let store = ProviderCredentials()
            if !gatewayCredential.isEmpty { try store.save(gatewayCredential, for: .gateway) }
            if !voiceCredential.isEmpty { try store.save(voiceCredential, for: .voice) }
            clearSecrets(); error = nil; refreshLocalChecks()
            notice = runtime.externallyManaged ? "Saved in Keychain. The developer launcher's own environment still takes precedence."
                : "Saved in Keychain. Restarting local services to use them…"
            Task { await runtime.credentialsChanged() }
        } catch { self.error = error.localizedDescription }
    }
    private func refreshIntegrations() async {
        accountBusy = true; defer { accountBusy = false }
        do {
            guard profiles.cloudProfile != nil else { throw AssistantClientError.service("Pair your cloud deployment first. Optional Google, Telegram, and phone integrations are configured there.") }
            let bytes = try await cloud.setupData(path: "/v1/cloud/setup/integrations/status")
            let state = try JSONDecoder().decode(IntegrationReadiness.self, from: bytes)
            guard state.version == 1 else { throw AssistantClientError.invalidResponse }
            integrations = state; error = nil
        } catch { self.error = error.localizedDescription; integrations = nil }
    }
    private func connectGoogle() async {
        guard let projectID else { return }
        accountBusy = true; defer { accountBusy = false }
        do {
            struct Result: Decodable { let url: String, expiresAt: String }
            let bytes = try await cloud.setupData(path: "/v1/cloud/setup/integrations/google/connect", method: "POST", body: [
                "accountId": UUID().uuidString, "projectId": projectID, "objectiveId": NSNull(), "consent": googleConsent,
                "labels": identifiers(labels), "calendars": identifiers(calendars), "retentionAllowed": retainAccountContent, "cloudAllowed": useAccountContentInCloud])
            let result = try JSONDecoder().decode(Result.self, from: bytes)
            guard let url = URL(string: result.url), url.scheme == "https", url.host == "accounts.google.com", url.user == nil, url.password == nil,
                  let expiry = RoomsStateRules.date(result.expiresAt), expiry > Date() else { throw AssistantClientError.invalidResponse }
            NSWorkspace.shared.open(url); notice = "Finish Google's consent screen, then check account readiness again."
        } catch { self.error = error.localizedDescription }
    }
    private func reducePermissions(_ account: IntegrationReadiness.Google.Account, retain: Bool) async {
        guard let revision = account.revision else { return }
        accountBusy = true
        do {
            struct Result: Decodable { let id: String, projectId: String, revision: Int }
            let data = try await cloud.setupData(path: "/v1/cloud/setup/integrations/google/permissions", method: "POST", body: [
                "accountId": account.id, "expectedRevision": revision, "retentionAllowed": retain, "cloudAllowed": false,
                "labels": account.labels, "calendars": account.calendars])
            let updated = try JSONDecoder().decode(Result.self, from: data)
            guard updated.id == account.id, updated.projectId == account.projectId, updated.revision > revision else { throw AssistantClientError.invalidResponse }
            accountBusy = false; await refreshIntegrations()
        } catch { accountBusy = false; self.error = error.localizedDescription }
    }
    private func pairTelegram() async {
        accountBusy = true; defer { accountBusy = false }
        do {
            struct Result: Decodable { let code: String, expiresAt: String }
            let bytes = try await cloud.setupData(path: "/v1/cloud/setup/integrations/telegram/pair", method: "POST", body: [:])
            let result = try JSONDecoder().decode(Result.self, from: bytes)
            guard result.code.utf16.count <= 128, let expiry = RoomsStateRules.date(result.expiresAt), expiry > Date() else { throw AssistantClientError.invalidResponse }
            pairingCode = result.code; pairingExpiry = result.expiresAt
        } catch { self.error = error.localizedDescription }
    }
    private func verifyPhone() async {
        guard let projectID else { return }
        accountBusy = true
        do { _ = try await cloud.setupData(path: "/v1/cloud/setup/integrations/twilio/verify-owner", method: "POST", body: ["projectId": projectID, "objectiveId": NSNull()]); accountBusy = false; await refreshIntegrations() }
        catch { accountBusy = false; self.error = error.localizedDescription }
    }
    private func identifiers(_ text: String) -> [String] { text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
}
