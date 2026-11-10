import SwiftUI

/// The one place Jarvis's colours, spacing, corner radii and text sizes are decided.
/// Views take values from here instead of writing their own, so every screen reads as one app.
enum JarvisTheme {
    enum Colors {
        static let background = Color(red: 0.025, green: 0.037, blue: 0.054)
        static let panel = Color(red: 0.052, green: 0.070, blue: 0.090)
        static let elevated = Color(red: 0.075, green: 0.098, blue: 0.122)
        static let line = Color.white.opacity(0.10)
        static let accent = Color(red: 0.43, green: 0.89, blue: 0.91)
        /// Secondary text. Light enough to stay readable on every surface above.
        static let muted = Color(red: 0.65, green: 0.71, blue: 0.77)
        static let warning = Color(red: 1.0, green: 0.76, blue: 0.43)
        static let danger = Color(red: 1.0, green: 0.48, blue: 0.49)
        static let success = Color(red: 0.47, green: 0.87, blue: 0.62)
        static let text = Color.white
        /// Text drawn on top of `accent`.
        static let onAccent = Color(red: 0.02, green: 0.09, blue: 0.11)
    }

    enum Radius {
        static let control: CGFloat = 8
        static let card: CGFloat = 12
        static let panel: CGFloat = 18
    }

    enum Space {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 18
        static let xl: CGFloat = 24
        static let xxl: CGFloat = 32
    }

    /// Text sizes. Nothing a person is meant to read is smaller than `finePrint`.
    enum TextSize {
        static let finePrint: CGFloat = 10
        static let caption: CGFloat = 11
        static let label: CGFloat = 12
        static let body: CGFloat = 13
        static let heading: CGFloat = 15
        static let title: CGFloat = 20
        static let display: CGFloat = 28
    }
}

extension Text {
    /// Small spaced capitals used above a section, such as "YOUR SPACE".
    func jarvisEyebrow(_ color: Color = JarvisTheme.Colors.muted) -> some View {
        font(.system(size: JarvisTheme.TextSize.finePrint, weight: .semibold)).tracking(1.8).foregroundStyle(color)
    }
}
