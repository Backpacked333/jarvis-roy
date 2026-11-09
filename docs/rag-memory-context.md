# RAG, personal memory and context

Jarvis retrieves relevant project passages and approved memories before each conversational turn. It keeps one replaceable Eve memory slot instead of appending another copy of recalled facts every turn. Ordinary conversation history uses Eve's built-in compaction at 75% of the configured model context window.

## Use it on your Mac

1. Rebuild with `./scripts/setup-macos.sh` and open `dist/Jarvis.app`.
2. In Settings, enable **Knowledge**, **Personal Memory**, and optionally **Local Semantic Retrieval**. Restart local services. The Assistant workspace remains separately opt-in.
3. Import selected documents into a project. A read grant and its **cloud reasoning** permission are separate choices. Local-only documents can be searched in the native workspace.
4. Open **Memory** to add personal or project information. Review pending suggestions before approving them. Pin a preference or routine when it should act as standing context.
5. Ask a question. Automatic recall selects evidence and relevant memories; `recall_context` supports focused follow-ups. The project's **Context** tab previews the selected passages, provenance, omissions and conservative token budget. Local previews and cloud-eligible previews are distinct.

The development launcher accepts `JARVIS_ENABLE_KNOWLEDGE=1`, `JARVIS_ENABLE_MEMORY=1`, and `JARVIS_ENABLE_SEMANTIC_RETRIEVAL=1`. New features default off. Provider credentials remain in Keychain or the trusted launch environment.

## Retrieval

Documents retain immutable source versions, exact passage IDs and page/line locators. Keyword retrieval uses conversational query terms and SQLite FTS5 BM25. When an Apple sentence embedding model is available, Jarvis combines lexical and cosine ranks, limits repeated passages from one source, and explains which retrieval lanes matched.

Embeddings are generated locally through the bundled native helper and stored in private SQLite databases. Cache identities include model, revision, dimensions, language and OS version; incompatible vectors are never mixed. Indexing and scans are bounded, expose partial coverage, and resume on later requests. **Index local sources** warms a larger batch. Missing or busy models fall back explicitly to keyword search. The initial native model language is English. See [local semantic retrieval](local-semantic-retrieval.md) for Mac validation.

Project scope, latest source revision, archival state and current grants are checked before retrieval and again before disclosure. Revoked, expired or local-only material cannot enter a new cloud context packet. Retrieval rank and semantic similarity indicate relevance, not factual truth. Metadata-only research records remain labeled; citations identify original passages rather than independently verifying claims.

## Memory lifecycle

Structured entries distinguish personal and project scope, preference/fact/goal/person/routine/decision, provenance, confidence, expiry, pinning and cloud permission. Confidence records an assertion; it is not verification.

Native user-authored entries can be saved as active memories. Model suggestions are pending proposals. Review binds approval to the exact entry ID, revision and digest. Editing an entry makes it pending again. Supersession, archive and expiry exclude it from recall. Forget removes the current entry, its vector index and any mirrored legacy preference file; content-free tombstones prevent legacy files from resurrecting forgotten memory. Historical migration backups remain backups and may retain earlier data; Forget does not promise forensic erasure or removal from provider logs.

Project source references remain in that project and are checked against current source grants on every recall. Personal facts do not silently absorb project documents. Approved cloud-allowed pinned preferences and routines may become standing context; other pinned entries still need relevance. Local-only memory stays out of cloud recall.

Existing approved preference files are mirrored with their original identity and a backed-up migration. Native edits detach the old file; external changes require another review. Deletion of an authoritative legacy file removes its mirrored entry. Credentials are rejected.

## Context management

Packets have a stable content digest, exact project/conversation/task scope, selected original references, recall reasons, omission counts and complete serialized-size accounting. Budgets include JSON metadata and use UTF-8 bytes plus framing as a conservative token upper bound, not a provider billing measurement. Pins prioritize exact revisions but cannot bypass grants or budgets. Selection reserves room for multiple available context channels.

Automatic recall replaces the previous slot even when no authorized entries remain. History recall includes explicitly submitted user messages from the current conversation; it does not recycle assistant prose that may quote a revoked source. Active task references preserve status without granting execution authority. Personal memory capture is explicit, not automatic ingestion of every conversation.

Replacing recall does not erase previously disclosed provider content, earlier tool responses, or Eve's conversation summaries. Summaries remain historical context, never fresh evidence or action approval. The current implementation preserves the existing Eve session and durable execution ledger; it does not rotate sessions or replay actions to compact context.

## Validation and release limits

Tests cover hybrid paraphrase retrieval with a deterministic embedding fixture, source diversity, cache restart and model changes, migration backups, exact review, stale revisions, project/cloud boundaries, source revocation, forgetting, cancellation, persistence rollback and serialized context budgets. HTTP integration exercises automatic recall and proposal review with real SQLite stores. `node scripts/smoke-runtime.mjs --assistant` exercises built Eve/bridge startup, context preview, memory persistence and forgetting across restart without calling model providers.

Deterministic vectors validate retrieval mechanics. They do not measure Apple's embedding relevance. Native build/tests and representative real-document retrieval on the target Mac, followed by live model conversation evaluation, are separate release gates. No cloud embedding service or embedding API credential is required.
