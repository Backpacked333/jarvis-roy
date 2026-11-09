# Jarvis implementation and release status

This document separates implemented source code from release acceptance for the
voice-first research and action plan. The app remains a **source-build preview**.
New Assistant, Knowledge, Research and Voice Approval flags default off. No stage is
declared released solely because its automated tests pass.

## What is implemented

| Stage | Source implementation | Remaining release evidence |
| --- | --- | --- |
| 1 — Reliability and startup | Conversation changes serialize and publish after durable persistence. Author/worker/research accounting rejects unknown prices, returned-model mismatches and uncertain usage before further budgeted calls. Structured diagnostics omit private content and credentials. The native supervisor owns startup, readiness, bounded recovery and shutdown; Settings uses Keychain for secrets and app preferences for nonsecrets. The development launcher remains supported. | Compile and exercise the supervisor on macOS, including double-click, child failure, Quit, restart and Keychain refusal. Resolve the blocked model catalog. Verify actual Docker limits on the target Mac. |
| 2 — Voice and workspace | A bridge-owned session coordinator persists versioned turns, task bindings and typed presentation revisions. Sequenced events update the native workspace. Sentence segmentation, bounded queues, native speech-generation fences and drain acknowledgements extend the ElevenLabs transport. Conversational/dictation modes, pause/correction handling, side conversations, Back and Pin are implemented. Sources, passages, documents, equations, tables, charts, code/diffs, plans, drafts and proposals have native views. | Sustained real voice conversations, acoustic interruption, audio-device changes, visual references during navigation and concurrent work. Measure latency on a documented Mac/network fixture. |
| 3 — Context and knowledge | Local SQLite full-text search, immutable imported originals/versions, locators and extraction status. Project scope, explicit cloud-sharing grants, expiry/revocation and guarded context reads. PDFKit text extraction in native import, bounded text/Markdown/CSV/code import, source export/deletion and revision history. Selected-window scope, Mail account scope and occurrence-aware EventKit Calendar reads. Backed-up personal-preference migration. Explicit settled-room history archival and retrieval. | Real PDF samples, account/window identity changes, permission denial and revocation on macOS. Verify the migration and export flow with a backed-up copy of real user state. Scanned PDFs do not gain OCR through this importer. |
| 4 — Research and analysis | Bounded public retrieval, project evidence, reproducible artifact access, source-linked deliverables, a synthesis call and separate critique call, explicit research budgets and separate deep-work model preference. Offline Rooms remain the execution mechanism for calculations/code. A version-pinned numerical/symbolic/plotting image and offline fixtures are provided. | Run the 30-task evaluation set with model access and inspect outputs. Run Docker enforcement and actual numerical/code workloads on a supported engine. A critique by a model is not independent expert verification. |
| 5 — Spoken actions and initiative | Native-only, action-specific review and fresh challenge, bound to an immutable proposal digest/revision. Playback-drain, active/unlocked-session, expiry and single-consumption checks. Existing action authority and deduplication execute the decision. Room plan acceptance and start remain separately bound. Optional daily briefings prepare drafts/proposals from a selected project's permitted sources. | Physical Mac end-to-end review/correction/confirmation, lock/sleep/interrupt scenarios, uncertain sends and cancellations. Daily briefing timing and permission handling on the target Mac. |

## Startup and configuration

Run `./scripts/setup-macos.sh` on macOS, then open `dist/Jarvis.app`. The build
records the prepared runtime checkout and Node executable. This supports
app-owned double-click startup after setup; it is not a standalone installer.
Moving the checkout requires rebuilding or updating the trusted runtime path in
Settings. Closing the workspace keeps the menu-bar assistant available;
Control–Option–Space summons it and Quit shuts down its owned services.

Use Settings → Providers for Keychain credentials. Model IDs, voice ID and
feature switches are nonsecret app preferences. Restart local services to apply
changes. The shell development launcher still accepts environment configuration
and manages its own children; restart that launcher for changes. Explicit shell
values take precedence. See the [main setup instructions](../README.md#reproducible-setup).

| Opt-in setting / environment flag | Default and boundary |
| --- | --- |
| Voice-first assistant / `JARVIS_ENABLE_ASSISTANT` | Off. Enables coordinated sessions and the adaptive workspace. |
| Project knowledge / `JARVIS_ENABLE_KNOWLEDGE` | Off. Enables imports and scoped grants. Room history also needs the Assistant workspace. |
| Deep research / `JARVIS_ENABLE_RESEARCH` | Off. Enables bounded research runs; also requires Knowledge. |
| Voice confirmation / `JARVIS_ENABLE_VOICE_APPROVAL` | Off. Also requires the Assistant and session cloud-voice consent. |
| Desktop, Apple services, terminal | Separately off. These switches do not grant macOS permissions or approve actions. |
| Daily briefing | Off. One chosen project and local time; runs when Jarvis is active, awake and unlocked. |

## Evidence and disclosure

Each source import retains original bytes and a hash. Search results cite an
immutable version and actual page/line passage; metadata-only arXiv/Crossref
records remain labeled as metadata. Public retrieval is bounded and does not
bypass logins or paywalls. Exact quotation/locator checks establish that quoted
text exists in a passage; they do not establish that every interpretation is
correct. Critique can mark unsupported or conflicting claims unresolved.

Local reading and cloud sharing are separate grant decisions. Model tools cannot
create grants or request local-only data by changing a purpose field. Private
context is bound to the current project, exact resource and permitted operation.
Revocation stops queued/new broker reads and interrupts guarded in-flight work.
It cannot retroactively withdraw data already disclosed to a provider or remove
prior authorized tool results from that provider's conversation context.

A selected-window grant does not permit whole-screen OCR. Mail reads check the
chosen account before returning content. EventKit reads use the chosen calendar
and time range, including recurring occurrences. OS permission prompts remain
required. Legacy personal memories migrate as preferences, with provenance and a
backup; project evidence does not automatically become a global preference.

Room archival is explicit and native-only. A room must first be marked archived,
have no unsettled external project work, and have terminal measured state with
no active question, pending approval, uncertain action or unknown accounting.
The kernel writes immutable history before committing its archive catalog and
pruning active state. IDs, deduplication and artifact references survive. An
export contains private history/checkpoints and artifact manifests; artifact
bytes remain in the artifact store. Unresolved work is never discarded to meet
a retention target.

## Research and actions

The bounded research workflow retrieves selected/public evidence, makes **two
Gateway calls** (synthesis and separate critique), validates citations and saves
a versioned deliverable. It does not execute generated numerical code itself.
Use Rooms and the [offline analysis image](../runtime/workers/analysis/README.md)
for computations, symbolic checks, charts and tests; inspect commands, inputs,
environment identity, output artifacts and verification results.

The suggested research budget is $5 estimated cost, 30 minutes and two concurrent
workers/retrieval slots. Users can review limits before starting. Retrieval and
critique participate in admission; Tavily needs an explicit operator allowance
because actual charges are not observable here. Estimates are not provider
billing caps. Unknown prices, usage or model identity block further budgeted
calls. `JARVIS_DEEP_MODEL` selects research synthesis/critique and otherwise uses
the existing `JARVIS_MODEL`; no replacement model has been promoted by evaluation.

For supported actions, review the complete frozen proposal, let its spoken
review finish and repeat the fresh action-bound challenge during its 15-second
window. Generic “yes,” text copied from a document, audio captured during review,
edits, stale proposals and replay cannot authorize the action. Voice establishes
consent through the active local channel, not biometric identity. Exact buttons
remain an alternative. Sends and cancellations report observed uncertainty;
already-completed effects are not rolled back. Daily briefings prepare work and
do not send messages or execute actions automatically.

The first native release limits a full spoken review to 1,200 characters so it
fits the bounded provider turn and proposal lifetime. Longer proposals remain
fully inspectable on screen and require the exact button; their review is never
silently truncated. Longer spoken reviews require a future segmented review
protocol with independently tested expiry and interruption behavior.

The existing terminal caution still applies: an explicitly approved terminal
command runs with **your user's privileges, not in a security sandbox**. It can
access files and the network. Generated-code Rooms remain offline,
credential-free Docker workers with no host-execution fallback.

## Recorded validation and open gates

- Before implementation, the Linux suite recorded **337 tests: 316 passed,
  21 skipped**, with typecheck passing and build completing without model
  metadata. See [the saved baseline](../evaluations/baseline.json).
- Added regression coverage includes failed durable commits, grants and project
  boundaries, queued revocation, source versions and citations, archive failure
  and replay, session/navigation references, exact voice confirmation, research
  budgets and cancellation. Latest Linux run: **475 tests, 454 passed, 21 skipped,
  zero failures**; TypeScript checking passed. Both built-runtime smoke modes
  passed, including authenticated startup, restart persistence, scoped imports,
  revocation, archive access and Stop all. The analysis image's four offline
  calculation/plotting fixtures passed; its enforcement gate did not.
- The cloud environment does not have the macOS SDK/compiler or physical audio
  hardware. All **65 Swift source/test files** passed tree-sitter syntax parsing;
  this does not replace a macOS build or device acceptance. Native tests were
  added but not executed here. No new native release gate is claimed passed.
- `ai-gateway.vercel.sh` is blocked by the managed network policy. Eve builds
  without populated model metadata (`fetchedAt: null`). An allowlist addition was
  saved in an environment-setup draft, not applied/published. Rebuild after access
  is enabled; local readiness is not proof of model/provider readiness.
- Rootless Docker in this environment does not enforce the requested cgroup
  limits: the probe requested 512 MiB memory, no swap, 64 PIDs and one CPU, but
  observed approximately 32 GiB, unrestricted swap/PIDs and four CPUs. Jarvis
  correctly refuses that worker profile. Installing Docker and pulling an image
  do not satisfy the enforcement gate.
- The fixed **30 research, mathematics, coding, writing and daily-assistance
  evaluations remain unrun** with live providers. Follow the
  [evaluation instructions](../evaluations/README.md), preserve inaccessible or
  conflicting evidence, and record expert-reviewable artifacts rather than
  substituting unit-test success for task quality.
- Playback interruption ≤250 ms at p95, visible local feedback ≤150 ms and simple
  first meaningful audio ≤3 seconds at median are **targets, not measured
  results**. Document Mac/network/audio fixtures and measure deep-work latency
  separately. Speakers, headphones, long pauses, device changes, sleep and
  permission denial remain required acceptance cases.

Run `node scripts/smoke-runtime.mjs` and `node scripts/smoke-runtime.mjs --assistant`
after building the runtime for isolated local API checks with all provider
credentials removed. See [latency diagnostics](latency-diagnostics.md) for the
implemented component measurements and their limits.
The follow-up [testing report](testing-report.md) records integration scenarios,
defects reproduced and corrected, and remaining live acceptance blockers.

Public distribution, mobile clients, always-on remote workers and work continuing
through Mac sleep remain deferred. Feature flags should remain off until their
corresponding gates pass on the intended Mac.
