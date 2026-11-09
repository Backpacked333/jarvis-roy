import EventKit
import Foundation

struct CalendarQuery {
    let calendarId: String
    let start: Date
    let end: Date
    let limit: Int

    init(_ request: Request) throws {
        guard let id = request.calendarId, !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              id.utf8.count <= 256,
              let start = request.start.flatMap(Self.date), let end = request.end.flatMap(Self.date),
              start < end, end.timeIntervalSince(start) <= 31 * 24 * 60 * 60,
              let limit = request.limit, (1...50).contains(limit) else {
            throw ControlFailure("INVALID_REQUEST", "Select an exact EventKit calendarId, timezone-qualified ISO-8601 start/end no more than 31 days apart, and a limit from 1 to 50.")
        }
        calendarId = id; self.start = start; self.end = end; self.limit = limit
    }

    static func date(_ value: String) -> Date? {
        guard value.utf8.count <= 64,
              value.range(of: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$", options: .regularExpression) != nil else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    func includes(start: Date, end: Date) -> Bool {
        start < self.end && (end > self.start || (start == end && start >= self.start))
    }
}

func calendarTimestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

struct CalendarOccurrence {
    let calendarId: String
    let eventId: String
    let title: String
    let start: Date
    let end: Date
    let isAllDay: Bool

    var occurrenceId: String {
        // A recurring series can share an event ID. Bind the occurrence to its
        // actual start, retaining calendar scope across otherwise equal IDs.
        let components = [calendarId, eventId, calendarTimestamp(start)]
        return sha(Data(components.map { "\($0.utf8.count):\($0)" }.joined().utf8))
    }

    var response: [String: Any] {
        ["occurrenceId": occurrenceId, "calendarId": calendarId, "eventId": eventId,
         "title": boundedWireString(title, limit: 500), "start": calendarTimestamp(start),
         "end": calendarTimestamp(end), "isAllDay": isAllDay]
    }
}

func boundedCalendarOccurrences(_ occurrences: [CalendarOccurrence], query: CalendarQuery) -> (events: [[String: Any]], truncated: Bool) {
    var seen = Set<String>()
    let scoped = occurrences.filter { occurrence in
        occurrence.calendarId == query.calendarId && query.includes(start: occurrence.start, end: occurrence.end)
    }.sorted { left, right in
        if left.start != right.start { return left.start < right.start }
        return left.occurrenceId < right.occurrenceId
    }.filter { seen.insert($0.occurrenceId).inserted }
    return (Array(scoped.prefix(query.limit)).map(\.response), scoped.count > query.limit)
}

private func calendarStore() throws -> EKEventStore {
    // EventKit provides no read-only OS authorization. Full access is needed to
    // read, but this helper exposes no EventKit mutation operations and never
    // prompts from a read. Permission setup must be an explicit user flow.
    guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
        throw ControlFailure("CALENDAR_PERMISSION", "EventKit calendar reading requires Full Access for the responsible Jarvis app/helper in System Settings → Privacy & Security → Calendars. No calendar data was read and no permission prompt was opened. Complete explicit calendar permission setup, then retry.")
    }
    return EKEventStore()
}

func calendarAccessStatus(_ status: EKAuthorizationStatus) -> (name: String, canRead: Bool) {
    switch status {
    case .fullAccess: return ("authorized", true)
    case .denied: return ("denied", false)
    case .restricted: return ("restricted", false)
    case .writeOnly: return ("write_only", false)
    case .notDetermined: return ("not_determined", false)
    @unknown default: return ("not_determined", false)
    }
}

@MainActor
func requestCalendarAccess(deadline: Deadline) async throws -> [String: Any] {
    let status = EKEventStore.authorizationStatus(for: .event)
    if status == .notDetermined || status == .writeOnly {
        let store = EKEventStore()
        do { _ = try await store.requestFullAccessToEvents() }
        catch {
            throw ControlFailure("CALENDAR_PERMISSION", "macOS could not complete calendar permission setup. Check Privacy & Security → Calendars, then explicitly retry setup.")
        }
    }
    do { try deadline.check() }
    catch {
        throw ControlFailure("CALENDAR_PERMISSION_TIMEOUT", "Calendar permission request timed out. Respond to the macOS prompt, then explicitly retry calendar setup.")
    }
    let access = calendarAccessStatus(EKEventStore.authorizationStatus(for: .event))
    return ["kind": "calendar_access", "status": access.name, "canRead": access.canRead,
            "detail": access.canRead
                ? "Calendar access is available. Jarvis reads only your selected calendar and date range; this helper does not modify events."
                : "Calendar reading requires Full Access. In System Settings → Privacy & Security → Calendars, enable the responsible Jarvis Control app/helper, then explicitly retry setup."]
}

@MainActor
func listCalendars(deadline: Deadline) throws -> [String: Any] {
    let store = try calendarStore()
    try deadline.check()
    let calendars = store.calendars(for: .event).sorted { $0.calendarIdentifier < $1.calendarIdentifier }
    guard calendars.allSatisfy({ !$0.calendarIdentifier.isEmpty && $0.calendarIdentifier.utf8.count <= 256 }) else {
        throw ControlFailure("CALENDAR_DATA", "A calendar could not be identified within the supported identifier bounds. No incomplete result is reported.")
    }
    try deadline.check()
    let rows: [[String: Any]] = calendars.prefix(100).map { calendar in
        ["calendarId": calendar.calendarIdentifier, "title": boundedWireString(calendar.title, limit: 256),
         "sourceTitle": boundedWireString(calendar.source.title, limit: 256)]
    }
    return ["kind": "calendars", "calendars": rows, "truncated": calendars.count > rows.count]
}

@MainActor
func listCalendarEvents(_ request: Request, deadline: Deadline) throws -> [String: Any] {
    let query = try CalendarQuery(request)
    let store = try calendarStore()
    try deadline.check()
    guard let calendar = store.calendar(withIdentifier: query.calendarId), calendar.allowedEntityTypes.contains(.event) else {
        throw ControlFailure("CALENDAR_UNAVAILABLE", "The exact selected EventKit calendar is unavailable. List calendars again; no other calendar was searched.")
    }
    // EventKit expands recurring instances in this bounded date interval. Do not
    // look up a series with event(withIdentifier:) and mistake it for all events.
    let predicate = store.predicateForEvents(withStart: query.start, end: query.end, calendars: [calendar])
    let matches = store.events(matching: predicate)
    try deadline.check()
    let occurrences = try matches.map { event -> CalendarOccurrence in
        guard let eventCalendar = event.calendar, eventCalendar.calendarIdentifier == query.calendarId,
              !event.calendarItemIdentifier.isEmpty, event.calendarItemIdentifier.utf8.count <= 256,
              let start = event.startDate, let end = event.endDate, start <= end else {
            throw ControlFailure("CALENDAR_DATA", "Calendar occurrences changed or could not be identified safely. No incomplete result is reported; refresh and retry.")
        }
        return CalendarOccurrence(calendarId: query.calendarId, eventId: event.calendarItemIdentifier,
                                  title: event.title ?? "", start: start, end: end, isAllDay: event.isAllDay)
    }
    let result = boundedCalendarOccurrences(occurrences, query: query)
    try deadline.check()
    return ["kind": "calendar_events", "calendarId": query.calendarId,
            "start": calendarTimestamp(query.start), "end": calendarTimestamp(query.end),
            "events": result.events, "truncated": result.truncated]
}
