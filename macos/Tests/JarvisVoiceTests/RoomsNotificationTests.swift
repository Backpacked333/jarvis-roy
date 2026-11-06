import Foundation
import XCTest
@testable import Jarvis

@MainActor
private final class RoomsNotificationServiceDouble: RoomsNotificationServing {
    var onOpen: ((String) -> Void)?
    var status: RoomsNotificationPermission = .authorized
    var permissionCalls = 0, requestCalls = 0, finishedPosts = 0
    var posted: [RoomsNotificationNotice] = []
    var removed: [String] = []
    var permissionHandler: (() async -> Bool)?
    var postHandler: (() async -> Void)?
    func permission() async -> RoomsNotificationPermission { permissionCalls += 1; return status }
    func requestPermission() async throws -> Bool { requestCalls += 1; return await permissionHandler?() ?? false }
    func post(_ notice: RoomsNotificationNotice) async throws {
        posted.append(notice)
        await postHandler?()
        finishedPosts += 1
    }
    func remove(_ identifiers: [String]) { removed.append(contentsOf: identifiers) }
}

@MainActor
final class RoomsNotificationTests: XCTestCase {
    private func target() throws -> RoomsAttentionTarget { .question(try RoomsFixture.load().authoringQuestion.binding) }
    private func until(_ predicate: () -> Bool) async {
        for _ in 0..<1_000 { if predicate() { return }; await Task.yield() }
        XCTFail("Expected notification operation did not settle")
    }

    func testDisabledAndDeniedPermissionsDoNotPostOrPromptImplicitly() async throws {
        let service = RoomsNotificationServiceDouble()
        let model = RoomsNotifications(service: service)
        model.update([try target()], suppressed: false)
        XCTAssertEqual(service.permissionCalls, 0)
        XCTAssertEqual(service.requestCalls, 0)
        XCTAssertTrue(service.posted.isEmpty)
        service.status = .denied
        await model.enable()
        XCTAssertFalse(model.enabled)
        XCTAssertEqual(model.permission, .denied)
        XCTAssertEqual(service.requestCalls, 0)
        XCTAssertTrue(service.posted.isEmpty)
    }

    func testPermissionPromptCanBeRevokedBeforeItCompletes() async throws {
        let service = RoomsNotificationServiceDouble()
        service.status = .notDetermined
        var continuation: CheckedContinuation<Bool, Never>?
        service.permissionHandler = { await withCheckedContinuation { continuation = $0 } }
        let notifications = RoomsNotifications(service: service)
        let enabling = Task { await notifications.enable() }
        await until { continuation != nil }
        notifications.disable()
        continuation?.resume(returning: true)
        await enabling.value
        XCTAssertFalse(notifications.enabled)
        XCTAssertFalse(notifications.isRequesting)
        XCTAssertTrue(service.posted.isEmpty)
    }

    func testNotificationClickIsExactAndMuteRevokesItWithoutReplay() async throws {
        let service = RoomsNotificationServiceDouble(), value = try target()
        let notifications = RoomsNotifications(service: service)
        var opened: [RoomsAttentionTarget] = []
        notifications.onOpen = { opened.append($0) }
        notifications.update([value], suppressed: false)
        await notifications.enable()
        await until { service.finishedPosts == 1 }
        await notifications.enable()
        let id = try XCTUnwrap(service.posted.first?.identifier)
        XCTAssertEqual(service.posted.count, 1)
        service.onOpen?(id)
        XCTAssertEqual(opened, [value])
        notifications.update([value], suppressed: true)
        service.onOpen?(id)
        XCTAssertEqual(opened.count, 1)
        XCTAssertTrue(service.removed.contains(id))
        notifications.update([value], suppressed: false)
        await Task.yield()
        XCTAssertEqual(service.posted.count, 1)
        notifications.disable()
    }

    func testDisableDuringPostingRemovesLateDeliveryAndCannotNavigate() async throws {
        let service = RoomsNotificationServiceDouble()
        var continuation: CheckedContinuation<Void, Never>?
        service.postHandler = { await withCheckedContinuation { continuation = $0 } }
        let notifications = RoomsNotifications(service: service)
        var opened = false
        notifications.onOpen = { _ in opened = true }
        notifications.update([try target()], suppressed: false)
        await notifications.enable()
        await until { continuation != nil }
        let id = try XCTUnwrap(service.posted.first?.identifier)
        notifications.disable()
        continuation?.resume()
        await until { service.finishedPosts == 1 }
        service.onOpen?(id)
        XCTAssertFalse(opened)
        XCTAssertTrue(service.removed.contains(id))
    }

    func testOSPermissionRevocationClearsDeliveredNotifications() async throws {
        let service = RoomsNotificationServiceDouble(), value = try target()
        let notifications = RoomsNotifications(service: service)
        notifications.update([value], suppressed: false)
        await notifications.enable()
        await until { service.finishedPosts == 1 }
        service.status = .denied
        notifications.update([value], suppressed: false)
        await until { !notifications.enabled }
        XCTAssertFalse(service.removed.isEmpty)
        XCTAssertEqual(notifications.permission, .denied)
    }
}
