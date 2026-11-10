import SwiftUI

// Reference implementations of the HUD primitives. Visual values are exact; wire data from the
// existing models (AppModel, RoomsModel, AssistantModel, VoiceController). Do not add behavior here
// that bypasses runtime approval: buttons only call existing model actions.

// MARK: - Screen chrome

/// Full-window HUD chrome: grid background, rulers, corner marks, vignette, optional scanlines, ticker.
struct HUDScreen<Content: View>: View {
    var tickerText: String
    var scanlines = true
    @ViewBuilder var content: () -> Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .topLeading) {
            HUDBackground()
            content().padding(.top, JV.S.ruler).padding(.bottom, JV.S.tickerHeight)
            RulerTop().frame(height: JV.S.ruler)
            RulerLeft().frame(width: JV.S.ruler).padding(.top, JV.S.ruler).padding(.bottom, JV.S.tickerHeight)
            CornerMarks().padding(EdgeInsets(top: 22, leading: 22, bottom: 28, trailing: 8)).allowsHitTesting(false)
            RadialGradient(colors: [.clear, .black.opacity(0.5)], center: .center, startRadius: 400, endRadius: 900)
                .allowsHitTesting(false)
            if scanlines { Scanlines().allowsHitTesting(false) }
            VStack { Spacer(); Ticker(text: tickerText, animated: !reduceMotion) }
        }
        .background(JV.C.void)
        .preferredColorScheme(.dark)
    }
}

struct HUDBackground: View {
    var body: some View {
        Canvas { ctx, size in
            // 20pt dot grid at 6% + 100pt line grid at 3.5%
            let dot = JV.C.cyan.opacity(0.06), line = JV.C.cyan.opacity(0.035)
            stride(from: 0.0, through: size.width, by: 20).forEach { x in
                stride(from: 0.0, through: size.height, by: 20).forEach { y in
                    ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.3, height: 1.3)), with: .color(dot))
                }
            }
            stride(from: 0.0, through: size.width, by: 100).forEach { x in ctx.fill(Path(CGRect(x: x, y: 0, width: 1, height: size.height)), with: .color(line)) }
            stride(from: 0.0, through: size.height, by: 100).forEach { y in ctx.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 1)), with: .color(line)) }
        }
        .background(RadialGradient(colors: [JV.C.cyan.opacity(0.14), .clear], center: UnitPoint(x: 0.5, y: 0.42), startRadius: 0, endRadius: 560))
    }
}

struct RulerTop: View {
    var body: some View {
        Canvas { ctx, size in
            for i in stride(from: 0, through: Int(size.width), by: 10) {
                let len: CGFloat = i % 100 == 0 ? 9 : i % 50 == 0 ? 6 : 3
                ctx.fill(Path(CGRect(x: CGFloat(i), y: 14 - len, width: 1, height: len)), with: .color(JV.C.cyan.opacity(i % 100 == 0 ? 0.6 : 0.28)))
                if i % 100 == 0 && i > 0 {
                    ctx.draw(Text("\(i)").font(JV.F.mono(7)).foregroundColor(JV.C.text3), at: CGPoint(x: CGFloat(i) + 3, y: 5), anchor: .leading)
                }
            }
        }
        .background(Color(red: 2/255, green: 6/255, blue: 9/255).opacity(0.7))
        .overlay(alignment: .bottom) { Rectangle().fill(JV.C.lineSubtle).frame(height: 1) }
    }
}

struct RulerLeft: View {
    var body: some View {
        Canvas { ctx, size in
            for i in stride(from: 0, through: Int(size.height), by: 10) {
                let len: CGFloat = i % 100 == 0 ? 9 : i % 50 == 0 ? 6 : 3
                ctx.fill(Path(CGRect(x: 14 - len, y: CGFloat(i), width: len, height: 1)), with: .color(JV.C.cyan.opacity(i % 100 == 0 ? 0.6 : 0.28)))
            }
        }
        .background(Color(red: 2/255, green: 6/255, blue: 9/255).opacity(0.7))
        .overlay(alignment: .trailing) { Rectangle().fill(JV.C.lineSubtle).frame(width: 1) }
    }
}

struct CornerMarks: View {
    var size: CGFloat = 16, color: Color = JV.C.cyan, stroke: CGFloat = 1
    var body: some View {
        GeometryReader { g in
            Path { p in
                let w = g.size.width, h = g.size.height
                p.move(to: .init(x: 0, y: size)); p.addLine(to: .zero); p.addLine(to: .init(x: size, y: 0))
                p.move(to: .init(x: w - size, y: 0)); p.addLine(to: .init(x: w, y: 0)); p.addLine(to: .init(x: w, y: size))
                p.move(to: .init(x: 0, y: h - size)); p.addLine(to: .init(x: 0, y: h)); p.addLine(to: .init(x: size, y: h))
                p.move(to: .init(x: w - size, y: h)); p.addLine(to: .init(x: w, y: h)); p.addLine(to: .init(x: w, y: h - size))
            }.stroke(color, lineWidth: stroke)
        }
    }
}

struct Scanlines: View {
    var body: some View {
        Canvas { ctx, size in
            stride(from: 0.0, through: size.height, by: 3).forEach { y in ctx.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 1)), with: .color(.white.opacity(0.02))) }
        }
    }
}

// MARK: - Panel

/// Glass panel with TL/BR corner accents and numbered header. Square corners — never rounded.
struct HUDPanel<Content: View>: View {
    var index: String
    var title: String
    var meta: String? = nil
    var metaLED: StatusLED.State? = nil
    var emphasis = false                     // command bar: stronger border + outer glow
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text(index).jvText(JV.F.index, JV.C.textIndex)
                Text(title).jvText(JV.F.panelTitle, JV.C.cyan, uppercase: true)
                Spacer(minLength: 0)
                if let meta {
                    HStack(spacing: 5) {
                        if let metaLED { StatusLED(state: metaLED, size: 5) }
                        Text(meta).jvText((JV.F.hud(8.5, .medium), 2), JV.C.text2, uppercase: true)
                    }
                }
            }
            .padding(.bottom, 10)
            .overlay(alignment: .bottom) {
                ZStack(alignment: .leading) {
                    Rectangle().fill(JV.C.lineSubtle).frame(height: 1)
                    Rectangle().fill(JV.C.cyan).frame(width: 32, height: 1).shadow(color: JV.C.cyan, radius: 3)
                }
            }
            .padding(.bottom, 12)
            content()
        }
        .padding(JV.S.panelPadding)
        .background(
            LinearGradient(colors: [JV.C.glassTop, JV.C.glassBottom], startPoint: .top, endPoint: .bottom)
                .background(.ultraThinMaterial.opacity(0.35))
        )
        .overlay(Rectangle().stroke(emphasis ? JV.C.lineStrong : JV.C.line, lineWidth: 1))
        .overlay(alignment: .top) { Rectangle().fill(JV.C.cyan200.opacity(0.07)).frame(height: 1).padding(.horizontal, 1) }
        .overlay(CornerAccents())
        .shadow(color: emphasis ? JV.C.cyan.opacity(0.08) : .black.opacity(0.35), radius: emphasis ? 40 : 30, y: emphasis ? 0 : 24)
    }
}

/// 12×12, 1.5pt accents at top-leading and bottom-trailing, offset −1 so they sit on the border.
struct CornerAccents: View {
    var color: Color = JV.C.cyan, length: CGFloat = JV.S.cornerAccent, stroke: CGFloat = JV.S.cornerAccentStroke
    var body: some View {
        GeometryReader { g in
            Path { p in
                p.move(to: .init(x: -1, y: length - 1)); p.addLine(to: .init(x: -1, y: -1)); p.addLine(to: .init(x: length - 1, y: -1))
                let w = g.size.width + 1, h = g.size.height + 1
                p.move(to: .init(x: w - length, y: h)); p.addLine(to: .init(x: w, y: h)); p.addLine(to: .init(x: w, y: h - length))
            }.stroke(color, lineWidth: stroke)
        }.allowsHitTesting(false)
    }
}

// MARK: - Indicators

struct StatusLED: View {
    enum State { case ok, attention, off, error }
    var state: State, size: CGFloat = 6
    var body: some View {
        Group {
            switch state {
            case .ok: Circle().fill(JV.C.cyan).shadow(color: JV.C.cyan, radius: 3)
            case .attention: Circle().fill(JV.C.amber).shadow(color: JV.C.amber, radius: 3)
            case .error: Circle().fill(JV.C.red).shadow(color: JV.C.red, radius: 3)
            case .off: Circle().stroke(JV.C.text2, lineWidth: 1)
            }
        }.frame(width: size, height: size)
    }
}

/// Segmented bar: 6pt segments, 2pt gaps (5/2 for 6pt-tall bars). Track = color @18%.
struct SegmentedMeter: View {
    var value: Double                    // 0…1
    var color: Color = JV.C.cyan
    var height: CGFloat = 5, segment: CGFloat = 6, gap: CGFloat = 2
    var glow = false
    var body: some View {
        GeometryReader { g in
            let count = Int((g.size.width + gap) / (segment + gap))
            let lit = Int((Double(count) * value).rounded())
            HStack(spacing: gap) {
                ForEach(0..<count, id: \.self) { i in
                    Rectangle().fill(i < lit ? color : color.opacity(0.18)).frame(width: segment)
                        .shadow(color: i < lit && glow ? color : .clear, radius: 2)
                }
            }
        }.frame(height: height)
        .accessibilityElement().accessibilityValue("\(Int(value * 100)) percent")
    }
}

/// 44pt ring gauge: r18 stroke 3 (track 15%), inner dotted r13, center content.
struct RingGauge<Center: View>: View {
    var value: Double, color: Color = JV.C.cyan, dashed = false
    @ViewBuilder var center: () -> Center
    var body: some View {
        ZStack {
            if dashed {
                Circle().stroke(color.opacity(0.4), style: StrokeStyle(lineWidth: 1.5, dash: [3, 3])).frame(width: 36, height: 36)
            } else {
                Circle().stroke(color.opacity(0.15), lineWidth: 3).frame(width: 36, height: 36)
                Circle().trim(from: 0, to: value).stroke(color, lineWidth: 3).rotationEffect(.degrees(-90))
                    .frame(width: 36, height: 36).shadow(color: color, radius: 1.5)
                Circle().stroke(color.opacity(0.25), style: StrokeStyle(lineWidth: 1, dash: [1, 2.4])).frame(width: 26, height: 26)
            }
            center()
        }.frame(width: 44, height: 44)
    }
}

struct Keycap: View {
    var label: String, color: Color = JV.C.cyan200
    var body: some View {
        Text(label).font(JV.F.mono(9, .medium)).foregroundStyle(color)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .overlay(alignment: .bottom) { Rectangle().fill(color.opacity(0.3)).frame(height: 1).offset(y: 1) }
            .overlay(RoundedRectangle(cornerRadius: JV.S.keycapRadius).stroke(color.opacity(0.3), lineWidth: 1))
    }
}

struct GateBadge: View {
    enum Kind { case gated, ask, authorized, rejected }
    var kind: Kind
    var body: some View {
        Text(label).jvText((JV.F.hud(8.5), 1.8), color).padding(.horizontal, 7).padding(.vertical, 4)
            .overlay(Rectangle().stroke(color.opacity(0.45), lineWidth: 1))
    }
    private var label: String {
        switch kind {
        case .gated: return "GATED · NEEDS YOU"
        case .ask: return "WILL ASK BEFORE DRAFTING"
        case .authorized: return "AUTHORIZED"
        case .rejected: return "DENIED"
        }
    }
    private var color: Color {
        switch kind {
        case .gated: return JV.C.amber
        case .ask: return JV.C.cyan200
        case .authorized: return JV.C.cyan
        case .rejected: return JV.C.red
        }
    }
}

// MARK: - Buttons

struct HUDButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, ghost, danger, attention }
    var kind: Kind = .secondary
    var large = false                      // 54pt tall decision buttons

    func makeBody(configuration: Configuration) -> some View {
        HUDButtonBody(kind: kind, large: large, pressed: configuration.isPressed) { configuration.label }
    }
}

extension ButtonStyle where Self == HUDButtonStyle {
    static var hud: HUDButtonStyle { HUDButtonStyle() }
    static func hud(_ kind: HUDButtonStyle.Kind, large: Bool = false) -> HUDButtonStyle { HUDButtonStyle(kind: kind, large: large) }
}

/// A view, so that it can read whether the button is enabled from the environment.
private struct HUDButtonBody<Label: View>: View {
    let kind: HUDButtonStyle.Kind
    let large: Bool
    let pressed: Bool
    @ViewBuilder var label: () -> Label
    @Environment(\.isEnabled) private var enabled

    private var foreground: Color {
        switch kind {
        case .primary: return JV.C.cyanInk
        case .secondary: return JV.C.cyan200
        case .ghost: return JV.C.text2
        case .danger: return JV.C.red
        case .attention: return JV.C.amber
        }
    }
    private var border: Color {
        switch kind {
        case .primary: return JV.C.cyan
        case .secondary: return JV.C.lineStrong
        case .ghost: return Color.white.opacity(0.14)
        case .danger: return JV.C.red.opacity(0.55)
        case .attention: return JV.C.amber
        }
    }
    private var glow: Color {
        switch kind {
        case .primary: return JV.C.cyan.opacity(0.5)
        case .attention: return JV.C.amber.opacity(0.25)
        default: return Color.clear
        }
    }
    @ViewBuilder private var fill: some View {
        switch kind {
        case .primary: JV.C.cyan
        case .secondary, .ghost: Color.clear
        case .danger: HazardStripes(color: JV.C.red.opacity(0.08))
        case .attention: JV.C.amber.opacity(0.12)
        }
    }

    var body: some View {
        label()
            .jvText(large ? JV.F.buttonLarge : JV.F.button, foreground, uppercase: true)
            .lineLimit(1)
            .padding(.horizontal, large ? 20 : 16).frame(minHeight: large ? 54 : 34)
            .background(fill)
            .overlay(Rectangle().stroke(border, lineWidth: 1))
            .shadow(color: glow, radius: 12)
            .brightness(pressed ? -0.08 : 0)
            .scaleEffect(pressed ? 0.98 : 1)
            .opacity(enabled ? 1 : 0.4)
            .contentShape(Rectangle())
            .animation(JV.M.press, value: pressed)
    }
}

/// −45° stripes, 6pt band / 12pt period.
struct HazardStripes: View {
    var color: Color
    var body: some View {
        Canvas { ctx, size in
            var x: CGFloat = -size.height
            while x < size.width { var p = Path(); p.move(to: .init(x: x, y: size.height)); p.addLine(to: .init(x: x + size.height, y: 0))
                ctx.stroke(p, with: .color(color), lineWidth: 6); x += 12 }
        }
    }
}

/// Press-and-hold confirmation. Fill grows left→right over `duration`; release early cancels.
/// IMPORTANT: on completion, call the EXISTING approval path (model.act(... optionId: "approve" ...)).
struct HoldToConfirmButton: View {
    var title = "HOLD TO AUTHORIZE"
    var duration: Double = 1.2
    var tint: Color = JV.C.amber
    var action: () -> Void
    @State private var progress: Double = 0
    @State private var holding = false

    var body: some View {
        ZStack(alignment: .leading) {
            Rectangle().fill(tint.opacity(0.12))
            GeometryReader { g in
                Rectangle().fill(LinearGradient(colors: [tint.opacity(0.35), tint.opacity(0.15)], startPoint: .leading, endPoint: .trailing))
                    .frame(width: g.size.width * progress)
            }
            HStack(spacing: 10) { Text(title); Keycap(label: "⌘⏎", color: tint) }
                .jvText(JV.F.buttonLarge, tint).frame(maxWidth: .infinity)
        }
        .frame(height: 54)
        .overlay(Rectangle().stroke(tint, lineWidth: 1))
        .shadow(color: tint.opacity(0.25), radius: 15)
        .gesture(DragGesture(minimumDistance: 0)
            .onChanged { _ in
                guard !holding else { return }
                holding = true
                withAnimation(.linear(duration: duration * (1 - progress))) { progress = 1 }
                DispatchQueue.main.asyncAfter(deadline: .now() + duration) { if holding && progress >= 1 { holding = false; action() } }
            }
            .onEnded { _ in holding = false; if progress < 1 { withAnimation(.easeOut(duration: 0.2)) { progress = 0 } } })
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("Authorize. Press and hold.")
        .accessibilityAction { action() }   // VoiceOver: explicit activation still required
    }
}

// MARK: - Lists

struct Ticker: View {
    var text: String, animated = true
    @State private var offset: CGFloat = 0
    var body: some View {
        GeometryReader { g in
            HStack(spacing: 80) { Text(text); Text(text) }
                .font(JV.F.mono(9.5)).tracking(0.6).foregroundStyle(JV.C.text2).fixedSize()
                .offset(x: offset)
                .onAppear {
                    guard animated else { return }
                    withAnimation(.linear(duration: JV.M.ticker).repeatForever(autoreverses: false)) { offset = -g.size.width }
                }
        }
        .frame(height: JV.S.tickerHeight).clipped()
        .background(Color(red: 2/255, green: 6/255, blue: 9/255).opacity(0.88))
        .overlay(alignment: .top) { Rectangle().fill(JV.C.line).frame(height: 1) }
        .accessibilityHidden(true)
    }
}

struct EventRow: View {
    enum Glyph: String { case op = "●", sealed = "◆", done = "✓", question = "▲", you = "◇" }
    var glyph: Glyph, time: String, source: String, text: String, tint: Color = JV.C.cyan, dim = false
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(glyph.rawValue).foregroundStyle(tint).frame(width: 12)
            Text(time).foregroundStyle(JV.C.text3).frame(width: 56, alignment: .leading)
            Text(source).foregroundStyle(tint).frame(width: 34, alignment: .leading)
            Text(text).foregroundStyle(dim ? JV.C.text2 : JV.C.text1)
        }.font(JV.F.mono(10.5)).lineSpacing(4.5)
    }
}
