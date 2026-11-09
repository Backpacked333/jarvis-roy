import SwiftUI

struct JarvisSettingsView: View {
    @ObservedObject var assistant: AssistantModel
    @ObservedObject var supervisor = RuntimeSupervisor.shared
    @ObservedObject var diagnostics = RuntimeDiagnostics.shared
    @AppStorage("Jarvis.assistantEnabled") private var assistantEnabled = false
    @AppStorage("Jarvis.knowledgeEnabled") private var knowledgeEnabled = false
    @AppStorage("Jarvis.memoryEnabled") private var memoryEnabled = false
    @AppStorage("Jarvis.semanticRetrievalEnabled") private var semanticRetrievalEnabled = false
    @AppStorage("Jarvis.researchEnabled") private var researchEnabled = false
    @AppStorage("Jarvis.voiceApprovalEnabled") private var voiceApprovalEnabled = false
    @AppStorage("Jarvis.desktopEnabled") private var desktopEnabled = false
    @AppStorage("Jarvis.appleServicesEnabled") private var appleServicesEnabled = false
    @AppStorage("Jarvis.terminalEnabled") private var terminalEnabled = false
    @AppStorage("Jarvis.objectivesEnabled") private var objectivesEnabled = false
    @AppStorage("Jarvis.cloudEnabled") private var cloudEnabled = false
    @AppStorage("Jarvis.telegramEnabled") private var telegramEnabled = false
    @AppStorage("Jarvis.googleEnabled") private var googleEnabled = false
    @AppStorage("Jarvis.phoneEnabled") private var phoneEnabled = false
    @AppStorage("Jarvis.model") private var model = ""
    @AppStorage("Jarvis.deepModel") private var deepModel = ""
    @AppStorage("Jarvis.voiceID") private var voiceID = ""
    @AppStorage("Jarvis.homeURL") private var homeURL = ""
    @AppStorage("Jarvis.runtimeDirectory") private var runtimeDirectory = ""
    @AppStorage("Jarvis.nodeExecutable") private var nodeExecutable = ""
    @StateObject private var calendarSetup = CalendarPermissionSetup()
    @ObservedObject private var briefing = DailyBriefingCoordinator.shared
    @AppStorage("Jarvis.dailyBriefingEnabled") private var dailyBriefingEnabled = false
    @AppStorage("Jarvis.dailyBriefingHour") private var dailyBriefingHour = 9
    @AppStorage("Jarvis.dailyBriefingMinute") private var dailyBriefingMinute = 0
    @AppStorage("Jarvis.dailyBriefingProjectID") private var dailyBriefingProjectID = ""

    var body: some View {
        TabView {
            Form {
                Section("Local assistant") {
                    Label(supervisor.state.rawValue.capitalized, systemImage: supervisor.state == .ready ? "checkmark.circle" : "network")
                    Text(supervisor.detail).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    Button("Restart local services") { Task { await supervisor.restart() } }
                        .disabled(supervisor.state == .starting || supervisor.state == .stopping)
                    Text("Changes take effect after restarting services. Existing actions are reconciled, never automatically replayed.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("New experience") {
                    Toggle("Voice-first assistant", isOn: $assistantEnabled)
                    Toggle("Project knowledge and read grants", isOn: $knowledgeEnabled)
                    Toggle("Reviewed personal memory", isOn: $memoryEnabled)
                    Toggle("On-device semantic retrieval", isOn: $semanticRetrievalEnabled)
                    Text("Semantic retrieval uses an available Apple language model on this Mac. If unavailable, search uses keywords. Source access and cloud disclosure still require grants.")
                        .font(.caption).foregroundStyle(.secondary)
                    Toggle("Reviewed research workflows", isOn: $researchEnabled)
                    Text("Research also requires project knowledge. Each run has a separately reviewed estimate and time limit.")
                        .font(.caption).foregroundStyle(.secondary)
                    Toggle("Action-specific voice confirmation", isOn: $voiceApprovalEnabled)
                    Text("Source access and cloud sharing still require individual grants. Voice capture requires its separate session consent.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Mac capabilities") {
                    Toggle("Selected screen and app access", isOn: $desktopEnabled)
                    Toggle("Mail, Calendar and Messages", isOn: $appleServicesEnabled)
                    Button("Set up Calendar access…") { Task { await calendarSetup.request() } }
                        .disabled(calendarSetup.isRequesting)
                    Text(calendarSetup.detail).font(.caption).foregroundStyle(.secondary)
                    Toggle("Exact approved terminal commands", isOn: $terminalEnabled)
                    Text("These switches do not grant macOS permissions or approve actions. Terminal commands run with your account's privileges.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Daily preparation") {
                    Toggle("Prepare a daily briefing", isOn: $dailyBriefingEnabled)
                    Picker("Briefing project", selection: $dailyBriefingProjectID) {
                        Text("Choose a project").tag("")
                        ForEach(briefingProjects) { project in
                            Text(project.title).tag(project.focus.projectID ?? "")
                        }
                        if !dailyBriefingProjectID.isEmpty && !briefingProjects.contains(where: { $0.focus.projectID == dailyBriefingProjectID }) {
                            Text("Previously selected project").tag(dailyBriefingProjectID)
                        }
                    }
                    HStack {
                        Stepper("Hour: \(dailyBriefingHour)", value: $dailyBriefingHour, in: 0...23)
                        Stepper("Minute: \(dailyBriefingMinute)", value: $dailyBriefingMinute, in: 0...59)
                    }
                    Text("Prepares once per local day when Jarvis is active, awake and unlocked. Only this project's permitted cloud sources may be used. It creates drafts and proposals; it does not send or execute actions.")
                        .font(.caption).foregroundStyle(.secondary)
                    Text(briefing.status).font(.caption).foregroundStyle(.secondary)
                }
                Section("Companion capabilities") {
                    Toggle("Long-running objectives", isOn: $objectivesEnabled)
                    Toggle("Paired cloud companion", isOn: $cloudEnabled)
                    Toggle("Telegram channel", isOn: $telegramEnabled)
                    Toggle("Selected Google accounts", isOn: $googleEnabled)
                    Toggle("Phone channel", isOn: $phoneEnabled)
                    Text("Each channel needs its own setup and grants. Cloud pairing uses a separate device credential; switching profiles does not move local history or pending actions.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }.formStyle(.grouped).tabItem { Label("General", systemImage: "gearshape") }
            Form {
                Section("Provider credentials") {
                    ForEach(ProviderCredential.allCases) { ProviderCredentialRow(credential: $0) }
                    Text("Credentials are stored in your login Keychain. Existing launcher credentials take precedence. Saving a credential does not prove provider access.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Provider preferences") {
                    TextField("Interactive model (empty uses default)", text: $model)
                    TextField("Deep-work model (empty uses interactive)", text: $deepModel)
                    TextField("ElevenLabs voice ID", text: $voiceID)
                    TextField("Home Assistant HTTPS origin", text: $homeURL)
                }
            }.formStyle(.grouped).tabItem { Label("Providers", systemImage: "key") }
            Form {
                Section("Source-build runtime") {
                    Text("The app starts the prepared runtime recorded when it was built. Only change these paths to trusted local code. A moved checkout must be rebuilt or selected here.")
                        .font(.callout).foregroundStyle(.secondary)
                    TextField("Runtime directory override", text: $runtimeDirectory)
                    TextField("Node 24 executable override", text: $nodeExecutable)
                }
                Section("Isolated analysis workers") {
                    WorkerImagePreferenceView()
                }
                Section("Runtime diagnostics") {
                    Text("Only fixed event codes, service roles and bounded durations are recorded; no transcripts, source IDs, provider responses, or credentials.")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Voice timings measure local stop, first received PCM and first non-silent render callback. Session feedback measures published state, not a displayed frame. Physical audio latency and full-turn performance require Mac testing.")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(diagnostics.entries.suffix(20).reversed()) { event in
                        HStack {
                            Text(event.date, style: .time).monospacedDigit()
                            Text(event.role).foregroundStyle(.secondary)
                            Text(event.code).font(.system(.caption, design: .monospaced))
                            if let milliseconds = event.durationMilliseconds {
                                Text("\(milliseconds, specifier: "%.1f") ms").monospacedDigit().font(.caption)
                            }
                        }
                    }
                }
            }.formStyle(.grouped).tabItem { Label("Diagnostics", systemImage: "stethoscope") }
        }.frame(width: 640, height: 620)
    }

    private var briefingProjects: [AssistantSession] {
        var seen = Set<String>()
        return assistant.sessions.filter { session in
            guard let id = session.focus.projectID, session.title != "Daily brief" else { return false }
            return seen.insert(id).inserted
        }
    }
}

private struct WorkerImagePreferenceView: View {
    @AppStorage("Jarvis.workerImage") private var savedImage = ""
    @State private var draftImage = ""
    @State private var notice = ""
    private var validatedImage: String? { RuntimePreferences.validatedWorkerImage(draftImage) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Immutable worker image ID or registry digest", text: $draftImage)
                .font(.system(.body, design: .monospaced))
            HStack {
                Button("Save image") {
                    guard let image = validatedImage else { return }
                    savedImage = image; draftImage = image
                    notice = "Saved. Restart local services to apply."
                }.disabled(validatedImage == nil)
                Button("Clear image") { savedImage = ""; draftImage = ""; notice = "Cleared. Restart local services to apply." }
                    .disabled(savedImage.isEmpty && draftImage.isEmpty)
            }
            Text("Paste the verified sha256 image ID emitted by scripts/setup-analysis-image.sh, or an image@sha256 registry digest. Saving this setting does not pull or run an image.")
                .font(.caption).foregroundStyle(.secondary)
            if !draftImage.isEmpty && validatedImage == nil {
                Text("Use sha256 followed by 64 lowercase hexadecimal digits, optionally prefixed by a registry image and @. Mutable tags are not accepted.")
                    .font(.caption).foregroundStyle(.orange)
            }
            if ProcessInfo.processInfo.environment["JARVIS_WORKER_IMAGE"] != nil {
                Text("The development launcher's image setting takes precedence over this preference.").font(.caption).foregroundStyle(.secondary)
            } else if !savedImage.isEmpty {
                Text("Saved image: \(savedImage)").font(.caption.monospaced()).textSelection(.enabled)
            }
            if !notice.isEmpty { Text(notice).font(.caption).foregroundStyle(.secondary) }
        }.onAppear { draftImage = savedImage }
    }
}

private struct ProviderCredentialRow: View {
    let credential: ProviderCredential
    @State private var value = ""
    @State private var status = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                SecureField(credential.title, text: $value)
                Button("Save") {
                    do { try ProviderCredentials().save(value, for: credential); value = ""; status = "Saved in Keychain. Restart services to apply." }
                    catch { status = error.localizedDescription }
                }.disabled(value.isEmpty)
                Button("Remove") {
                    do { try ProviderCredentials().remove(credential); value = ""; status = "Removed from Keychain. Restart services to apply." }
                    catch { status = error.localizedDescription }
                }
            }
            if !status.isEmpty { Text(status).font(.caption).foregroundStyle(.secondary) }
        }
    }
}
