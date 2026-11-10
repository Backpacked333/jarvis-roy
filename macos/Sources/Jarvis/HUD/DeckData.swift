import Foundation

// Everything the Command Deck shows is derived here from the app's existing models, as plain values that can be
// tested without a window. Design principle 01 from the handoff governs all of it: where there is no real data,
// the result is empty, and the deck renders nothing rather than inventing activity.

/// One room on the Operations panel.
struct DeckOperation: Identifiable, Equatable {
    enum Phase: Equatable {
        case running(progress: Double)   // a run is in progress: completed workers / all workers
        case held                        // a worker asked a question, or dispatch is paused
        case ready                       // a plan is accepted but nothing has been started
        case drafting                    // a plan is being written or awaits review
        case finished(ok: Bool)          // the latest run ended
        case idle                        // a room with no plan yet
    }
    /// How one worker in the latest run stands, drawn as a small square.
    enum Worker: Equatable { case done, running, asking, queued, failed }

    let id: String
    let title: String
    let phase: Phase
    let workers: [Worker]
    /// Short state in the handoff's capitals, for example "RUNNING" or "ASKS YOU".
    let status: String
    /// Right-hand figure: tokens used so far, or the number of workers a ready plan would start.
    let trailing: String?
    let detail: String?
}

/// One line on the Comms panel.
struct DeckCommsLine: Identifiable, Equatable {
    enum Speaker: Equatable { case you, jarvis }
    let id: String
    let time: String
    let speaker: Speaker
    let text: String
}

/// One item that needs the person, for the Needs-you panel and the Decisions chip.
struct DeckDecision: Identifiable, Equatable {
    enum Kind: Equatable { case approval, question, proposal }
    let id: String
    let kind: Kind
    let title: String
    let origin: String
    /// The approval, question or proposal this stands for, as the runtime identifies it.
    let reference: String
}

/// Something Jarvis noticed in its own state that you may want to act on next. Each one is produced by a fixed
/// rule over real facts, carries the facts that triggered it, and can only open an existing screen.
/// There is no confidence score: a rule either fired or it did not, and a number would pretend otherwise.
struct DeckSignal: Identifiable, Equatable {
    enum Action: Equatable {
        case openRoom(String)       // show the room; starting or accepting stays a separate, explicit step there
        case openSetup
        case openThread
    }
    let id: String
    let icon: String
    let sentence: String
    /// The facts behind it, for the BECAUSE line.
    let because: String
    let actionLabel: String
    let action: Action
}

enum DeckData {
    // MARK: Signals

    /// At most `limit` signals, most actionable first. Empty when nothing in the app's state calls for one.
    static func signals(state: HarnessState?, tasks: [AgentTask], servicesReady: Bool, hasModelKey: Bool?, limit: Int = 3) -> [DeckSignal] {
        var result: [DeckSignal] = []
        if servicesReady, hasModelKey == false {
            result.append(DeckSignal(id: "key", icon: "key", sentence: "Add a model key so Jarvis can answer.",
                                     because: "local services running · no key saved", actionLabel: "ADD KEY", action: .openSetup))
        }
        let interrupted = tasks.filter { $0.status == "interrupted" }
        if let task = interrupted.first {
            result.append(DeckSignal(id: "interrupted:\(task.id)", icon: "exclamationmark.arrow.circlepath",
                                     sentence: "“\(String(task.title.prefix(60)))” was interrupted. Check it before continuing; nothing is replayed.",
                                     because: interrupted.count == 1 ? "1 interrupted task · outcome not confirmed" : "\(interrupted.count) interrupted tasks · outcome not confirmed",
                                     actionLabel: "OPEN", action: .openThread))
        }
        if let state {
            for room in state.rooms where room.status != "archived" {
                let runs = state.runs.filter { $0.roomId == room.id }.sorted { $0.createdAt > $1.createdAt }
                let plans = state.plans.filter { $0.roomId == room.id }.sorted { $0.revision > $1.revision }
                if runs.isEmpty, let plan = plans.first(where: { $0.status == "accepted" }) {
                    let workers = state.worker.available ? "workers ready" : "workers not set up"
                    let accepted = plan.acceptedAt.map { clock($0) } ?? "earlier"
                    result.append(DeckSignal(id: "ready:\(plan.id)", icon: "bolt", sentence: "\(room.title) has an accepted plan that has not been started.",
                                             because: "plan rev \(plan.revision) accepted \(accepted) · \(workers)",
                                             actionLabel: "REVIEW START", action: .openRoom(room.id)))
                } else if runs.isEmpty, let plan = plans.first(where: { $0.status == "draft" }) {
                    result.append(DeckSignal(id: "draft:\(plan.id)", icon: "square.and.pencil", sentence: "\(room.title) has a draft plan waiting for your review.",
                                             because: "draft rev \(plan.revision) written \(clock(plan.createdAt)) · nothing runs until you accept and start",
                                             actionLabel: "REVIEW", action: .openRoom(room.id)))
                } else if let run = runs.first, run.status == "completed" {
                    let sealed = state.artifacts.filter { $0.roomId == room.id }.count
                    if sealed > 0 {
                        result.append(DeckSignal(id: "done:\(run.id)", icon: "lock.doc", sentence: "\(room.title) finished. Its results are ready to read.",
                                                 because: "run completed \(clock(run.updatedAt)) · " + (sealed == 1 ? "1 sealed output" : "\(sealed) sealed outputs"),
                                                 actionLabel: "OPEN", action: .openRoom(room.id)))
                    }
                }
            }
        }
        return Array(result.prefix(max(0, limit)))
    }

    // MARK: Operations

    static func operations(from state: HarnessState?, now: Date = Date()) -> [DeckOperation] {
        guard let state else { return [] }
        let pending = state.questions.filter { RoomsStateRules.pending($0, now: now) }
        return state.rooms.filter { $0.status != "archived" }.map { room in
            let runs = state.runs.filter { $0.roomId == room.id }.sorted { $0.createdAt > $1.createdAt }
            let plans = state.plans.filter { $0.roomId == room.id }.sorted { $0.revision > $1.revision }
            let authoring = state.authorings.contains { $0.roomId == room.id }
            let asked = pending.contains { question in
                guard case .node(_, let runId, _, _) = question.target else { return false }
                return runId == runs.first?.id
            }
            if let run = runs.first {
                let workers = run.nodes.map(worker)
                let tokens = run.usage.inputTokens + run.usage.outputTokens
                let trailing = tokens > 0 ? "\(compact(tokens)) TOK" : nil
                let done = workers.filter { $0 == .done }.count
                let progress = workers.isEmpty ? 0 : Double(done) / Double(workers.count)
                switch run.status {
                case "running":
                    if asked || workers.contains(.asking) {
                        return DeckOperation(id: room.id, title: room.title, phase: .held, workers: workers, status: "ASKS YOU", trailing: trailing, detail: nil)
                    }
                    return DeckOperation(id: room.id, title: room.title, phase: .running(progress: progress), workers: workers, status: "RUNNING",
                                         trailing: trailing, detail: run.nodes.first { $0.status == "running" }?.operation)
                case "waiting_question":
                    return DeckOperation(id: room.id, title: room.title, phase: .held, workers: workers, status: "ASKS YOU", trailing: trailing, detail: nil)
                case "paused":
                    return DeckOperation(id: room.id, title: room.title, phase: .held, workers: workers, status: "DISPATCH PAUSED", trailing: trailing, detail: nil)
                case "cancel_requested":
                    return DeckOperation(id: room.id, title: room.title, phase: .held, workers: workers, status: "STOP REQUESTED", trailing: trailing, detail: nil)
                case "completed":
                    return DeckOperation(id: room.id, title: room.title, phase: .finished(ok: true), workers: workers, status: "COMPLETED", trailing: trailing, detail: nil)
                case "cancelled":
                    return DeckOperation(id: room.id, title: room.title, phase: .finished(ok: false), workers: workers,
                                         status: run.cancelConfirmed ? "CANCELLED" : "STOP NOT CONFIRMED", trailing: trailing, detail: nil)
                default:
                    return DeckOperation(id: room.id, title: room.title, phase: .finished(ok: false), workers: workers,
                                         status: run.status.replacingOccurrences(of: "_", with: " ").uppercased(), trailing: trailing, detail: nil)
                }
            }
            if let plan = plans.first(where: { $0.status == "accepted" }) {
                return DeckOperation(id: room.id, title: room.title, phase: .ready, workers: [], status: "ACCEPTED REV \(plan.revision) · READY",
                                     trailing: "\(plan.nodes.count) WORKER\(plan.nodes.count == 1 ? "" : "S")", detail: nil)
            }
            if authoring || plans.contains(where: { $0.status == "draft" }) {
                return DeckOperation(id: room.id, title: room.title, phase: .drafting, workers: [], status: authoring ? "DRAFTING PLAN" : "PLAN AWAITS REVIEW",
                                     trailing: nil, detail: nil)
            }
            return DeckOperation(id: room.id, title: room.title, phase: .idle, workers: [], status: "NO PLAN YET", trailing: nil, detail: nil)
        }
    }

    static func worker(_ node: HarnessNodeState) -> DeckOperation.Worker {
        switch node.status {
        case "completed", "passed": return .done
        case "running": return .running
        case "waiting_question": return .asking
        case "failed", "interrupted", "cancelled": return .failed
        default: return .queued
        }
    }

    /// 1,234 → "1.2K", 46,000 → "46K", 1,250,000 → "1.3M". Never rounds a non-zero count down to zero.
    static func compact(_ count: Int) -> String {
        guard count >= 1_000 else { return String(max(0, count)) }
        let value = Double(count) / (count >= 1_000_000 ? 1_000_000 : 1_000)
        let suffix = count >= 1_000_000 ? "M" : "K"
        return value >= 10 ? "\(Int(value.rounded()))\(suffix)" : String(format: "%.1f%@", value, suffix)
    }

    // MARK: Comms

    /// The most recent exchanges in the open conversation, one line each, oldest first.
    static func comms(entries: [AssistantThreadEntry], limit: Int = 4, timeZone: TimeZone = .current) -> [DeckCommsLine] {
        var lines: [DeckCommsLine] = []
        for entry in entries {
            lines.append(DeckCommsLine(id: "\(entry.turn.id):you", time: clock(entry.turn.createdAt, timeZone: timeZone), speaker: .you, text: oneLine(entry.turn.text)))
            if let reply = entry.replies.last, let markdown = reply.content.markdown, !markdown.isEmpty {
                lines.append(DeckCommsLine(id: "\(entry.turn.id):jarvis:\(reply.revision)", time: clock(reply.updatedAt, timeZone: timeZone),
                                           speaker: .jarvis, text: oneLine(markdown)))
            } else if let error = entry.turn.error, !error.isEmpty {
                lines.append(DeckCommsLine(id: "\(entry.turn.id):error", time: clock(entry.turn.updatedAt, timeZone: timeZone), speaker: .jarvis, text: oneLine(error)))
            }
        }
        return Array(lines.suffix(max(0, limit)))
    }

    /// Markdown reduced to a single plain line for a one-row display. The full answer lives in the thread.
    static func oneLine(_ text: String) -> String {
        var line = text.replacingOccurrences(of: "\r", with: "\n").split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty && !$0.hasPrefix("```") && !$0.hasPrefix("|--") } ?? ""
        for marker in ["### ", "## ", "# ", "> ", "- ", "* "] where line.hasPrefix(marker) { line.removeFirst(marker.count); break }
        line = line.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "__", with: "").replacingOccurrences(of: "`", with: "")
        return String(line.prefix(240))
    }

    static func clock(_ stamp: String, timeZone: TimeZone = .current) -> String {
        guard let date = RoomsStateRules.date(stamp) else { return "--:--:--" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: date)
    }

    // MARK: Decisions

    /// `questions` are the ones still waiting for an answer, as `RoomsModel.questions` reports them.
    static func decisions(tasks: [AgentTask], questions: [HarnessQuestion], rooms: [HarnessRoom], proposals: [AssistantProposal]) -> [DeckDecision] {
        var result: [DeckDecision] = []
        for task in tasks {
            for approval in task.approvals {
                result.append(DeckDecision(id: "approval:\(approval.id)", kind: .approval, title: approval.title, origin: task.title, reference: approval.id))
            }
        }
        for question in questions {
            let room = rooms.first { $0.id == question.target.roomId }?.title ?? "A room"
            result.append(DeckDecision(id: "question:\(question.id)", kind: .question, title: question.question.prompt, origin: room, reference: question.id))
        }
        for proposal in proposals {
            result.append(DeckDecision(id: "proposal:\(proposal.id)", kind: .proposal, title: "Review by voice", origin: "Voice confirmation", reference: proposal.id))
        }
        return result
    }

    // MARK: Ticker and top bar

    /// The voice state as one word for "VOICE · …" lines, so the label never repeats the word voice.
    static func voiceWord(state: HarnessVoiceState, consent: Bool) -> String {
        guard consent else { return "OFF" }
        switch state {
        case .connecting: return "CONNECTING"
        case .listening: return "LISTENING"
        case .thinking: return "THINKING"
        case .speaking: return "SPEAKING"
        case .idle: return "STANDBY"
        case .interrupted: return "PAUSED"
        case .unavailable: return "UNAVAILABLE"
        }
    }

    /// The scrolling line at the foot of the HUD. Only things that are true right now.
    static func ticker(supervisor: String, connected: Bool, model: String?, voice: String, operations: [DeckOperation], decisions: Int) -> String {
        var parts = ["SERVICES \(supervisor.uppercased())", connected ? "AGENT CONNECTED" : "AGENT OFFLINE"]
        if let model, !model.isEmpty, model != "Connecting" { parts.append("MODEL \(model.uppercased())") }
        parts.append("VOICE \(voice.uppercased())")
        let running = operations.filter { if case .running = $0.phase { return true } else { return false } }.count
        let held = operations.filter { $0.phase == .held }.count
        if running > 0 { parts.append("\(running) ROOM\(running == 1 ? "" : "S") RUNNING") }
        if held > 0 { parts.append("\(held) ROOM\(held == 1 ? "" : "S") WAITING ON YOU") }
        if decisions > 0 { parts.append("\(decisions) DECISION\(decisions == 1 ? "" : "S") PENDING") }
        parts.append("STOP ALL WITH ⌘.")
        return parts.joined(separator: " · ")
    }

    /// "MON 09 NOV 2026 · W46", in the person's own calendar and time zone.
    static func dateLine(_ date: Date, calendar: Calendar = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "EEE dd MMM yyyy"
        let week = calendar.component(.weekOfYear, from: date)
        return "\(formatter.string(from: date).uppercased()) · W\(String(format: "%02d", week))"
    }

    /// hh:mm:ss since the app started.
    static func elapsed(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        return String(format: "%02d:%02d:%02d", total / 3_600, (total / 60) % 60, total % 60)
    }

    /// The first name macOS has for this account, for the brand line and speaker tags; nil if it has none.
    static func firstName(_ fullName: String) -> String? {
        let first = fullName.split(separator: " ").first.map(String.init)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return first.isEmpty ? nil : String(first.prefix(16)).uppercased()
    }
}
