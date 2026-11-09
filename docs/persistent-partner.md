# Persistent partner preview

Jarvis now has a durable objective coordinator, project continuity, and a
separate private cloud deployment profile. The local Mac profile remains
available. All unattended integrations require explicit configuration.

## Run locally

Prepare the existing Mac checkout with `scripts/setup-macos.sh`. Enable
Assistant, Knowledge, Memory, Research and Persistent Objectives in Settings as
needed. Today shows objectives, questions, bounded runs and cancellation state.
The default objective estimate is $5, each child run is limited to 30 minutes,
and the horizon is seven days. Waiting does not run an inference loop.

Use a project working set to retain selected context across conversations.
“Sources and memories used” lists context supplied to a turn, with current
availability and provenance. This is not a claim that every supplied item was
used in the answer. Personal memory proposals still require review. Temporal
assertions retain corrections and supersession; conflicting facts remain
inspectable.

Continuity stores committed user goals and observed task states across project
conversations. Those checkpoints do not prove that an email was sent or another
external effect completed. Generated summaries need complete source dependencies
before recall. Memory assertions bind a selected entity and property to reviewed
values, validity dates and revision history; duplicate names do not automatically
merge people. Context-use manifests retain exact references and hashes without
copying answer text. Opening local evidence rechecks its current permission.
Remote snapshot/account references remain receipts; they do not become local
source grants.

Manual navigation holds the displayed revision until Follow Jarvis. Draft
edits create a revision and invalidate pending spoken confirmation. Passage,
table-cell and text-range references capture the exact displayed object; they
never silently retarget a newer revision. History is bounded; expired references
are refused. Equations render with bundled, offline KaTeX MathML.

## Prepare the dedicated cloud host

Follow [deploy/README.md](../deploy/README.md). The package targets Ubuntu 24.04,
Node 24, pinned Eve, systemd, Caddy, private SQLite stores and a supported Docker
engine. It installs disabled services; it does not provision a VM or domain.
The operator must supply TLS/DNS, provider access, backup destination and account
configuration. The application rejects unknown prices before spending. The
$300/month and $10/day limits are application estimates, not billing caps.

Eve, the bridge and the HTTPS gateway have distinct responsibilities. Only the
bridge writes runtime objectives and tasks. The gateway has an authenticated,
restricted loopback interface; it never receives the native UI token. Eve never
receives the cloud runtime token. Public routes cannot forward to arbitrary
bridge endpoints.

Cloud conversations now use the budgeted Eve text path. Each provider call reserves
an estimate through the bridge, validates the returned model and usage, and durably
settles accounting before releasing output or tool calls. Unknown prices, uncertain
accounting and unsupported model input block further admission. Prompt/output bounds
also apply to delegated reasoning and compaction. Provider stream chunks are buffered
until accounting completes, so this cloud path does not promise token-by-token or
sub-three-second replies. The normal unmetered local model path is not admitted as
a cloud fallback. Existing configured reasoning models remain unchanged.

Pair the Mac outbound with a dedicated device credential. Select cloud copies
explicitly: a local read grant or cloud reasoning permission does not authorize
cloud retention. Retained source/memory versions are checked again against
current retention grants before context disclosure. Account connections have
separate retention and cloud reasoning settings. Revocation aborts reads and
removes unauthorized retained/indexed material. Existing local sessions and
approvals retain their original authority.

Linux semantic search uses the pinned CPU `intfloat/multilingual-e5-base`
identity and `sqlite-vec`. Provision reviewed local model files and their exact
checksums/revisions as described in [the embedding setup instructions](../runtime/bridge/knowledge/README.md). Model
weights are not downloaded during a conversation. Missing or incompatible
weights produce an explicit lexical fallback. Apple embeddings remain local
and are never mixed into the Linux model's index.

Normal turns read the current lexical/vector index and encode the query; source and
memory document encoding runs in bounded background batches. Inference does not hold
the memory mutation queue. Revocation and Stop can therefore refuse late results while
consent edits remain responsive. Retrieval reports incomplete indexing and bounded
corpus coverage. Format-aware passage locators preserve Markdown sections, code symbols
and CSV physical rows; PDF text extraction does not verify reading order, equations,
tables or missing image text.

## Communication and exact approval

Telegram pairing binds one numeric owner user/chat. Outbound notifications use
a durable outbox; an uncertain send is retained and is not automatically
resent. Minimal status and secure links are the default. Project details need
channel disclosure permission, rechecked again when the outbox sends. A normal message
starts or continues the paired project's budgeted cloud conversation. `/new` opens
a new conversation. If the previous turn is still working, new discussion gets a
separate conversation in the same project. Task completion and pending reviews appear
through the durable outbox. Unknown submissions are retained and never automatically
retried; inspect Jarvis before issuing a replacement request.

Replies to clarification cards bind to the exact task or objective, project, question
and revision. Choice answers must match one exact option label or identifier; free
text is accepted only when the current question allows it. These replies do not grant
action authority. `/stop` pauses work and queued outreach. Resume does not restore old
approvals. The channel adapter retains at most 100 unresolved/tracked submissions and
refuses more work rather than discarding uncertain state.

Google OAuth starts with reads from selected labels and calendars. Sending
mail and writing calendar events require separate consent and the existing
exact tool approval. The approved effect ledger binds the Eve session, call,
arguments and approval revision, with durable single consumption before the
provider attempt.

Approved retained Google records can participate in project context, with a fresh
account-consent and source-revision check before disclosure. Selection is bounded to
recently synchronized permitted records, so an inbox summary or daily planning request
is not a completeness guarantee. Calendar incremental records preserve recurrence
rules and instance exceptions; this path does not expand recurring masters into a
complete daily occurrence view.

Remote review uses passkeys with user verification and a fresh action-bound
challenge. The complete proposal is frozen by revision/digest. A signed receipt
returns to the original executor, which rereads the exact pending action.
Telegram messages, telephone transcripts and generic “yes” never grant action
authority. Queued/approved work is not reported as a completed external effect;
only an exact observed receipt can resolve an uncertain result.

Owner calls use Twilio through the shared speech adapter. A call begins with a
generic greeting; a call-specific passkey verification and disclosure policy
must authorize private discussion. Calls have bounded duration, destination,
quiet hours, issue/daily limits and price reservations. Raw call audio is not
stored. Live phone/provider behavior must be validated with the owner's accounts.

After verification, phone turns use a scoped Eve conversation and recheck the exact
live call and disclosure policy before admission and before returning speech. Simple
completed replies are capped at 1,200 characters. The adapter waits at most about
15 seconds, then returns a background or uncertain-submission status. A clarification
binds only after it is returned for speech during that same verified call; a late
question cannot capture the next utterance, and its binding does not carry to another
call. Telephone agreement never executes an action; supported actions require the
existing exact secure review.

## Recovery and validation

Backups quiesce the owned writers, encrypt the consistent state, verify the
uploaded ciphertext and enforce 30-day off-host archive retention. Restore
refuses an existing destination and writes a recovery-review marker. Services
refuse unattended startup until explicit recovery review; a backup cannot prove
that an effect did not occur after it was taken. Unknown effects and reservations
remain unresolved until authoritative receipts establish the outcome.

[The persistent baseline](../evaluations/persistent-partner-baseline.json)
records the prior exact commit and CI evidence. The fixed 30 real tasks remain
unrun because no provider/physical-Mac fixture or cloud host has been supplied.
The 150 labeled retrieval cases are deterministic regression fixtures; their
results do not establish multilingual model quality on a personal corpus.
Likewise, project continuity fixtures and software passkey/telephony transports
do not replace physical-device testing or the seven-day personal pilot.

Current operator gates include provider catalog access, reviewed model weights,
actual Docker resource enforcement, public TLS, pairing, Google/Telegram/Twilio
owner setup, encrypted off-host restoration, and real latency measurements.
Cloud conversation code is implemented behind accounting/readiness checks; live model
admission, real account conversations, phone acoustics and physical Mac behavior remain
release gates. Reviewed E5 weights are not bundled: the implementation environment
could not retrieve the model repository, so live E5 inference and personal-corpus
quality remain unverified. Objective adapters continue to require bounded research or
accepted isolated room plans where those execution modes apply.
