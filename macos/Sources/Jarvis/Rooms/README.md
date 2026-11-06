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
    },
    observationOwnership: .application
)
```

The symbols `capturedRoomContext` and `showExistingApproval` above are parent-owned
composition hooks, not additional globals or services supplied by this module.
SwiftPM discovers the `.swift` sources automatically. Exclude `Rooms/README.md`
from the executable target's resources, or relocate this document into `docs/`
during integration, to avoid SwiftPM's unhandled-file warning.

### One observer across navigation and other apps

The app shell owns the durable model, not the Rooms destination. Start exactly
one application owner after wiring its callbacks:

```swift
rooms.startObserving() // default owner: .application; repeated starts are idempotent
rooms.setApplicationActive(isApplicationActive)
// Forward subsequent app/scene activation changes to setApplicationActive.
// At app shutdown:
rooms.shutdown()
```

Use `observationOwnership: .application` as above. The view then neither starts
nor stops observation and never overrides the app's foreground state. Do not
create another timer. `startObserving(owner:)`/`stopObserving(owner:)` share one
loop, so even a legacy workspace owner cannot stop an application owner. The
default `.workspace` view ownership remains usable standalone, but it ends when
the view disappears. Background polling is 15 seconds; foreground polling is
2 seconds with active work or 6 seconds idle, with disconnected backoff capped at
30 seconds. Activation refreshes immediately. Local Mac sleep still stops work
and delivery; these are not remote or guaranteed real-time notifications.

Parent may explicitly call `refresh()` after external approvals. Events are
bounded invalidations, not another durable store. Unchanged-event polls still
expire/revoke attention. Background RMS callbacks do not publish UI history.

### Exact proactive attention callback

Wire these on the main actor before calling `startObserving()`:

```swift
rooms.onQuestionAttention = { [weak rooms] notice in
    guard let rooms, rooms.canSpeak(notice) else { return false }
    // Track this exact binding as the owner of this playback in the app shell.
    currentQuestionPlayback = notice.binding
    voice.speak(notice.question.question.prompt, context: notice.context)
    return true
}
rooms.onQuestionAttentionRevoked = { binding in
    // Never stop unrelated conversation speech or a newer question's playback.
    if currentQuestionPlayback == binding {
        currentQuestionPlayback = nil
        voice.interrupt()
    }
}
rooms.onAttentionNavigation = { target in
    switch target {
    case .question:
        showRoomsAttention() // question is already exactly focused after refresh
    case .approval(let approval):
        showExistingApproval(approval) // existing card revalidates before approval
    }
}
```

`currentQuestionPlayback` and the navigation functions are parent-owned hooks.
Clear/update the playback marker whenever any other speech or capture starts.
The callback is synchronous: return true only when this exact playback was
accepted. Returning false leaves it eligible for a later idle poll. Do not queue
an asynchronous `speak` after returning true. A delayed action must revalidate
`canSpeak(notice)` and the actual voice state immediately before playback.
`RoomsQuestionAttention` is a value snapshot containing the exact question,
binding and context. It never selects a new room or changes the original target.

The model invokes it only after explicit `spokenAttentionEnabled` opt-in, with
idle voice and no mute, while connected/ready. Quiet/archived rooms, expired or
cancelled questions, old attempts and cancelled runs cannot announce. Waiting
questions remain in the text inbox; only one is spoken until resolved or cleared.
`attentionMuted = true` pauses proactive speech and notifications, not workers
or microphone capture. Wire a global voice mute/consent revocation to this flag
as well as stopping the real voice port. Exact revocation callbacks occur on
mute, opt-out, expiry, cancellation, quiet policy, disconnect and observer stop.
Rooms never calls a new hands-free setter or implicitly opens an answer window.
The voice lane owns any separately opted-in answer-window behavior.

With an external callback installed, the view's legacy automatic speech hook is
disabled to avoid double delivery. Manual read-aloud controls also require idle
voice; they never interrupt listening/speaking. All received answers still pass
through exact server-bound validation, and approval cards are never spoken
authorization requests.

### Private native notifications

The Attention panel exposes **Private macOS notifications**, default off each
session. `rooms.notifications.enable()` must only be called from an explicit
user toggle/action. It uses `UNUserNotificationCenter.requestAuthorization` with
`.alert` only, after inspecting standard system permission. It does not prompt
on launch, silently re-request denial, add sound/badges, install response actions,
change TCC, or bypass the OS. The packaged `Jarvis.app` with its bundle identifier
is required; an unbundled executable reports unavailable. Denial/error leaves
the full text inbox usable. Permission is rechecked during bounded polling.

Lock-screen content is always **Jarvis needs your attention / Open Jarvis to
review a pending item.** No room name, goal, prompt, operation, token, target ID
or answer is included in content/userInfo. An opaque per-session UUID maps to
the original question binding or full approval snapshot in memory, capped at
32 outstanding notices. Clicks only refresh and navigate after exact revalidation;
stale/unknown clicks never retarget. There are no approval/answer buttons.
Mute/disable/stale state removes owned pending/delivered notices, including late
async posts; unmute does not replay already announced items. Old session notices
are removed on first explicit enable, and old clicks are ignored after relaunch.

The default adapter refuses to replace an existing `UNUserNotificationCenter`
delegate. Applications already using that delegate should inject
`RoomsNotifications(service:)` with a composed `RoomsNotificationServing`
adapter. A delegate replacement during a post fails closed.
No package dependency, entitlement, or Package.swift linker addition is required
by this module beyond the existing documentation exclusion. Normal bundle/signing
and notification delivery must still be verified on the parent Mac.

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
never a timer or a task-progress value. Reduced motion fixes orb geometry,
disables interpolation and replaces the moving history with a current-level bar.
Background rendering drops level history. Idle rendering has no animation clock.

## Compatible reference ideas and plan reuse

The compatible ideas adopted from the reference brief are a distinct voice core
versus long-running worker floor, independent microphone/playback meters, visible
runtime worker census, exact graph connections, proactive but revocable attention,
and repeatable accepted plans. The visual implementation is original SwiftUI:
layered radial orb lighting, actual RMS-driven rings/meters, and anchor-based DAG
connections (solid artifact handoffs, dashed ordering-only dependencies). There
is no copied React/LiveKit shader, auto-running demo, fabricated spectrum or
pretend worker percentage. Public visual reference pages could not be fetched in
this lane; no claim is made to have copied or audited their source.

Accepted plan cards expose **Review & run again** when real prior runs exist.
The existing exact revision/digest Start API creates a fresh run only after an
explicit confirmation; policy mismatch remains blocked. **Draft a variation**
copies only the existing goal into an editable, original-room-bound authoring
form. It calls the existing author API and still requires separate review,
acceptance and Start. It does not clone an accepted graph as trusted executable
state or copy approvals/artifacts. Named persistent cross-room templates,
parameters, versioning and playbook management need new kernel APIs; this module
does not fake those capabilities in UserDefaults or a second store.

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
quiet attention, explicit controls and actual audio-level state. Follow-up tests
cover shared observer owners, background/mute/expiry/cancellation, exact attention
and notification navigation, denied/revoked permissions and late post cleanup,
accepted-plan re-runs, real graph edges and bounded polling. The synthetic
shared fixture exists only in tests; it is never seeded into the UI.

Linux syntax parsing and Foundation-only state tests do **not** verify SwiftUI,
Combine, AppKit, URLSession AsyncBytes on Darwin, audio hardware or actual provider
access. Native compile and recorded UI acceptance remain separate requirements.
