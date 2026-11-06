# Harness authoring and clarification routing

This module turns a natural-language room goal into a **draft** dependency graph
using an actual Gateway model. It has no execution, plan-acceptance, approval,
host-tool, filesystem-write or network-research authority. The two additive Eve
tools let a root conversation create a room with the operator's default policy,
request a draft, and inspect scoped state. Draft acceptance and starting workers
remain separate native controls.

## Composition

```ts
import { createPlanAuthor, createQuestionRouter } from "./harness-interactions/index.ts";

const author = createPlanAuthor({ model: configuredModel });
// Pass author to createHarnessKernel alongside its worker and data directory.
const questions = createQuestionRouter({ harness });
```

`createPlanAuthor` uses `AI_GATEWAY_API_KEY` only in outbound HTTPS headers to
`https://ai-gateway.vercel.sh/v1/chat/completions`. The model is an explicit
`provider/model` supplied by the operator; there is no provider/model fallback.
The optional `modelClient` implements the frozen `AuthorModel` port for other
trusted controllers/tests. `fetch` is an injectable transport, not model input.
No npm dependencies beyond the existing pinned Eve/Zod are needed.

The model receives only the room title/description, goal, bounded inert
clarification history, role guidance, and numeric graph/run constraints. It does
not receive bridge credentials, image names, unrelated rooms, approval cards,
accepted-plan identity, or host capabilities. Builder/researcher/reviewer/tester
roles are prompt templates, not additional tool authority. Research is limited
to supplied material; workers have no network by default.

## Limits and uncertainty

- Strict JSON is parsed into a draft or question, with no extra keys. Shared
  validation enforces graph acyclicity, roles, dependency/input scope, relative
  output paths, room limits and cumulative node reservations. Model-generated
  acceptance/status, policy, tools and permissions are rejected.
- Authoring is at most three model calls total, including prior clarifications,
  and never exceeds the room's lower step/call limit. Only malformed plan output
  is eligible for correction; transport/auth/truncation failures are not retried.
- Before each call, UTF-8 context bytes plus framing allowance reserve input
  tokens conservatively; output is explicitly capped by the remaining budget and
  the room output limit. Missing usage retains the corresponding reservation and
  marks accounting partial/unknown. Known charges are never reported as zero.
- A provider reporting more tokens than reserved stops further calls and reports
  failure with the actual reported usage. Byte reservations are conservative
  estimates, **not a provider tokenizer or provider-enforced billing cap**.
  Cancellation disconnects the request but cannot guarantee the provider stops
  billing immediately. Dollar limits remain estimates; no price is fabricated.
- The active-generation deadline is the lower of the room limit and two minutes,
  cumulative across clarification checkpoints. Time spent waiting for the user
  is excluded. Oversized context fails rather than silently dropping constraints.
- Credential-like inputs and obvious requests for passwords/API keys/MFA codes
  are refused. These checks supplement strict no-tool boundaries; they do not
  claim to recognize every secret or every prompt-injection wording.

## Durable clarification authority

The kernel is the **only** question store and compare-and-consume authority.
Persist a `waiting_question` result, its cumulative usage and inert checkpoint
before presenting it. The kernel allocates the question ID/revision, checks
expiry and the complete binding atomically, persists the answer, and calls the
author again with that checkpoint and answer. Never call the author directly
from an unvalidated answer route.

The checkpoint is JSON, not a serialized agent/tool state. Its scope envelope
binds room ID, authoring ID, policy revision and goal digest, and records active
generation time. Its history contains only clarification text. Because kernel
question IDs are assigned **after** the author returns the checkpoint, only the
kernel can authenticate that later question ID/revision. The author additionally
checks scope, allowed choice/text shape and carries forward the higher cumulative
usage counters from the authoring record and checkpoint.

`questions.answerVoice` accepts only the frozen `VoiceAnswerRequest`. It resolves
the exact pending question, rejects expired/orphaned/prior-attempt targets,
normalizes only exact choice IDs/labels (case/whitespace), rejects ambiguous
collisions, and sends the entire original binding to `harness.answerQuestion`.
Unmatched speech is free text only when explicitly allowed. It never selects a
question based on the current room or a transcript, never sends Eve `optionId`,
and has no approval port. A spoken “yes” may answer a clarification but cannot
approve anything.

`attention()` returns a deterministic deduplicated queue: blocked node questions
before authoring questions, then expiry/creation/ID order. Quiet rooms are absent
from spoken attention but remain in `harness.state().questions` for the inbox.
`createSpokenQuestionQueue()` is optional ephemeral playback coordination: it
hands out one exact binding, suppresses refresh replays, and ignores stale
release calls. It is not durable state. Call `release(binding)` when playback
finishes/is interrupted; capture and retain the binding with the utterance.
Drop/cancel playback if a refreshed attention list removes that binding. Native
clients may implement the same coordination with their own real audio lifecycle.

## Eve integration and safety

The default root tools use a narrow delegation port over the frozen endpoints:

- `GET http://127.0.0.1:39202/v1/harness/state`
- `POST /v1/harness/rooms`
- `POST /v1/harness/rooms/:roomId/author`

They use only `JARVIS_LOCAL_TOKEN` in bearer headers, reject redirects, bound
responses/deadlines, and validate returned DTOs. They do not instantiate a second
kernel/client protocol or require Eve and the bridge to share memory. Request
IDs are derived from `ctx.session.id`, `ctx.callId`, and operation, so tool replay
uses the same kernel idempotency keys. There are no implicit retries. If room
creation succeeds and authoring is interrupted, the room may exist without a
draft; no work has started. Existing-room requests pass the exact observed
revision without silently refreshing it. Both tools are unavailable in subagents
and additionally check delegated session metadata at execution.

The integrator must register these frozen bridge routes behind the existing
loopback address/Host/Origin/bearer/body-size checks. Root tool instruction/config,
shared bridge source and manifests are intentionally not changed here.

Eve `1.0.0-rc.6` can use a **plain follow-up message to answer its first pending
prompt**, including an approval. Therefore:

1. Preserve `request.kind` and the exact `interactionId` from `interaction.opened`.
   `inspectEveInteraction` classifies only actual `approval` as approval;
   `question`, `budget`, `sign-in`, and unknown kinds are not approval cards.
2. Keep the existing `JarvisService.createTask` synchronous conversation
   reservation and unconfirmed-turn checks. Before any ambient text/voice
   `EveSession.send`, require authoritative idle/settled state and **no** pending
   prompt. A stale client snapshot or only the approvals array is insufficient.
3. The optional `createEveConversationGate` rejects overlapping sends and pending
   prompts. Its `inspect` port must read authoritative state; its `send` port must
   reserve the turn before returning a delivery. It does not replace durable
   task reservation, stream reconciliation, or external admission controls.
4. Only existing exact, reviewed approval-card operations may call Eve
   `respond([{ interactionId, optionId }])`. Harness questions use the kernel
   answer route, never Eve follow-up text. Keep expiry, secure-field,
   stale-native-target and reviewability checks on the legacy approval path.

## Verification

```sh
source ~/.nvm/nvm.sh
nvm use 24
npm --prefix runtime run typecheck
node --experimental-strip-types --test runtime/test/harness-interactions-*.test.ts
npm --prefix runtime test
npm --prefix runtime run build
```

The explicitly opt-in live authoring test makes at most **one** Gateway model
call with 6,000 total reserved tokens, 1,600 output tokens, and a 30-second
deadline. It generates and validates a harmless two-specialist draft only: no
worker, tool, artifact execution or external mutation. It is skipped by ordinary
tests, even when a key is configured. Run only with spending authorization:

```sh
JARVIS_TEST_LIVE_AUTHORING=1 node --experimental-strip-types --test runtime/test/harness-interactions-live.test.ts
```

Linux verification is not macOS/voice verification. The parent integrates the
kernel/worker/native lanes and validates real isolated execution, durable restart
and Mac controls. No ElevenLabs or acoustic success is claimed by these tests.
Local workers cannot continue through Mac sleep/shutdown without a separately
operated always-on worker.

## Sources

- Installed `eve/docs/README.md`, `tools/index.mdx`,
  `tools/human-in-the-loop.md`, `concepts/sessions-runs-and-streaming.md`,
  and `subagents/index.mdx` (version `1.0.0-rc.6`).
- [Gateway Chat Completions REST](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/rest-api)
- [Gateway JSON response formats](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/structured-outputs)
- [Current model catalog](https://ai-gateway.vercel.sh/v1/models)
