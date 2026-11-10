import Foundation
import Combine
import OSLog

struct RuntimeDiagnostic: Identifiable {
    let id = UUID()
    let date = Date()
    let code: String
    let role: String
    let durationMilliseconds: Double?
}

enum RuntimeDiagnosticPolicy {
    static let maximumDurationMilliseconds = 600_000.0
    static let codes: Set<String> = [
        "startup_begin", "startup_ready", "startup_failed", "model_catalog_missing", "process_started", "process_exited",
        "shutdown_confirmed", "shutdown_unconfirmed", "shutdown_recovered", "restart_reconcile", "restart_limit", "forced_process_stop",
        "local_credentials_invalid", "summon_shortcut_unavailable", "briefing_dispatched", "briefing_unconfirmed", "briefing_journal_unavailable",
        "voice_speech_requested", "voice_first_pcm", "voice_playback_scheduled", "voice_first_output_rendered",
        "voice_interrupt_complete", "voice_barge_in_stop_complete", "voice_capture_requested", "voice_capture_ready",
        "session_local_feedback", "session_event_applied",
    ]
    static let roles: Set<String> = ["app", "runtime", "bridge", "voice", "session"]

    static func validDuration(_ value: Double) -> Bool {
        value.isFinite && value >= 0 && value <= maximumDurationMilliseconds
    }

    /// Monotonic uptime only. Reject clock resets and invalid samples rather than reporting misleading values.
    static func elapsedMilliseconds(from start: TimeInterval, to end: TimeInterval) -> Double? {
        guard start.isFinite, end.isFinite, start >= 0, end >= start else { return nil }
        let value = (end - start) * 1_000
        return validDuration(value) ? value : nil
    }
}

/// One bounded trace per current generation; no session IDs or spoken content are retained.
struct RuntimeLatencySpan {
    enum Milestone: Hashable { case firstPCM, playbackScheduled, firstOutputRendered, captureReady }
    let generation: Int
    let startedAt: TimeInterval
    private var completed: Set<Milestone> = []

    init(generation: Int, startedAt: TimeInterval) { self.generation = generation; self.startedAt = startedAt }

    mutating func finish(_ milestone: Milestone, generation: Int, at time: TimeInterval) -> Double? {
        guard generation == self.generation, !completed.contains(milestone),
              let elapsed = RuntimeDiagnosticPolicy.elapsedMilliseconds(from: startedAt, to: time) else { return nil }
        completed.insert(milestone)
        return elapsed
    }
}

@MainActor
final class RuntimeDiagnostics: ObservableObject {
    static let shared = RuntimeDiagnostics()
    @Published private(set) var entries: [RuntimeDiagnostic] = []
    private let logger = Logger(subsystem: "ai.backpacked.jarvisroy", category: "diagnostics")

    /// Reject unrecognized labels so accidental provider output cannot enter public logs.
    @discardableResult
    func record(_ code: String, role: String = "app", durationMilliseconds: Double? = nil) -> Bool {
        guard RuntimeDiagnosticPolicy.codes.contains(code), RuntimeDiagnosticPolicy.roles.contains(role),
              durationMilliseconds.map(RuntimeDiagnosticPolicy.validDuration) ?? true else { return false }
        entries.append(RuntimeDiagnostic(code: code, role: role, durationMilliseconds: durationMilliseconds))
        if entries.count > 100 { entries.removeFirst(entries.count - 100) }
        if let durationMilliseconds {
            logger.info("event=\(code, privacy: .public) role=\(role, privacy: .public) duration_ms=\(durationMilliseconds, privacy: .public)")
        } else {
            logger.info("event=\(code, privacy: .public) role=\(role, privacy: .public)")
        }
        return true
    }

    func elapsed(_ code: String, role: String, since start: TimeInterval, at end: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        guard let elapsed = RuntimeDiagnosticPolicy.elapsedMilliseconds(from: start, to: end) else { return }
        record(code, role: role, durationMilliseconds: elapsed)
    }
}
