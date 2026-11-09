import AppKit
import Carbon

/// A registered macOS hot key needs no global keyboard monitoring or Accessibility permission.
@MainActor
final class SummonShortcut {
    private var hotKey: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    var action: (() -> Void)?

    func register() {
        guard hotKey == nil else { return }
        var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, context in
            guard let context else { return OSStatus(eventNotHandledErr) }
            let owner = Unmanaged<SummonShortcut>.fromOpaque(context).takeUnretainedValue()
            Task { @MainActor in owner.action?() }
            return noErr
        }, 1, &type, context, &eventHandler)
        guard installed == noErr else { return }
        let identifier = EventHotKeyID(signature: OSType(0x4A415256), id: 1)
        let status = RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey), identifier,
                                        GetApplicationEventTarget(), 0, &hotKey)
        if status != noErr {
            if let eventHandler { RemoveEventHandler(eventHandler) }
            eventHandler = nil
            RuntimeDiagnostics.shared.record("summon_shortcut_unavailable")
        }
    }

    func unregister() {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let eventHandler { RemoveEventHandler(eventHandler) }
        hotKey = nil
        eventHandler = nil
    }
}
