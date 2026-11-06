# Harness v1 implementation contract

This document describes the frozen interoperability boundary, not a completed
room runtime. The contract validators and fixtures execute; the five implementation
lanes supply the actual services. Existing conversations and exact approval cards
remain supported. Nothing here deploys infrastructure or authorizes host actions.

## Files and authority

All TypeScript imports use explicit `.ts` extensions and `import type` for types.
The modules are under `runtime/bridge/harness-contracts/`, already covered by the
existing `tsconfig.json`. Do not fork these definitions in individual lanes.

| Module | Public surface |
| --- | --- |
| `domain.ts` | `Room`, `RoomPolicy`, `PlanDraft`, `Plan`, `PlanNode`, `Run`, `NodeState`, `Authoring`, `ArtifactManifest`, `Usage`, `BudgetLimits`, their `*Schema` validators, `defaultRoomPolicy(image = null)` |
| `validation.ts` | `validatePlan`, `acceptPlan`, `planDigest`, `validateArtifact`, `artifactDigest`, `canonicalJson`, `sha256` |
| `interactions.ts` | `Question`, `QuestionTarget`, `QuestionBinding`, `HarnessApproval`, `AnswerQuestionRequest`, `VoiceAnswerRequest`, schemas, `questionBinding`, `assertAnswerMatches` |
| `worker.ts` | `WorkerRunner`, `WorkerSpec`, `WorkerEvent`, `WorkerResult`, `WorkerCheckpoint`, `Continuation`, `Cancellation`, `Reconciliation`, `ArtifactReader` |
| `service.ts` | `HarnessService`, `PlanAuthor`, `AuthorModel`, `QuestionRouter`, constructor option types, request schemas, `HarnessState`, `HarnessEvent`, `HarnessEvents`, `HARNESS_ROUTES` |
| `voice.ts` | `VoiceBridge`, `VoiceBridgeOptions`, `VoiceContext`, frame/status schemas, `VoiceGenerationGate`, `parseVoiceClientFrame`, constants |
| `elevenlabs.ts` | Outbound URL constructors and small documented TTD/Scribe protocol validators, with **no credential handling** |

`macos/Sources/Jarvis/HarnessContracts.swift` contains corresponding UI-facing
Codable values and `HarnessServing`. `HarnessVoiceContracts.swift` contains voice
wire values and `HarnessVoiceControlling`. Required null fields use
`HarnessNullable`, so Swift encoding does not silently omit them. Backend worker
checkpoints stay internal; native clients receive only state and event DTOs.

`contracts/fixtures/harness-v1.json` is synthetic **test data**, not demonstrated
work or a default UI state. `runtime/test/harness-contracts.test.ts` validates its
hashes, scope, graph, resume and audio boundaries. The Swift
`HarnessContractTests.swift` decodes the same file and round-trips state including
nulls. The parent Mac stage must compile/run the Swift tests.

## Exact additive exports and disjoint file ownership

Only the prep stage owns the contract files, fixture, contract tests and this
document. They are frozen until integration. Each lane works on its own branch
from the prep commit, not from another implementation lane. Do not wait for a
sibling implementation: use the typed injected ports in tests.

| Lane | Exclusively owned paths | Required entry exports |
| --- | --- | --- |
| kernel | `runtime/bridge/harness-kernel/**`, `runtime/test/harness-kernel*.test.ts` | `runtime/bridge/harness-kernel/index.ts`: `createHarnessKernel(options: HarnessKernelOptions): HarnessService` |
| worker | `runtime/bridge/harness-worker/**`, `runtime/workers/**`, `runtime/test/harness-worker*.test.ts` | `runtime/bridge/harness-worker/index.ts`: `createWorkerRunner(options: WorkerRunnerOptions): WorkerRunner` |
| voice | `runtime/bridge/harness-voice/**`, `runtime/test/harness-voice*.test.ts`, `macos/Sources/Jarvis/Voice/**`, existing `VoiceController.swift`, existing `WakeDetection.swift`, `macos/Sources/JarvisAudioSafety/**`, existing `WakeDetectionTests.swift`, `macos/Tests/JarvisVoiceTests/VoiceTransport*.swift` | `runtime/bridge/harness-voice/index.ts`: `createVoiceBridge(options: VoiceBridgeOptions): VoiceBridge`; existing `VoiceController` conforms to `HarnessVoiceControlling` |
| interactions | `runtime/bridge/harness-interactions/**`, `runtime/test/harness-interactions*.test.ts`, `runtime/agent/tools/harness_author_plan.ts`, `runtime/agent/tools/harness_room_state.ts` | `runtime/bridge/harness-interactions/index.ts`: `createPlanAuthor(options: PlanAuthorOptions): PlanAuthor`, `createQuestionRouter(options: QuestionRouterOptions): QuestionRouter` |
| native-ui | `macos/Sources/Jarvis/Rooms/**`, `macos/Tests/JarvisVoiceTests/Rooms*.swift` | `HarnessClient: HarnessServing`, `@MainActor RoomsModel: ObservableObject`, `RoomsWorkspaceView` with the initializer below |

Native composition surface (use these names, with internal implementation freedom):

```swift
// HarnessClient defaults to authenticated 127.0.0.1:39202, never a public URL.
HarnessClient() // conforms to HarnessServing; injectable client in model tests
RoomsModel(client: any HarnessServing)
RoomsWorkspaceView(model: RoomsModel,
                   onVoiceContext: @escaping (HarnessVoiceContext) -> Void,
                   onSpeakQuestion: @escaping (HarnessQuestion) -> Void,
                   onReviewApproval: @escaping (HarnessApproval) -> Void)
// Required model methods for AppModel integration:
func refresh() async
func handleUtterance(_ utterance: HarnessVoiceUtterance) async
func updateAudioLevels(_ levels: HarnessAudioLevels)
func updateVoiceState(_ state: HarnessVoiceState)
// The model's selectedRoomId is a published String?; context binds at capture time.
```

The integrator exclusively owns shared wiring: `runtime/bridge/server.ts`,
`service.ts`, `types.ts`, existing root agent config/instructions, all dependency
manifests/locks/tsconfig, `macos/Package.swift`, `AppModel.swift`,
`WorkspaceView.swift`, `JarvisApp.swift`, existing `Models.swift`/`RuntimeClient.swift`,
root scripts, README, CI and legacy regression tests. Lanes report any required
dependency/config edits instead of committing them. No lane edits another lane's
files or opens/updates the parent PR.

## Authoring, policy and execution are separate

1. The user creates a durable room with an explicit policy. Native creation uses
   `state.defaultPolicy` as its editable starting point. A null sandbox image means
   unconfigured, **not** “select latest” or “execute on host.” The integrator may
   inject `defaultRoomPolicy(JARVIS_WORKER_IMAGE)` after an explicitly pinned
   local image has been configured. Image values are an OCI digest or local image
   ID; tags alone fail validation.
2. A text or committed voice goal calls `authorPlan`. Persist an `Authoring` record
   before returning 202 and run `PlanAuthor.author` asynchronously with a deadline.
   The real model returns a small `PlanDraft` or a clarification. It cannot return
   policy, permissions, arbitrary tools, an accepted status or a runnable job.
3. Kernel gives a draft its trusted IDs, timestamps, room and policy revision,
   validates the DAG and persists it. A waiting authoring question targets the
   exact `authoringId`, never a guessed future run/node.
4. The user inspects/edits the draft, then explicitly accepts that revision.
   `acceptPlan` clones and deep-freezes it and computes the content digest.
   Acceptance covers this sandbox plan, **not** a privileged operation. Accepted
   plans cannot be edited; author a new revision/plan instead.
5. Starting is a separate explicit control with a request ID, plan revision and
   digest. No draft execution and no accidental start from a planning tool.
   Repeating a request ID returns its original result; changed content with the
   same ID conflicts. Reusable accepted plans can create new runs with new request
   IDs if the room policy revision still matches.
6. Kernel snapshots policy into the run, allocates distinct attempts, and schedules
   independent nodes concurrently under room and global reservations. Failed or
   cancelled prerequisites block dependents. A review/test node receives the exact
   upstream manifests in `inputFrom`, not a mutable working directory.

The first version only permits `network: "none"` in generated-code containers.
A “researcher” can reason over supplied material, not silently fetch arbitrary
URLs. Future allowlisted egress needs an actually enforcing adapter and a versioned
policy change. Existing explicitly allowed root research tools remain separate.

### Budget semantics

`validatePlan` bounds graph nodes, dependency fan-in, each node's limits and the
**sum** of planned maximum steps/calls/tokens. Limits are per full node, including
all clarification continuations, not fresh budgets on each retry/answer.
`Continuation.usage` carries prior consumption. Run wall time includes active
execution; waiting for a human must not keep a container or a model request alive.
Document which clock is used and persist its consumed active duration.

Kernel reserves before parallel dispatch and releases only on a durable terminal
result/reconciliation. Worker/controller enforces steps, model call count, request
size, max output tokens, cumulative token allowance, wall time, artifact/log bytes
and Docker resource limits. Do not label a model's missing token count as zero
measured usage: use `partial`/`unknown`, retain conservative reservations and stop
before another call if its remaining bound cannot be established. A bounded UTF-8
request size plus conservative token allowance can constrain requests; model
output token parameters constrain generation. Neither is provider-side billing
enforcement. `estimatedUsd` and `estimatedUsdLimit` are **estimates**, never hard
billing caps. If an estimate cannot be computed, leave it null.

## Worker lifecycle and inert checkpoint boundary

`WorkerRunner.run(spec, {signal, emit})` returns one `WorkerResult`; `emit` must be
awaited, so persistence failures abort work instead of silently losing events.
Events are ordered and bound to `{roomId, runId, nodeId, attemptId}`. Each attempt
starts its event sequence at zero. `started` means a real execution resource exists,
not that a model request has merely been queued. Progress is an actual operation,
not a synthesized percentage. A terminal/obsolete attempt cannot modify state.

Kernel validates every event/result's scope against its persisted attempt and
validates every manifest/digest before exposing it. The interface's TypeScript
types are not a runtime trust boundary. Inputs must come from completed upstream
nodes in the same run and accepted plan; caller-supplied manifests are not grants.

Recommended HF implementation: pinned `smolagents==1.26.0` `ToolCallingAgent`,
`add_base_tools=False`, bounded `max_steps`, and only an inspected narrow tool set.
The trusted controller owns model requests; model-generated code runs only through
Docker. Do not use `CodeAgent` with `LocalPythonExecutor`, `from_hub` remote code,
Hub Spaces, a default Eve sandbox selector or just-bash. There is no host tool
capability in the worker spec. A controller may broker tools over bounded stdio;
never pass provider keys, the local API token or a Docker socket into the executor.

For Docker, use an inspected pinned image, explicit non-root user, `--network=none`,
`--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, no privileged or
host PID/IPC mode, no devices, memory plus swap cap, CPU and PID limits, and bounded
tmpfs work/output storage. No broad mounts, no host secrets, no environment
inheritance. Prefer safe bounded stdio/copy-in/copy-out of regular files; do not
unpack arbitrary archive entries onto the host. Inspect every path, symlink,
hardlink/device entry and total output size. Verify cgroup/control availability;
fail closed if the chosen environment cannot enforce it. Docker is useful
isolation, not a guarantee against host-kernel vulnerabilities.

On a clarification, the worker stops at a safe tool boundary, seals regular files
as immutable snapshot artifacts, tears down its container, and returns
`waiting_question` with `WorkerCheckpoint`. This data contains only bounded text
history, a summary, completed-step IDs, usage and immutable artifact manifests.
It is not a pickled Python agent, bytecode, callable state or a command to replay.
On the answer, kernel atomically persists the answer and consumes the pending
question, then allocates a **new** attempt. `WorkerSpec.checkpoint` references the
previous attempt, `answer.binding` references its exact question, and `ref` names
the new attempt. Restore only verified snapshot files and inert history; add the
answer as data and ask the model for the **next** action. No replay of old tools.
The worker implements this boundary deliberately; HF serialization is not assumed
to be a safe or complete pause/resume mechanism.

Artifact digests cover provenance, ordered file hashes/sizes, input digests and
verification metadata using `canonicalJson` + SHA-256. Content is addressed by
room/run/artifact/digest and exact relative path, never a host absolute path.
Creation time, evidence or verification changes create a new manifest revision/ID,
not mutation of a handed-off artifact. A reviewer outputs its own evidence artifact
with the reviewed input digests; it does not rewrite the builder's manifest.
Only actual checks can yield `verification: "passed"`.

### Stop, pause, restart and sleep

Pause prevents new dispatch but lets active bounded sandbox steps finish. A room
pause applies to all its dispatch; run pause affects only that run. Cancel marks
`cancel_requested`, cancels queued nodes and signals active workers. Only a
confirmed resource stop yields `cancelled`/`cancelConfirmed=true`; unknown stops
remain interrupted/uncertain. Shutdown also attempts cleanup. Late results never
overwrite cancellation.

Persist an attempt intent before dispatch; use deterministic attempt resource
labels so a crash between resource creation and event persistence is reconcilable.
`reconcile(ref)` inspects real resources/results. At bridge restart: cancel/reap
orphaned running resources and reconcile before scheduling anything. A durably
recorded terminal result can be adopted after validation. Missing/unknown state
is interrupted, not successful and not automatically retried. `retryNode` is an
explicit user control and is allowed only once previous resources are confirmed
stopped. Questions/answers survive restart; an answer whose new attempt intent
exists must not create another attempt. A pending question with no dispatched
continuation can resume after its persisted answer. Host/external uncertain side
effects are never in this replay path: they remain existing gated operations.

Local execution does not continue through Mac sleep/shutdown. Data must survive;
always-on remote execution is a future adapter, not a deployed feature.

## Questions, voice replies and exact approval cards

The kernel is the **only** durable authority for room questions and answers.
Interactions lane supplies model authoring and `QuestionRouter`, not a competing
question store. `QuestionRouter.attention()` returns pending/unexpired questions,
deduplicated and ordered by creation time, excluding quiet rooms from spoken
attention only. All remain visible in the inbox. Native UI speaks one question
at a time and holds its binding while the room selection changes. Answered,
expired/cancelled questions leave the queue. Voice reply normalization may match
one exact choice ID/label (case/whitespace normalized) or allowed free text; do not
guess between multiple choices or multiple pending questions.

Both text and voice answers validate question ID, revision, entire target,
pending status and expiry atomically before persistence. A submitted response is
not considered applied until the service confirms it. A duplicate/stale answer
is a conflict, not an answer to the next pending question.

`HarnessApproval` is a separate projection of existing root approval cards.
The kernel has no `approve` method. The integrator projects real cards into state;
approval UI calls the existing exact operation endpoint, preserving its target,
expiry, secure-field, current-state and reviewability checks. A spoken yes can
answer a low-risk question; **it cannot authorize any approval**.

**Important Eve rc.6 behavior:** `request.kind` distinguishes `question`,
`approval`, `budget` and `sign-in`. A plain follow-up message can answer the first
open prompt, including an approval whose option matches the text. Do not forward
voice transcripts into `EveSession.send()` when any prompt is waiting. Do not
convert arbitrary Eve interactions into approval cards. Route structured question
answers by exact interaction ID, map relayed child interactions through the parent
as documented, and preserve uncertainty on mismatched/unknown kinds. Authoring
uses its dedicated no-host-tools port; it never receives the root approval tools.
The integrator must also audit legacy text follow-ups so only exact card responses
can authorize privileged operations, not ambient conversational messages.

## HTTP and state/event protocol

Retain the existing authentication boundary for **every** route and WebSocket
upgrade: loopback bind/remote address, Host validation, reject any Origin header,
constant-time bearer token check, no credential in query strings, bounded JSON,
no permissive CORS. Root `/v1/state` remains compatible. Harness has independent
`version: 1`; native clients reject unsupported versions rather than guess.

All paths below start with `/v1/harness`. Responses are the named DTO directly.
Use existing `{error: string}` error envelopes; validation 400, unknown scope 404,
revision/stale/idempotency conflicts 409, unavailable infrastructure 503. Never
return a different room's entity because only its ID happened to match.

| Method/path | Input / result |
| --- | --- |
| `GET /state` | `HarnessState`; state includes `defaultPolicy` and current worker availability |
| `GET /events?after=N&roomId=ID` | `HarnessEvents`; `roomId` optional, global monotonic sequence, max 1000; compacted cursor sets `resetRequired`, client refetches state |
| `POST /rooms` | `CreateRoomRequestSchema` → `Room` (201) |
| `PATCH /rooms/:roomId` | `UpdateRoomRequestSchema` → `Room`; increment room revision, increment policy revision on policy changes; never mutate active-run snapshots |
| `POST /rooms/:roomId/author` | `AuthorPlanRequestSchema` → `Authoring` (202) |
| `POST /rooms/:roomId/authorings/:authoringId/cancel` | `RunControlRequestSchema` → `Authoring` |
| `PUT /rooms/:roomId/plans/:planId` | `UpdatePlanRequestSchema` → new revision of draft `Plan` |
| `POST /rooms/:roomId/plans/:planId/accept` | `AcceptPlanRequestSchema` → accepted `Plan` |
| `POST /rooms/:roomId/runs` | `StartRunRequestSchema` → `Run` (202) |
| `POST /rooms/:roomId/runs/:runId/{pause,resume,cancel}` | `RunControlRequestSchema` → `Run`; resume never replays uncertain attempts |
| `POST /rooms/:roomId/runs/:runId/nodes/:nodeId/retry` | `RetryNodeRequestSchema` → `Run` |
| `POST /questions/:questionId/answer` | `AnswerQuestionRequestSchema` → `Question`; URL ID must match binding |
| `POST /questions/:questionId/voice-answer` | `VoiceAnswerRequestSchema` → `Question`, through `QuestionRouter.answerVoice`; no approval path |
| `GET /rooms/:roomId/runs/:runId/artifacts/:artifactId/content?path=PATH&digest=HASH` | validate manifest through `HarnessService.artifact`, then `WorkerRunner.artifacts.read(ref, path, maxBytes)`; bounded raw bytes, safe attachment filename, no-store and restrictive MIME/nosniff |

Events are durable **invalidation records**, not a second state store. Clients
refresh authoritative state after relevant events. Same-connection or reconnect
duplicates must not trigger duplicate speech/actions. Bounded polling is supported;
there is no need to add a second unauthenticated SSE service.

## Supported outbound ElevenLabs architecture

The bridge makes outbound TLS WebSocket connections. No ElevenLabs custom-LLM
callback, public tunnel, server webhook or hosted conversation agent is needed.
Eve/kernel retain all task/permission authority. The local native-to-bridge socket
uses `/v1/voice/stream`; `GET /v1/voice/status` reports unavailable/configured/
connected, not fabricated sound or verified account access.

* STT: `wss://api.elevenlabs.io/v1/speech-to-text/realtime`,
  `model_id=scribe_v2_realtime`, `audio_format=pcm_16000`, manual commit.
  Native converts microphone hardware format to mono signed little-endian PCM16
  16 kHz. Bridge sends documented `input_audio_chunk` messages with
  `audio_base_64`, `sample_rate: 16000`, `commit` as appropriate. Partial and
  committed transcript events remain distinct; only committed text dispatches.
* Output: `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input`,
  `model_id=eleven_v4_turbo`, `output_format=pcm_24000`. First message registers
  exactly one configured voice. Incremental `inputs` contain `text`, `voice_id`,
  optional `new_turn`; flush at a completed sentence/turn. Parse `audio`,
  `is_final_audio_for_turn`, `is_final` (snake case), errors, and keep-alive timeout.
  Provider docs disagree on some multi-voice v4 limits; one voice is safe under
  both descriptions. Do not use the old `/text-to-speech/{voice}/stream-input` for v4.
* Authenticate provider sockets with headers in the trusted bridge only. Missing
  key/voice/model access/format support produces explicit unavailable/error state;
  **no silent downgrade** to Apple speech, v2, v3, Flash or another provider. The
  two status stages `configured` and `connected` deliberately avoid claiming that
  the account was tested merely because an environment variable exists.

Local wire version is 1. Every frame carries `sessionId` + `generation`. A new
connection needs a new session ID; start/speak/interrupt/stop transitions advance
the generation when they replace a turn. Additional text chunks for that same
speaking turn use the same generation. `VoiceGenerationGate` is per connection and
direction; audio sequences start at zero with no duplicates/gaps. Advancing a
generation invalidates prior asynchronous microphone, network and playback work.
Stop closes capture and provider streams and prevents permission callbacks from
rearming them. Interrupt drains/discards buffered audio and closes the old TTD
connection; do not assume an undocumented provider cancel command.

Input frames are 16 kHz; output frames are 24 kHz mono PCM16. Max local frame is
32 KiB, decoded chunk 16,000 bytes, local queued audio 2 seconds. Split larger
provider frames safely; reject overlarge provider messages before buffering them.
Overflow disconnects safely, never grows without bound. Device changes/loss,
format conversion, reconnect, manual commit, cancellation and late permission
callbacks need real tests. Reconnect is bounded and requires a new generation;
never replay audio or resubmit a committed transcript automatically.

`VoiceController` preserves the existing safe AVAudio Objective-C boundary and
no-device behavior, plus existing text usability. It gains `onUtterance`,
`contextProvider`, `onAudioLevels` and `onStateChange`, and `speak(_:context:)`/`interrupt()`.
Snapshot context at capture start, not recognition completion. `onUtterance`
includes this frozen context; never route to whichever room is now selected.
Emit input/playback RMS from **actual** buffers (zero when inactive); UI must not
generate a speaking waveform from timers. Keep compatibility methods used by
current AppModel until integration rewires them. Local wake recognition, if kept,
is only an explicit on-device wake gate, not a fallback command recognizer/TTS.
Cloud capture begins only with explicit active consent; quiet/off state is visible.
Do not request secrets through spoken questions.

## Integration order and validation responsibilities

1. Compose worker and planner. Import `createWorkerRunner`/`createPlanAuthor` from
   their `index.ts` files with the options above; provider credentials stay in the
   trusted processes. Compose `createHarnessKernel({dataDirectory, worker, author,
   defaultPolicy, maxActiveWorkers: 2})`; await `initialize()` before readiness.
2. Compose `createQuestionRouter({harness})`. Wire versioned HTTP routes and merge
   actual root approvals into the harness state projection without changing
   kernel authority. Apply existing auth/error handling first, including upgrades.
3. Compose `createVoiceBridge({apiKey, voiceId})`. Pass only authenticated upgrade
   requests into `handleUpgrade`; transport must additionally bound frames, rate,
   connection count and idle lifetime. Route transcript→native→author/question,
   not provider→privileged tool. Shutdown closes voice and cancels kernel work.
4. Instantiate `RoomsModel(client: HarnessClient())` and `RoomsWorkspaceView` in
   shared AppModel/WorkspaceView. Connect `voice.onAudioLevels` to
   `rooms.updateAudioLevels`, `voice.onStateChange` to `rooms.updateVoiceState`, and
   `voice.onUtterance` to `rooms.handleUtterance` (or the safe conversation route
   when its captured context has no room). Native lane delivers
   room rail, actual graph/node states, separate inbox categories, artifact shelf,
   policy/accept/start/pause/stop controls, real levels, reduced motion and labels.
   Generated HTML is untrusted: no bridge-token injection, native handlers or
   authenticated webview scripts. Prefer text/source preview plus safe download.
5. Integrator reconciles dependencies/locks. Prep adds **none**. Voice likely needs
   a pinned maintained `ws` and `@types/ws` (Node's built-in client does not supply
   a server upgrade handler). Worker pins its inspected Python `smolagents` tool
   environment in `runtime/workers/`; generated-code image has no SDK/provider
   key. No guessed npm imports outside declared dependencies and no `latest` images.
6. Kernel tests use injected real async ports for concurrency/restart/races;
   interactions tests validate real structured model-response parsing; worker lane
   must additionally execute a real Docker fixture, isolation probes, safe artifact
   round-trip and bounded live-model run before calling integration live. No-key
   voice tests exercise actual transport codecs/state, not fake provider success.
7. Full runtime typecheck/tests/build, then the parent-owned Mac compile/native
   acceptance recording. Native audio/provider acoustic verification is a separate
   claim requiring the key, supported account and usable hardware. Do not start a
   Linux UI testing agent. Existing Mac VM was audio-less.

Verified Linux runtime setup uses the already installed Node 24:

```sh
source ~/.nvm/nvm.sh
nvm use 24
npm --prefix runtime run typecheck
npm --prefix runtime test
npm --prefix runtime run build
```

No linter or active pre-commit hook is configured in the baseline. No environment
blueprint changes are needed for the prep files; implementation lanes should
report only setup commands they actually verified for later blueprint review.

## Primary sources inspected

* Installed `eve@1.0.0-rc.6`: `docs/README.md`, `tools/human-in-the-loop.md`,
  `subagents/index.mdx`, `sandbox/index.mdx`,
  `concepts/sessions-runs-and-streaming.md`,
  `concepts/execution-model-and-durability.mdx`. In particular, DefaultSandbox can
  fall back to just-bash; pinning Eve is important because changed Eve versions can
  strand durable local sessions. Do not upgrade Eve in these lanes.
* [smolagents 1.26.0 agents](https://huggingface.co/docs/smolagents/v1.26.0/en/reference/agents)
  and [secure execution](https://huggingface.co/docs/smolagents/v1.26.0/en/tutorials/secure_code_execution):
  ToolCallingAgent uses JSON tool calls; CodeAgent AST restrictions are not a complete sandbox.
* [Docker run resource/isolation controls](https://docs.docker.com/engine/containers/run/).
* [Eleven v4](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4),
  [TTD WebSocket](https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket),
  [TTS vs TTD](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets),
  [realtime Scribe API](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime),
  [server streaming guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/server-side-streaming).

Documentation support is not account-specific validation. No provider API key was
available for ElevenLabs in prep, no paid call was made, and no sound was verified.
