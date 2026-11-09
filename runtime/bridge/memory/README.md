# Structured memory

`MemoryService.open` owns a private SQLite database and is disabled unless
`enabled: true` or `JARVIS_ENABLE_MEMORY=1`. It does not capture user activity or
write personal memories automatically. The bridge must derive the agent's
project from its authenticated task and reserve `nativeAuthenticated: true` for
the separate native capability.

Agents can propose and recall. Native actions can create, inspect, export, edit,
approve, archive, supersede, and forget. Proposal origin is always `inferred`.
Approval requires the exact pending entry ID, revision, and canonical digest.
Any edit, including pin or cloud consent, creates a new proposed revision.
Native creation is itself an explicit approval. Confidence and provenance are
recorded assertions; approval does not independently verify a remembered fact.

Recall includes active, unexpired global entries and entries in the exact
requested project. Agent recall always uses cloud purpose and requires explicit
`cloudAllowed`. Source-linked entries require a synchronous `resolveSource`
dependency that checks the exact source version, project, passage, current read
grant, and archive state. Missing or failing resolvers deny recall. The public
`authorize({id, revision}, {projectId, purpose})` repeats these checks at the final
context disclosure boundary.

Optional `embeddingProvider` implements the shared trusted local embedding
interface. Recall combines meaningful lexical terms, local cosine similarity,
pinning, and recency, returning reasons and explicit retrieval status. Approved
pinned preferences and routines are standing context within their allowed scope;
other pins still need relevance. The private vector cache binds the entry digest
and model identity. Each request indexes at most 32 new entries, scans at most
512 vectors, and allows two seconds for local inference. Busy or invalid helpers
produce an explicit lexical fallback. `cancelReads()` and the optional recall
abort signal cancel queued or active reads; native edits/archive/forget also
cancel reads before changing authority.

Legacy UUID JSON files were written by the existing approval-required remember
tool. They are mirrored as approved global preferences with their original cloud
recall behavior and a private migration snapshot. Later edits require fresh
approval. Original files remain authoritative until a native action adopts the
entry into structured storage. Missing originals remove mirrored entries.
Content-free tombstones prevent stale original files from resurrecting content;
adoption or forgetting removes the original and its legacy snapshot copy.
Synchronous authorization also verifies an unadopted original's current file
fingerprint. `onLegacyChanged(id)` lets the bridge remove its separate legacy
Knowledge inspection index. The bridge must route enabled legacy recall through
this service, since direct file recall has no scope or cloud controls.

SQLite schema upgrades create a private pre-migration database backup. Backups
are never restored automatically. Forget removes the live record, lexical index,
and vector cache transactionally; schema backups are historical operator
recovery artifacts. The store uses secure deletion, full synchronous commits,
exclusive ownership, private file modes, strict versioned records, and bounded
record sizes. Tests exercise real SQLite persistence and migration; semantic
tests use a deterministic local provider rather than claiming live Mac inference.
