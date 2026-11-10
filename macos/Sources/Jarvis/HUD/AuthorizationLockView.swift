import SwiftUI

/// The authorization lock (handoff screen 6c, overlay O8): one decision at a time, full window.
/// It shows exactly what the runtime issued, in a readable layout and verbatim, with a fingerprint of the card,
/// the runtime's impact description, and the time left. Deny has the focus. Authorizing takes a deliberate hold.
/// Both buttons call the same response endpoint as every other approval control and obey the same gate.
struct AuthorizationLockView: View {
    @ObservedObject var model: AppModel
    let task: AgentTask
    let approval: Approval
    let position: Int
    let total: Int
    var close: () -> Void
    @State private var tab = 0
    @State private var submitted: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var payload: AuthorizationPayload { AuthorizationPayload(detail: approval.detail) }
    private var revision: Int { approval.revision ?? 0 }
    private var digest: [UInt8] { AuthorizationData.fingerprint(id: approval.id, revision: revision, detail: approval.detail) }
    private var pending: Bool { model.pendingActions.contains(approval.id) }
    private func allowed(_ option: String) -> Bool {
        approval.options.contains { $0.id == option } &&
            ApprovalGate.allows(optionID: option, reviewable: approval.reviewable, pending: pending, connected: model.isConnected)
    }

    var body: some View {
        ZStack {
            JV.C.void.opacity(0.86).ignoresSafeArea()
            RadialGradient(colors: [JV.C.amber.opacity(0.09), .clear], center: .center, startRadius: 0, endRadius: 620).allowsHitTesting(false)
            reticle.allowsHitTesting(false)
            VStack(spacing: 0) {
                header.padding(.top, 14)
                HStack(alignment: .top, spacing: 36) {
                    impactColumn.frame(minWidth: 260, maxWidth: 350)
                    payloadFrame.frame(width: 560)
                    detailColumn.frame(minWidth: 260, maxWidth: 350)
                }
                .padding(.top, 34).padding(.horizontal, 44)
                Spacer(minLength: 12)
                preconditions.padding(.bottom, 14)
            }
        }
        .accessibilityAddTraits(.isModal)
        .accessibilityLabel("Authorization required")
    }

    // MARK: Header

    private var header: some View {
        VStack(spacing: 8) {
            HStack(spacing: 22) {
                HazardStripes(color: JV.C.amber.opacity(0.4)).frame(height: 10)
                Text("AUTHORIZATION REQUIRED").font(JV.F.hud(13)).tracking(7).foregroundStyle(JV.C.amber).shadow(color: JV.C.amber.opacity(0.6), radius: 8).fixedSize()
                HazardStripes(color: JV.C.amber.opacity(0.4)).frame(height: 10)
            }.padding(.horizontal, 44)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                HStack(spacing: 6) {
                    Text(headline).foregroundStyle(JV.C.text2)
                    if let left = AuthorizationData.remaining(until: approval.expiresAt, now: context.date) {
                        Text("· EXPIRES \(left)").foregroundStyle(JV.C.amber)
                    } else if approval.expiresAt != nil {
                        Text("· EXPIRED").foregroundStyle(JV.C.red)
                    }
                }.font(JV.F.mono(9)).lineLimit(1)
            }
        }
    }

    private var headline: String {
        var parts = ["DECISION \(position)/\(total)"]
        if let tool = payload.tool { parts.append(tool.uppercased()) }
        parts.append("FROM " + String(task.title.uppercased().prefix(40)))
        return parts.joined(separator: " · ")
    }

    private var reticle: some View {
        TimelineView(.animation(minimumInterval: 1 / 20, paused: reduceMotion)) { timeline in
            let angle = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 120) / 120 * 360
            ZStack {
                Circle().stroke(JV.C.amber.opacity(0.25), style: StrokeStyle(lineWidth: 1, dash: [2, 9])).frame(width: 780, height: 780)
                Circle().trim(from: 0.05, to: 0.22).stroke(JV.C.amber.opacity(0.55), lineWidth: 2).frame(width: 760, height: 760)
                Circle().trim(from: 0.55, to: 0.68).stroke(JV.C.amber.opacity(0.55), lineWidth: 2).frame(width: 760, height: 760)
            }
            .rotationEffect(.degrees(angle))
            .opacity(0.55)
        }
    }

    // MARK: Payload

    private var payloadFrame: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 22) {
                tabButton("AS IT WILL ARRIVE", 0)
                tabButton("EXACT ARGUMENTS", 1)
                Spacer()
            }
            Text(approval.title).jvText(JV.F.question).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            if let blocked = approval.blockedReason, approval.reviewable == false {
                Label(blocked, systemImage: "exclamationmark.octagon").font(JV.F.mono(10.5)).foregroundStyle(JV.C.red).fixedSize(horizontal: false, vertical: true)
            }
            ScrollView {
                if tab == 0 && !(payload.fields.isEmpty && payload.bodies.isEmpty) { readable } else { verbatim }
            }
            .frame(maxHeight: 300)
            .overlay(Rectangle().stroke(JV.C.line, lineWidth: 1))
            fingerprint
            if let submitted {
                Text(submitted).font(JV.F.mono(10)).foregroundStyle(JV.C.cyan200)
            } else if let error = model.error {
                Text(error).font(JV.F.mono(10)).foregroundStyle(JV.C.red).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 12) {
                Button { respond("deny") } label: { HStack(spacing: 10) { Text("Deny"); Keycap(label: "ESC", color: JV.C.text2) } }
                    .buttonStyle(.hud(.ghost, large: true))
                    .keyboardShortcut(.cancelAction)
                    .disabled(!allowed("deny"))
                    .frame(maxWidth: .infinity)
                HoldToConfirmButton(action: { respond("approve") })
                    .allowsHitTesting(allowed("approve"))
                    .disabled(!allowed("approve"))
                    .opacity(allowed("approve") ? 1 : 0.4)
                    .frame(maxWidth: .infinity)
                    // A new revision is a new decision: any hold in progress starts over.
                    .id("\(approval.id):\(revision)")
                    .layoutPriority(1)
            }
            if approval.reviewable == false {
                Text("Some arguments are hidden or too long. This can only be denied.").font(JV.F.mono(9.5)).foregroundStyle(JV.C.amber)
            }
        }
        .padding(30)
        .overlay(CornerMarks(size: JV.S.reticleCorner, color: JV.C.amber, stroke: JV.S.reticleStroke).shadow(color: JV.C.amber.opacity(0.6), radius: 3))
        .overlay(alignment: .top) {
            Text("TARGET LOCK · REV \(revision)").font(JV.F.mono(8)).foregroundStyle(JV.C.amber)
                .padding(.horizontal, 8).background(JV.C.void).offset(y: -5)
        }
    }

    private func tabButton(_ title: String, _ index: Int) -> some View {
        Button { tab = index } label: {
            Text(title).font(JV.F.hud(10)).tracking(2).foregroundStyle(tab == index ? JV.C.text1 : JV.C.text2)
                .padding(.bottom, 6)
                .overlay(alignment: .bottom) { Rectangle().fill(tab == index ? JV.C.amber : Color.clear).frame(height: 2) }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(tab == index ? .isSelected : [])
    }

    private var readable: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !payload.fields.isEmpty {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 18, verticalSpacing: 9) {
                    ForEach(payload.fields) { field in
                        GridRow {
                            Text(field.key.uppercased()).font(JV.F.mono(12)).foregroundStyle(JV.C.text3)
                            Text(field.value).font(JV.F.mono(12)).foregroundStyle(JV.C.text1).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }.padding(16)
            }
            ForEach(payload.bodies) { field in
                Rectangle().fill(JV.C.line).frame(height: 1)
                VStack(alignment: .leading, spacing: 6) {
                    Text(field.key.uppercased()).font(JV.F.mono(9)).foregroundStyle(JV.C.text3)
                    Text(field.value).font(.system(size: 14)).lineSpacing(5).foregroundStyle(JV.C.text1).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.padding(16)
            }
        }
        .background(JV.C.cyan.opacity(0.03))
    }

    private var verbatim: some View {
        Text(approval.detail).font(JV.F.mono(10.5)).foregroundStyle(JV.C.text1.opacity(0.9)).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading).padding(14)
            .overlay(alignment: .leading) { Rectangle().fill(JV.C.cyan.opacity(0.3)).frame(width: 2) }
    }

    private var fingerprint: some View {
        let cells = AuthorizationData.cells(digest)
        return HStack(alignment: .center, spacing: 14) {
            Grid(horizontalSpacing: 2, verticalSpacing: 2) {
                ForEach(0..<4, id: \.self) { row in
                    GridRow {
                        ForEach(0..<8, id: \.self) { column in
                            let value = cells[row * 8 + column]
                            Rectangle().fill((value % 2 == 0 ? JV.C.cyan : JV.C.amber).opacity(0.25 + Double(value) / 15 * 0.75)).frame(width: 9, height: 9)
                        }
                    }
                }
            }
            .padding(4).overlay(Rectangle().stroke(JV.C.line, lineWidth: 1))
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("SHA-256 FINGERPRINT").font(JV.F.mono(9)).foregroundStyle(JV.C.text2)
                Text(AuthorizationData.grouped(digest)).font(JV.F.mono(10.5)).foregroundStyle(JV.C.cyan200).textSelection(.enabled)
                Text("OF THIS EXACT CARD · ANY CHANGE GIVES A NEW ONE").font(JV.F.mono(8.5)).foregroundStyle(JV.C.text3)
            }
        }
    }

    // MARK: Side columns

    private var impactColumn: some View {
        let risk = AuthorizationData.risk(approval.impact)
        return VStack(alignment: .leading, spacing: 18) {
            sectionTitle("10", "Impact analysis")
            RiskGauge(position: risk.position, level: risk.level).frame(width: 220, height: 120)
            Text("RISK · \(risk.label)").font(JV.F.hud(10)).tracking(2.4)
                .foregroundStyle(risk.level == .high ? JV.C.red : risk.level == .medium ? JV.C.amber : JV.C.cyan)
            if let impact = approval.impact {
                VStack(alignment: .leading, spacing: 0) {
                    Text("WHERE IT GOES").jvText(JV.F.micro, JV.C.text2).padding(.bottom, 10)
                    ForEach(Array(impact.egress.enumerated()), id: \.offset) { index, hop in
                        let external = hop.scope == "external"
                        if index > 0 {
                            Rectangle().fill(external ? JV.C.amber.opacity(0.6) : JV.C.cyan.opacity(0.5)).frame(width: 1, height: 14).padding(.leading, 3.5)
                        }
                        HStack(spacing: 10) {
                            Group {
                                if external { Rectangle().stroke(JV.C.amber, lineWidth: 1) } else { Rectangle().fill(JV.C.cyan) }
                            }.frame(width: 8, height: 8)
                            Text(hop.label).font(JV.F.mono(11)).foregroundStyle(external ? JV.C.amber : JV.C.text1)
                            Spacer(minLength: 4)
                            Text(external ? "LEAVES THIS MAC" : hop.scope == "automation" ? "ANOTHER APP" : "LOCAL")
                                .font(JV.F.hud(8, .medium)).tracking(1.6).foregroundStyle(external ? JV.C.amber : JV.C.text2)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(impact.facts, id: \.self) { fact in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("●").font(.system(size: 6)).foregroundStyle(JV.C.cyan)
                            Text(fact).font(JV.F.mono(10.5)).foregroundStyle(JV.C.text1.opacity(0.9)).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            } else {
                Text("The service gave no impact description for this action. Read the exact arguments before deciding.")
                    .font(JV.F.mono(10.5)).foregroundStyle(JV.C.text2).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var detailColumn: some View {
        VStack(alignment: .leading, spacing: 18) {
            sectionTitle("11", "This decision")
            VStack(alignment: .leading, spacing: 10) {
                row("ASKED BY", task.title)
                row("TOOL", payload.tool ?? "Not named")
                row("REVISION", "\(revision)")
                row("QUEUE", total > 1 ? "\(position) of \(total)" : "Only one")
            }
            Rectangle().fill(JV.C.lineSubtle).frame(height: 1)
            VStack(alignment: .leading, spacing: 9) {
                note("Authorizing runs this once, exactly as shown.")
                note("Cancelling afterwards is a request, not a rollback.")
                note("A typed or spoken “yes” in conversation never authorizes anything.")
            }
            if total > 1 {
                Button("Decide later") { close() }.buttonStyle(.hud(.ghost))
                    .help("Leave this decision open and return to the deck. Nothing is approved or denied.")
            }
        }
    }

    private func sectionTitle(_ index: String, _ title: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text(index).jvText(JV.F.index, JV.C.textIndex)
                Text(title).jvText(JV.F.panelTitle, JV.C.cyan, uppercase: true)
            }
            ZStack(alignment: .leading) {
                Rectangle().fill(JV.C.lineSubtle).frame(height: 1)
                Rectangle().fill(JV.C.cyan).frame(width: 32, height: 1)
            }
        }
    }

    private func row(_ key: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(key).jvText(JV.F.micro, JV.C.text2).frame(width: 74, alignment: .leading)
            Text(value).font(JV.F.mono(11)).foregroundStyle(JV.C.text1).lineLimit(2)
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(JV.F.mono(10.5)).foregroundStyle(JV.C.text2).fixedSize(horizontal: false, vertical: true)
    }

    /// The conditions that must hold for a response to be accepted, each read from real state.
    private var preconditions: some View {
        HStack(spacing: 22) {
            led(model.isConnected, "SERVICE CONNECTED")
            led(approval.reviewable != false, "ARGUMENTS FULLY VISIBLE")
            led(!pending, pending ? "RESPONSE IN FLIGHT" : "NO RESPONSE IN FLIGHT")
            led(approval.options.contains { $0.id == "approve" }, "APPROVAL OFFERED")
        }
    }

    private func led(_ ok: Bool, _ label: String) -> some View {
        HStack(spacing: 7) {
            StatusLED(state: ok ? .ok : .error, size: 6)
            Text(label).font(JV.F.mono(9)).foregroundStyle(ok ? JV.C.text2 : JV.C.red)
        }
    }

    private func respond(_ option: String) {
        guard allowed(option) else { return }
        let id = approval.id, path = "v1/tasks/\(task.id)/respond", revision = String(approval.revision ?? 0)
        submitted = option == "approve" ? "Submitting your authorization…" : "Submitting your denial…"
        Task {
            await model.act(key: id, path: path, body: ["interactionId": id, "optionId": option, "expectedRevision": revision])
            submitted = nil
        }
    }
}

/// The half-dial from the handoff: three bands and a needle.
struct RiskGauge: View {
    let position: Double
    let level: AuthorizationData.Level

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height - 8)
            let radius = min(size.width / 2, size.height) - 12
            func band(_ from: Double, _ to: Double, _ color: Color, _ width: CGFloat) {
                var path = Path()
                path.addArc(center: center, radius: radius, startAngle: .degrees(180 + 180 * from), endAngle: .degrees(180 + 180 * to), clockwise: false)
                context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .butt))
            }
            band(0, 0.33, JV.C.cyan.opacity(0.6), 8)
            band(0.35, 0.66, JV.C.amber.opacity(0.75), 8)
            band(0.68, 1, JV.C.red, 8)
            let clamped = min(1, max(0, position))
            let angle = CGFloat((180 + 180 * clamped) * Double.pi / 180)
            let tipX: CGFloat = center.x + cos(angle) * (radius - 14)
            let tipY: CGFloat = center.y + sin(angle) * (radius - 14)
            var needle = Path()
            needle.move(to: center)
            needle.addLine(to: CGPoint(x: tipX, y: tipY))
            context.stroke(needle, with: .color(JV.C.text1), lineWidth: 1.5)
            context.fill(Path(ellipseIn: CGRect(x: center.x - 4, y: center.y - 4, width: 8, height: 8)), with: .color(JV.C.text1))
        }
        .accessibilityElement()
        .accessibilityLabel("Risk gauge")
        .accessibilityValue(level == .high ? "high" : level == .medium ? "medium" : "low")
    }
}
