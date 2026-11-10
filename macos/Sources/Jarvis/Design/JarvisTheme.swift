import SwiftUI

/// Spacing and text sizes for the screens that have not moved to the HUD layout yet.
/// Colours come from the HUD tokens in `JV`, which are the single source of truth.
enum JarvisTheme {
    /// Older names kept so existing screens compile; every value is a HUD token from `JV.C`.
    enum Colors {
        static let background = JV.C.void
        static let panel = JV.C.panel
        static let elevated = JV.C.elevated
        static let line = JV.C.line
        static let accent = JV.C.cyan
        static let muted = JV.C.text2
        static let warning = JV.C.amber
        static let danger = JV.C.red
        static let success = JV.C.cyan
        static let text = JV.C.text1
        /// Text drawn on top of `accent`.
        static let onAccent = JV.C.cyanInk
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
