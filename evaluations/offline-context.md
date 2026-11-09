# Offline context evaluation

`offline-context.mjs` measures the production in-process context assembly path
without model calls, an embedding encoder, account access, or network access.
It uses synthetic public fixture text in a fresh temporary data directory and
removes that directory afterward. It does not touch your Jarvis data.

Run with Node 24 and the repository's installed runtime dependencies:

```sh
node evaluations/offline-context.mjs \
  --output /tmp/jarvis-offline-context-report.json \
  --samples 300 --warmup 30
```

The runner refuses to overwrite a report. Use a new filename for each run.
Reports contain the fixture digest, relevant code-file hashes, start/end commit,
Node/kernel/CPU/cgroup metadata, raw successful samples, failures, and nearest-rank
p50/p95. Missing or failed measurements are never represented as zero. Performance
has no pass threshold in this harness; a completed run is not release approval.

Add `--profile true` to collect inclusive phase timings during measured assembly.
Nested phase durations overlap and must not be added together. Add
`--final-authorization true` to time a separate, fresh synchronous authorization
immediately after each assembled packet, matching the HTTP handler's final guard.
That optional measurement excludes JSON serialization and the response/network send.

## What the fixture exercises

- The fixed [150-query fixture](../runtime/test/fixtures/retrieval-150.json) has
  30 short, single-sentence sources and five directly labeled queries per source.
  Each query must find its expected source in the first three lexical retrieval
  results. Returned citations are resolved through the actual knowledge service.
- A temporary SQLite knowledge store holds the imported immutable originals and
  explicit cloud-enabled fixture grants. Thirty approved project facts reference
  these sources. One global pinned preference participates in every context packet;
  foreign-project and no-cloud preferences must stay excluded.
- Twenty projects each record five distinct session episodes. Duplicate event
  delivery must preserve identities; service close/reopen must preserve all five
  scoped sessions per project and the approved working-set pin.
- Production `createContextRuntime.current()` combines source retrieval, memory
  recall, checkpoint retrieval, packet budgeting, final authorization and durable
  usage manifests. The runtime's current-turn/history/scope source is a small,
  explicit in-process fixture with 12 earlier user messages and one running task.
  It is not an Eve session, an HTTP request or a native UI test.

Import, service startup, the 150 retrieval checks and 30 warmup assemblies precede
measurement. The measured 300 calls traverse the query set twice in fixed order.
They share one fixture task identity; the second pass can reuse an existing
packet/manifest identity. This measures warmed repeated context assembly, not
300 distinct conversation turns or a worst-case durable-write workload.
Each call includes SQLite work performed by `current()`, including permission
checks and usage-manifest persistence. The runner records all timings; it does
not remove slow samples. It checks packet scope and exact source hashes after
stopping each sample timer. Those evaluation-only assertions are outside timing.

## Interpretation limits

This tiny corpus tests implementation contracts and warm assembly overhead.
Direct lexical labels are easy retrieval cases. They do not establish useful
paraphrase search, multilingual ranking, document extraction quality, or research
accuracy on a real personal corpus. No E5 files are provisioned or loaded. The
continuity checks establish persistence and scope behavior, not understanding of
an ongoing project. There is no human or expert review.

The managed Linux workspace is not the proposed reference VM or the target Mac.
Other workspace activity, host scheduling and storage are uncontrolled. These
numbers cannot establish the UI-feedback, playback-interruption or first-audio
performance targets. The fixed 30-task human evaluation, E5 inference/quality,
physical-device checks and real-account pilot remain separate, unrun gates.

## Recorded Linux result — 2026-11-09

The workspace reported an AMD EPYC 7763 CPU, four CPUs of cgroup quota, 32 GiB
of cgroup memory, Linux 6.18.57 and Node 24.22.1. The corpus contains only
**1,595 bytes of original source text**. Relevant production files were stable
during every recorded run; reports include exact file hashes and worktree state.

The first run overlapped other local tests. It is preserved as
[the original report](offline-context-linux-2026-11-09.json), with p50 605.04 ms
and p95 1,231.78 ms. After the competing local test run finished, a separate
profiled baseline showed that approximately 73 individual audit writes per
assembly consumed 125.39 seconds of 144.89 seconds total measured time (86.5%).
Live grant checks themselves averaged 0.046 ms each.

The implementation now buffers read-audit events per assembly and commits every
event in a synchronous SQLite transaction before returning context. Grant,
revision, source and provenance checks still read current state. Mutation audits
remain immediate. Failed assembly still records its intermediate reads; failed
audit persistence withholds the packet. The final HTTP authorization uses its own
synchronous audit transaction. Usage manifests are written only after a successful
audit commit and another fresh synchronous authorization. No transaction spans an
await, and no grant decision is cached.

| Measurement | Samples | Before p50 | After p50 | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Warm production context assembly, including durable manifests | 300 each | 453.68 ms | 60.52 ms | 809.09 ms | 109.14 ms |
| Separate fresh synchronous final authorization | 30 each | 11.46 ms | 6.03 ms | 84.40 ms | 15.39 ms |

The 300-sample runs used identical corpus/query/configuration inputs and 30 warmups,
with phase profiling enabled. The separate final-authorization pair used the same
fixture with 30 samples and five warmups. Root's local test jobs were paused during
these comparisons; residual host load and storage variation were not controlled.
The observed p95 assembly is below the 500 ms objective **for this fixture**, not a
claim about a large corpus, E5 inference, a reference VM, or physical Mac interaction.
The audit phase after optimization measures buffering; its eventual durable commit
remains included in total context latency.

Both 300-sample runs had zero execution, scope or citation failures; the expected
source appeared in all 300 packets. Each report also records 150/150 labeled top-three
retrieval checks, all 20 projects retaining their five sessions after service reopen,
100 successful duplicate-event checks, and the retained working-set pin. No expected
labels were changed for the optimization.

Raw evidence:

- [Profiled assembly before](offline-context-isolated-before-2026-11-09.json)
- [Profiled assembly after](offline-context-isolated-after-2026-11-09.json)
- [Final authorization before](offline-final-authorization-before-2026-11-09.json)
- [Final authorization after](offline-final-authorization-after-2026-11-09.json)
