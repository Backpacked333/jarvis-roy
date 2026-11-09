import Foundation
import EventKit
import XCTest
@testable import JarvisControl

final class ScopedReadTests: XCTestCase {
    func testNativeTitlesRespectUTF16WireBoundsWithoutSplittingCharacters() {
        XCTAssertEqual(boundedWireString("A🙂B", limit: 3), "A🙂")
        XCTAssertEqual(boundedWireString("A🙂B", limit: 2), "A")
        XCTAssertEqual(boundedWireString(String(repeating: "🙂", count: 300), limit: 500).utf16.count, 500)
    }
    func testCalendarAccessStatusNeverTreatsWriteOnlyOrUndeterminedAsReadable() {
        XCTAssertTrue(calendarAccessStatus(.fullAccess).canRead)
        XCTAssertEqual(calendarAccessStatus(.fullAccess).name, "authorized")
        for status in [EKAuthorizationStatus.notDetermined, .denied, .restricted, .writeOnly] {
            XCTAssertFalse(calendarAccessStatus(status).canRead)
        }
    }
    private func request(_ fields: [String: Any]) throws -> Request {
        var body: [String: Any] = ["version": 1]
        body.merge(fields) { _, value in value }
        return try JSONDecoder().decode(Request.self, from: JSONSerialization.data(withJSONObject: body))
    }

    private var windowFields: [String: Any] {
        ["operation": "read_window", "bundleId": "com.example.Editor", "windowId": 42,
         "expectedProcessId": 123, "expectedLaunchTimestamp": 1_700_000_000.25]
    }

    func testWindowIdentityRequiresExplicitWindowProcessAndLaunch() throws {
        let scope = try WindowScope(request(windowFields))
        XCTAssertEqual(scope.windowId, 42)
        try scope.validate(bundleId: "com.example.Editor", windowId: 42, processId: 123, launchTimestamp: 1_700_000_000.25)
        for field in ["bundleId", "windowId", "expectedProcessId", "expectedLaunchTimestamp"] {
            var fields = windowFields
            fields.removeValue(forKey: field)
            XCTAssertThrowsError(try WindowScope(request(fields)))
        }
        for field in ["windowId", "expectedProcessId", "expectedLaunchTimestamp"] {
            var fields = windowFields; fields[field] = 0
            XCTAssertThrowsError(try WindowScope(request(fields)))
        }
    }

    func testWindowCannotRetargetAnotherAppWindowOrRelaunchedProcess() throws {
        let scope = try WindowScope(request(windowFields))
        let candidates: [(String?, UInt32, Int32, Double?)] = [
            ("com.example.Other", 42, 123, 1_700_000_000.25),
            ("com.example.Editor", 43, 123, 1_700_000_000.25),
            ("com.example.Editor", 42, 124, 1_700_000_000.25),
            ("com.example.Editor", 42, 123, 1_700_000_001),
            (nil, 42, 123, 1_700_000_000.25),
            ("com.example.Editor", 42, 123, nil),
        ]
        for (bundle, window, process, launch) in candidates {
            XCTAssertThrowsError(try scope.validate(bundleId: bundle, windowId: window, processId: process, launchTimestamp: launch)) { error in
                XCTAssertEqual((error as? ControlFailure)?.code, "WINDOW_CHANGED")
            }
        }
    }

    private var calendarFields: [String: Any] {
        ["operation": "list_calendar_events", "calendarId": "selected-calendar",
         "start": "2026-11-01T00:00:00Z", "end": "2026-11-08T00:00:00Z", "limit": 50]
    }

    func testCalendarQueryRequiresExactCalendarBoundedDatesAndLimit() throws {
        let query = try CalendarQuery(request(calendarFields))
        XCTAssertEqual(query.calendarId, "selected-calendar")
        XCTAssertEqual(query.limit, 50)
        for field in ["calendarId", "start", "end", "limit"] {
            var fields = calendarFields; fields.removeValue(forKey: field)
            XCTAssertThrowsError(try CalendarQuery(request(fields)))
        }
        let invalidFields: [(String, Any)] = [("calendarId", ""), ("start", "2026-11-01T00:00:00"),
                                              ("end", "2027-01-01T00:00:00Z"), ("end", "2026-11-01T00:00:00Z"),
                                              ("limit", 0), ("limit", 51)]
        for (field, value) in invalidFields {
            var fields = calendarFields; fields[field] = value
            XCTAssertThrowsError(try CalendarQuery(request(fields)))
        }
        XCTAssertEqual(CalendarQuery.date("2026-11-01T01:00:00+01:00"), query.start)
        XCTAssertEqual(CalendarQuery.date("2026-11-01T00:00:00.000Z"), query.start)
    }

    func testRecurringOccurrencesHaveDistinctStableScopedIdentifiers() throws {
        let start = try XCTUnwrap(CalendarQuery.date("2026-11-02T09:00:00Z"))
        let occurrence = CalendarOccurrence(calendarId: "selected-calendar", eventId: "series",
                                            title: "Weekly seminar", start: start, end: start.addingTimeInterval(3600), isAllDay: false)
        let next = CalendarOccurrence(calendarId: occurrence.calendarId, eventId: occurrence.eventId,
                                      title: occurrence.title, start: start.addingTimeInterval(86400), end: start.addingTimeInterval(90000), isAllDay: false)
        let other = CalendarOccurrence(calendarId: "other-calendar", eventId: occurrence.eventId,
                                       title: occurrence.title, start: start, end: occurrence.end, isAllDay: false)
        let renamed = CalendarOccurrence(calendarId: occurrence.calendarId, eventId: occurrence.eventId,
                                         title: "Updated seminar title", start: start, end: occurrence.end, isAllDay: false)
        XCTAssertEqual(occurrence.occurrenceId, renamed.occurrenceId)
        XCTAssertEqual(occurrence.occurrenceId.count, 64)
        XCTAssertNotEqual(occurrence.occurrenceId, next.occurrenceId)
        XCTAssertNotEqual(occurrence.occurrenceId, other.occurrenceId)
        let query = try CalendarQuery(request(calendarFields))
        let result = boundedCalendarOccurrences([next, other, occurrence, occurrence], query: query)
        XCTAssertEqual(result.events.count, 2)
        XCTAssertEqual(result.events[0]["occurrenceId"] as? String, occurrence.occurrenceId)
        XCTAssertFalse(result.truncated)
    }

    func testCalendarRangeIncludesOverlapsAndLimitsOccurrencesAfterSorting() throws {
        var fields = calendarFields; fields["limit"] = 1
        let query = try CalendarQuery(request(fields))
        func occurrence(_ id: String, _ start: Date, _ end: Date) -> CalendarOccurrence {
            CalendarOccurrence(calendarId: query.calendarId, eventId: id, title: id, start: start, end: end, isAllDay: false)
        }
        let overlap = occurrence("overlap", query.start.addingTimeInterval(-3600), query.start.addingTimeInterval(3600))
        let boundary = occurrence("boundary", query.end, query.end.addingTimeInterval(3600))
        let later = occurrence("later", query.start.addingTimeInterval(86400), query.start.addingTimeInterval(90000))
        let result = boundedCalendarOccurrences([boundary, later, overlap], query: query)
        XCTAssertEqual(result.events.count, 1)
        XCTAssertEqual(result.events[0]["eventId"] as? String, "overlap")
        XCTAssertTrue(result.truncated)
    }
}
