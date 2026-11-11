import AppKit
import SwiftUI

/// The colour tokens every Jarvis surface reads from the environment.
///
/// Three looks share one set of names: light and dark follow the system appearance, and Legends mode is a
/// forced-dark look with a gold accent. Views read `@Environment(\.theme)` rather than fixed colours, so
/// switching the mode restyles the whole window without rebuilding any view state.
struct JarvisTheme: Equatable {
    enum Mode: String { case light, dark, legends }

    static let legendsKey = "Jarvis.legendsMode"

    let mode: Mode
    var isLegends: Bool { mode == .legends }
    var isDark: Bool { mode != .light }

    /// Window base, behind everything.
    let background: Color
    /// Flat content surface (cards, message bubbles from Jarvis).
    let panel: Color
    /// A surface raised inside a panel (chips, nested rows).
    let elevated: Color
    /// Darker inset fill for text entry.
    let trough: Color
    /// Hairlines and card outlines.
    let line: Color
    let text: Color
    let muted: Color
    let faint: Color
    /// Solid accent: fills, selected indicators, large glyphs.
    let accent: Color
    /// Accent used for small text and icons on a surface; tuned per mode for contrast.
    let accentText: Color
    /// Label colour on top of a solid accent fill.
    let onAccent: Color
    let warning: Color
    let danger: Color
    let success: Color
    /// The two ends of the accent fill, top to bottom. Equal in the standard modes; a metallic ramp in Legends.
    let accentHighlight: Color
    let accentShadow: Color

    /// Tint fill behind a selected row or an accent chip.
    var accentSoft: Color { accent.opacity(isDark ? 0.16 : 0.12) }
    /// Hover fill for flat rows.
    var hover: Color { isDark ? Color.white.opacity(0.06) : Color.black.opacity(0.045) }
    /// Fill for the solid accent (primary buttons, the send button, user bubbles).
    var accentFill: LinearGradient {
        LinearGradient(colors: [accentHighlight, accent, accentShadow], startPoint: .top, endPoint: .bottom)
    }
    var shadow: Color { Color.black.opacity(isDark ? 0.35 : 0.14) }

    func status(_ status: String) -> Color {
        switch status {
        case "running", "accepted", "active", "starting", "authoring": return accentText
        case "completed", "passed", "measured": return success
        case "failed", "cancel_requested", "interrupted": return danger
        case "waiting", "waiting_question", "paused", "blocked", "unverified", "cancelling": return warning
        default: return muted
        }
    }

    static func resolve(legends: Bool, scheme: ColorScheme) -> JarvisTheme {
        legends ? .legends : (scheme == .dark ? .dark : .light)
    }

    /// Legends mode is always dark, whatever the system appearance; the standard modes follow the system.
    @MainActor static func applyAppearance(legends: Bool) {
        NSApp?.appearance = legends ? NSAppearance(named: .darkAqua) : nil
    }

    @MainActor static func applyStoredAppearance() {
        applyAppearance(legends: UserDefaults.standard.bool(forKey: legendsKey))
    }

    static let light = JarvisTheme(
        mode: .light,
        background: Color(jarvisHex: 0xF3F4F8),
        panel: Color(jarvisHex: 0xFFFFFF),
        elevated: Color(jarvisHex: 0xEEF0F5),
        trough: Color(jarvisHex: 0x1D1D1F, opacity: 0.06),
        line: Color.black.opacity(0.09),
        text: Color(jarvisHex: 0x1D1D1F),
        muted: Color(jarvisHex: 0x1D1D1F, opacity: 0.68),
        faint: Color(jarvisHex: 0x1D1D1F, opacity: 0.45),
        accent: Color(jarvisHex: 0x2B6BFF),
        accentText: Color(jarvisHex: 0x1A4FD6),
        onAccent: .white,
        warning: Color(jarvisHex: 0xA85A00),
        danger: Color(jarvisHex: 0xD6363B),
        success: Color(jarvisHex: 0x1B7F4E),
        accentHighlight: Color(jarvisHex: 0x2B6BFF),
        accentShadow: Color(jarvisHex: 0x2B6BFF))

    static let dark = JarvisTheme(
        mode: .dark,
        background: Color(jarvisHex: 0x0B0E14),
        panel: Color(jarvisHex: 0x141922),
        elevated: Color(jarvisHex: 0x1C232E),
        trough: Color.black.opacity(0.28),
        line: Color.white.opacity(0.09),
        text: Color.white.opacity(0.95),
        muted: Color.white.opacity(0.66),
        faint: Color.white.opacity(0.42),
        accent: Color(jarvisHex: 0x2B6BFF),
        accentText: Color(jarvisHex: 0x9DBBFF),
        onAccent: .white,
        warning: Color(jarvisHex: 0xF7B963),
        danger: Color(jarvisHex: 0xFF6B70),
        success: Color(jarvisHex: 0x6FD3A0),
        accentHighlight: Color(jarvisHex: 0x2B6BFF),
        accentShadow: Color(jarvisHex: 0x2B6BFF))

    /// Warm black with a metallic gold accent. Warning moves to coral so it never reads as the accent.
    static let legends = JarvisTheme(
        mode: .legends,
        background: Color(jarvisHex: 0x090806),
        panel: Color(jarvisHex: 0x14110B),
        elevated: Color(jarvisHex: 0x1D1810),
        trough: Color.black.opacity(0.36),
        line: Color(jarvisHex: 0xE8C15A, opacity: 0.16),
        text: Color(jarvisHex: 0xF8F2E4),
        muted: Color(jarvisHex: 0xF8F2E4, opacity: 0.66),
        faint: Color(jarvisHex: 0xF8F2E4, opacity: 0.42),
        accent: Color(jarvisHex: 0xE6BC52),
        accentText: Color(jarvisHex: 0xF2D27C),
        onAccent: Color(jarvisHex: 0x1A1203),
        warning: Color(jarvisHex: 0xFF9E66),
        danger: Color(jarvisHex: 0xFF6B6B),
        success: Color(jarvisHex: 0x86D9A8),
        accentHighlight: Color(jarvisHex: 0xFBE7A1),
        accentShadow: Color(jarvisHex: 0xB8842A))
}

extension Color {
    init(jarvisHex hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: opacity)
    }
}

private struct JarvisThemeKey: EnvironmentKey {
    /// Used only where no themed root is above a view: follow the stored mode and the system appearance.
    static var defaultValue: JarvisTheme {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: JarvisTheme.legendsKey) { return .legends }
        return defaults.string(forKey: "AppleInterfaceStyle") == "Dark" ? .dark : .light
    }
}

extension EnvironmentValues {
    var theme: JarvisTheme {
        get { self[JarvisThemeKey.self] }
        set { self[JarvisThemeKey.self] = newValue }
    }
}

/// Resolves the theme for a window, sheet or panel root and publishes it to everything inside.
private struct JarvisThemeRoot: ViewModifier {
    @AppStorage(JarvisTheme.legendsKey) private var legends = false
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let theme = JarvisTheme.resolve(legends: legends, scheme: scheme)
        content
            .environment(\.theme, theme)
            .tint(theme.accent)
            .foregroundStyle(theme.text)
            .onAppear { JarvisTheme.applyAppearance(legends: legends) }
            .onChange(of: legends) { _, enabled in JarvisTheme.applyAppearance(legends: enabled) }
    }
}

extension View {
    /// Apply at the root of every scene, sheet and popover so its content sees the current theme.
    func jarvisThemed() -> some View { modifier(JarvisThemeRoot()) }

    /// Themed root plus the Jarvis capsule as the default button look. Buttons that set their own style keep it.
    func jarvisWorkspaceRoot() -> some View { buttonStyle(.jarvisSecondary).jarvisThemed() }
}
