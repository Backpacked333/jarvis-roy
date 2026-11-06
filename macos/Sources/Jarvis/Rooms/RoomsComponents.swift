import SwiftUI

enum RoomsPalette {
    static let background = Color(red: 0.025, green: 0.037, blue: 0.054)
    static let panel = Color(red: 0.052, green: 0.070, blue: 0.090)
    static let elevated = Color(red: 0.075, green: 0.098, blue: 0.122)
    static let line = Color.white.opacity(0.10)
    static let cyan = Color(red: 0.43, green: 0.89, blue: 0.91)
    static let muted = Color(red: 0.65, green: 0.71, blue: 0.77)
    static let amber = Color(red: 1.0, green: 0.76, blue: 0.43)
    static let red = Color(red: 1.0, green: 0.48, blue: 0.49)
    static func status(_ status: String) -> Color {
        switch status {
        case "running", "completed", "accepted", "active", "passed": return cyan
        case "failed", "cancel_requested", "interrupted": return red
        case "waiting_question", "paused", "blocked", "unverified": return amber
        default: return muted
        }
    }
}

struct RoomsPanel<Content: View>: View {
    var title: String
    var eyebrow: String? = nil
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let eyebrow { Text(eyebrow.uppercased()).font(.system(size: 9, weight: .semibold)).tracking(2).foregroundStyle(RoomsPalette.cyan) }
            if !title.isEmpty { Text(title).font(.system(size: 19, weight: .medium)).foregroundStyle(.white) }
            content()
        }
        .padding(22).frame(maxWidth: .infinity, alignment: .leading)
        .background(RoomsPalette.panel, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(RoomsPalette.line, lineWidth: 1))
    }
}

struct RoomsStatus: View {
    let value: String
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(RoomsPalette.status(value)).frame(width: 5, height: 5)
            Text(value.replacingOccurrences(of: "_", with: " ").capitalized)
                .font(.system(size: 10, weight: .medium))
        }
        .foregroundStyle(RoomsPalette.status(value)).padding(.horizontal, 8).padding(.vertical, 5)
        .background(RoomsPalette.status(value).opacity(0.09), in: Capsule())
        .accessibilityElement(children: .ignore).accessibilityLabel("Status: \(value.replacingOccurrences(of: "_", with: " "))")
    }
}

struct RoomsEmptyState: View {
    let icon: String
    let title: String
    let detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: icon).font(.system(size: 25, weight: .light)).foregroundStyle(RoomsPalette.cyan)
            Text(title).font(.system(size: 20, weight: .medium))
            Text(detail).font(.system(size: 13)).foregroundStyle(RoomsPalette.muted).lineSpacing(4)
        }.padding(.vertical, 18).frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct RoomsUsageView: View {
    let usage: HarnessUsage
    var limits: HarnessBudgetLimits? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 18) {
                metric("STEPS", value: "\(usage.steps)" + (limits.map { " / \($0.maxSteps)" } ?? ""))
                metric("MODEL CALLS", value: "\(usage.modelCalls)" + (limits.map { " / \($0.maxModelCalls)" } ?? ""))
                metric("TOKENS REPORTED", value: "\(usage.inputTokens + usage.outputTokens)")
                Spacer(minLength: 0)
            }
            Text("Accounting: \(usage.accounting) · \(usage.reservedTokens) tokens reserved")
                .font(.system(size: 10)).foregroundStyle(RoomsPalette.muted)
            Text(usage.estimatedUsd.map { String(format: "Estimated cost $%.4f · not a provider billing cap", $0) }
                 ?? "Cost unavailable · token/step limits are enforced, dollars are estimates")
                .font(.system(size: 10)).foregroundStyle(RoomsPalette.muted)
            if usage.accounting != "measured" {
                Label("Usage is incomplete; missing usage is not zero.", systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(RoomsPalette.amber)
            }
        }
    }
    private func metric(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 8, weight: .semibold)).tracking(1.2).foregroundStyle(RoomsPalette.muted)
            Text(value).font(.system(size: 14, weight: .medium, design: .monospaced)).foregroundStyle(.white)
        }
    }
}

struct RoomsSignalCore: View {
    let state: HarnessVoiceState
    let levels: HarnessAudioLevels
    let history: [Double]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var amplitude: Double { max(levels.inputRMS, levels.playbackRMS) }

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle().fill(RadialGradient(colors: [RoomsPalette.cyan.opacity(0.13), .clear], center: .center, startRadius: 16, endRadius: 98))
                Circle().stroke(RoomsPalette.line, lineWidth: 1).padding(6)
                Circle().trim(from: 0.04, to: 0.39).stroke(RoomsPalette.cyan.opacity(0.45), style: StrokeStyle(lineWidth: 1, lineCap: .round)).padding(6)
                Circle().trim(from: 0.54, to: 0.89).stroke(RoomsPalette.cyan.opacity(0.45), style: StrokeStyle(lineWidth: 1, lineCap: .round)).padding(6)
                Circle().stroke(RoomsPalette.cyan.opacity(0.13 + amplitude * 0.6), lineWidth: 1).padding(25 - amplitude * 10)
                Circle().stroke(RoomsPalette.cyan.opacity(0.28), lineWidth: 1).padding(43)
                Circle().fill(RoomsPalette.cyan.opacity(0.08 + amplitude * 0.2)).padding(47 - amplitude * 14)
                Image(systemName: state == .unavailable ? "mic.slash" : "waveform")
                    .font(.system(size: 29, weight: .ultraLight)).foregroundStyle(RoomsPalette.cyan)
            }.frame(width: 182, height: 182)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.09), value: amplitude)
                .accessibilityHidden(true)
            Canvas { context, size in
                let samples = history.isEmpty ? [0.0] : history
                let width = size.width / CGFloat(max(48, samples.count))
                for (index, value) in samples.enumerated() {
                    let height = max(1, CGFloat(value) * size.height)
                    let rect = CGRect(x: CGFloat(index) * width, y: (size.height - height) / 2, width: max(1, width - 2), height: height)
                    context.fill(Path(roundedRect: rect, cornerRadius: 1), with: .color(RoomsPalette.cyan.opacity(0.65)))
                }
            }.frame(width: 190, height: 26).accessibilityHidden(true)
            Text(state.rawValue.uppercased()).font(.system(size: 9, weight: .medium, design: .monospaced)).tracking(3).foregroundStyle(RoomsPalette.muted)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Premium voice: \(state.rawValue). Input level \(Int(levels.inputRMS * 100)), playback level \(Int(levels.playbackRMS * 100)).")
    }
}

struct RoomsDependencyGraph: View {
    let nodes: [HarnessPlanNode]
    var states: [HarnessNodeState] = []
    var body: some View {
        if let layers = try? RoomsStateRules.layers(nodes) {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 16) {
                    ForEach(Array(layers.enumerated()), id: \.offset) { index, layer in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(index == 0 ? "INDEPENDENT" : "STAGE \(index + 1)")
                                .font(.system(size: 9, weight: .medium, design: .monospaced)).tracking(1.5).foregroundStyle(RoomsPalette.muted)
                            ForEach(layer) { node in
                                VStack(alignment: .leading, spacing: 9) {
                                    HStack { Image(systemName: icon(node.role)).foregroundStyle(RoomsPalette.cyan); Spacer(); RoomsStatus(value: states.first(where: { $0.nodeId == node.id })?.status ?? "planned") }
                                    Text(node.title).font(.system(size: 13, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                                    Text(node.role.uppercased()).font(.system(size: 8)).tracking(1.5).foregroundStyle(RoomsPalette.muted)
                                    if !node.dependencies.isEmpty {
                                        Label(node.dependencies.joined(separator: " + "), systemImage: "arrow.turn.down.right")
                                            .font(.system(size: 10, design: .monospaced)).foregroundStyle(RoomsPalette.muted)
                                    }
                                    if !node.inputFrom.isEmpty {
                                        Text("Artifact inputs: \(node.inputFrom.joined(separator: ", "))").font(.system(size: 9)).foregroundStyle(RoomsPalette.cyan)
                                    }
                                }.padding(13).frame(width: 170, alignment: .leading)
                                    .background(RoomsPalette.elevated, in: RoundedRectangle(cornerRadius: 11))
                                    .overlay(RoundedRectangle(cornerRadius: 11).stroke(RoomsPalette.line, lineWidth: 1))
                                    .accessibilityElement(children: .combine)
                            }
                        }
                        if index < layers.count - 1 {
                            Image(systemName: "arrow.right").foregroundStyle(RoomsPalette.cyan.opacity(0.5)).padding(.top, 66).accessibilityHidden(true)
                        }
                    }
                }.padding(.bottom, 5)
            }.accessibilityLabel("Dependency graph. Nodes in each stage can run independently after their dependencies succeed.")
        } else {
            Label("Invalid dependency graph. Execution must remain blocked.", systemImage: "exclamationmark.triangle").foregroundStyle(RoomsPalette.red)
        }
    }
    private func icon(_ role: String) -> String {
        switch role { case "builder": return "hammer"; case "researcher": return "magnifyingglass"; case "tester": return "checkmark.seal"; default: return "eye" }
    }
}
