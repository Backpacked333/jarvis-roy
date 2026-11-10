import AppKit
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
    @State private var gatewayCredential = ""
    @State private var voiceCredential = ""
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
    private let steps = [("Start on this Mac", "desktopcomputer"), ("Add your cloud", "cloud"), ("Connect accounts", "person.crop.circle"), ("Try a conversation", "waveform")]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 4) { Text("Make Jarvis yours").font(.title); Text("Set up one capability at a time. You can return here from Today.").foregroundStyle(.secondary) }
                Spacer(); Button("Done") { completed = true; clearSecrets(); dismiss() }
            }.padding(24)
            Divider()
            HSplitView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { index, entry in
                        Button { step = index } label: { Label(entry.0, systemImage: entry.1).frame(maxWidth: .infinity, alignment: .leading).padding(10) }
                            .buttonStyle(.plain).background(step == index ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 8))
                    }
                    Spacer()
                    SettingsLink { Label("All settings", systemImage: "gearshape") }
                }.padding(18).frame(width: 210)
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if let error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
                        if let notice { Text(notice).foregroundStyle(.secondary) }
                        switch step {
                        case 0: localSetup
                        case 1: cloudSetup
                        case 2: accountSetup
                        default: conversationSetup
                        }
                    }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(minWidth: 520)
            }
        }.frame(width: 900, height: 690)
            .onDisappear { clearSecrets() }
            .onChange(of: profiles.cloudProfile?.id) { _, _ in integrations = nil; pairingCode = nil; pairingExpiry = nil; error = nil }
            .onChange(of: step) { _, _ in error = nil; notice = nil; clearSecrets() }
    }
    private var localSetup: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Your Mac is the local control point").font(.title2)
            setupStatus("Local services", value: runtime.state == .ready ? "Ready" : runtime.state.rawValue.capitalized, detail: runtime.detail)
            setupStatus("Model key", value: runtime.providerConfigured ? "Saved" : "Needed",
                        detail: runtime.providerConfigured ? "A Vercel AI Gateway key is saved in your Keychain. A saved key is not proof the provider accepts it."
                            : "Jarvis reasons through the Vercel AI Gateway. Create a key at vercel.com/ai-gateway and save it below.")
            GroupBox("Provider credentials") {
                VStack(alignment: .leading, spacing: 12) {
                    SecureField("Vercel AI Gateway API key", text: $gatewayCredential)
                    SecureField("ElevenLabs API key (optional)", text: $voiceCredential)
                    Button("Save credentials to Keychain") { saveCredentials() }.disabled(gatewayCredential.isEmpty && voiceCredential.isEmpty)
                    Text("Keys stay in your macOS Keychain and are never shown again. Saving restarts local services so they are used straight away. Never paste a key into a conversation.").font(.caption).foregroundStyle(.secondary)
                }.padding(8)
            }
            Toggle("Assistant conversation workspace", isOn: $assistantEnabled)
            Toggle("Project documents and context", isOn: $knowledgeEnabled)
            Toggle("Reviewed personal memory", isOn: $memoryEnabled)
            Toggle("Bounded research", isOn: $researchEnabled)
            Toggle("Objectives and Today progress", isOn: $objectivesEnabled)
            Text("New capabilities take effect after restarting local services. Source access and cloud disclosure still require their own grants.").font(.caption).foregroundStyle(.secondary)
            HStack { Button("Restart local services") { Task { await runtime.restart() } }; Button("Next: optional cloud") { step = 1 } }
            SettingsLink { Text("Runtime paths, worker image, and macOS permissions…") }
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
        VStack(alignment: .leading, spacing: 16) {
            Text("Start with one real question").font(.title2)
            Text("Open a conversation, import a document for that project, and ask for an explanation with evidence. Review a memory suggestion before saving it globally.").foregroundStyle(.secondary)
            Label("Control–Option–Space summons the compact panel", systemImage: "keyboard")
            Label("Back holds the displayed revision; Follow Jarvis resumes updates", systemImage: "pin")
            Label("Stop speaking leaves background work running", systemImage: "speaker.slash")
            Label("Closing the window keeps services available; Quit stops them", systemImage: "menubar.rectangle")
            Button("Start a conversation") { completed = true; clearSecrets(); dismiss(); Task { await app.startNewConversation() } }
                .buttonStyle(.borderedProminent).disabled(runtime.state != .ready)
            if runtime.state != .ready {
                Text("Available once local services are ready: \(runtime.detail)").font(.caption).foregroundStyle(.orange)
            } else if !runtime.providerConfigured && !runtime.externallyManaged {
                Text("Jarvis cannot answer until a model key is saved in the first step.").font(.caption).foregroundStyle(.orange)
            }
            Text("Voice starts only after explicit session consent and macOS microphone permission. Test speakers, headphones, interruption, long pauses, and device changes on this Mac before relying on hands-free use.").font(.caption).foregroundStyle(.secondary)
        }
    }
    private func setupStatus(_ title: String, value: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 6) { HStack { Text(title).font(.headline); Spacer(); Text(value).font(.caption).foregroundStyle(.secondary) }; Text(detail).font(.caption).foregroundStyle(.secondary) }
            .padding(14).background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
    }
    private func clearSecrets() { gatewayCredential = ""; voiceCredential = ""; cloudBootstrap = "" }
    private func saveCredentials() {
        do {
            let store = ProviderCredentials()
            if !gatewayCredential.isEmpty { try store.save(gatewayCredential, for: .gateway) }
            if !voiceCredential.isEmpty { try store.save(voiceCredential, for: .voice) }
            clearSecrets(); error = nil
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
