# RAG, personal memory and context

Jarvis retrieves relevant project passages, approved memories and permitted project continuity before each root conversational turn. It keeps one replaceable Eve memory slot instead of appending another copy of recalled facts every turn. Ordinary conversation history uses Eve's built-in compaction at 75% of the configured model context window. This bounds the recall packet, not the entire provider conversation.

## Use it on your Mac

1. Rebuild with `./scripts/setup-macos.sh` and open `dist/Jarvis.app`.
2. In Settings, enable **Knowledge**, **Personal Memory**, and optionally **Local Semantic Retrieval**. Restart local services. The Assistant workspace remains separately opt-in.
3. Import selected documents into a project. A read grant and its **cloud reasoning** permission are separate choices. Local-only documents can be searched in the native workspace.
4. Open **Memory** to add personal or project information. Review pending suggestions before approving them. Pin a preference or routine when it should act as standing context.
5. In the project's **Context** tab, inspect selected passages, provenance, omissions and the conservative token budget. Local previews and cloud-eligible previews are distinct. Save a project working set to persist selected pins and a project goal across conversations.
6. Ask a question. Automatic recall uses the working set alongside relevant evidence, memories and continuity; `recall_context` supports focused follow-ups. **Sources and memories used** shows the context supplied to a turn, with current availability. It does not claim the model used every item in its answer.

The development launcher accepts `JARVIS_ENABLE_KNOWLEDGE=1`, `JARVIS_ENABLE_MEMORY=1`, and `JARVIS_ENABLE_SEMANTIC_RETRIEVAL=1`. New features default off. Provider credentials remain in Keychain or the trusted launch environment.

## Retrieval

Documents retain immutable source versions, exact passage IDs and page/line locators. Markdown sections, code symbols and CSV physical rows add format-aware locations. PDF text extraction does not establish reading order or recover image-only text. Keyword retrieval uses conversational query terms and SQLite FTS5 BM25. When the configured local encoder is available, Jarvis combines lexical and cosine ranks, limits repeated passages from one source, and explains which retrieval lanes matched.

On macOS, embeddings use the bundled native helper and an available Apple sentence model; English is the initial language. The Linux cloud profile supports provisioned, pinned `intfloat/multilingual-e5-base` CPU embeddings with `sqlite-vec`. Reviewed model files and conversion provenance must be supplied before enabling Linux inference; weights are not downloaded during a conversation. Apple and E5 have separate model identities and indexes. See [Mac semantic retrieval](local-semantic-retrieval.md) and [Linux model provisioning](../runtime/bridge/knowledge/README.md).

Private SQLite caches bind model/revision, dimensions and platform-specific identity. Incompatible vectors are never mixed. Source and memory document encoding runs in bounded background batches; normal turns encode the query and read the existing index. Memory mutation does not wait on inference. Missing, busy or incompatible models produce an explicit lexical fallback, and partial index coverage remains visible. Source vector distance is exact over at most 100,000 authorized indexed passages; larger corpora use a bounded scan with coverage warnings. Memory vector recall scans at most 512 eligible cached entries. These are retrieval bounds, not a promise to search every document or memory.

Project scope, latest source revision, archival state and current grants are checked before retrieval and again before disclosure. Revoked, expired or local-only material cannot enter a new cloud context packet. Retrieval rank and semantic similarity indicate relevance, not factual truth. Metadata-only research records remain labeled; citations identify original passages rather than independently verifying claims.

## Memory lifecycle

Structured entries distinguish personal and project scope, preference/fact/goal/person/routine/decision, provenance, confidence, expiry, pinning and cloud permission. Optional assertions bind a selected entity and property to a value, validity interval and observation time. Duplicate names do not automatically merge entities. Confidence records an assertion; it is not verification.

Native user-authored entries can be saved as active memories. Model suggestions are pending proposals. Review binds approval to the exact entry ID, revision and digest. Editing an entry makes it pending again. Supersession, archive and expiry exclude it from current recall. Explicit historical assertion lookup can use the applicable validity interval while preserving revision and source permissions. Conflicting values with overlapping validity are shown for review; they are not silently resolved. Forget removes the current entry, its vector index and any mirrored legacy preference file; content-free tombstones prevent legacy files from resurrecting forgotten memory. Historical migration backups remain backups and may retain earlier data; Forget does not promise forensic erasure or removal from provider logs.

Project source references remain in that project and are checked against current source grants on every recall. Personal facts do not silently absorb project documents. Approved cloud-allowed pinned preferences and routines may become standing context; other pinned entries still need relevance. Local-only memory stays out of cloud recall.

Existing approved preference files are mirrored with their original identity and a backed-up migration. Native edits detach the old file; external changes require another review. Deletion of an authoritative legacy file removes its mirrored entry. Credentials are rejected.

## Context management

Packets have a stable content digest, exact project/conversation/task scope, selected original references, recall reasons, retrieval diagnostics, omission counts and complete serialized-size accounting. The current automatic route allows at most 12 selected items, 32,768 serialized bytes and a conservative 12,000-token upper bound. The latter uses UTF-8 bytes plus 32 framing units, not a model tokenizer or billing measurement. The preview route supports 0–32 selected items and 512–12,000 estimated tokens under the same byte ceiling. A budget too small for required scope/action provenance is refused.

Project working sets persist up to 16 source, memory, history or checkpoint pins and a project goal. Automatic recall consumes these pins on later turns; they are no longer limited to an inspector preview. Exact pinned source passages and memory revisions are retrieved even without a lexical match when authorized. Missing, stale or revoked pins remain omissions rather than silently selecting a replacement. Pins cannot bypass project scope, cloud permission or packet limits. Standing memory pins are separate: approved preferences/routines may be included without a query match, while other kinds still require relevance. Selection gives available channels a chance to contribute before filling remaining space by relevance; excerpts can be truncated with the original hash and selected span retained.

A history pin still has to belong to the current conversation. Project
continuity supplies permitted context across conversations; pinning does not
remove a conversation boundary.

Automatic recall replaces the previous slot even when no authorized entries remain. Failed authorization does not reuse an old packet. History recall includes explicitly submitted user messages from the current conversation; it does not recycle assistant prose that may quote a revoked source. Cross-conversation project checkpoints retain committed user goals and observed task states. Generated summaries require complete, currently authorized dependencies before recall and remain unverified historical context. Active task references preserve status without granting execution authority. Personal memory capture is explicit, not automatic ingestion of every conversation.

Each supplied packet can produce a context-use manifest containing references, revisions, hashes, selection reasons and citations without copying answer text. Opening the manifest rechecks current local availability. A manifest records supplied context, not claim attribution or proof that a tool executed. Remote retained-snapshot and Google account references remain receipts; they do not become local source grants.

Replacing recall does not erase previously disclosed provider content, earlier tool responses, or Eve's conversation summaries. Summaries remain historical context, never fresh evidence or action approval. The current implementation preserves the existing Eve session and durable execution ledger; it does not rotate sessions or replay actions to compact context.

## Cloud retention and disclosure

The cloud profile accepts only explicitly retained source/memory versions and permitted account context. Local reading, permission to send data for cloud reasoning, and permission to retain a cloud copy are separate decisions. Retained snapshots are checked against current retention grants before disclosure; Gmail/Calendar context additionally checks account consent and exact source revision. Revocation interrupts reads and excludes unauthorized retained/indexed content from new packets. Source synchronization is bounded, so a recalled inbox or calendar excerpt is not a completeness guarantee.

Research objectives have their own durable checkpoints. Their continuation currently includes bounded user answers and exact predecessor references, not arbitrary old summaries or artifact contents lacking revocable lineage. An owner review package can join current-authorized research results and actual worker manifests/check records. That join does not establish that a later model inspected every preceding artifact.

## Validation and release limits

Tests cover hybrid paraphrase retrieval with deterministic embedding fixtures, source diversity, cache restart/model changes, background-index cancellation, temporal assertions, migration backups, exact review, working-set pins, continuity, stale revisions, project/cloud boundaries, retained-account revocation, forgetting, persistence rollback and serialized packet budgets. The 150 labeled retrieval fixtures are regression cases, not a live multilingual benchmark. HTTP integration exercises automatic recall and proposal review with real SQLite stores. `node scripts/smoke-runtime.mjs --assistant` exercises built Eve/bridge startup, context preview, memory persistence and forgetting across restart without calling model providers.

Use [latest validation](../evaluations/latest-validation.json) for the exact tested commit, automated results and CI status. The [earlier baseline](../evaluations/persistent-partner-baseline.json) already records successful macOS build/tests; it must not be presented as the latest run. Physical Mac behavior, representative real-document retrieval, live E5 loading/relevance, model conversation quality and the seven-day personal pilot remain separate acceptance gates. Deterministic vectors establish retrieval mechanics, not Apple or multilingual model quality. No cloud embedding service or embedding API credential is required.
