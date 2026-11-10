import CoreText
import SwiftUI

/// Jarvis HUD design tokens, taken from the design handoff without rounding or "tidying": every value is intentional.
/// Fonts are Chakra Petch (Light, Regular, Medium, SemiBold) and JetBrains Mono (Light, Regular, Medium), both
/// SIL OFL, shipped in Resources/Fonts and registered for this process by `JarvisFonts.registerBundledFonts()`.
enum JV {
    // MARK: Color
    enum C {
        static let void = Color(hex: 0x02040A)
        static let abyss = Color(hex: 0x030508)
        static let panel = Color(hex: 0x0D1217)
        static let elevated = Color(hex: 0x13191F)

        static let cyan50 = Color(hex: 0xE6FDFD)
        static let cyan200 = Color(hex: 0xBFF8FA)
        static let cyan = Color(hex: 0x6EE3E8)          // primary signal
        static let cyan700 = Color(hex: 0x2A8A93)
        static let cyan900 = Color(hex: 0x1B5E66)
        static let cyanInk = Color(hex: 0x03181B)

        static let amber = Color(hex: 0xFFC26E)         // needs you / gated
        static let amberInk = Color(hex: 0x1A1205)
        static let red = Color(hex: 0xFF7A7D)           // destructive / irreversible

        static let text1 = Color(hex: 0xE6F7F8)
        static let text2 = Color(hex: 0x7F9AA6)
        static let text3 = Color(hex: 0x4F6A73)
        static let textIndex = Color(hex: 0x3E5A63)

        static let lineFaint = cyan.opacity(0.07)
        static let lineSubtle = cyan.opacity(0.10)
        static let line = cyan.opacity(0.14)
        static let lineStrong = cyan.opacity(0.32)
        static let lineActive = cyan.opacity(0.45)
        static let fill1 = cyan.opacity(0.05)
        static let fill2 = cyan.opacity(0.08)
        static let fill3 = cyan.opacity(0.14)

        static let glassTop = Color(red: 18/255, green: 40/255, blue: 48/255).opacity(0.45)
        static let glassBottom = Color(red: 6/255, green: 16/255, blue: 20/255).opacity(0.30)
    }

    // MARK: Type
    enum F {
        static func hud(_ size: CGFloat, _ weight: HudWeight = .semibold) -> Font { .custom("ChakraPetch-\(weight.rawValue)", size: size) }
        static func mono(_ size: CGFloat, _ weight: MonoWeight = .regular) -> Font { .custom("JetBrainsMono-\(weight.rawValue)", size: size) }
        enum HudWeight: String { case light = "Light", regular = "Regular", medium = "Medium", semibold = "SemiBold" }
        enum MonoWeight: String { case light = "Light", regular = "Regular", medium = "Medium" }

        // Named styles: (font, tracking). Apply with .jvText(_:)
        static let wordmark = (hud(18), 7.0)
        static let displayXL = (hud(44, .light), -0.5)
        static let display = (hud(30, .light), 0.0)
        static let transcript = (hud(34, .light), -0.2)   // line height 62 → lineSpacing 21
        static let question = (hud(28, .light), 0.0)
        static let panelTitle = (hud(10.5), 2.8)           // uppercase
        static let micro = (hud(8.5), 2.0)                 // uppercase
        static let button = (hud(10), 1.8)                 // uppercase
        static let buttonLarge = (hud(11), 2.6)            // 54pt-tall buttons
        static let body = (Font.system(size: 13), 0.0)
        static let bodyLarge = (Font.system(size: 14), 0.0)
        static let data = (mono(11), 0.0)
        static let dataSmall = (mono(9.5), 0.0)
        static let index = (mono(9, .medium), 0.0)
        static let metric = (mono(17), 0.0)
        static let metricLarge = (mono(26, .light), 0.0)
        static let clock = (mono(23, .light), 2.0)
    }

    // MARK: Layout (exact values; do not snap to an 8pt grid)
    enum S {
        static let ruler: CGFloat = 14
        static let tickerHeight: CGFloat = 20
        static let contentInsetLeading: CGFloat = 44   // after ruler
        static let contentInsetTrailing: CGFloat = 24
        static let topBarY: CGFloat = 28, topBarHeight: CGFloat = 46, headerRuleY: CGFloat = 84
        static let columnsTop: CGFloat = 100
        static let columnWidth: CGFloat = 340
        static let gutter: CGFloat = 14
        static let panelPadding = EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16)
        static let cornerAccent: CGFloat = 12, cornerAccentStroke: CGFloat = 1.5
        static let reticleCorner: CGFloat = 40, reticleStroke: CGFloat = 2
        static let keycapRadius: CGFloat = 3
    }

    // MARK: Motion
    enum M {
        static let press = Animation.easeOut(duration: 0.08)
        static let hover = Animation.easeOut(duration: 0.12)
        static let overlayIn = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.18)
        static let overlayOut = Animation.timingCurve(0.4, 0, 1, 1, duration: 0.12)
        static let state = Animation.easeInOut(duration: 0.24)
        // Decorative loop periods (seconds). Disable when accessibilityReduceMotion is true.
        static let degreeRing = 240.0, segmentRing = 48.0, segmentRingHot = 14.0, orbitRing = 80.0
        static let satellites: [Double] = [12, 19, 27], reticle = 30.0
        static let waveform = 4.0, waveformHot = 0.8, radar = 6.0, ticker = 70.0
        static let cursor = 1.1, scan = 3.2, pulse = 1.8, workerOrbit = 90.0
    }
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: opacity)
    }
}

extension View {
    func jvText(_ style: (Font, Double), _ color: Color = JV.C.text1, uppercase: Bool = false) -> some View {
        self.font(style.0).tracking(style.1).foregroundStyle(color).textCase(uppercase ? .uppercase : nil)
    }
}

/// Registers the fonts shipped inside the app for this process only. If a font is missing, SwiftUI falls back to the
/// system font, so the interface stays usable; it just loses its typeface.
enum JarvisFonts {
    private static var registered = false
    static let postScriptNames = ["ChakraPetch-Light", "ChakraPetch-Regular", "ChakraPetch-Medium", "ChakraPetch-SemiBold",
                                  "JetBrainsMono-Light", "JetBrainsMono-Regular", "JetBrainsMono-Medium"]

    static func registerBundledFonts() {
        guard !registered else { return }
        registered = true
        // A packaged app keeps SwiftPM's resource bundle inside Contents/Resources; a test run finds it beside the binary.
        let bundle = Bundle.main.url(forResource: "JarvisRoy_Jarvis", withExtension: "bundle").flatMap(Bundle.init(url:)) ?? Bundle.module
        guard let root = bundle.resourceURL,
              let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return }
        for case let url as URL in files where url.pathExtension.lowercased() == "ttf" {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    /// The bundled fonts this process can actually use, for diagnostics and tests.
    static func availablePostScriptNames() -> [String] {
        postScriptNames.filter { name in
            let font = CTFontCreateWithName(name as CFString, 12, nil)
            return (CTFontCopyPostScriptName(font) as String) == name
        }
    }
}
