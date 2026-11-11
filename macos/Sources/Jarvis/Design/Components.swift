import SwiftUI

// MARK: - Buttons

/// Capsule buttons. One `primary` per group; everything beside it is `secondary` or `ghost`.
/// A button with the destructive role is drawn as `danger` unless it is the primary.
struct JarvisButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, danger, ghost }
    var kind: Kind = .secondary
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        JarvisButtonBody(configuration: configuration, kind: kind, compact: compact)
    }
}

private struct JarvisButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let kind: JarvisButtonStyle.Kind
    let compact: Bool
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    private var resolved: JarvisButtonStyle.Kind {
        configuration.role == .destructive && kind != .primary ? .danger : kind
    }

    var body: some View {
        configuration.label
            .font(.system(size: compact ? 12 : 13, weight: .semibold))
            .multilineTextAlignment(.leading)
            .padding(.horizontal, compact ? 11 : 15)
            .padding(.vertical, compact ? 5 : 7)
            .foregroundStyle(foreground)
            .background(fill, in: Capsule())
            .overlay(Capsule().strokeBorder(border, lineWidth: 1))
            .contentShape(Capsule())
            .brightness(hovering && isEnabled ? (theme.isDark ? 0.07 : -0.04) : 0)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(isEnabled ? 1 : 0.42)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
            .animation(.easeOut(duration: 0.12), value: hovering)
            .onHover { hovering = $0 }
    }

    private var foreground: Color {
        switch resolved {
        case .primary: return theme.onAccent
        case .secondary: return theme.text
        case .danger: return theme.danger
        case .ghost: return theme.accentText
        }
    }

    private var fill: AnyShapeStyle {
        switch resolved {
        case .primary: return AnyShapeStyle(theme.accentFill)
        case .secondary: return AnyShapeStyle(theme.elevated)
        case .danger: return AnyShapeStyle(theme.danger.opacity(theme.isDark ? 0.16 : 0.10))
        case .ghost: return AnyShapeStyle(hovering ? theme.accentSoft : Color.clear)
        }
    }

    private var border: Color {
        switch resolved {
        case .primary: return theme.isLegends ? theme.accentHighlight.opacity(0.55) : Color.clear
        case .secondary: return theme.line
        case .danger: return theme.danger.opacity(0.28)
        case .ghost: return Color.clear
        }
    }
}

extension ButtonStyle where Self == JarvisButtonStyle {
    /// The one solid-accent action in a group.
    static var jarvisPrimary: JarvisButtonStyle { JarvisButtonStyle(kind: .primary) }
    static var jarvisSecondary: JarvisButtonStyle { JarvisButtonStyle(kind: .secondary) }
    static var jarvisDanger: JarvisButtonStyle { JarvisButtonStyle(kind: .danger) }
    /// Text-only action in the accent colour.
    static var jarvisGhost: JarvisButtonStyle { JarvisButtonStyle(kind: .ghost) }
    static var jarvisCompact: JarvisButtonStyle { JarvisButtonStyle(kind: .secondary, compact: true) }
    static var jarvisCompactPrimary: JarvisButtonStyle { JarvisButtonStyle(kind: .primary, compact: true) }
}

/// A round icon button with a hover fill. Pass `active` for a toggled-on state.
struct JarvisIconButtonStyle: ButtonStyle {
    var size: CGFloat = 30
    var active = false
    var tint: Color? = nil

    func makeBody(configuration: Configuration) -> some View {
        JarvisIconButtonBody(configuration: configuration, size: size, active: active, tint: tint)
    }
}

private struct JarvisIconButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let size: CGFloat
    let active: Bool
    let tint: Color?
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    var body: some View {
        configuration.label
            .font(.system(size: size * 0.46, weight: .medium))
            .foregroundStyle(tint ?? (active ? theme.accentText : theme.muted))
            .frame(width: size, height: size)
            .background(active ? theme.accentSoft : (hovering && isEnabled ? theme.hover : Color.clear), in: Circle())
            .contentShape(Circle())
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .opacity(isEnabled ? 1 : 0.4)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
            .onHover { hovering = $0 }
    }
}

extension ButtonStyle where Self == JarvisIconButtonStyle {
    static var jarvisIcon: JarvisIconButtonStyle { JarvisIconButtonStyle() }
}

/// A full-width row button: hover fill, optional selected tint pill. Used for lists of choices.
struct JarvisRowButtonStyle: ButtonStyle {
    var selected = false
    var cornerRadius: CGFloat = 10

    func makeBody(configuration: Configuration) -> some View {
        JarvisRowButtonBody(configuration: configuration, selected: selected, cornerRadius: cornerRadius)
    }
}

private struct JarvisRowButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let selected: Bool
    let cornerRadius: CGFloat
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    var body: some View {
        configuration.label
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? theme.accentSoft : (hovering && isEnabled ? theme.hover : Color.clear),
                        in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
            .onHover { hovering = $0 }
    }
}

// MARK: - Surfaces

enum JarvisSurfaceTone { case panel, elevated, warning, danger, accent }

private struct JarvisSurface: ViewModifier {
    let tone: JarvisSurfaceTone
    let radius: CGFloat
    @Environment(\.theme) private var theme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background(fill, in: shape)
            .overlay(shape.strokeBorder(stroke, lineWidth: 1))
    }

    private var fill: Color {
        switch tone {
        case .panel: return theme.panel
        case .elevated: return theme.elevated
        case .warning: return theme.warning.opacity(theme.isDark ? 0.09 : 0.08)
        case .danger: return theme.danger.opacity(theme.isDark ? 0.09 : 0.07)
        case .accent: return theme.accentSoft
        }
    }

    private var stroke: Color {
        switch tone {
        case .panel, .elevated: return theme.line
        case .warning: return theme.warning.opacity(0.32)
        case .danger: return theme.danger.opacity(0.30)
        case .accent: return theme.accent.opacity(0.35)
        }
    }
}

extension View {
    /// A flat content surface: fill plus hairline. Content cards are flat; glass is for the floating controls.
    func jarvisSurface(_ tone: JarvisSurfaceTone = .panel, radius: CGFloat = 14) -> some View {
        modifier(JarvisSurface(tone: tone, radius: radius))
    }

    /// Padding plus a flat surface, filling the available width.
    func jarvisCard(_ tone: JarvisSurfaceTone = .panel, padding: CGFloat = 18, radius: CGFloat = 16) -> some View {
        self.padding(padding).frame(maxWidth: .infinity, alignment: .leading).jarvisSurface(tone, radius: radius)
    }
}

/// A darker inset field background for text entry.
private struct JarvisField: ViewModifier {
    let focused: Bool
    @Environment(\.theme) private var theme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        content
            .textFieldStyle(.plain)
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(theme.trough, in: shape)
            .overlay(shape.strokeBorder(focused ? theme.accent : theme.line, lineWidth: focused ? 2 : 1))
    }
}

extension View {
    func jarvisField(focused: Bool = false) -> some View { modifier(JarvisField(focused: focused)) }
}

// MARK: - Small pieces

/// A coloured dot and label in a capsule. Colour comes from the status name unless given.
struct StatusPill: View {
    let label: String
    var status: String? = nil
    var color: Color? = nil
    var working = false
    @Environment(\.theme) private var theme

    var body: some View {
        let tone = color ?? theme.status(status ?? label.lowercased())
        HStack(spacing: 6) {
            if working { ProgressView().controlSize(.mini) }
            else { Circle().fill(tone).frame(width: 6, height: 6) }
            Text(label).font(.system(size: 11, weight: .medium)).lineLimit(1)
        }
        .foregroundStyle(tone)
        .padding(.horizontal, 9).padding(.vertical, 4)
        .background(tone.opacity(0.12), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Status: \(label)")
    }
}

/// A small numeric badge for items that need attention.
struct CountBadge: View {
    let count: Int
    var tone: Color? = nil
    @Environment(\.theme) private var theme

    var body: some View {
        Text("\(count)")
            .font(.system(size: 11, weight: .semibold)).monospacedDigit()
            .foregroundStyle(tone ?? theme.warning)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background((tone ?? theme.warning).opacity(0.16), in: Capsule())
    }
}

/// A sentence-case section title with an optional supporting line.
struct SectionHeader: View {
    let title: String
    var detail: String? = nil
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(theme.muted)
            if let detail { Text(detail).font(.system(size: 12)).foregroundStyle(theme.faint) }
        }
    }
}

/// A keyboard shortcut hint, such as ⌘K.
struct KeyHint: View {
    let keys: String
    @Environment(\.theme) private var theme

    var body: some View {
        Text(keys)
            .font(.system(size: 11, weight: .medium, design: .rounded))
            .foregroundStyle(theme.faint)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(theme.hover, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// An inline message strip. Give it `onDismiss` when the reader can clear it.
struct NoticeBanner: View {
    enum Tone { case info, warning, danger }
    let message: String
    var icon: String = "exclamationmark.triangle"
    var tone: Tone = .warning
    var working = false
    var onDismiss: (() -> Void)? = nil
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            if working { ProgressView().controlSize(.small) }
            else { Image(systemName: icon).foregroundStyle(color) }
            Text(message).font(.system(size: 12)).foregroundStyle(theme.text).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let onDismiss {
                Button(action: onDismiss) { Image(systemName: "xmark") }
                    .buttonStyle(JarvisIconButtonStyle(size: 22))
                    .accessibilityLabel("Dismiss")
                    .help("Dismiss")
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(color.opacity(theme.isDark ? 0.10 : 0.09), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(color.opacity(0.28), lineWidth: 1))
    }

    private var color: Color {
        switch tone {
        case .info: return theme.accentText
        case .warning: return theme.warning
        case .danger: return theme.danger
        }
    }
}

/// A centred empty state with one optional action.
struct EmptyStateView<Actions: View>: View {
    let icon: String
    let title: String
    let detail: String
    @ViewBuilder var actions: () -> Actions
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 30, weight: .light)).foregroundStyle(theme.accentText)
            Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(theme.text)
            Text(detail).font(.system(size: 13)).foregroundStyle(theme.muted)
                .multilineTextAlignment(.center).lineSpacing(3).frame(maxWidth: 420)
            actions().padding(.top, 4)
        }
        .padding(28)
        .frame(maxWidth: .infinity)
    }
}

extension EmptyStateView where Actions == EmptyView {
    init(icon: String, title: String, detail: String) {
        self.init(icon: icon, title: title, detail: detail, actions: { EmptyView() })
    }
}

/// The large page heading used at the top of each workspace page.
struct PageHeader<Trailing: View>: View {
    let title: String
    var subtitle: String? = nil
    @ViewBuilder var trailing: () -> Trailing
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.system(size: 26, weight: .semibold)).foregroundStyle(theme.text)
                if let subtitle {
                    Text(subtitle).font(.system(size: 14)).foregroundStyle(theme.muted).lineSpacing(3)
                }
            }
            Spacer(minLength: 12)
            trailing()
        }
    }
}

extension PageHeader where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil) {
        self.init(title: title, subtitle: subtitle, trailing: { EmptyView() })
    }
}

// MARK: - Orb

/// The Jarvis mark. It breathes while listening or working and wears a turning metal rim in Legends mode.
struct JarvisOrb: View {
    var size: CGFloat = 120
    var listening = false
    var working = false
    var connected = true
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    private var active: Bool { listening || working }

    var body: some View {
        ZStack {
            Circle().fill(RadialGradient(colors: [theme.accent.opacity(0.30), theme.accent.opacity(0.04), .clear],
                                         center: .center, startRadius: 0, endRadius: size * 0.62))
                .frame(width: size * 1.24, height: size * 1.24)
            Circle().fill(RadialGradient(colors: [theme.elevated, theme.background],
                                         center: .topLeading, startRadius: 0, endRadius: size))
                .frame(width: size * 0.74, height: size * 0.74)
            rim.frame(width: size * 0.74, height: size * 0.74)
            Image(systemName: listening ? "waveform" : "sparkle")
                .font(.system(size: size * 0.24, weight: .light))
                .foregroundStyle(theme.accentText)
        }
        .frame(width: size * 1.24, height: size * 1.24)
        .opacity(connected ? 1 : 0.45)
        .scaleEffect(pulse && active && !reduceMotion ? 1.04 : 1)
        .animation(reduceMotion || !active ? .default : .easeInOut(duration: 1.6).repeatForever(autoreverses: true), value: pulse)
        .animation(.easeInOut(duration: 0.3), value: active)
        .onAppear { pulse = true }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(listening ? "Listening" : working ? "Working" : connected ? "Ready" : "Disconnected")
    }

    @ViewBuilder private var rim: some View {
        if theme.isLegends {
            LegendsMetalRing(lineWidth: max(2, size * 0.028), turning: true)
        } else {
            Circle().strokeBorder(AngularGradient(colors: [theme.accent.opacity(0.2), theme.accent, theme.accent.opacity(0.25)],
                                                  center: .center), lineWidth: max(1.5, size * 0.018))
        }
    }
}

/// A polished gold rim: the one metal element in a view. It turns slowly, and holds still under Reduce Motion.
struct LegendsMetalRing: View {
    var lineWidth: CGFloat = 3
    var turning = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if turning && !reduceMotion {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                ring(angle: context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 12) * 30)
            }
        } else {
            ring(angle: 200)
        }
    }

    private func ring(angle: Double) -> some View {
        Circle().strokeBorder(AngularGradient(stops: [
            .init(color: Color(jarvisHex: 0x3A2806), location: 0.00),
            .init(color: Color(jarvisHex: 0xFFF3C4), location: 0.10),
            .init(color: Color(jarvisHex: 0xC9962E), location: 0.30),
            .init(color: Color(jarvisHex: 0xFFFBE6), location: 0.45),
            .init(color: Color(jarvisHex: 0x6B4A0E), location: 0.55),
            .init(color: Color(jarvisHex: 0xF0CF73), location: 0.70),
            .init(color: Color(jarvisHex: 0x3A2806), location: 0.81),
            .init(color: Color(jarvisHex: 0xFFF3C4), location: 0.92),
            .init(color: Color(jarvisHex: 0x3A2806), location: 1.00)
        ], center: .center, angle: .degrees(angle)), lineWidth: lineWidth)
    }
}

// MARK: - Legends mode

/// A compact switch whose track turns gold when on.
struct LegendsSwitchStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        LegendsSwitchBody(configuration: configuration)
    }
}

private struct LegendsSwitchBody: View {
    let configuration: ToggleStyleConfiguration
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) { configuration.isOn.toggle() }
        } label: {
            HStack(spacing: 10) {
                configuration.label
                Spacer(minLength: 8)
                ZStack(alignment: configuration.isOn ? .trailing : .leading) {
                    Capsule().fill(configuration.isOn ? AnyShapeStyle(JarvisTheme.legends.accentFill) : AnyShapeStyle(theme.trough))
                        .overlay(Capsule().strokeBorder(configuration.isOn ? JarvisTheme.legends.accentHighlight.opacity(0.6) : theme.line, lineWidth: 1))
                    Circle().fill(configuration.isOn ? Color(jarvisHex: 0x1A1203) : Color.white)
                        .shadow(color: .black.opacity(0.25), radius: 1.5, y: 1)
                        .padding(2.5)
                }
                .frame(width: 38, height: 22)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(configuration.isOn ? "On" : "Off")
    }
}

/// The Legends mode switch, the same control wherever it appears.
struct LegendsModeToggle: View {
    @AppStorage(JarvisTheme.legendsKey) private var legends = false
    @Environment(\.theme) private var theme

    var body: some View {
        Toggle(isOn: $legends) {
            HStack(spacing: 9) {
                Image(systemName: legends ? "crown.fill" : "crown")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(legends ? theme.accentText : theme.muted)
                    .frame(width: 18)
                Text("Legends mode").font(.system(size: 13, weight: .medium)).foregroundStyle(theme.text)
            }
        }
        .toggleStyle(LegendsSwitchStyle())
        .help("Switch everything to dark with a gold accent (⇧⌘L)")
    }
}

// MARK: - Helpers

enum JarvisFormat {
    /// "5 min ago", "Yesterday": a short relative time for an ISO 8601 timestamp, or nil when unparseable.
    static func relative(_ iso: String, now: Date = Date()) -> String? {
        guard let date = RoomsStateRules.date(iso) else { return nil }
        if now.timeIntervalSince(date) < 60 { return "Just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: now)
    }
}
