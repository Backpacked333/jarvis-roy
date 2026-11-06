# Native room control center

This module consumes the frozen `HarnessContracts.swift` and
`HarnessVoiceContracts.swift`; it owns no worker, provider, approval authority or
second durable task store. Room data comes only from the authenticated bridge.
The shared app/navigation and voice implementation are deliberately outside this
module.

## Root integration

Keep one `@StateObject` / app-owned instance alive across tab changes:

```swift
let rooms = RoomsModel(client: HarnessClient())
```

Expose Rooms as a top-level destination **alongside** existing conversations,
capabilities, memory, privacy and exact approval controls. Do not replace those
screens with this view. The room rail occupies 175–218 points inside this
destination. Recommended window minimum is 1000 × 720; the full room/attention
three-column layout appears at 1240 points. Narrower layouts retain Attention as
a keyboard-accessible tab instead of hiding it.

```swift
RoomsWorkspaceView(
    model: rooms,
    onVoiceContext: { context in capturedRoomContext = context },
    onSpeakQuestion: { question in
        voice.speak(question.question.prompt, context: HarnessVoiceContext(
            roomId: question.target.roomId,
            conversationId: nil,
            question: question.binding
        ))
    },
    onReviewApproval: { approval in
        // Navigate to the EXISTING card for taskId + interactionId + revision.
        // Do not answer or approve here. Revalidate the original card there.
        showExistingApproval(approval)
    }
)
```

The symbols `capturedRoomContext` and `showExistingApproval` above are parent-owned
composition hooks, not additional globals or services supplied by this module.
SwiftPM discovers the `.swift` sources automatically. Exclude `Rooms/README.md`
from the executable target's resources, or relocate this document into `docs/`
during integration, to avoid SwiftPM's unhandled-file warning.

The view polls only while it is mounted and its scene is active: 2 seconds with
active work, 6 seconds idle, backoff up to 15 seconds disconnected. Do not start a
second polling timer in AppModel. Parent may explicitly call `refresh()` after
external approval changes. Events are bounded invalidations; the model never
reconstructs state from event payloads. Duplicate cursors do not replay speech.

## Voice wiring and consent

On the main actor, connect the existing `HarnessVoiceControlling` implementation:

```swift
voice.onAudioLevels = { [weak rooms] in rooms?.updateAudioLevels($0) }
voice.onStateChange = { [weak rooms] in rooms?.updateVoiceState($0) }
voice.onUtterance = { [weak rooms] utterance in
    if utterance.context.roomId != nil || utterance.context.question != nil {
        Task { await rooms?.handleUtterance(utterance) }
    } else {
        // Existing SAFE conversation route using utterance.context.conversationId.
        // Never use whichever conversation happens to be selected now.
    }
}
voice.contextProvider = {
    // Choose based on the active top-level destination at capture start.
    // Return rooms.voiceContext in Rooms; an exact conversation context elsewhere.
    currentCaptureContext()
}
```

The voice lane snapshots `contextProvider` before asynchronous recognition.
Do not rebuild a received utterance from current selection. Questions use exact
room/run/node/attempt or authoring targets; no question is guessed from “yes.”
With a question context, `handleUtterance` calls only `/voice-answer`; without a
question but with a room it requests a draft, never accepts/starts/approves.
No-room utterances are intentionally not handled by this model. Disable the
legacy `onCommand` submission path when `onUtterance` is installed.

Keep an explicit premium-voice consent/start/mute control in the app shell. The
voice lane's `setCloudConsent(true)` is allowed only after the user opts in to
ElevenLabs microphone upload for the session; do not enable it just because Rooms
appears or “Read new questions aloud” is enabled. That toggle grants spoken
attention only, not microphone access. No provider key is requested by this UI.
No fallback voice is selected. A missing key, unsupported model or device loss
must enter `.unavailable` visibly. Stop-all must stop/interrupt the voice port as
well as request cancellation of runs and existing tasks. An unavailable root
voice control must not imply the room UI has started capturing.

The model resets its level generation on `.connecting`; the transport must still
reject old-session callbacks before forwarding levels (the frozen level DTO has
no session ID). Audio history/rings are driven solely by actual RMS callbacks,
never a timer or a task-progress value. Reduced motion disables level interpolation.
Idle rendering has no animation clock.

## Safety and lifecycle

* Client origin is fixed to `http://127.0.0.1:39202`; the token comes from
  `JARVIS_LOCAL_TOKEN`. No credentials in URLs, cookies or an artifact webview.
  Redirects are refused, responses are byte-bounded and unsupported versions fail.
* Draft save, accept and start are three separate operations. Mutations use the
  reviewed revision; no automatic retry after 409 or uncertain cancellation.
  Explicit repeated uncertain starts reuse the same in-memory request ID.
* Questions remain pending while a request is in flight. Answers require the
  exact pending, unexpired binding; stale captures cannot retarget another prompt.
  Approval review only invokes the supplied navigation callback. Root ambient
  text/voice must still be blocked while Eve prompts are pending.
* Pausing prevents dispatch; it does not stop active workers. Cancellation is
  labeled requested until confirmed. Retry names the exact old attempt and the
  kernel must confirm it stopped before dispatching another.
* Policy edits apply to future work; run cards show each saved policy snapshot.
  Dollars are estimates, not billing enforcement. Unknown usage is not zero.
* Artifact downloads carry exact room/run/manifest digest and path. Byte count and
  file SHA256 must match before the bytes reach the inspector. UTF-8 source up to
  256 KiB is displayed as literal selectable text, including HTML. Larger/binary
  files may be saved explicitly; no file is opened, executed or rendered as HTML.
* The module states that local work stops during Mac sleep/shutdown. There is no
  always-on or remote execution claim.

## Verification

On a Mac with the integrated revision, run from the repository root:

```sh
swift test --package-path macos --filter Rooms
swift test --package-path macos
./scripts/setup-macos.sh
./scripts/run-macos.sh
```

Run the app's ordinary consent/approval flow; never bypass TCC. The native suite
includes client decoding/URL/null/hash checks and injected-service model tests for
stale responses, cursor reset/dedupe, captured context, pending confirmation,
quiet attention, explicit controls and actual audio-level state. The synthetic
shared fixture exists only in tests; it is never seeded into the UI.

Linux syntax parsing and Foundation-only state tests do **not** verify SwiftUI,
Combine, AppKit, URLSession AsyncBytes on Darwin, audio hardware or actual provider
access. Native compile and recorded UI acceptance remain separate requirements.
