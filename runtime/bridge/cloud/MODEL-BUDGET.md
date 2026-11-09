# Cloud conversational model admission

`JARVIS_RUNTIME_PROFILE=cloud` automatically selects the bounded AI SDK v4
model wrapper. It retains `JARVIS_MODEL` and Eve as the execution authority.
The root agent and analyst use the same selection; automatic compaction inherits
the wrapped active model. No compaction override or alternate unwrapped model
should be added. Cloud selection uses a conservative 16,384-token application
context window, independent of the model catalog's advertised maximum.
The cloud profile requires an explicit `AI_GATEWAY_API_KEY`; missing credentials
are rejected before reservation. Presence does not establish provider validity.

`ModelBudgetRuntime` is the single writer for per-call accounting. Its loopback
`/v1/model-budget/*` routes require the bridge's local bearer authentication.
The Eve session header is resolved by `JarvisService` to its admitted task and
project; delegated model calls use their root session. The request cannot supply
its own project, objective, price, or dollar allowance. These routes must never
be mounted on the public cloud gateway. Native and cloud-runtime credentials
are not supplied to Eve.

Each actual provider invocation, including compaction, reserves against the
shared objective ledger before dispatch. A turn is limited to 32 model calls,
30 minutes, and $5 estimated cost; global ledger limits remain $10 per UTC day
and $300 per UTC month. There are at most two outstanding model calls. Each
call has a 120-second deadline, a 96-KiB serialized text/tool envelope, and at
most 4,096 output tokens. Known Gateway catalog pricing is required, with the
highest supported tier/cache/regional rates used conservatively.

The input estimate is twice the UTF-8 envelope byte count plus 8,192 tokens for
provider framing. It is an admission estimate, not a provider-enforced billing
ceiling. Observed usage above the bound is charged and fences new calls. Unknown
model identity, missing usage, interrupted streams, or lost accounting receipts
retain the reservation and also fence admission. Inspect provider accounting
before any manual recovery; restarting does not clear unknown calls or replay
them. Current recovery intentionally requires an operator, rather than an
automatic retry or unverified refund.

All generated and streamed output is buffered until exact model identity and
token totals pass validation and settlement commits. Tools therefore cannot run
from an unaccounted stream. This also delays cloud text display until the model
call finishes. The actual provider's short model ID may match its requested
publisher/name; a fast OpenAI alias additionally requires priority metadata.
Unknown aliases and provider options that introduce model fallbacks fail closed.
Errors returned to Eve are terminal HTTP-style 403 errors without provider
causes, preventing Eve's provider retry/recovery path from bypassing admission.

This path accepts text and ordinary function tools. Media, remotely expanded
files, provider-hosted tools, and direct Tavily search/extraction are refused.
Other paid tools must enter their separately bounded objective adapters; model
accounting does not authorize an unpriced provider API. Eve's inert session and
safety identifiers are permitted, while optional attribution headers are removed.

The private SQLite store contains identifiers, prices, limits and accounting
receipts only. Durable writes precede committed-state publication. A crash
between the separate model and shared-ledger writes is treated as unknown;
neither database is used to infer a free retry. Stop blocks reservation but
settlement remains available so already observed usage can still be recorded.

`test/cloud-model-budget.test.ts` exercises real SQLite and the real public AI
SDK against deterministic provider fixtures. It covers delayed tool release,
actual SDK tool non-execution after rejected accounting, cancellation, replay,
project binding, restart, disk faults, shared limits, and Eve's terminal error
classifier. The compaction/analyst configuration guard checks inheritance; these
tests do not claim a live paid Eve conversation or a live provider evaluation.
