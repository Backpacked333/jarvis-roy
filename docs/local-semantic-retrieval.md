# Local semantic retrieval

Enable **On-device semantic retrieval** in Settings and restart local services,
or set `JARVIS_ENABLE_SEMANTIC_RETRIEVAL=1` in the development launcher. It is off
by default and independent of the personal-memory feature. Project knowledge,
resource grants, and cloud-disclosure checks still control source access.

The trusted bridge asks the bundled JarvisControl helper for an already available
`NLEmbedding.sentenceEmbedding(for:)` model. English is the initial default.
The helper does not request model assets or call a network embedding service.
A missing model, unsupported platform, or invalid helper response produces an
explicit lexical fallback. Turning the feature on does not certify model
availability or retrieval quality on a particular Mac.

Model identity binds the language, macOS version, Apple model revision, and
vector dimensions. Every embedding batch must match the discovered identity.
A changed identity requires reindexing; vectors from different models are never
silently mixed. Vectors are finite and normalized before returning to knowledge
storage. Text and vectors are not written to diagnostic logs.

Requests travel through bounded stdin IPC to the operator-selected helper,
without provider credentials or shell arguments containing text. The shared
helper authority permits one native operation at a time. The shared embedding
provider serializes callers with at most eight waiting batches; cancelled queued
work is removed immediately and never reaches the helper. It holds no native
helper authority between requests, so desktop operations retain their existing
authority checks. Cancellation terminates
the process and returns no partial batch. Input is bounded to 16 texts, 16 KiB
per text and 64 KiB total; batches split further for JSON escaping and the native
output budget. A slow or busy helper falls back visibly rather than blocking
search indefinitely.

Linux tests exercise the adapter using a disposable protocol fixture, including
model changes, malformed vectors, batch limits, cancellation and credential
isolation. Native model availability and embedding quality require macOS tests;
syntax parsing alone does not establish either.
