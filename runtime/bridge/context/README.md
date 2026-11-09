# Bounded context packets

`createContextAssembler` builds deterministic version-1 JSON packets from injected
source, memory, conversation-history and checkpoint providers. It does not call a
model, summarize documents, write memory, execute actions, or change Eve sessions.
The existing evidence and conversation stores remain authoritative originals.

`assemble(request, signal)` requires an exact project, optional conversation/task
scope, local/cloud purpose, query and current user-turn text. A project-only local
preview uses null conversation and task IDs. A task requires its conversation.
The packet records the current turn's SHA-256 and task ID; the actual user message
remains in the normal turn instead of being duplicated inside retrieval data.

Each configured provider supplies at most 64 candidates and implements both
bounded retrieval and a synchronous current-authorization check. Retrieval gets a
32-candidate target and exact pin references; the provider must materialize pins
within its bounded result instead of loading an entire collection. Permission
checks run after all asynchronous retrieval and action reads, again at the end of
assembly, and through `revalidate(packet)` immediately before disclosure. Changes
to source grants, memory revisions/expiry, project membership and active actions
must therefore be reflected by those callbacks, not cached authorization flags.
An unauthorized candidate is omitted; a permission change after selection refuses
the packet. Never accept caller-authored packet JSON as a substitute for assembly.

Source candidates carry immutable source-version and passage IDs with optional
page/line locators. Approved personal memories may be projected into the requested
project only after the memory provider authorizes that use; their personal origin
remains visible in provenance. Approval means the user allowed that memory, not
that its factual claims were independently verified. History and checkpoints must
belong to the requested conversation. Prefer direct user messages; replaying old
assistant prose can disclose excerpts from a source whose grant was revoked.
An extractive checkpoint should preserve references to its original messages.
Model-authored summaries remain explicitly unverified historical data.

Pins take priority, followed by one candidate from each available channel, then
ranked candidates. The first round caps each excerpt at 2,048 UTF-8 bytes so an
abundant source channel does not consume the default packet before memory/history
can participate. Later excerpts can use up to 8,000 bytes. Text is an exact Unicode
prefix, never a generated summary. Each excerpt carries the full original text's
hash, original/selected byte counts and a truncation flag. Pins do not bypass
permissions, revision matching, item limits or budgets. Missing pins and omitted
candidate counts remain visible without exposing their content.

Providers can attach bounded retrieval diagnostics (lexical, hybrid, history or
unavailable mode and warnings), including when no candidates match. Candidate
retrieval reasons remain beside the assembler's selection reasons. These fields
are reference data and count against the same serialized budget; a partial index
or lexical fallback must not be presented as complete semantic recall. Memory
selections retain up to all 20 supported evidence references rather than dropping
citations to fit a smaller packet.

Both the byte budget and token budget cover the **entire serialized packet**,
including citations, labels and accounting metadata. The conservative token
estimate is the UTF-8 JSON byte count plus 32 framing tokens. This deliberately
underuses many models' text capacity; it is a byte-tokenizer upper bound, not an
exact tokenizer measurement or provider billing figure. Callers must budget any
additional prompt framing separately. Current-turn and action provenance are
mandatory: a budget too small for that metadata is refused. Runtime actions are
only references; this packet cannot approve or retarget them.

For automatic retrieval, use Eve's stable recall-message replacement mechanism
with one context message ID per turn. Assemble again under current cloud grants;
replace the previous recall even when no selections remain. A context packet
alone does not bound or remove the provider's existing conversation history.
Automatic recall refreshes once per turn, not between every model call in a turn.
Previously authorized tool results, user messages or model replies may remain in
that history. Runtime-managed compaction and stable recall replacement are
separate controls; neither makes a model summary verified evidence. Do not rotate
the session ID of an existing Jarvis conversation: the task store deliberately
enforces immutable session identity. A future continuation feature should create
a fresh conversation in the same immutable project and explicitly link an
authorized bounded checkpoint while retaining the original conversation.

Validation: `node --experimental-strip-types --test runtime/test/context.test.ts`.
Tests cover determinism, fair channel selection, exact citations, byte/token
bounds with multibyte text, pins, project/conversation boundaries, revocation,
action references, control text, malformed provider output and cancellation.
