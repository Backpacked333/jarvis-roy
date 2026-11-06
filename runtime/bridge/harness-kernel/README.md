# Durable room kernel

`createHarnessKernel(options): HarnessService` implements the frozen v1 ports.
The bridge must supply `WorkerRunner` and `PlanAuthor`, await `initialize()` before
advertising readiness, and await `shutdown()` on exit. This module does not wire
HTTP, run host tools, contact providers, or approve operations.

```ts
const harness = createHarnessKernel({
  dataDirectory,
  worker,
  author,
  maxActiveWorkers: 2,
  defaultPolicy: defaultRoomPolicy(configuredPinnedImage),
});
await harness.initialize();
```

The default image is deliberately null. Run start fails unless availability has
been established and the room has an explicit digest-pinned sandbox image. No
fallback executor exists. Availability is sampled during initialization; changing
backend installation/configuration requires restarting the bridge.

## Storage and recovery

Node 24's built-in `node:sqlite` is the only storage dependency. The database is
`<dataDirectory>/harness-kernel/kernel.sqlite`, in a private directory with 0600
regular-file checks. SQLite FULL-sync transactions atomically commit state,
idempotency keys, intents, answers, revisions, reservations, metadata and events.
A lifetime exclusive SQLite lock prevents two bridge processes from dispatching
the same database. OS process death releases the lock; there is no stale-PID lease
to guess or manually override. Use a local filesystem, not a network share.

The initial migration creates SQLite `user_version=1` and the versioned snapshot
table. Unknown versions, corrupt schemas, plan/artifact digest mismatches and
inconsistent scopes fail closed rather than creating an empty replacement. This
store is independent of the existing conversation/task store; it never migrates
or rewrites that history. Stop the bridge before backing up the entire kernel
directory. There is no automatic deletion/compaction of accepted plans/artifacts.

Each mutation works on a cloned snapshot. Nothing is published until the durable
commit succeeds. Write failure fences further dispatch, aborts controllers and
attempts resource cancellation. Restart reconciles before allowing more work.
Workers must await every event acknowledgement and stop on a rejected event.

Startup reconciles every unresolved attempt, including an intent written before
the resource-start event. A validated durable result is adopted without running
the worker again. Otherwise the kernel attempts teardown; unknown/missing outcomes
stay interrupted and require an explicit safe retry. Unconfirmed resources keep
their global/per-room slots. A stop acknowledgement proves teardown, not missing
provider accounting. Unknown consumption retains its entire unspent reservation
and cannot be retried inside the old budget; create a newly budgeted run instead.
Shutdown also attempts cleanup, with bounded control deadlines. Local execution
does not continue during Mac sleep or shutdown.

## Plans, budgets and scheduling

Model authoring receives a scoped room snapshot and an inert checkpoint, never
execution authority. Authorings are committed before asynchronous work begins.
The kernel assigns plan IDs, room/policy revisions and timestamps, then validates
the graph. Editing, acceptance and starting are distinct controls. Accepted plans
and handoff manifests are immutable. Run start requires an exact accepted digest
and revision and snapshots the policy. Changing room policy does not mutate a
running run's grants. New starts require the current policy revision. For policy
updates, send the current policy revision; the server increments it.

Full-node step/call/token maxima are reserved at plan validation/run creation.
They are not fresh budgets for retries or answers. Worker usage must be monotonic
and **cumulative for the entire node**, including explicit retries. Original
accepted limits are passed to the worker, whose durable journal enforces that
cumulative consumption; the kernel independently checks counters, reservations,
and continuation allowance. Missing usage is partial/unknown, never measured zero.
Dollar limits and reported dollars are estimates, not hard provider billing caps.

Scheduling rotates rooms and runs, honors global and room-wide caps across all
their runs, and dispatches only completed prerequisites. `inputFrom` handoffs are
immutable manifests from this run/plan's successful ancestors. Failed/cancelled
prerequisites block descendants. Pausing prevents new dispatch but does not
pretend to freeze already running work. Cancellation returns `cancel_requested`
first and only confirms after teardown; late output cannot resurrect the run.

Wall time is persisted separately because v1 `Usage` has no duration field. The
kernel conservatively reserves **aggregate active worker milliseconds** for a
run (parallel workers each consume time), using elapsed wall-clock time clamped
against rollback. Human waiting consumes none. Timers enforce the remaining
node/run allowance. A recovered durable result has no duration in the frozen
contract, so it consumes its entire previous wall reservation, not guessed
elapsed time or post-crash downtime. A recovered clarification can therefore
exhaust the old node's wall allowance; use a new explicitly budgeted run. A future
versioned result duration would make recovery less conservative.

## Questions and artifacts

The kernel is the sole question authority. A question is bound to exact room,
run/node/attempt or authoring IDs, revision and a 24-hour expiry. Answering consumes
that binding atomically and stores the answer before a new worker attempt exists.
Duplicate answers conflict. Waiting checkpoints are inert; the old resource must
be stopped. The next attempt gets the exact checkpoint and answer and never
replays prior tools. Answers queued behind a pause survive restart and dispatch
once when resumed. Expired questions fail the suspended work rather than quietly
retargeting it. Questions in quiet rooms remain available; attention selection is
the separate router's job.

Worker and authoring prompts (including choice IDs/labels) pass the same sensitive
information filter before any snapshot, event or UI state is committed. Text,
choice and voice answers are checked at the kernel boundary before consumption or
continuation; rejection leaves the exact pending revision unchanged. The shared
filter uses credential patterns, secret redaction and sensitive terms, not a claim
to detect every possible secret. Clarifications never grant approval authority.

Recovered worker questions pass the same checks as live results. Legacy snapshots
containing unsafe prompts/answers fail startup before dispatch or reconciliation,
with no raw state exposed and no automatic rewriting or cancellation of unrelated
resources. Such data requires offline review; this is not secure erasure of content
already written by an older version, including journals or backups.

`approvals` is empty for the parent to project real root approval cards. There is
no kernel approval mutation, and a spoken answer cannot grant privileged authority.

Artifacts are metadata only here. The authenticated bridge first calls scoped
`harness.artifact(roomId, runId, artifactId)`, then the worker's digest/path-bound
`artifacts.read`. This kernel validates manifest hashes, provenance, declared
output paths, upstream digests and aggregate count/byte bounds. The worker reader
must verify actual content bytes and file safety; these tests do not impersonate
real container output or verification evidence. No HTML execution is authorized.

## Operational bounds and tests

History fails closed at 100 rooms, 1,000 plans/runs/authorings, 5,000 questions,
10,000 artifacts/attempts/request keys, or a 32 MiB serialized snapshot. Accepted
history is not silently pruned. Export/rotate the stopped data directory when the
limit is reached. Event polling retains the last 1,000 events and returns
`resetRequired` for stale/future cursors. Each attempt is limited to 1,000 events.
Worker cancel/reconcile controls have five-second response deadlines; uncertainty
is surfaced rather than assumed success. Run timers are bounded by policy.

```sh
source ~/.nvm/nvm.sh
nvm use 24
npm --prefix runtime run typecheck
node --experimental-strip-types --test runtime/test/harness-kernel.test.ts
npm --prefix runtime test
npm --prefix runtime run build
```

Tests use actual SQLite persistence, observed-commit barriers, controllable typed
ports, reentrant callbacks and SIGKILL child-process recovery. They exercise intent
windows, scoped durable-result adoption, orphan cleanup, idempotency/CAS,
parallelism/fairness, dependencies, immutable handoffs, cancellation races,
unknown accounting, persistence failure, expiry and exact new-attempt resumes.
They do not establish Docker isolation, live model behavior, or Mac UI/audio;
those belong to worker and integrated platform verification.
