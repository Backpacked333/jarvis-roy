import AppKit
import SwiftUI

struct IntegrationReadiness: Decodable {
    struct Telegram: Decodable { let configured: Bool, paired: Bool, ownerChatId: String? }
    struct Google: Decodable {
        struct Account: Decodable, Identifiable { let id: String, email: String, projectId: String, labels: [String], calendars: [String], consents: [String] }
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
    private var projectID: String? { app.assistant.selectedSession?.focus.projectID }
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
            .onChange(of: step) { _, _ in error = nil; notice = nil; clearSecrets() }
    }
    private var localSetup: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Your Mac is the local control point").font(.title2)
            setupStatus("Local services", value: runtime.state == .ready ? "Ready" : runtime.state.rawValue.capitalized, detail: runtime.detail)
            setupStatus("Model catalog", value: runtime.modelMetadataAvailable ? "Available" : "Needs setup", detail: "Exact model and price metadata are required before budgeted work.")
            GroupBox("Provider credentials") {
                VStack(alignment: .leading, spacing: 12) {
                    SecureField("Vercel AI Gateway API key", text: $gatewayCredential)
                    SecureField("ElevenLabs API key (optional)", text: $voiceCredential)
                    Button("Save credentials to Keychain") { saveCredentials() }.disabled(gatewayCredential.isEmpty && voiceCredential.isEmpty)
                    Text("Credentials stay in macOS Keychain. Restart local services after changing them. Never paste them into a conversation.").font(.caption).foregroundStyle(.secondary)
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
                    }
                }
                Picker("Permission", selection: $googleConsent) { Text("Read selected sources").tag("read"); Text("Send reviewed Gmail").tag("gmail_send"); Text("Write reviewed Calendar events").tag("calendar_write") }
                TextField("Gmail label IDs, separated by commas", text: $labels)
                TextField("Calendar IDs, separated by commas", text: $calendars)
                Text("Project: \(app.assistant.selectedSession?.title ?? "Start or select a conversation first")").font(.caption).foregroundStyle(.secondary)
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
            clearSecrets(); notice = "Credentials saved in Keychain. Restart local services to use them."; error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func refreshIntegrations() async {
        accountBusy = true; defer { accountBusy = false }
        do {
            let state = try await app.assistant.client.value(IntegrationReadiness.self, path: "/v1/integrations/status")
            guard state.version == 1 else { throw AssistantClientError.invalidResponse }
            integrations = state; error = nil
        } catch { self.error = error.localizedDescription; integrations = nil }
    }
    private func connectGoogle() async {
        guard let projectID else { return }
        accountBusy = true; defer { accountBusy = false }
        do {
            struct Result: Decodable { let url: String, expiresAt: String }
            let result = try await app.assistant.client.value(Result.self, path: "/v1/integrations/google/connect", method: "POST", body: [
                "accountId": UUID().uuidString, "projectId": projectID, "objectiveId": NSNull(), "consent": googleConsent,
                "labels": identifiers(labels), "calendars": identifiers(calendars)])
            guard let url = URL(string: result.url), url.scheme == "https", url.host == "accounts.google.com", url.user == nil, url.password == nil,
                  let expiry = RoomsStateRules.date(result.expiresAt), expiry > Date() else { throw AssistantClientError.invalidResponse }
            NSWorkspace.shared.open(url); notice = "Finish Google's consent screen, then check account readiness again."
        } catch { self.error = error.localizedDescription }
    }
    private func pairTelegram() async {
        accountBusy = true; defer { accountBusy = false }
        do {
            struct Result: Decodable { let code: String, expiresAt: String }
            let result = try await app.assistant.client.value(Result.self, path: "/v1/integrations/telegram/pair", method: "POST", body: [:])
            guard result.code.utf16.count <= 128, let expiry = RoomsStateRules.date(result.expiresAt), expiry > Date() else { throw AssistantClientError.invalidResponse }
            pairingCode = result.code; pairingExpiry = result.expiresAt
        } catch { self.error = error.localizedDescription }
    }
    private func verifyPhone() async {
        guard let projectID else { return }
        accountBusy = true
        do { _ = try await app.assistant.client.data("/v1/integrations/twilio/verify-owner", method: "POST", body: ["projectId": projectID, "objectiveId": NSNull()]); accountBusy = false; await refreshIntegrations() }
        catch { accountBusy = false; self.error = error.localizedDescription }
    }
    private func identifiers(_ text: String) -> [String] { text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
}
