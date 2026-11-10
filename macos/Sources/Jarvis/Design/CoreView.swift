import SwiftUI

/// The living core. One Canvas redrawn by TimelineView; every layer's rotation is derived from time,
/// so there is no per-layer animation state to leak. Waveform amplitude MUST come from real audio levels
/// (HarnessAudioLevels.inputRMS / playbackRMS) — never synthesize activity (existing product rule).
struct CoreView: View {
    enum Mode: Equatable {
        case standby          // HarnessVoiceState.idle — mic off
        case armed            // on-device wake detector only — white dashed ring, "LOCAL"
        case connecting       // .connecting
        case listening        // .listening — "hot": bright sphere, fast segments, tall bars
        case thinking         // .thinking — bars collapse, triangles spin 2×
        case speaking         // .speaking — bars follow playbackRMS
        case stopped          // .interrupted / muted by ⌘. — grey, no rotation
        case unavailable      // .unavailable — grey, mic.slash, no rotation
        case authorization    // a decision is on screen — amber tint
    }

    var mode: Mode
    var diameter: CGFloat                 // 160–200 (S), 380 (M), 520–540 (L)
    var inputRMS: Double = 0              // 0…1
    var playbackRMS: Double = 0
    var metrics: (context: Double, budget: Double)? = nil   // 6a only: 0…1 each
    /// Show the particle face at the centre instead of the drawn sphere. The sphere stays until the face is really
    /// on screen, and for good where WebGL is unavailable.
    var presence = false
    /// Words inside the core. Off for small cores, where they would not be legible.
    var labelled = false
    /// Shown under the title while standing by, for example "MIC OFF · WAKE OFF". Built by the caller from real state.
    var detail: String? = nil
    @State private var faceReady = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var tint: Color {
        switch mode {
        case .authorization: return JV.C.amber
        case .stopped, .unavailable: return JV.C.text2
        case .armed: return Color.white
        default: return JV.C.cyan
        }
    }
    private var hot: Bool { mode == .listening || mode == .speaking }
    private var still: Bool { reduceMotion || scenePhase != .active || mode == .stopped || mode == .unavailable }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: still)) { timeline in
            let t = still ? 0 : timeline.date.timeIntervalSinceReferenceDate
            ZStack {
                sphere.scaleEffect(showsFace ? 1.5 : 1).opacity(showsFace ? 0.22 : 1)
                if presence {
                    PresenceFaceView(state: PresenceState(mode: mode, inputRMS: inputRMS, playbackRMS: playbackRMS,
                                                          still: reduceMotion || scenePhase != .active), ready: $faceReady)
                        // The face is given the space inside the waveform ring, a little more than the sphere it replaces.
                        .frame(width: diameter * 0.56, height: diameter * 0.56)
                        // It fades into the core's edge instead of being cut off by it.
                        .mask(RadialGradient(colors: [.black, .black, .clear], center: .center, startRadius: 0, endRadius: diameter * 0.28))
                        .opacity(faceReady ? 1 : 0)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                Canvas { ctx, size in draw(&ctx, size: size, t: t, crosshair: !showsFace) }
                if labelled { labels }
            }
            .animation(JV.M.state, value: faceReady)
        }
        .frame(width: diameter, height: diameter)
        .accessibilityElement()
        .accessibilityLabel(accessibilityText)
    }

    private var sphere: some View {
        // The handoff insets the sphere 166 pt inside a 520 pt core, so it sits within the reticle and waveform.
        let r = diameter * 0.18
        return Circle()
            .fill(RadialGradient(colors: hot
                ? [Color(hex: 0xF2FEFE), Color(hex: 0x9AEDF0), Color(hex: 0x2A8A93), Color(hex: 0x061E24)]
                : [JV.C.cyan50.opacity(0.75), Color(hex: 0x8FEAEE).opacity(0.45), JV.C.cyan900.opacity(0.55), Color(hex: 0x041014).opacity(0.9)],
                center: UnitPoint(x: 0.36, y: 0.30), startRadius: 0, endRadius: r * 1.1))
            .frame(width: r * 2, height: r * 2)
            .shadow(color: tint.opacity(hot ? 0.6 : 0.4), radius: (hot ? 50 : 30) * min(1, diameter / 520))
            .saturation(mode == .stopped || mode == .unavailable ? 0 : 1)
            .animation(JV.M.state, value: mode)
    }

    private var showsFace: Bool { presence && faceReady }

    /// The words for each mode, from the handoff's core table.
    nonisolated static func words(for mode: Mode) -> (kicker: String?, title: String) {
        switch mode {
        case .standby: return ("STANDING BY", "READY")
        case .armed: return ("ARMED", "LOCAL")
        case .connecting: return (nil, "CONNECTING")
        case .listening: return (nil, "LISTENING")
        case .thinking: return (nil, "THINKING")
        case .speaking: return ("TALK TO INTERRUPT", "SPEAKING")
        case .authorization: return (nil, "DECISION")
        case .stopped: return (nil, "STOPPED")
        case .unavailable: return ("TEXT READY", "VOICE UNAVAILABLE")
        }
    }

    @ViewBuilder private var labels: some View {
        let words = Self.words(for: mode)
        if showsFace {
            // With a face at the centre the words sit beneath it, in light on the dark rim, instead of across it.
            VStack(spacing: 3) {
                Text(words.title).font(JV.F.hud(13, .medium)).tracking(5).foregroundStyle(tint)
                    .shadow(color: tint.opacity(0.7), radius: 6)
                if let line = detail ?? words.kicker {
                    Text(line).font(JV.F.mono(8.5, .medium)).foregroundStyle(JV.C.text2)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(JV.C.void.opacity(0.55))
            .offset(y: diameter * 0.335)
        } else {
            VStack(spacing: 6) {
                if let kicker = words.kicker { Text(kicker).font(JV.F.hud(9)).tracking(4) }
                Text(words.title).font(JV.F.hud(words.title.count > 9 ? 12 : 24, .medium)).tracking(words.title.count > 9 ? 2 : 5)
                    .minimumScaleFactor(0.6).lineLimit(2)
                if let detail { Text(detail).font(JV.F.mono(8.5, .medium)) }
            }
            .foregroundStyle(JV.C.cyanInk)
            .multilineTextAlignment(.center)
            .frame(width: diameter * 0.34)
        }
    }

    private func draw(_ ctx: inout GraphicsContext, size: CGSize, t: Double, crosshair: Bool = true) {
        let c = CGPoint(x: size.width / 2, y: size.height / 2), R = size.width / 2
        let big = diameter > 300
        func rotated(_ deg: Double, _ body: (inout GraphicsContext) -> Void) {
            var g = ctx; g.translateBy(x: c.x, y: c.y); g.rotate(by: .degrees(deg)); body(&g)
        }
        // Bearings are in degrees clockwise from the top. Everything is converted to CGFloat once, here, so the
        // trigonometry never has to choose between the Double and CGFloat overloads.
        func point(_ deg: Double, _ radius: CGFloat) -> CGPoint {
            let angle = CGFloat((deg - 90) * Double.pi / 180)
            let x: CGFloat = cos(angle) * radius
            let y: CGFloat = sin(angle) * radius
            return CGPoint(x: x, y: y)
        }
        func tick(_ g: inout GraphicsContext, r0: CGFloat, r1: CGFloat, deg: Double, color: Color, width: CGFloat) {
            var p = Path(); p.move(to: point(deg, r0)); p.addLine(to: point(deg, r1))
            g.stroke(p, with: .color(color), lineWidth: width)
        }
        func arc(_ r: CGFloat, _ a0: Double, _ a1: Double) -> Path {
            Path { $0.addArc(center: .zero, radius: r, startAngle: .degrees(a0 - 90), endAngle: .degrees(a1 - 90), clockwise: false) }
        }

        // 1 · Degree ring (bearings every 30°), 240 s / rev
        let rD = R - (big ? 30 : 8)
        rotated(t / JV.M.degreeRing * 360) { g in
            g.stroke(Path(ellipseIn: CGRect(x: -rD, y: -rD, width: rD * 2, height: rD * 2)), with: .color(tint.opacity(0.16)), lineWidth: 1)
            for d in stride(from: 0, to: 360, by: 2) {
                let major = d % 30 == 0, mid = d % 10 == 0
                tick(&g, r0: rD, r1: rD + (major ? 10 : mid ? 6 : 3), deg: Double(d), color: tint.opacity(major ? 0.85 : mid ? 0.5 : 0.22), width: major ? 1.4 : 1)
                if big && major {
                    g.draw(Text(String(format: "%03d", d)).font(JV.F.mono(8)).foregroundColor(tint.opacity(0.6)),
                           at: point(Double(d), rD + 20))
                }
            }
        }
        // 2 · Segment ring, reverse, 48 s (14 s hot)
        let rS = R * 0.8
        rotated(-t / (hot ? JV.M.segmentRingHot : JV.M.segmentRing) * 360) { g in
            let circ = 2 * .pi * rS
            g.stroke(Path(ellipseIn: CGRect(x: -rS, y: -rS, width: rS * 2, height: rS * 2)), with: .color(tint.opacity(0.75)),
                     style: StrokeStyle(lineWidth: 2.5, dash: [0.18, 0.03, 0.07, 0.03, 0.22, 0.12, 0.10, 0.25].map { $0 * circ }))
            let accents: [Double] = [20, 140, 260]
            for start in accents { g.stroke(arc(rS - 8, start, start + 24), with: .color(tint.opacity(0.9)), lineWidth: 5) }
        }
        // 3 · Metric gauges (static): context 215°→325°, budget 35°→145°
        if let m = metrics {
            rotated(0) { g in
                let rM = R * 0.72
                let gauges: [(from: Double, to: Double, value: Double, color: Color)] =
                    [(215, 325, min(1, max(0, m.context)), JV.C.cyan), (35, 145, min(1, max(0, m.budget)), JV.C.amber)]
                for gauge in gauges {
                    let span = gauge.to - gauge.from
                    g.stroke(arc(rM, gauge.from, gauge.to), with: .color(gauge.color.opacity(0.16)), lineWidth: 6)
                    g.stroke(arc(rM, gauge.from, gauge.from + span * gauge.value), with: .color(gauge.color), lineWidth: 6)
                    for step in 0...10 {
                        tick(&g, r0: rM + 6, r1: rM + 10, deg: gauge.from + span * Double(step) / 10, color: gauge.color.opacity(0.5), width: 1)
                    }
                }
            }
        }
        // 4 · Orbit ring + 3 satellites (12/19/27 s)
        let rO = R * 0.64
        rotated(t / JV.M.orbitRing * 360) { g in
            g.stroke(Path(ellipseIn: CGRect(x: -rO, y: -rO, width: rO * 2, height: rO * 2)), with: .color(tint.opacity(0.4)), style: StrokeStyle(lineWidth: 1, dash: [2, 5]))
        }
        for (i, period) in JV.M.satellites.enumerated() {
            rotated(Double(i) * 120 + t / period * 360) { g in
                let s: CGFloat = i == 0 ? 3.5 : 2.5
                g.fill(Path(ellipseIn: CGRect(x: -s, y: -rO - s, width: s * 2, height: s * 2)), with: .color(tint))
            }
        }
        // 5 · Waveform, 96 bars at r = 0.5R. Amplitude from REAL levels.
        let rW = R * 0.5
        let level = mode == .speaking ? playbackRMS : inputRMS
        let breathePeriod: Double = hot ? JV.M.waveformHot : JV.M.waveform
        let breathePhase: Double = t * 2 * Double.pi / breathePeriod
        let breathe: Double = 0.6 + 0.4 * (0.5 + 0.5 * sin(breathePhase))
        rotated(0) { g in
            for i in 0..<96 {
                let index = Double(i)
                let shapeA: Double = sin(index * 1.31), shapeB: Double = cos(index * 0.37)
                let restA: Double = sin(index * 0.9), restB: Double = cos(index * 0.2)
                let shape: Double = abs(shapeA * shapeB)
                let resting: Double = abs(restA * restB)
                let amplitude: Double = hot ? 6 + 30 * shape * max(0.2, level) : 2 + (big ? 6 : 3) * resting
                tick(&g, r0: rW, r1: rW + CGFloat(amplitude), deg: index / 96 * 360, color: tint.opacity((hot ? 0.95 : 0.55) * breathe), width: big ? 2 : 1.4)
            }
        }
        // 6 · Inward reticle triangles, reverse 30 s (15 s while thinking)
        let rT = R * 0.4
        rotated(-t / (mode == .thinking ? JV.M.reticle / 2 : JV.M.reticle) * 360) { g in
            let bearings: [Double] = [0, 120, 240]
            for bearing in bearings {
                var p = Path()
                p.move(to: point(bearing, rT))
                p.addLine(to: point(bearing - 4, rT + 10))
                p.addLine(to: point(bearing + 4, rT + 10))
                p.closeSubpath()
                g.fill(p, with: .color(tint.opacity(0.85)))
            }
        }
        // 7 · Crosshair inside the sphere (ink on cyan). Left out when a face is there: it would cross the eyes.
        if crosshair {
            let arms: [Double] = [0, 90, 180, 270]
            rotated(0) { g in for arm in arms { tick(&g, r0: R * 0.16, r1: R * 0.3, deg: arm, color: JV.C.cyanInk.opacity(0.45), width: 1) } }
        }
    }

    private var accessibilityText: String {
        switch mode {
        case .standby: return "Jarvis ready. Microphone off."
        case .armed: return "Wake listening armed, on device only."
        case .connecting: return "Connecting voice."
        case .listening: return "Listening. Audio is sent to ElevenLabs."
        case .thinking: return "Thinking."
        case .speaking: return "Speaking. Talk to interrupt."
        case .stopped: return "Voice stopped."
        case .unavailable: return "Voice unavailable. Typing still works."
        case .authorization: return "A decision needs your authorization."
        }
    }
}

extension CoreView.Mode {
    /// Map the runtime's voice state onto the core. `decisionOnScreen` wins for the amber tint.
    init(_ state: HarnessVoiceState, wakeArmed: Bool, decisionOnScreen: Bool) {
        if decisionOnScreen { self = .authorization; return }
        switch state {
        case .connecting: self = .connecting
        case .listening: self = .listening
        case .thinking: self = .thinking
        case .speaking: self = .speaking
        case .idle: self = wakeArmed ? .armed : .standby
        case .interrupted: self = .stopped
        case .unavailable: self = .unavailable
        }
    }
}
