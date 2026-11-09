# Durable objectives

`ObjectiveService` is a single-owner coordinator over existing task, research and
room authorities. It never executes tools, accepts a plan or approves an effect.
An empty objective needs an explicit plan. The integrated adapters support
bounded research and an already accepted, exact room plan; ordinary Eve tasks
are deliberately unavailable because their usage is not yet capped here.

The private SQLite v1 snapshot commits objective revisions, child intents,
questions/inbox, budget reservations, request deduplication and metadata events
atomically. Memory and subscriptions publish only after successful writes. A
write fault fences further mutation while retaining the last readable snapshot.
Only an empty unversioned database can initialize; unknown schemas are refused.
There is no prior objective schema to migrate. Future schema migrations must
take and verify a private SQLite backup before replacing any existing schema.
Limits are 500 objectives, 128 attempts per objective, 10,000 reservations and
16 MiB total snapshot; history and accounting are never silently pruned.

Objectives have a seven-day horizon and at most two active child operations.
Children are separately bounded to 30 minutes, including the remaining objective
horizon. Wake times and unanswered questions consume no model calls. Pausing
prevents new work; it does not freeze already running children. Stop preserves
cancellation intent and retains uncertain child slots until the underlying
authority confirms the outcome. Child questions/approvals remain with their
original authority. Objective questions only clarify the objective and never
authorize an effect. Answers compare objective revision plus question ID,
revision and expiry before entering the durable inbox.

Admission reserves at most $5 per objective, $10 per UTC day and $300 per UTC
month, using integer microdollars. `reserve`/`settle` also support trusted
integration adapters; these methods must not be exposed as caller-controlled
accounting endpoints. Known pre-dispatch rejection can settle to zero. Unknown
paid or effect outcomes retain the full reservation. Settlement is immutable;
daily/monthly accounting belongs to the reservation's original UTC period while
the objective's total never resets. Reported model cost remains an estimate,
not a provider billing cap. Unpriced retrieval retains uncertainty.

Restart never repeats a dispatch. A saved exact child receipt can be inspected
or cancelled by its original adapter. Missing receipts remain unknown and block
their slots. Inert checkpoints preserve exact child and artifact references;
their summaries explicitly remain unverified. Events report committed status,
identity and revision, never invented success, goals or source text.

`createObjectiveRuntime` supplies the research/room adapters and strict routes.
Owner authentication may come from the native app or a separately authenticated
cloud broker; model callers receive only project-scoped reads. No global native
token is promoted to a remote client. Research preserves its existing source
grant checks, citation checks and paid-call reservations. Room dispatch requires
an accepted plan revision/digest and a cost/time-capped room policy; it never
changes the plan or policy to make it fit.

Validation: `node --experimental-strip-types --test runtime/test/objectives.test.ts runtime/test/objective-runtime.test.ts`.
