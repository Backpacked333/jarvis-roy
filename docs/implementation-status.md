# Jarvis implementation and release status

This document separates implemented source code from release acceptance for the
voice-first research and action plan. The app remains a **preview**: CI now builds a
self-contained, ad-hoc signed disk image, but nothing has been accepted on a physical Mac.
A new installation starts with the Assistant, Knowledge and Personal Memory on; Semantic
Retrieval, Research, Voice Approval and everything that acts on the Mac, reaches an account,
leaves the Mac or spends unattended still default off. No stage is declared released solely
because its automated tests pass.

## Startup, packaging and HUD update

- **Startup:** local model selection no longer depends on the build-time gateway catalog; a rejected
  key fails with its reason instead of a silent cancellation; services stop themselves when the app
  dies; service output is kept in redacted, capped logs and shown with a failed start; `npm run doctor`
  lists what blocks a start.
- **Packaging:** `scripts/package-macos.sh` produces a self-contained app and disk image. CI builds and
  self-checks one for Apple silicon and one for Intel, and the Linux job proves the staged runtime runs
  away from the checkout. Gatekeeper, Keychain and first launch on a real Mac are untested.
- **HUD redesign (from the design handoff):** tokens, fonts and primitives; the Command Deck as home; the
  core with the particle-face presence and a drawn-sphere fallback; the authorization lock with the
  runtime's per-tool impact description; the Stop-all banner; the listening screen; rule-based
  Anticipating signals. Checked only by CI builds, unit tests and rendered screenshots. The WebGL face,
  voice, and every interaction are unverified on hardware.
- **Not built:** operations theater, summon wheel, command palette, toasts, boot sequence, and the
  Situation and Telemetry panels. Situation needs calendar reads through the existing per-calendar grants
  and the native helper; Telemetry needs the runtime to record per-turn usage and latency. Both need
  on-device or live-provider verification that was not possible in the session that added the HUD.
- **Evaluation:** `evaluations/live/run.mjs` can run 15 of the 30 fixed tasks headlessly with a spend
  cap and provisional machine scores. It has been dry-run only; no live run has been recorded.

## Persistent partner update

The [persistent partner guide](persistent-partner.md) describes objectives,
continuity, background retrieval, private cloud pairing, owner integrations,
remote passkey review and recovery. The [deployment package](../deploy/README.md)
is prepared for an operator-provided VM; no host or live accounts were configured
in this workspace. New cloud, objectives and integration flags remain opt-in.
The [persistent-partner baseline](../evaluations/persistent-partner-baseline.json)
records the earlier RAG implementation at commit `0cf0388`; it is historical
evidence. Use [latest validation](../evaluations/latest-validation.json) for the
current tested commit, exact automated counts, CI results and remaining gates.
Physical Mac interaction, live task quality and the seven-day pilot remain
separate acceptance work.

## What is implemented

| Stage | Source implementation | Remaining release evidence |
| --- | --- | --- |
| 1 — Reliability and startup | Conversation changes serialize and publish after durable persistence. Author/worker/research accounting rejects unknown prices, returned-model mismatches and uncertain usage before further budgeted calls. Cloud Eve reasoning also reserves and settles each provider call before exposing output or tool calls. Structured diagnostics omit private content and credentials. The native supervisor owns startup, readiness, bounded recovery and shutdown; Settings uses Keychain for secrets and app preferences for nonsecrets. The development launcher remains supported. | Native build and tests have run in macOS CI; check the current commit's result in latest validation. Physical double-click startup, child failure, Quit, restart and Keychain refusal still need exercise. Verify provider catalog access and actual Docker limits on the intended host. |
| 2 — Voice and workspace | A bridge-owned session coordinator persists versioned turns, task bindings and typed presentation revisions. Sequenced events update the native workspace. Sentence segmentation, bounded queues, native speech-generation fences and drain acknowledgements extend the ElevenLabs transport. Conversational/dictation modes, pause/correction handling, side conversations, Back and Pin are implemented. Sources, passages, documents, equations, tables, charts, code/diffs, plans, drafts and proposals have native views. | Sustained real voice conversations, acoustic interruption, audio-device changes, visual references during navigation and concurrent work. Measure latency on a documented Mac/network fixture. |
| 3 — Context and knowledge | SQLite full-text/vector retrieval, immutable originals/versions, format-aware locators and extraction status. Bounded background indexing, persistent project working sets, reviewed temporal memory, cross-conversation continuity and context-use manifests. Project scope, explicit cloud reasoning/retention grants, expiry/revocation and guarded context reads. Native PDFKit import, selected-window reads, Mail account scope and occurrence-aware EventKit Calendar reads. Backed-up preference migration and settled-room archival. | Real documents, account/window identity changes, permission denial and revocation on macOS. Validate Apple and provisioned Linux E5 relevance on a personal corpus. Verify migration/export with a backed-up copy of real user state. Scanned PDFs do not gain OCR through this importer. |
| 4 — Research and analysis | Bounded evidence retrieval, source-linked deliverables, synthesis and separate critique, with one optional repair plus fresh critique when a four-call budget permits. Explicit cost/token/time bounds and separate deep-work model preference. Durable objectives coordinate research and already accepted isolated Room plans; their review package joins exact research results and worker manifests/check evidence. A pinned numerical/symbolic/plotting image and offline fixtures are provided. | Run the 30-task evaluation set with model access and inspect outputs. Run enforcement and actual workloads on the intended Docker engine. Model critique and supplied-context manifests do not independently verify conclusions. |
| 5 — Spoken actions and initiative | Native spoken review uses an action-bound challenge, playback-drain, unlocked-session, expiry and single-consumption checks. Remote review uses a separate passkey challenge and signed receipt returned to the original executor. Google sends/writes require the existing exact tool approval. Telegram and verified phone conversations use bounded cloud reasoning; durable outboxes preserve uncertain submissions. Optional daily briefings prepare work from permitted project sources. | Physical Mac review/correction/confirmation, lock/sleep/interruption, real owner account setup, phone acoustics, uncertain sends/cancellations and a seven-day pilot. No VM or live integration has been deployed by preparing this package. |

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
| Personal memory / `JARVIS_ENABLE_MEMORY` | Off. Enables reviewed structured memory, personal/project scopes and bounded per-turn recall. |
| Local semantic retrieval / `JARVIS_ENABLE_SEMANTIC_RETRIEVAL` | Off. Apple embeddings locally; provisioned pinned multilingual E5 CPU embeddings on Linux. Explicit lexical fallback and separate model identities. |
| Deep research / `JARVIS_ENABLE_RESEARCH` | Off. Enables bounded research runs; also requires Knowledge. |
| Voice confirmation / `JARVIS_ENABLE_VOICE_APPROVAL` | Off. Also requires the Assistant and session cloud-voice consent. |
| Desktop, Apple services, terminal | Separately off. These switches do not grant macOS permissions or approve actions. |
| Persistent objectives / `JARVIS_ENABLE_OBJECTIVES` | Off. Durable bounded research/accepted-room child runs, checkpoints, questions and shared admission ledger. |
| Cloud pairing / `JARVIS_ENABLE_CLOUD` | Off. Dedicated device credentials, separate cloud profile and exact remote review. |
| Cloud integrations / `JARVIS_ENABLE_INTEGRATIONS` | Off. Google, Telegram and Phone each require separate flags, setup and scope. |
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

The [RAG and memory upgrade](rag-memory-context.md) adds hybrid retrieval, local
vector caches, ranked personal/project memory, exact memory review, and an
inspectable context budget. One stable Eve recall slot is replaced each turn;
ordinary conversation history retains Eve's separate compaction mechanism.
Project working-set pins now persist across conversations and feed automatic
recall. Exact revision, grant and packet-budget checks still apply; missing or
stale pins are reported as omissions. Inspector-only previews remain available,
and standing memory preferences have their own persistent pin. Context-use
manifests identify what was supplied, not which evidence caused a model claim.
Native embedding relevance and live personal-assistant quality still require
evaluation on the target Mac.

Room archival is explicit and native-only. A room must first be marked archived,
have no unsettled external project work, and have terminal measured state with
no active question, pending approval, uncertain action or unknown accounting.
The kernel writes immutable history before committing its archive catalog and
pruning active state. IDs, deduplication and artifact references survive. An
export contains private history/checkpoints and artifact manifests; artifact
bytes remain in the artifact store. Unresolved work is never discarded to meet
a retention target.

## Research and actions

The bounded research workflow retrieves selected/public evidence, defaults to
**two Gateway calls** (synthesis and separate critique), validates citations and
saves a versioned deliverable. An explicitly allowed four-call budget can add
one repair and a fresh critique when the initial critique requests revision.
A repair is not started without budget for its separate review. Research does
not execute generated numerical code itself.
Use Rooms and the [offline analysis image](../runtime/workers/analysis/README.md)
for computations, symbolic checks, charts and tests; inspect commands, inputs,
environment identity, output artifacts and verification results.

Research defaults to a $5 estimate, 30 minutes, 100,000 tokens and two concurrent
workers/retrieval slots. The direct research contract allows two to four model
calls, up to 200,000 tokens and up to 60 minutes; an objective child remains
capped at 30 minutes and its admitted estimate. Persistent objectives have a
seven-day horizon, two active child slots, a cumulative $5 objective limit and
shared $10/day and $300/month estimated admission limits. Waiting uses stored
wake times, not a reasoning loop. Unknown accounting retains its reservation.

Local Tavily research needs an explicit allowance because actual retrieval
charges are not observable. The cloud profile currently uses permitted local
evidence and free arXiv/Crossref retrieval; Tavily search/extraction is disabled
there. Paid research and Room starts in that profile must use capped objectives.
Estimates are admission controls, not provider billing caps. Unknown prices,
usage or model identity block further budgeted calls. `JARVIS_DEEP_MODEL` selects
research synthesis/critique and otherwise uses `JARVIS_MODEL`; no replacement
model has been promoted by evaluation.

Objective continuation carries bounded user answers and exact predecessor
references. Unlineaged checkpoint prose and worker artifact contents are not
silently replayed into another model call. The owner review package joins
currently authorized research deliverables with actual worker artifact and
check records. Cloud Stop preserves paused goals, requests cancellation and
durably fences scheduling. Explicit resume enables fresh work; it does not
revive approvals or replay stopped paid attempts.

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
- The later historical RAG baseline at `0cf0388` recorded **506 local passes,
  21 skips and zero failures**, plus successful runtime, isolated-worker and
  macOS CI jobs. See its [exact commit and CI record](../evaluations/persistent-partner-baseline.json).
  These counts are not the current release result.
- [Latest validation](../evaluations/latest-validation.json) is the current
  evidence record for exact counts, typecheck, build, smoke runs and each CI
  job. Regression coverage includes durable-write failure, project/grant
  isolation, revocation, retrieval/continuity, exact approval, budget accounting,
  paused-objective recovery, private cloud transport and Stop failures. Tests
  with fake providers establish contracts, not live task quality.
- macOS CI compiles the application and helper and runs both test packages in
  debug and release. The Linux workspace itself has no macOS SDK or physical
  audio hardware. Successful CI compilation does not establish Keychain,
  Accessibility/EventKit permissions, microphone behavior or physical acceptance.
- Earlier managed-environment builds completed without populated provider model
  metadata because catalog access was unavailable. Check latest validation for
  the current build limitation. Local readiness and a successful build do not
  establish live provider access or known prices for a chosen model.
- The historical managed rootless-Docker probe did not enforce requested cgroup
  limits: the probe requested 512 MiB memory, no swap, 64 PIDs and one CPU, but
  observed approximately 32 GiB, unrestricted swap/PIDs and four CPUs. Jarvis
  correctly refused that profile. Isolated-worker CI has passed on a supported
  engine; the intended Mac or cloud host must pass its own enforcement probe.
  Installing Docker and pulling an image do not satisfy that gate.
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

Public distribution and mobile clients remain deferred. The opt-in cloud
deployment can coordinate cloud-owned work independently of Mac sleep once an
operator provisions it; Mac-only actions still require the paired Mac to be
available. No production host or live continuous-operation pilot is claimed.
Keep unvalidated features disabled on the intended deployment.
