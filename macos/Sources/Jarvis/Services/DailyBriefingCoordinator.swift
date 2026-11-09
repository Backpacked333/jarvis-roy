import AppKit
import Combine
import CoreGraphics
import Foundation

struct DailyBriefingPolicy {
    static func dueKey(now: Date, hour: Int, minute: Int, projectID: String,
                       calendar: Calendar = .current) -> String? {
        guard (0...23).contains(hour), (0...59).contains(minute),
              projectID.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$", options: .regularExpression) != nil else { return nil }
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: now)
        guard let year = parts.year, let month = parts.month, let day = parts.day,
              let currentHour = parts.hour, let currentMinute = parts.minute,
              currentHour * 60 + currentMinute >= hour * 60 + minute else { return nil }
        return "\(projectID):\(year)-\(month)-\(day)"
    }
}

@MainActor
final class DailyBriefingCoordinator: ObservableObject {
    static let shared = DailyBriefingCoordinator()
    @Published private(set) var status = "Daily briefing is off."
    private var loop: Task<Void, Never>?
    private var prepare: ((String) async -> Bool)?
    private var busy = false
    private struct Attempt: Codable { let date: Date; var state: String }
    private struct Journal: Codable { let version: Int; var attempts: [String: Attempt] }

    func start(prepare: @escaping (String) async -> Bool) {
        self.prepare = prepare
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.check()
                do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
            }
        }
    }

    func stop() { loop?.cancel(); loop = nil; prepare = nil }

    private func check() async {
        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: "Jarvis.dailyBriefingEnabled") else { status = "Daily briefing is off."; return }
        guard !busy, let prepare else { return }
        guard RuntimeSupervisor.shared.state == .ready, NSApp.isActive,
              let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              session["kCGSessionOnConsoleKey"] as? Bool == true,
              session["CGSSessionScreenIsLocked"] as? Bool != true else {
            status = "Waiting until Jarvis is active and your Mac is awake and unlocked."
            return
        }
        let projectID = defaults.string(forKey: "Jarvis.dailyBriefingProjectID") ?? ""
        let hour = defaults.object(forKey: "Jarvis.dailyBriefingHour") == nil ? 9 : defaults.integer(forKey: "Jarvis.dailyBriefingHour")
        let minute = defaults.integer(forKey: "Jarvis.dailyBriefingMinute")
        guard let key = DailyBriefingPolicy.dueKey(now: Date(), hour: hour, minute: minute, projectID: projectID) else {
            status = projectID.isEmpty ? "Choose a project with cloud-enabled read grants in Settings." : "Waiting for your scheduled local time."
            return
        }
        busy = true
        defer { busy = false }
        do {
            var journal = try readJournal()
            if let attempt = journal.attempts[key] {
                status = attempt.state == "submitted" ? "Today's briefing was requested in its project. Review its actual result there." :
                    "Today's preparation was not confirmed. Ask Jarvis explicitly to prepare a briefing after inspecting its work."
                return
            }
            // Reserve durably before making a provider-backed request. A crash never silently retries it.
            journal.attempts[key] = Attempt(date: Date(), state: "dispatched")
            try saveJournal(journal)
            status = "Preparing a draft briefing from your project's permitted sources…"
            let prepared = await prepare(projectID)
            journal.attempts[key]?.state = prepared ? "submitted" : "unconfirmed"
            try saveJournal(journal)
            status = prepared ? "Briefing requested in its project. Review the actual result there; no actions were sent." :
                "A briefing could not be confirmed. Check source grants and project state; no automatic retry is scheduled today."
            RuntimeDiagnostics.shared.record(prepared ? "briefing_dispatched" : "briefing_unconfirmed")
        } catch {
            status = "Briefing scheduling is paused because its local journal could not be verified. No new preparation was started."
            RuntimeDiagnostics.shared.record("briefing_journal_unavailable")
        }
    }

    private var directory: URL {
        if let path = ProcessInfo.processInfo.environment["JARVIS_DATA_DIR"], path.hasPrefix("/") { return URL(fileURLWithPath: path) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/JarvisRoy")
    }

    private func readJournal() throws -> Journal {
        let file = directory.appendingPathComponent("briefing-schedule.json")
        guard FileManager.default.fileExists(atPath: file.path) else { return Journal(version: 1, attempts: [:]) }
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              ((attributes[.size] as? NSNumber)?.intValue ?? Int.max) <= 128 * 1_024 else { throw CocoaError(.fileReadCorruptFile) }
        let journal = try JSONDecoder().decode(Journal.self, from: Data(contentsOf: file))
        guard journal.version == 1 else { throw CocoaError(.fileReadCorruptFile) }
        return journal
    }

    private func saveJournal(_ journal: Journal) throws {
        var retained = journal
        let oldest = retained.attempts.sorted { $0.value.date < $1.value.date }
        for (key, _) in oldest.prefix(max(0, oldest.count - 90)) { retained.attempts.removeValue(forKey: key) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = directory.appendingPathComponent("briefing-schedule.json")
        try JSONEncoder().encode(retained).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.synchronize()
    }
}
