import Combine
import Foundation
import UserNotifications

enum RoomsNotificationPermission: String { case notDetermined, denied, authorized, unavailable }

@MainActor
protocol RoomsNotificationServing: AnyObject {
    var onOpen: ((String) -> Void)? { get set }
    func permission() async -> RoomsNotificationPermission
    func requestPermission() async throws -> Bool
    func post(_ notice: RoomsNotificationNotice) async throws
    func remove(_ identifiers: [String])
}

@MainActor
final class RoomsSystemNotifications: NSObject, RoomsNotificationServing, UNUserNotificationCenterDelegate {
    var onOpen: ((String) -> Void)?
    private var prepared = false
    private var center: UNUserNotificationCenter? {
        guard Bundle.main.bundleURL.pathExtension == "app", Bundle.main.bundleIdentifier != nil else { return nil }
        return UNUserNotificationCenter.current()
    }

    func permission() async -> RoomsNotificationPermission {
        guard let center else { return .unavailable }
        if let delegate = center.delegate, delegate !== self { return .unavailable }
        center.delegate = self
        if !prepared {
            prepared = true
            let pending = await center.pendingNotificationRequests().map(\.identifier)
            let delivered = await center.deliveredNotifications().map { $0.request.identifier }
            remove((pending + delivered).filter { $0.hasPrefix("jarvis.rooms.") })
        }
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional: return .authorized
        case .notDetermined: return .notDetermined
        default: return .denied
        }
    }

    func requestPermission() async throws -> Bool {
        guard let center else { return false }
        return try await center.requestAuthorization(options: [.alert])
    }

    func post(_ notice: RoomsNotificationNotice) async throws {
        guard let center else { throw RoomsError.invalid("Native notifications require the bundled Jarvis app.") }
        guard center.delegate === self else { throw RoomsError.invalid("The app's notification delegate changed. Review the text inbox instead.") }
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.categoryIdentifier = "jarvis.rooms.review-only"
        try await center.add(UNNotificationRequest(identifier: notice.identifier, content: content, trigger: nil))
    }

    func remove(_ identifiers: [String]) {
        guard !identifiers.isEmpty, let center else { return }
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let identifier = response.notification.request.identifier
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            Task { @MainActor [weak self] in self?.onOpen?(identifier) }
        }
        completionHandler()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([])
    }
}

@MainActor
final class RoomsNotifications: ObservableObject {
    @Published private(set) var enabled = false
    @Published private(set) var permission: RoomsNotificationPermission = .notDetermined
    @Published private(set) var isRequesting = false
    @Published private(set) var error: String?
    var onOpen: ((RoomsAttentionTarget) -> Void)?
    private let service: any RoomsNotificationServing
    private var ledger = RoomsNotificationLedger()
    private var targets: [RoomsAttentionTarget] = []
    private var suppressed = false
    private var generation = 0
    private var syncTask: Task<Void, Never>?
    private var needsUpdate = false

    init(service: (any RoomsNotificationServing)? = nil) {
        self.service = service ?? RoomsSystemNotifications()
        self.service.onOpen = { [weak self] identifier in
            guard let self, self.enabled, !self.suppressed,
                  let target = self.ledger.target(for: identifier), self.targets.contains(target) else { return }
            self.onOpen?(target)
        }
    }

    func enable() async {
        guard !enabled, !isRequesting else { return }
        generation += 1
        let token = generation
        isRequesting = true
        defer { if token == generation { isRequesting = false } }
        var status = await service.permission()
        guard token == generation else { return }
        do {
            if status == .notDetermined {
                let granted = try await service.requestPermission()
                status = granted ? .authorized : .denied
            }
            guard token == generation else { return }
            permission = status
            enabled = status == .authorized
            error = enabled ? nil : "Notifications are off. The text inbox remains available; use System Settings to change denied permission."
            update(targets, suppressed: suppressed)
        } catch {
            guard token == generation else { return }
            self.error = "Notifications could not be enabled. The text inbox remains available."
        }
    }

    func disable() {
        generation += 1
        enabled = false
        isRequesting = false
        syncTask?.cancel(); syncTask = nil
        service.remove(ledger.reconcile(targets, enabled: false).removed)
    }

    func update(_ targets: [RoomsAttentionTarget], suppressed: Bool) {
        self.targets = Array(targets.prefix(256))
        if self.suppressed != suppressed {
            generation += 1
            syncTask?.cancel(); syncTask = nil
        }
        self.suppressed = suppressed
        if !enabled || suppressed {
            service.remove(ledger.reconcile(self.targets, enabled: false).removed)
            return
        }
        needsUpdate = true
        guard syncTask == nil else { return }
        let token = generation
        syncTask = Task { [weak self] in
            guard let self else { return }
            defer { if token == self.generation { self.syncTask = nil } }
            while self.needsUpdate && token == self.generation && !Task.isCancelled {
                self.needsUpdate = false
                await self.synchronize(token)
            }
        }
    }

    private func synchronize(_ token: Int) async {
        let status = await service.permission()
        guard token == generation, enabled, !suppressed, !Task.isCancelled else { return }
        permission = status
        if status != .authorized {
            disable()
            error = "Notification permission is no longer available. The text inbox remains available."
            return
        }
        let changes = ledger.reconcile(targets, enabled: true)
        service.remove(changes.removed)
        for notice in changes.added {
            guard token == generation, enabled, !suppressed, targets.contains(notice.target), !Task.isCancelled else {
                ledger.failed(notice.identifier)
                continue
            }
            do {
                try await service.post(notice)
                if token != generation || !enabled || suppressed || !targets.contains(notice.target) || Task.isCancelled {
                    service.remove([notice.identifier])
                    ledger.failed(notice.identifier)
                }
            } catch {
                service.remove([notice.identifier])
                ledger.failed(notice.identifier)
                if token == generation { self.error = "A notification could not be delivered. Review the text inbox instead." }
            }
        }
    }
}
