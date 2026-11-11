import SwiftUI

struct RoomsPanel<Content: View>: View {
    @Environment(\.theme) private var theme
    var title: String
    var eyebrow: String? = nil
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if eyebrow != nil || !title.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    if let eyebrow { Text(Self.sentence(eyebrow)).font(.system(size: 12, weight: .semibold)).foregroundStyle(theme.accentText).lineLimit(1).truncationMode(.middle) }
                    if !title.isEmpty { Text(title).font(.system(size: 18, weight: .semibold)).foregroundStyle(theme.text) }
                }
            }
            content()
        }
        .jarvisCard(padding: 20, radius: 18)
    }

    /// "02 / REVIEW BEFORE ACCEPTING" reads as "Step 2 · Review before accepting".
    static func sentence(_ eyebrow: String) -> String {
        let parts = eyebrow.split(separator: "/", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        func soften(_ text: String) -> String {
            // Only plain upper-case words; identifiers keep their exact spelling.
            guard text == text.uppercased(), text.contains(where: \.isLetter),
                  text.allSatisfy({ $0.isLetter || $0.isWhitespace || "·&-".contains($0) }) else { return text }
            return String(text.prefix(1)) + text.dropFirst().lowercased()
        }
        if parts.count == 2, let step = Int(parts[0]) { return "Step \(step) · " + soften(parts[1]) }
        return parts.map(soften).joined(separator: " · ")
    }
}

struct RoomsStatus: View {
    let value: String
    var body: some View {
        StatusPill(label: value.replacingOccurrences(of: "_", with: " ").capitalized, status: value)
    }
}

struct RoomsEmptyState: View {
    @Environment(\.theme) private var theme
    let icon: String
    let title: String
    let detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: icon).font(.system(size: 24, weight: .light)).foregroundStyle(theme.accentText)
            Text(title).font(.system(size: 18, weight: .semibold)).foregroundStyle(theme.text)
            Text(detail).font(.system(size: 13)).foregroundStyle(theme.muted).lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }.padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct RoomsUsageView: View {
    @Environment(\.theme) private var theme
    let usage: HarnessUsage
    var limits: HarnessBudgetLimits? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 18) {
                metric("Steps", value: "\(usage.steps)" + (limits.map { " / \($0.maxSteps)" } ?? ""))
                metric("Model calls", value: "\(usage.modelCalls)" + (limits.map { " / \($0.maxModelCalls)" } ?? ""))
                metric("Tokens reported", value: "\(usage.inputTokens + usage.outputTokens)")
                Spacer(minLength: 0)
            }
            Text("Accounting: \(usage.accounting) · \(usage.reservedTokens) tokens reserved")
                .font(.system(size: 11)).foregroundStyle(theme.muted)
            Text(usage.estimatedUsd.map { String(format: "Estimated cost $%.4f · not a provider billing cap", $0) }
                 ?? "Cost unavailable · token/step limits are enforced, dollars are estimates")
                .font(.system(size: 11)).foregroundStyle(theme.muted)
            if usage.accounting != "measured" {
                Label("Usage is incomplete; missing usage is not zero.", systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(theme.warning)
            }
        }
    }
    private func metric(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(theme.muted)
            Text(value).font(.system(size: 15, weight: .semibold)).monospacedDigit().foregroundStyle(theme.text)
        }
    }
}

struct RoomsSignalCore: View {
    @Environment(\.theme) private var theme
    let state: HarnessVoiceState
    let levels: HarnessAudioLevels
    let history: [Double]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    private var amplitude: Double { scenePhase == .active ? max(levels.inputRMS, levels.playbackRMS) : 0 }
    private var motionAmplitude: Double { reduceMotion ? 0 : amplitude }
    private var tint: Color { state == .unavailable || state == .interrupted ? theme.muted : theme.accent }

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle().fill(RadialGradient(colors: [tint.opacity(0.15 + amplitude * 0.15), .clear], center: .center, startRadius: 16, endRadius: 98))
                Circle().stroke(theme.line, lineWidth: 1).padding(6)
                Circle().trim(from: 0.04, to: 0.39).stroke(theme.accentText.opacity(0.45), style: StrokeStyle(lineWidth: 1, lineCap: .round)).padding(6)
                Circle().trim(from: 0.54, to: 0.89).stroke(theme.accentText.opacity(0.45), style: StrokeStyle(lineWidth: 1, lineCap: .round)).padding(6)
                Circle().stroke(tint.opacity(0.13 + amplitude * 0.6), lineWidth: 1).padding(25 - motionAmplitude * 10)
                Circle().fill(RadialGradient(colors: [tint.opacity(0.45 + amplitude * 0.35), theme.panel, theme.background], center: .topLeading, startRadius: 0, endRadius: 128))
                    .padding(43 - motionAmplitude * 7)
                    .overlay(Circle().stroke(tint.opacity(0.32), lineWidth: 0.7).padding(43 - motionAmplitude * 7))
                Ellipse().stroke(tint.opacity(0.3 + amplitude * 0.4), lineWidth: 0.8)
                    .frame(width: 94 + motionAmplitude * 22, height: 29 + (reduceMotion || scenePhase != .active ? 0 : levels.inputRMS * 24)).rotationEffect(.degrees(-28))
                Ellipse().stroke(theme.text.opacity(0.10 + amplitude * 0.25), lineWidth: 0.7)
                    .frame(width: 90 + motionAmplitude * 18, height: 23 + (reduceMotion || scenePhase != .active ? 0 : levels.playbackRMS * 30)).rotationEffect(.degrees(34))
                Image(systemName: state == .unavailable ? "mic.slash" : "waveform")
                    .font(.system(size: 22, weight: .ultraLight)).foregroundStyle(tint.opacity(0.85))
            }.frame(width: 182, height: 182)
                .animation(reduceMotion || scenePhase != .active ? nil : .easeOut(duration: 0.09), value: amplitude)
                .accessibilityHidden(true)
            Canvas { context, size in
                let samples = history.isEmpty || scenePhase != .active ? [0.0] : reduceMotion ? [history.last ?? 0] : history
                let width = size.width / CGFloat(max(48, samples.count))
                for (index, value) in samples.enumerated() {
                    let height = max(1, CGFloat(value) * size.height)
                    let rect = CGRect(x: CGFloat(index) * width, y: (size.height - height) / 2, width: max(1, width - 2), height: height)
                    context.fill(Path(roundedRect: rect, cornerRadius: 1), with: .color(theme.accentText.opacity(0.65)))
                }
            }.frame(width: 190, height: 26).accessibilityHidden(true)
            HStack(spacing: 16) {
                level("Mic", value: levels.inputRMS)
                level("Playback", value: levels.playbackRMS)
            }.accessibilityHidden(true)
            Text(state.label).font(.system(size: 12, weight: .medium)).foregroundStyle(theme.muted)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Premium voice: \(state.rawValue). Input level \(Int(levels.inputRMS * 100)), playback level \(Int(levels.playbackRMS * 100)).")
    }

    private func level(_ label: String, value: Double) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 11, weight: .medium)).foregroundStyle(theme.muted)
            ZStack(alignment: .leading) {
                Capsule().fill(theme.line)
                Capsule().fill(tint).frame(width: 70 * (scenePhase == .active ? value : 0))
            }.frame(width: 70, height: 2)
        }
    }
}

struct RoomsDependencyGraph: View {
    @Environment(\.theme) private var theme
    let nodes: [HarnessPlanNode]
    var states: [HarnessNodeState] = []
    var body: some View {
        if let layers = try? RoomsStateRules.layers(nodes) {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 48) {
                    ForEach(Array(layers.enumerated()), id: \.offset) { index, layer in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(index == 0 ? "Independent" : "Stage \(index + 1)")
                                .font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.muted)
                            ForEach(layer) { node in
                                VStack(alignment: .leading, spacing: 9) {
                                    HStack { Image(systemName: icon(node.role)).foregroundStyle(theme.accentText); Spacer(); RoomsStatus(value: states.first(where: { $0.nodeId == node.id })?.status ?? "planned") }
                                    Text(node.title).font(.system(size: 13, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                                    Text(node.role.capitalized).font(.system(size: 11)).foregroundStyle(theme.muted)
                                    if !node.dependencies.isEmpty {
                                        Label(node.dependencies.joined(separator: " + "), systemImage: "arrow.turn.down.right")
                                            .font(.system(size: 11, design: .monospaced)).foregroundStyle(theme.muted)
                                    }
                                    if !node.inputFrom.isEmpty {
                                        Text("Artifact inputs: \(node.inputFrom.joined(separator: ", "))").font(.system(size: 11)).foregroundStyle(theme.accentText)
                                    }
                                }.padding(13).frame(width: 190, alignment: .leading)
                                    .background(theme.elevated, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(theme.status(states.first(where: { $0.nodeId == node.id })?.status ?? "planned").opacity(0.25), lineWidth: 1))
                                    .anchorPreference(key: RoomsGraphAnchors.self, value: .bounds) { [node.id: $0] }
                                    .accessibilityElement(children: .combine)
                            }
                        }
                    }
                }
                .backgroundPreferenceValue(RoomsGraphAnchors.self) { anchors in
                    GeometryReader { geometry in
                        Canvas { context, _ in
                            for edge in RoomsGraphEdge.edges(nodes) {
                                guard let startAnchor = anchors[edge.source], let endAnchor = anchors[edge.destination] else { continue }
                                let start = geometry[startAnchor], end = geometry[endAnchor]
                                var path = Path()
                                path.move(to: CGPoint(x: start.maxX, y: start.midY))
                                path.addCurve(to: CGPoint(x: end.minX, y: end.midY), control1: CGPoint(x: start.maxX + 24, y: start.midY), control2: CGPoint(x: end.minX - 24, y: end.midY))
                                context.stroke(path, with: .color(theme.accentText.opacity(edge.artifact ? 0.55 : 0.25)), style: StrokeStyle(lineWidth: 1, dash: edge.artifact ? [] : [3, 4]))
                            }
                        }
                    }.allowsHitTesting(false).accessibilityHidden(true)
                }.padding(.bottom, 5)
            }.accessibilityLabel("Dependency graph. Nodes in each stage can run independently after their dependencies succeed.")
            Text("Solid connection: immutable artifact input · dashed: dependency only")
                .font(.system(size: 11)).foregroundStyle(theme.muted)
        } else {
            Label("Invalid dependency graph. Execution must remain blocked.", systemImage: "exclamationmark.triangle").foregroundStyle(theme.danger)
        }
    }
    private func icon(_ role: String) -> String {
        switch role { case "builder": return "hammer"; case "researcher": return "magnifyingglass"; case "tester": return "checkmark.seal"; default: return "eye" }
    }
}

private struct RoomsGraphAnchors: PreferenceKey {
    static var defaultValue: [String: Anchor<CGRect>] { [:] }
    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

struct RoomsWorkerCensus: View {
    @Environment(\.theme) private var theme
    let nodes: [HarnessNodeState]
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 20) { counts }
            VStack(alignment: .leading, spacing: 10) { counts }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.trough, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    private var counts: some View {
        ForEach(["running", "queued", "waiting_question", "blocked", "completed", "failed"], id: \.self) { status in
            VStack(alignment: .leading, spacing: 5) {
                Text("\(nodes.filter { $0.status == status }.count)").font(.system(size: 20, weight: .semibold)).monospacedDigit()
                Text(status.replacingOccurrences(of: "_", with: " ").capitalized).font(.system(size: 11, weight: .medium))
            }.foregroundStyle(theme.status(status)).accessibilityElement(children: .combine)
        }
    }
}
