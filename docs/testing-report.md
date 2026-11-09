# Implementation testing

This pass exercised the current working tree on Linux with Node 24.22.1 and
Python 3.12.14. Native compilation and physical audio require a Mac.

## Executed checks

| Check | Result | What it establishes |
| --- | --- | --- |
| `npm --prefix runtime run typecheck` | Passed | TypeScript contract and implementation consistency. |
| `npm --prefix runtime test` | 475 tests: **454 passed, 21 skipped, zero failed** | Runtime regression behavior. Provider/Docker opt-in skips are excluded from passes. |
| `npm --prefix runtime run build` | Completed with missing-model-catalog warning | Eve tool compilation; live model selection remains blocked. |
| `node scripts/smoke-runtime.mjs` | Passed | Built Eve/bridge readiness, authentication, Origin rejection, conversation/room restart persistence, Stop and owned-process cleanup. |
| `node scripts/smoke-runtime.mjs --assistant` | Passed | Native-authority routes, session/import/grant persistence, local-only disclosure refusal, revocation and archive access. |
| `./scripts/setup-analysis-image.sh` | Four offline fixtures passed; enforcement probe failed | Numerical/symbolic/tabular/plotting dependencies work. This Docker host is unsuitable for worker execution. No image was enabled. |
| `./scripts/build-macos.sh` | Blocked: requires macOS 14+ | Native build was attempted and correctly refused Linux. |
| Swift source parsing | 65 files, zero syntax errors | Syntax only; no Swift type checking, XCTest, UI or audio execution. |

The analysis image was built from the pinned, hash-verified dependencies and
reused the immutable local ID
`sha256:f534040003846d19da734a3658ee7b375cdab854dcd10077f29610240c5f732f`.
The four offline fixtures passed again in 1.98 seconds. The mandatory isolation
probe exited with failure and the setup command produced zero stdout bytes,
so it could not advertise an approved image. No test containers remained.

## Integration scenarios

New tests use actual loopback HTTP servers, real bridge/session/knowledge/research
services and SQLite stores on disposable directories and ephemeral ports.
Eve/Gateway responses and native playback attestations are deterministic
fixtures. They do **not** establish model quality, physical playback or biometric
identity.

- Import selected text, start bounded research, execute separate synthesis and
  critique requests, verify exact quoted passages, and read the saved result.
- Reject missing authority, another project's evidence, local-only disclosure,
  repeated confirmations and stale action references.
- Revoke a source grant during inference and confirm request abortion and result
  denial; Stop all cancels research and invalidates pending voice approval.
- Run main and side room conversations concurrently; cancel the chosen project's
  work while preserving another project. Unconfirmed cancellation stays visible.
- Disconnect/reconnect the event stream at its current cursor, replay missed
  events exactly once and reject an invalid future cursor.
- Reject oversized multibyte presentations before durable mutation; retain valid
  captured references and prune replay history by bytes without losing current
  presentation state.

See [HTTP research tests](../runtime/test/assistant-research-http.test.ts),
[concurrency tests](../runtime/test/assistant-concurrency.test.ts),
[event integration tests](../runtime/test/assistant-integration.test.ts) and
[coordinator tests](../runtime/test/assistant.test.ts).

## Defects found and corrected

- Idle SSE connections withheld response headers until an event or heartbeat.
  Headers now flush immediately, including when reconnecting at the latest cursor.
- Room-scoped cancellation reported completion while main/side conversation tasks
  continued. It now cancels and verifies all project-scoped root work alongside
  the existing room worker authority.
- Valid presentation schemas could exceed native stream limits. Serialized
  UTF-8 cards/events now have compatible byte limits, replay has a byte budget,
  and native state fetches match the store's bounded snapshot size.
- Native HTTP responses could overwrite newer streamed revisions, and stale
  approval replies could restart review/challenge playback. Revision merges and
  post-await playback checks now reject those older states.
- Daily briefings treated valid fractional-second expiry dates as malformed.
  They now use the existing shared date parser and explicit grant predicates.
- Busy dictation and late submission responses could discard newer drafts.
  Submission outcomes now explicitly distinguish admission from retained text.
  Drafts are scoped to immutable session IDs; switching projects restores the
  correct draft, late replies target their original session, and repeated busy
  captures stay visibly separated for review.
- Ordinary ASR sentence-final periods and thousands commas invalidated an
  otherwise exact spoken challenge. The matcher now permits those two narrow
  formatting variants while rejecting question marks, quotes, extra words,
  changed numbers and generic yes. Every other review/expiry/single-use check
  still applies.

Native fixes have regression tests added in
[AssistantExperienceTests.swift](../macos/Tests/JarvisVoiceTests/AssistantExperienceTests.swift).
Those tests still require execution on macOS.

## Remaining acceptance

The running environment has no Gateway, ElevenLabs or Tavily credentials. A
fresh request to `https://ai-gateway.vercel.sh/v1/models` was refused by the
managed proxy with CONNECT 403; model metadata remains `fetchedAt: null`.
The saved environment draft has not changed the running policy.

Docker reports cgroup driver `none`; its real enforcement probe fails. Keep
worker execution disabled here. Do not substitute passing numerical fixtures
for resource-isolation acceptance.

Mac compilation, Keychain/permissions, speakers/headphones, audio-device changes,
sleep, physical interruption latency and real account actions remain unverified.
The [30-task evaluation set](../evaluations/README.md) remains unrun with live
models. Follow the [latency measurement guide](latency-diagnostics.md) and keep
these release gates separate from backend regression success.
