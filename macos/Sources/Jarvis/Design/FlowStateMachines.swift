import Foundation

// UI state machines for the HUD flows. These model PRESENTATION only. Every transition that
// causes an effect calls an existing runtime endpoint; the runtime remains the authority.
// Timings marked (UI) are design decisions; timings marked (RT) come from the runtime and
// must be read from it, not hard-coded.

// MARK: F1 — Summon (⌃⌥Space)

enum SummonPhase: Equatable {
    case closed
    case pressed(at: Date)                 // key down; nothing visible for 180 ms (UI)
    case wheel(highlight: WheelSegment?)   // shown if still held at 180 ms; flick = pointer >40 pt from center
    case capturing(target: CaptureTarget)  // held ≥ 500 ms with no flick OR segment chosen → mic opens (requires session consent)
    case parsing(utteranceID: String)      // key released → Scribe final; intent cards stream in
    case review(intents: [IntentCard])     // ⏎ = send to captured conversation; Esc = discard
    case consentRequired                   // cloud voice not granted this session → show consent sheet (O7)
    case dismissed

    enum WheelSegment: String, CaseIterable { case brief, draft, research, room, remember, stopAll }
    struct CaptureTarget: Equatable { var conversationID: String?; var roomID: String?; var windowGrantOffered: Bool }
    struct IntentCard: Equatable { var tool: String; var confidence: Double; var gated: Bool; var needsClarification: Bool }
}
// Rules
// • stopAll segment never opens the mic; it calls model.stopAll() immediately on release.
// • Releasing within 180 ms with no wheel = "tap" → open the main window (existing summon behavior).
// • Esc in any phase → .dismissed, capture muted, nothing submitted.
// • If the selected conversation is busy or has a pending approval, review shows the transcript
//   as a draft only (existing send-blocking rules) — no auto-submit.

// MARK: F2 — Authorization lock + voice challenge

enum AuthorizationPhase: Equatable {
    case presented(proposalID: String, revision: Int, digest: String)
    case holding(progress: Double)          // 0…1 over 1.2 s (UI); release <1 → back to presented
    case readingChallenge(phrase: [String]) // runtime issued challenge; TTS reads the review text + phrase
    case awaitingPlaybackDrain              // wait for native playback drain ack (RT) before opening window
    case listening(deadline: Date, matched: Int)  // window = 15 s (RT); matched = words matched so far
    case submitting
    case authorized
    case denied
    case expired                            // window closed or proposal expiresAt passed (RT)
    case invalidated(Reason)

    enum Reason: Equatable { case proposalChanged, appInactive, locked, challengeConsumed, transportLost }
}
// Rules
// • A generic "yes"/"ok"/"sure" never matches. Log it as "rejected · not the phrase"; window keeps running.
// • Word matching is sequential; a wrong word resets matched to 0 but does NOT end the window.
// • On any change to the proposal (revision/digest) → .invalidated(.proposalChanged); require fresh review.
// • App resigns active or screen locks → .invalidated(.appInactive/.locked); window closes immediately.
// • Hold-to-authorize and voice are alternatives; whichever completes first submits once (dedupe by proposal ID).

// MARK: F3 — Room lifecycle (maps 1:1 to runtime statuses)

enum RoomStage: Equatable {
    case describing                         // goal draft in the room; voice target = room (draft authoring only)
    case authoring(authoringID: String)     // "authoring" | "waiting_question" (RT)
    case draft(planID: String, revision: Int)
    case accepted(planID: String, revision: Int)           // frozen; NOT started
    case running(runID: String)
    case paused(runID: String)              // dispatch paused; running workers may finish
    case waitingQuestion(runID: String, questionID: String) // container stopped, files sealed
    case stopRequested(runID: String)       // "cancel_requested"
    case cancelled(runID: String, confirmed: Bool)
    case interrupted(runID: String)         // restart reconciliation could not confirm
    case completed(runID: String)
    case failed(runID: String)
}
// Rules
// • Accept and Start are separate confirmations (O6). Never chain them.
// • An answer to a worker question is bound to (questionID, revision). If the question changes while
//   drafting, show the stale-draft banner and block send (existing RoomsAnswerDraft behavior).
// • cancelled(confirmed: false) shows red "Stop requested, not confirmed. Resources may still be active."

// MARK: F5 — Stop all (⌘.)

enum StopAllPhase: Equatable {
    case idle
    case muting                             // synchronous: capture muted + speech interrupted (<1 frame)
    case requesting                         // POST stop-all; new work admission fenced
    case confirmed                          // all cancellations confirmed by runtime
    case unconfirmed(pending: Int)          // red banner; new work + voice stay blocked; Retry enabled
}
// Rules
// • Never show "Undone". Completed effects remain; copy says "Stopped. Completed actions can't be undone."
// • Unconfirmed persists across navigation until a successful retry.

// MARK: F6 — Boot (RuntimeSupervisor.State)

enum BootLine: Equatable {
    case ok(String), hold(String), off(String), fail(String)
}
// Supervisor idle → starting: stream BootLines; ready → greeting + consent prompt; failed → red line + Retry + Settings.
