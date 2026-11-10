import AppKit
import SwiftUI

/// What, if anything, stands between the person and a working assistant right now.
struct ReadinessNotice: Equatable {
    enum Kind: Equatable { case working, failed, needsKey }
    let kind: Kind
    let title: String
    let message: String
    var log: [String] = []

    /// `providerConfigured` is nil when it is not known, for example before the services first answer.
    static func current(state: RuntimeSupervisor.State, detail: String, failureLog: [String] = [],
                        providerConfigured: Bool?) -> ReadinessNotice? {
        switch state {
        case .ready:
            guard providerConfigured == false else { return nil }
            return ReadinessNotice(kind: .needsKey, title: "Jarvis needs a model key to think",
                message: "Everything on this Mac is running. Add a Vercel AI Gateway key and Jarvis can answer.")
        case .idle, .starting:
            return ReadinessNotice(kind: .working, title: "Starting Jarvis",
                                   message: state == .idle ? "Starting your local assistant…" : detail)
        case .stopping:
            return ReadinessNotice(kind: .working, title: "Stopping", message: detail)
        case .stopped:
            return ReadinessNotice(kind: .failed, title: "Jarvis is not running", message: detail)
        case .failed:
            return ReadinessNotice(kind: .failed, title: "Jarvis could not start", message: detail, log: failureLog)
        }
    }
}

/// Always-visible strip above the workspace whenever Jarvis cannot yet do its job, with the action that fixes it.
struct ReadinessBanner: View {
    let notice: ReadinessNotice
    var addKey: () -> Void = {}
    var retry: () -> Void = {}
    var diagnostics: () -> String = { "" }
    @State private var showingOutput = false
    @State private var copied = false

    private var tint: Color { notice.kind == .failed ? RoomsPalette.red : notice.kind == .needsKey ? RoomsPalette.amber : RoomsPalette.cyan }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                if notice.kind == .working {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: notice.kind == .needsKey ? "key.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(tint).accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(notice.title).font(.callout.weight(.semibold)).foregroundStyle(.white)
                    Text(notice.message).font(.callout).foregroundStyle(RoomsPalette.muted)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
                Spacer(minLength: 12)
                if notice.kind == .needsKey {
                    Button("Add key…", action: addKey).buttonStyle(.jarvis(.primary))
                }
                if notice.kind == .failed {
                    if !notice.log.isEmpty {
                        Button(showingOutput ? "Hide details" : "Show details") { showingOutput.toggle() }
                    }
                    Button(copied ? "Copied" : "Copy diagnostics") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(diagnostics(), forType: .string)
                        copied = true
                    }
                    SettingsLink { Text("Settings…") }
                    Button("Retry", action: retry).buttonStyle(.jarvis(.primary))
                }
            }
            if showingOutput && !notice.log.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(notice.log.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.system(.caption, design: .monospaced)).foregroundStyle(.white.opacity(0.85))
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityLabel("Last output from the service that failed")
            }
        }
        .buttonStyle(.jarvis)
        .padding(.horizontal, 18).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.08))
        .overlay(alignment: .bottom) { Rectangle().fill(tint.opacity(0.35)).frame(height: 1) }
        .accessibilityElement(children: .contain)
    }
}
