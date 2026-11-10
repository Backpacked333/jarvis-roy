import SwiftUI

/// The Stop-all banner (overlay O7). It says what is known and nothing more: a stop is "requested" until the
/// service confirms it, and it never claims that completed actions were undone.
struct StopAllBanner: View {
    let phase: StopAllPhase
    var retry: () -> Void
    var dismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            icon
            Text(Self.message(phase)).font(JV.F.hud(10)).tracking(2).foregroundStyle(tint).lineLimit(1)
            Spacer(minLength: 8)
            switch phase {
            case .confirmed: Button("Dismiss", action: dismiss).buttonStyle(.hud(.ghost))
            case .unconfirmed: Button { retry() } label: { HStack(spacing: 8) { Text("Retry"); Keycap(label: "⌘.", color: JV.C.red) } }.buttonStyle(.hud(.danger))
            default: EmptyView()
            }
        }
        .padding(.horizontal, 14).frame(height: 44)
        .background(background)
        .overlay(Rectangle().stroke(tint.opacity(phase == .confirmed ? 0.35 : 0.55), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Self.message(phase).capitalized)
    }

    private var tint: Color { phase == .confirmed ? JV.C.cyan : JV.C.red }

    @ViewBuilder private var icon: some View {
        switch phase {
        case .confirmed: Image(systemName: "checkmark.circle").foregroundStyle(JV.C.cyan)
        case .unconfirmed: Image(systemName: "exclamationmark.octagon").foregroundStyle(JV.C.red)
        default: ProgressView().controlSize(.small).tint(JV.C.red)
        }
    }

    @ViewBuilder private var background: some View {
        switch phase {
        case .confirmed: Color(red: 6 / 255, green: 16 / 255, blue: 20 / 255).opacity(0.8)
        case .unconfirmed: Color(red: 60 / 255, green: 10 / 255, blue: 12 / 255).opacity(0.7)
        default: ZStack { Color(red: 40 / 255, green: 8 / 255, blue: 10 / 255).opacity(0.6); HazardStripes(color: JV.C.red.opacity(0.10)) }
        }
    }

    /// The handoff's exact wording for each state.
    nonisolated static func message(_ phase: StopAllPhase) -> String {
        switch phase {
        case .idle: return ""
        case .muting, .requesting: return "STOPPING · VOICE MUTED · REQUEST SENT"
        case .confirmed: return "STOPPED · COMPLETED ACTIONS CAN’T BE UNDONE"
        case .unconfirmed(let pending): return "NOT CONFIRMED · \(pending) \(pending == 1 ? "ITEM" : "ITEMS") MAY STILL BE ACTIVE"
        }
    }
}
