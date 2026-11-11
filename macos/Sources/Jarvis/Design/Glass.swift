import SwiftUI

/// Liquid glass for the floating control layer: the sidebar, the composer, lens buttons and toasts.
///
/// On macOS 26 and later the system draws the glass (bend, rim, adaptive fill). Earlier systems get frost: a
/// material with a directional rim and an outer edge line, which has no bend. Content placed on a glass body
/// stays flat; never nest one glass body inside another.
struct JarvisGlass<S: InsettableShape>: ViewModifier {
    let shape: S
    var tint: Color? = nil
    var interactive = false
    var frosted = false
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        if reduceTransparency {
            // Reduce Transparency: an opaque surface with a plain outline, no optics.
            content
                .background(tint ?? theme.panel, in: shape)
                .overlay(shape.strokeBorder(theme.line, lineWidth: contrast == .increased ? 2 : 1))
        } else {
            optics(content)
                .overlay { if contrast == .increased { shape.strokeBorder(theme.text.opacity(0.55), lineWidth: 1) } }
        }
    }

    @ViewBuilder private func optics(_ content: Content) -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            content.glassEffect(systemGlass, in: shape)
        } else {
            frost(content)
        }
        #else
        frost(content)
        #endif
    }

    #if compiler(>=6.2)
    @available(macOS 26.0, *)
    private var systemGlass: Glass {
        var glass = Glass.regular
        if let tint { glass = glass.tint(tint) }
        if interactive { glass = glass.interactive() }
        return glass
    }
    #endif

    /// The pre-macOS 26 body: frost, a key-lit rim (top-left) with a counter-light (bottom-right), an edge line
    /// outside the rim and a soft drop shadow.
    private func frost(_ content: Content) -> some View {
        content
            .background {
                ZStack {
                    shape.fill(frosted ? AnyShapeStyle(.regularMaterial) : AnyShapeStyle(.ultraThinMaterial))
                    if let tint { shape.fill(tint) }
                }
                .shadow(color: theme.shadow, radius: 16, x: 0, y: 8)
            }
            .overlay(shape.strokeBorder(rim, lineWidth: 1))
            .overlay(shape.stroke(Color.black.opacity(theme.isDark ? 0.32 : 0.12), lineWidth: 0.5))
    }

    private var rim: LinearGradient {
        let key = theme.isDark ? 0.68 : 0.96
        let counter = theme.isDark ? 0.35 : 0.56
        return LinearGradient(stops: [
            .init(color: .white.opacity(key), location: 0),
            .init(color: .white.opacity(0.10), location: 0.42),
            .init(color: .white.opacity(0.06), location: 0.58),
            .init(color: .white.opacity(counter), location: 1)
        ], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

extension View {
    /// A floating glass body in `shape`. `tint` adds prominence; `interactive` gives press response on macOS 26.
    func jarvisGlass<S: InsettableShape>(_ shape: S, tint: Color? = nil, interactive: Bool = false,
                                         frosted: Bool = false) -> some View {
        modifier(JarvisGlass(shape: shape, tint: tint, interactive: interactive, frosted: frosted))
    }

    /// The common case: a continuous rounded rectangle.
    func jarvisGlass(cornerRadius: CGFloat, tint: Color? = nil, frosted: Bool = false) -> some View {
        jarvisGlass(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous), tint: tint, frosted: frosted)
    }
}

/// The detailed backdrop the glass floats over: soft colour fields plus thin curved bands, so there is
/// something for the glass to bend. Purely decorative and static.
struct JarvisBackdrop: View {
    @Environment(\.theme) private var theme

    var body: some View {
        ZStack {
            theme.background
            RadialGradient(colors: [theme.accent.opacity(theme.isDark ? 0.26 : 0.16), .clear],
                           center: .topLeading, startRadius: 0, endRadius: 620)
            RadialGradient(colors: [secondary.opacity(theme.isDark ? 0.20 : 0.14), .clear],
                           center: .bottomTrailing, startRadius: 0, endRadius: 720)
            RadialGradient(colors: [theme.accentShadow.opacity(theme.isDark ? 0.14 : 0.08), .clear],
                           center: .bottomLeading, startRadius: 0, endRadius: 460)
            Canvas { context, size in
                // Concentric bands sweeping from the top-left corner: edges for the glass to refract.
                let origin = CGPoint(x: -size.width * 0.08, y: -size.height * 0.2)
                for index in 0..<9 {
                    let radius = 180 + CGFloat(index) * 150
                    var path = Path()
                    path.addArc(center: origin, radius: radius, startAngle: .degrees(0), endAngle: .degrees(100), clockwise: false)
                    let strength = (theme.isDark ? 0.11 : 0.09) * (1 - Double(index) / 11)
                    context.stroke(path, with: .color(theme.accent.opacity(strength)), lineWidth: index.isMultiple(of: 3) ? 22 : 9)
                }
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }

    private var secondary: Color {
        switch theme.mode {
        case .legends: return Color(jarvisHex: 0xB3541E)
        case .dark: return Color(jarvisHex: 0x7B4DFF)
        case .light: return Color(jarvisHex: 0x9B7BFF)
        }
    }
}

/// A short arc of light travelling along `shape` at constant speed. Used on one element per view to show
/// that Jarvis is working or listening. Still under Reduce Motion.
struct BorderBeam<S: Shape>: View {
    var shape: S
    var lap: Double = 3
    var tail: CGFloat = 0.25
    var width: CGFloat = 1.5
    var color: Color = .white
    var bloom: CGFloat = 4
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if !reduceMotion {
            TimelineView(.animation) { context in
                let progress = CGFloat(context.date.timeIntervalSinceReferenceDate / lap)
                let head = progress.truncatingRemainder(dividingBy: 1)
                ZStack {
                    if bloom > 0 { beam(head: head, lineWidth: width * 2).blur(radius: bloom).opacity(0.8) }
                    beam(head: head, lineWidth: width)
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    /// The tail as nested strokes that all end at the head, so opacity builds toward the head with no seams.
    private func beam(head: CGFloat, lineWidth: CGFloat) -> some View {
        Canvas { context, size in
            let path = shape.path(in: CGRect(origin: .zero, size: size).insetBy(dx: width / 2, dy: width / 2))
            let pieces = 16
            func target(_ piece: Int) -> Double { piece < 0 ? 0 : pow(Double(piece + 1) / Double(pieces), 2) }
            for piece in 0..<pieces {
                let alpha = 1 - (1 - target(piece)) / (1 - target(piece - 1))
                for range in Self.wrapped(head - tail * CGFloat(pieces - piece) / CGFloat(pieces), head) {
                    context.stroke(path.trimmedPath(from: range.0, to: range.1), with: .color(color.opacity(alpha)), lineWidth: lineWidth)
                }
            }
        }
    }

    /// Splits [start, end] (start may be below 0) into ranges inside 0...1.
    private static func wrapped(_ start: CGFloat, _ end: CGFloat) -> [(CGFloat, CGFloat)] {
        if end <= 0 { return [(start + 1, end + 1)] }
        if start < 0 { return [(start + 1, 1), (0, end)] }
        return [(start, end)]
    }
}
