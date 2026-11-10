import SwiftUI

/// Buttons in Jarvis's own style. `primary` is the one thing a screen most wants done.
struct JarvisButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, quiet, destructive }
    var kind: Kind = .secondary

    func makeBody(configuration: Configuration) -> some View {
        JarvisButtonBody(kind: kind, pressed: configuration.isPressed) { configuration.label }
    }
}

/// A view, so that it can read whether the button is enabled from the environment.
private struct JarvisButtonBody<Label: View>: View {
    let kind: JarvisButtonStyle.Kind
    let pressed: Bool
    @ViewBuilder var label: () -> Label
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        label()
            .font(.system(size: JarvisTheme.TextSize.label, weight: .medium))
            .lineLimit(1)
            .padding(.horizontal, kind == .quiet ? JarvisTheme.Space.s : 14).padding(.vertical, 7)
            .foregroundStyle(foreground)
            .background(background, in: RoundedRectangle(cornerRadius: JarvisTheme.Radius.control))
            .overlay(RoundedRectangle(cornerRadius: JarvisTheme.Radius.control).stroke(border, lineWidth: 1))
            .opacity(isEnabled ? 1 : 0.42)
            .contentShape(RoundedRectangle(cornerRadius: JarvisTheme.Radius.control))
    }

    private var foreground: Color {
        switch kind {
        case .primary: return JarvisTheme.Colors.onAccent
        case .secondary: return JarvisTheme.Colors.text.opacity(0.92)
        case .quiet: return JarvisTheme.Colors.accent
        case .destructive: return JarvisTheme.Colors.danger
        }
    }

    private var background: Color {
        switch kind {
        case .primary: return JarvisTheme.Colors.accent.opacity(pressed ? 0.78 : 1)
        case .secondary: return Color.white.opacity(pressed ? 0.16 : 0.08)
        case .quiet: return pressed ? JarvisTheme.Colors.accent.opacity(0.12) : Color.clear
        case .destructive: return JarvisTheme.Colors.danger.opacity(pressed ? 0.22 : 0.10)
        }
    }

    private var border: Color {
        switch kind {
        case .primary, .quiet: return Color.clear
        case .secondary: return JarvisTheme.Colors.line
        case .destructive: return JarvisTheme.Colors.danger.opacity(0.35)
        }
    }
}

extension ButtonStyle where Self == JarvisButtonStyle {
    static var jarvis: JarvisButtonStyle { JarvisButtonStyle() }
    static func jarvis(_ kind: JarvisButtonStyle.Kind) -> JarvisButtonStyle { JarvisButtonStyle(kind: kind) }
}

/// A rounded surface that groups related content.
struct JarvisCard<Content: View>: View {
    var padding: CGFloat = JarvisTheme.Space.l
    var tint: Color? = nil
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: JarvisTheme.Space.m) { content() }
            .padding(padding).frame(maxWidth: .infinity, alignment: .leading)
            .background((tint ?? .white).opacity(tint == nil ? 0.04 : 0.07), in: RoundedRectangle(cornerRadius: JarvisTheme.Radius.card))
            .overlay(RoundedRectangle(cornerRadius: JarvisTheme.Radius.card).stroke((tint ?? .white).opacity(tint == nil ? 0.08 : 0.28), lineWidth: 1))
    }
}

/// How one line of a readiness checklist stands.
enum JarvisCheckState: Equatable {
    case done, working, needed, optional, failed
    var symbol: String {
        switch self {
        case .done: return "checkmark.circle.fill"
        case .working: return "circle.dotted"
        case .needed: return "exclamationmark.circle.fill"
        case .optional: return "circle"
        case .failed: return "xmark.octagon.fill"
        }
    }
    var color: Color {
        switch self {
        case .done: return JarvisTheme.Colors.success
        case .working: return JarvisTheme.Colors.accent
        case .needed: return JarvisTheme.Colors.warning
        case .optional: return JarvisTheme.Colors.muted
        case .failed: return JarvisTheme.Colors.danger
        }
    }
    var spoken: String {
        switch self {
        case .done: return "done"
        case .working: return "in progress"
        case .needed: return "needs your attention"
        case .optional: return "optional"
        case .failed: return "failed"
        }
    }
}

/// One line of a readiness checklist: what it is, how it stands, and what to do about it.
struct JarvisCheckRow<Accessory: View>: View {
    let state: JarvisCheckState
    let title: String
    let detail: String
    @ViewBuilder var accessory: () -> Accessory

    var body: some View {
        HStack(alignment: .top, spacing: JarvisTheme.Space.m) {
            Group {
                if state == .working { ProgressView().controlSize(.small) }
                else { Image(systemName: state.symbol).font(.system(size: 17)).foregroundStyle(state.color) }
            }.frame(width: 22, height: 22).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: JarvisTheme.Space.xs) {
                Text(title).font(.system(size: JarvisTheme.TextSize.heading, weight: .medium)).foregroundStyle(JarvisTheme.Colors.text)
                Text(detail).font(.system(size: JarvisTheme.TextSize.label)).foregroundStyle(JarvisTheme.Colors.muted)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                accessory()
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(title), \(state.spoken)")
    }
}

extension JarvisCheckRow where Accessory == EmptyView {
    init(state: JarvisCheckState, title: String, detail: String) {
        self.init(state: state, title: title, detail: detail, accessory: { EmptyView() })
    }
}
