# Jarvis for Roy

Persistent objectives, project continuity and the private cloud deployment are described in [the persistent partner guide](docs/persistent-partner.md) and [deployment instructions](deploy/README.md). Cloud services remain opt-in until the operator supplies and verifies the host and accounts.

A native macOS assistant for spoken collaboration, project research and explicitly approved actions. Jarvis combines SwiftUI, an authenticated TypeScript bridge, Eve cloud reasoning and isolated local workers. Inspired by the [Awesome Jarvis blueprint](https://github.com/csells/awesome-jarvis/blob/main/blueprint.md).

**Preview. There is no notarized consumer download.** CI builds a self-contained, ad-hoc signed disk image for Apple silicon and for Intel on every push (see [Install without a terminal](#install-without-a-terminal)); macOS asks once before opening it. A new installation starts with the Assistant, project knowledge and reviewed memory on; anything that acts on the Mac, reaches an account, leaves the Mac or spends unattended stays off until you turn it on. The five implementation stages have not all passed their release gates, nothing has been accepted on a physical Mac yet, and the window follows the [Jarvis HUD design](#the-hud) which is still being built out. See [implementation status and open acceptance gates](docs/implementation-status.md) and [the 30-task evaluation set](evaluations/README.md).

## Available in the source preview

- **Everyday startup:** after setup/build, open `dist/Jarvis.app` directly. The app supervises local services, checks readiness and bounds recovery attempts. Settings stores provider credentials in Keychain and nonsecret preferences in app settings. Close the window to keep Jarvis available; use the menu bar or **Control–Option–Space** to summon it. Quit stops its services.
- **Conversations and an adaptive workspace:** the opt-in Assistant coordinates sequenced events, captured project/visual references and side conversations while work continues. Native source, passage, document, equation, table, chart, code/diff, plan, draft and action views have stable IDs/revisions; Back, Pin and manual selection keep review under your control. Goal changes are explicit revisions. Existing conversations remain available, with separate activity and approval cards. Saved personal preferences are shared deliberately; project evidence stays scoped.
- **Rooms:** durable scoped workspaces with validated specialist dependency plans, separate **Accept** and **Start** actions, bounded parallel local Docker workers, immutable artifact previews, exact question cards, cancellation and restart reconciliation. Plan authoring is not execution. Generated code never runs on the host or receives host credentials. Local work stops during sleep/shutdown; this is not an always-on cloud worker service.
- **Voice:** explicit session-only cloud consent, ElevenLabs **v4 Turbo** dialogue streaming and **Scribe v2 realtime**, bounded sentence/audio queues, playback-drain acknowledgements and a reusable authenticated connection. Conversational and extended-dictation modes support pauses, corrections and “Still thinking.” Stop speaking and Stop all have separate meanings. Apple recognition is only an optional local “Hey Jarvis” detector. Wake listening is **off on every launch**. Exact buttons remain available; optional voice approval requires a reviewed proposal and its fresh challenge, never a generic “yes.” Acoustic interruption still requires hardware acceptance.
- **Desktop:** approved main-screen OCR, bounded Accessibility inspection, and validated focus/click/set-text/navigation-key actions. Approving a control action explicitly activates its named app after you leave the approval card; process identity, observation freshness and target safety are still checked before interaction. Document/window controls require unchanged non-menu content across the app, including other windows; menu targets require the entire observed tree unchanged. Secure or stale controls are refused. No universal app compatibility promise.
- **Terminal:** opt-in exact executable/argument-array/cwd execution, per-action approval, timeout/output limits and process-group cancellation. **It runs with your user's privileges, NOT in a security sandbox.** Explicitly approved scripts can access your files and network.
- **Project knowledge:** SQLite full-text search over imported PDF, text, Markdown, CSV and selected code, with original bytes, immutable versions, passage locators and extraction status. Individual grants control local reads and cloud disclosure separately. Inspect, supersede, archive, export or delete indexed material. Selected-window, Calendar and Mail context use exact resource scopes; a window grant never permits whole-screen OCR.
- **Research:** bounded Tavily retrieval plus arXiv/Crossref metadata, source-linked deliverables and a separate critique. The research workflow runs one Gateway synthesis call and one critique call, checks exact citation passages and reports unresolved evidence. Numerical work runs in Rooms with the optional [offline analysis image](runtime/workers/analysis/README.md). It requires an explicit budget; suggested limits are **$5 estimated cost, 30 minutes and two concurrent workers/retrieval slots**. Estimates are not provider billing caps, and model critique is not independent factual verification.
- **Apple services and daily preparation:** native Mail, Calendar and iMessage use accounts already configured on your Mac. Grant-based reads enforce the selected mail account/calendar; Calendar context includes recurring occurrences. Existing per-action approvals remain available. Optional daily briefings use one selected project's permitted cloud sources while Jarvis is active, awake and unlocked; they prepare drafts/proposals and do not execute actions. iMessage remains **send-only**.
- **Home Assistant:** optional approved state reads and allowlisted light/switch/fan/climate/media-player actions through your configured instance, not “all brands” or HomeKit support.
- Approved notes and saved preferences; separate analyst for reasoning/drafting from supplied context, with no private tool access.

## Install without a terminal

1. Open the repository's **Actions** tab, choose the latest successful **Checks** run on the branch you want, and download `jarvis-macos-apple-silicon` (M-series Macs) or `jarvis-macos-intel`. Tagging a commit `v<version>` also creates a draft release holding both images.
2. Unzip it, open the `.dmg`, and drag **Jarvis** to **Applications**. The image includes `Read me first.txt`.
3. Open Jarvis. Because this build is not signed with an Apple Developer ID, macOS blocks the first launch: on macOS 15 open **System Settings → Privacy & Security** and click **Open Anyway**; on macOS 14 right-click the app and choose **Open**. This is needed once.
4. Setup asks for one thing: a [Vercel AI Gateway key](https://vercel.com/ai-gateway). It is stored in your Keychain. Voice (an ElevenLabs key and voice ID) is optional.

The app contains its own Node.js and runtime; nothing else needs installing. Your data lives in `~/Library/Application Support/JarvisRoy`. If Jarvis cannot start, the banner at the top of the window says why, shows the failing service's last output, and has **Copy diagnostics**. After replacing the app with a newer build, macOS may ask again for Keychain or microphone access; that is a side effect of ad-hoc signing.

## The HUD

The window follows the Jarvis HUD design handoff. Built so far: the instrument chrome and design tokens, the **Command Deck** (what needs you, threads, the core, operations, the conversation, a command bar and Stop all), the **authorization lock** for every approval (exact arguments, fingerprint, impact, hold to authorize), and the **Stop-all banner**. The core is Jarvis's presence: a particle face driven only by the real voice state and measured audio levels, with a drawn sphere as the fallback. The other tabs still show their earlier screens inside the chrome. Panels the design shows that have no real data behind them yet (situation, anticipation, telemetry) are not drawn rather than mocked.

The face's geometry derives from a third-party model whose licence notices were not supplied with the design; see `macos/Sources/Jarvis/Resources/Presence/Presence-NOTICE.txt` before distributing a build.

## Requirements

The table below is for building from source. The disk image above needs only macOS 14 or newer and a model key.

| Dependency | Requirement |
| --- | --- |
| macOS | 14 Sonoma or newer |
| Compiler | Xcode Command Line Tools, Swift 5.9+ (`xcode-select --install`) |
| Runtime | [Node.js 24 LTS](https://nodejs.org/en/download), npm on `PATH` |
| Cloud model | [Vercel AI Gateway key](https://vercel.com/docs/ai-gateway/authentication-and-byok) and credits |
| Optional room execution | Python 3.10+, pinned controller dependencies, local Docker with cgroup v2/default seccomp, explicitly pulled immutable image |
| Optional voice | ElevenLabs key with v4 Turbo/Scribe access, one configured voice ID, real microphone/output and explicit session cloud consent; Speech Recognition/on-device English-US support only for wake detection |
| Optional providers | Your Tavily key and/or Home Assistant instance/token |

Text conversations do not require Docker or a speech-provider key. No database account or Vercel deployment is required. Model, research and voice use may be billed by their providers. Dependencies remain pinned to Eve `1.0.0-rc.6` and Zod `4.6.7`; upgrades require protocol/migration review.

## Reproducible setup

```sh
git clone https://github.com/Backpacked333/jarvis-roy.git
cd jarvis-roy
./scripts/setup-macos.sh
open dist/Jarvis.app
```

`cd runtime && npm run doctor` lists anything that would stop Jarvis from starting, with the fix for each item; it never prints a credential. `./scripts/package-macos.sh` builds the self-contained app and disk image locally. `cd runtime && npm run start:all` starts the two local services without the Mac app, for development.

The setup script runs `npm ci`, builds Eve, builds both Swift executables and bundles the helper. The app records the trusted checkout/runtime and Node paths at build time; it still needs that prepared checkout and Node 24. In **Settings → Providers**, save your Gateway key in your login Keychain, then restart local services. Configure the ElevenLabs key and voice ID there if desired. Moving the checkout requires rebuilding or selecting its trusted runtime path in Settings. Missing model metadata or credentials are reported explicitly; saving a credential is not a connection test.

The development launcher remains available: `./scripts/run-macos.sh` uses shell configuration, starts the local services itself and supplies fresh ephemeral authentication tokens. It prompts for a missing Gateway key without echoing or persisting it. Keep that terminal open; quit/relaunch the launcher to apply changes. Do not start app-owned and launcher-owned services simultaneously.

In the app, choose **New conversation**, then type a message. To try the new workspace, enable **Voice-first assistant** in Settings, restart services and select Assistant. Enable **Project knowledge and read grants** separately to import sources for the selected project. Cloud sharing starts off for each grant. Ask to save a preference and inspect its approval. Keep unrelated work in separate projects.

### Room worker setup and first run

Install a maintained Docker engine yourself, start it, then run `./scripts/setup-workers.sh`. This creates the trusted Python controller venv and checks pinned dependencies; it does not pull images or start workers. Choose the exact platform digest in [worker setup](runtime/workers/README.md), explicitly run `docker pull "$JARVIS_WORKER_IMAGE"`, and save the immutable image in **Settings → Diagnostics → Isolated analysis workers**, or export `JARVIS_WORKER_IMAGE` for the development launcher. The app discovers the local venv and Docker binary. Missing prerequisites fail closed, not through a host executor.

In **Rooms**, create two differently named rooms. Select one, enter a bounded goal, and **Author plan**. Inspect its graph, limits and output paths, then **Accept** and explicitly **Start**. Staff states and operations come from real worker events; artifacts appear only after sealed output. A question stops the old container and seals declared files; an exact answer creates a new attempt without replaying old tools. A question answer is not approval for a host action. Review such approvals in their original conversation. Use **Stop all** to stop root work, authors, workers and voice; uncertain stops/restarts require inspection and explicit retry.

The initial Python image is intentionally offline and cannot run arbitrary npm/native builds: there are no dependency downloads, network access or executable scratch binaries. For numerical/symbolic work and plots, build and probe the [pinned analysis image](runtime/workers/analysis/README.md). Declare every durable file/directory in plan outputs. [Worker limits](runtime/workers/README.md) describe the boundary; the actual engine must pass the enforcement probe. Dollar estimates are **not provider billing caps**. A sleeping/shut-down Mac cannot keep a local run working.

In the project's Knowledge view, **Room history** can mark a settled room archived, then export its immutable history and remove it from active state. Active work, pending questions/approvals, uncertain cancellation or unknown accounting block archival. Archived history preserves room/run IDs, deduplication and artifact references; JSON exports contain manifests, while original artifact bytes remain in their store.

### Opt-in capabilities

Use **Settings** for app-owned provider credentials, feature switches and model preferences; provider secrets go to Keychain, never UI defaults. Restart services after changes. **Capabilities** shows the actual server's configuration status. For development, set shell variables and quit/relaunch the launcher. Explicit shell values take precedence over app preferences. Environment flags require the exact value `1`; unset/empty/`0` is off in the launcher.

```sh
# Enable only the features you want; these do not grant macOS permissions.
export JARVIS_ENABLE_DESKTOP=1
export JARVIS_ENABLE_TERMINAL=1
export JARVIS_ENABLE_APPLE_SERVICES=1
./scripts/run-macos.sh
```

The checked-in `.env.example` contains **empty values only**, as a reference. It is **not automatically sourced**. Inject keys through your credential manager or a non-echoing shell prompt; do not paste real keys into chat, notes, command arguments or shell history. For example in bash:

```sh
read -r -s -p 'Tavily key: ' TAVILY_API_KEY; printf '\n'; export TAVILY_API_KEY
```

| Variable | Behavior |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Required inference credential, trusted runtime/bridge only; never passed to generated workers |
| `JARVIS_MODEL` | Default `openai/gpt-6-sol-fast` (GPT-6 Sol Fast through Vercel AI Gateway); unset/empty uses this default |
| `JARVIS_DEEP_MODEL` | Research synthesis/critique model; empty uses `JARVIS_MODEL`; replacements require evaluation |
| `JARVIS_DATA_DIR` | Default `~/Library/Application Support/JarvisRoy` |
| `JARVIS_ENABLE_ASSISTANT` | Default off; session coordination, event stream and adaptive workspace |
| `JARVIS_ENABLE_KNOWLEDGE` | Default off; local knowledge, scoped grants and history access |
| `JARVIS_ENABLE_MEMORY` | Default off; reviewed personal/project memory and bounded automatic recall |
| `JARVIS_ENABLE_SEMANTIC_RETRIEVAL` | Default off; local Apple sentence embeddings for hybrid document and memory retrieval; explicit keyword fallback |
| `JARVIS_ENABLE_RESEARCH` | Default off; bounded synthesis and critique; also requires Knowledge |
| `JARVIS_ENABLE_VOICE_APPROVAL` | Default off; action-specific spoken confirmation; also needs Assistant and cloud voice consent |
| `JARVIS_ENABLE_DESKTOP` | Default off; enable helper-based screen/AX tools |
| `JARVIS_ENABLE_TERMINAL` | Default off; enable unsandboxed terminal tool |
| `JARVIS_ENABLE_APPLE_SERVICES` | Default off; enable native Mail/Calendar/Messages |
| `TAVILY_API_KEY` | Tavily web retrieval off without a valid-format key; imported-source and public metadata research remain available |
| `HOME_ASSISTANT_URL`, `HOME_ASSISTANT_TOKEN` | Home Assistant off without both; fixed credential-free origin, no paths/query/fragment |
| `JARVIS_ALLOW_HOME_ASSISTANT_HTTP` | Default off; `1` permits HTTP only to an explicit private/loopback IP; prefer HTTPS |
| `JARVIS_LOCAL_TOKEN` | Ephemeral local service token supplied by the app supervisor or launcher; never save/share |
| `JARVIS_NATIVE_TOKEN` | Separate ephemeral native control authority; never given to Eve, model tools or generated workers |
| `JARVIS_NATIVE_HELPER` | Absolute bundled helper path set by supervisor/launcher; do not point to untrusted code |
| `JARVIS_WORKER_IMAGE` | Explicit local digest-pinned Linux image; mutable tags and automatic pulls are refused |
| `JARVIS_WORKER_PYTHON`, `JARVIS_DOCKER_BINARY` | Trusted absolute interpreter/Docker paths; launcher detects local venv and Docker |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | Bridge-only key and one selected voice; no credentials in native frames, query strings or worker environments |

To disable, change the relevant Settings switch or remove the shell override and relaunch. Model tools cannot enable features or create grants. Runtime tools refuse disabled/unconfigured services even if the model proposes them.

**RAG and personal memory:** enable Knowledge and Personal Memory in Settings, import selected documents, and review their cloud-sharing grants. Enable Local Semantic Retrieval to add on-device similarity search. The Memory workspace supports personal and project facts, preferences, goals, people, routines and decisions; suggestions require review, and edits require another review. Context is selected automatically each turn with bounded size, exact citations and current permissions. Use the project's Context inspector to examine selections, omissions and pins. See [RAG, memory and context](docs/rag-memory-context.md) for setup and boundaries.

Conversations, the analyst, Room plan authoring and worker reasoning use `JARVIS_MODEL`. Research synthesis/critique can use `JARVIS_DEEP_MODEL`, initially falling back to the same configured model. Choose models in Settings or the launch shell, then restart. No separate OpenAI key is needed; ElevenLabs voice models are unchanged. Budgeted calls require known prices and matching returned models from the [Gateway catalog](https://ai-gateway.vercel.sh/v1/models). Missing pricing, model mismatch or uncertain usage blocks further budgeted calls. Retrieval and critique count toward research admission; Tavily requires an explicit cost allowance because its actual charges are not observed.

Tavily setup: [quickstart](https://docs.tavily.com/documentation/quickstart), [Search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract). Queries/URLs go to Tavily; no login/paywall bypass. DNS preflight rejects local/special addresses, but Tavily resolves and fetches downstream pages itself; Jarvis cannot pin its DNS or fully control provider redirects. Retrieval time is not publication time; content may be cached.

Home Assistant setup: [authentication](https://www.home-assistant.io/docs/authentication/), [REST API](https://developers.home-assistant.io/docs/api/rest/). Create a token in your own Home Assistant profile, keep it runtime-only, and use an appropriately restricted account. The app never displays its URL/token. Supported service actions are limited; locks, alarms, doors, scripts, automations and arbitrary services are excluded. State reads omit provider attributes. A submitted service request is not proof a physical device changed.

### macOS permissions and native account setup

1. **Voice:** configure the ElevenLabs key and voice ID, relaunch, then explicitly enable **Cloud voice** for this session before Listen. Microphone PCM goes to Scribe, and spoken reply text goes to ElevenLabs v4 Turbo. The key stays in the bridge. Allow Microphone; optional local wake detection also needs Speech Recognition. If denied, use **System Settings → Privacy & Security → Microphone / Speech Recognition**, then relaunch. Missing/unsupported provider, voice or audio devices leaves typing available; there is no silent Apple/provider downgrade.
2. **Screen and app control:** opt in through Settings or the launch environment. In **Privacy & Security → Accessibility** and **Screen & System Audio Recording** (Screen Recording on macOS 14), grant the responsible JarvisControl/helper or launching terminal identity. The helper is bundled at `dist/Jarvis.app/Contents/Helpers/JarvisControl.app`, has a stable bundle ID and its own embedded/privacy metadata. A selected-window read grant remains narrower than whole-screen OCR. macOS prompts remain authoritative; rebuilding/moving ad-hoc signed bundles may require granting permissions again.
3. **Apple services:** configure accounts in **Mail**, **Calendar**, and **Messages** yourself. Opt in, request a bounded account/calendar/service listing, approve it, then allow the actual responsible terminal/runtime under **Privacy & Security → Automation** for that app. OSA execution may be attributed to the launching terminal, not the SwiftUI bundle. Privacy declarations explain intent; they do **not** grant access or replace TCC prompts. A permission refusal is an error, not a successful connection.

Mail supports bounded recent inbox headers, explicit inbox message reads and sends with exact account/from/to/subject/body. Grant-based reads enforce the selected account before returning content. No attachments, bulk sending, CC/BCC or arbitrary mailboxes. Auto-Cc/Bcc is refused; a content mismatch can leave an unsent draft. Listing sorts a bounded native-order selection, not an exhaustive newest-first inbox scan. Calendar supports explicit-calendar creation plus occurrence-aware EventKit context reads, including recurring events; use **Set up Calendar access** in Settings for its permission. No attendees, invitations or event deletion. iMessage requires one configured service and one email/E.164 recipient; no history, SMS, attachments or groups. Submission does not prove delivery.

### Wake listening is not a dedicated low-power wake engine

Optional wake detection uses rolling **on-device English-US speech recognition**, brief rearming gaps and a wake phrase at the start of an utterance; the subsequent command is a bounded, consented Scribe turn. Apple on-device availability varies by hardware, installed language resources and OS. Mute invalidates late permission/transport results; Apple prompts themselves cannot be programmatically dismissed.

**Hands-free is a separate, default-off session opt-in.** After the cloud disclosure, its own confirmation explains the local echo-cancelled microphone during replies, speech-classified interruption and automatic cloud reply/clarification windows. A window opens only after provider completion **and actual native playback drain**, stays bound to the original conversation or exact question, and closes after eight seconds of silence. Explicit fresh Listen/wake captures use the current target, never an old question. Busy conversations, pending approvals and existing drafts still block automatic submission. Mute/Stop all/sleep disable hands-free and spoken alerts; OS notification preferences are unchanged. Unsupported audio processing fails closed. Physical acoustic echo rejection, interruption accuracy and battery behavior still need real-device acceptance; injected-signal tests are not acoustic proof.

One app-owned room observer remains alive across navigation, with bounded background polling. Attention offers independently opt-in generic OS notifications and spoken questions; quiet rooms suppress proactive alerts. Notifications contain no question text and revalidate the exact target before navigation. They never answer or approve anything. The orb, microphone/playback meters and graph reflect real levels and runtime state; reduced motion removes animated geometry and background audio history is suppressed.

## Architecture and safety boundaries

```text
SwiftUI → Rooms / conversations / separate approval and question cards
  └─ authenticated 127.0.0.1:39202 bridge
       ├─ session coordinator → sequenced events → typed native presentations
       ├─ scoped grants / local knowledge / bounded research synthesis + critique
       ├─ conversations/tasks/approvals/capabilities/memory
       ├─ durable room kernel → validated author → explicit accepted-plan start
       │    └─ trusted controller → credential-free, offline, bounded Docker workers
       ├─ exact checkpoint questions / immutable scoped artifacts / cancellation
       ├─ authenticated voice WS → ElevenLabs Scribe + v4 Turbo (explicit consent)
       └─ authenticated 127.0.0.1:39201 Eve runtime
            ├─ Gateway model (cloud), analyst (supplied evidence only)
            ├─ Tavily public research
            └─ explicit approvals → local helper / terminal / Apple apps / Home Assistant
```

`defaultTools: false` remains in both agents. No default shell/browser/filesystem tool is enabled. The narrow authored terminal is independently opt-in. Effects use the existing runtime approval authority; context reads need an exact grant or the existing per-action approval. Grant creation, import, local-only browsing, archival and voice control require separate native authentication that Eve never receives. Full exact action arguments remain reviewable; missing/redacted/over-131,072-character arguments are deny-only. Credential-like inputs are conservatively refused. Webpages, screen text, emails, calendar entries, memories and tool results are untrusted data, never authorization.

Optional voice approval freezes the proposal's exact target, arguments, revision and digest. Jarvis reads the action-specific review, waits for actual playback drain, then opens a 15-second window for a fresh challenge such as “confirm amber 1234.” A generic “yes,” earlier audio, document text, modified/expired proposals and already-consumed challenges cannot authorize it. The local app must be active and unlocked. This confirms consent through the live channel, not biometric identity. Room plan review, acceptance and starting remain separate decisions. Successful confirmation uses the existing execution and deduplication authority; it adds no alternate execution path.

Both local services remain loopback-only and authenticated; the bridge rejects Origin-bearing browser requests. Do not tunnel, proxy or expose the ports. Child environments are allowlisted, provider credentials go only to trusted processes that need them, and generated workers remain credential-free. App-owned startup reads provider keys from Keychain; the development launcher's UI environment excludes provider keys. Credentials are never saved in UI defaults. Native process helpers receive minimal secret-free environments. A malicious process running as your OS user is outside this local boundary.

**Stop all / ⌘. immediately mutes capture and interrupts speech before asking for cancellation.** Cancellation needs runtime confirmation; unconfirmed threads stay blocked. Late output is labeled separately. Already-completed effects remain; cancellation is **not rollback**, and deliberately detached terminal descendants may escape cleanup. Do not repeat uncertain sends or mutations: inspect the target app/device. Hashed operation markers persist uncertain writes across sessions; there is no automatic retry/reset button.

Stop all fences requests admitted before the stop, including slowly uploaded request bodies, and waits for authoritative room cleanup rather than just a cancellation request. Failed, missing, unavailable or timed-out cleanup returns an explicit unconfirmed error and keeps new work/voice connections blocked. Inspect status and explicitly retry **Stop all** after resources settle; an eventual background result alone never reopens admission. Read-only status and exact cancellation remain available. A genuinely hanging admitted operation cannot safely be bypassed; restart still requires reconciliation.

If an approval or clarification response fails to return a receipt, its acceptance is unknown. Jarvis blocks the task and removes its response cards rather than offering a potentially unsafe retry. Late delivery output is labeled separately and cannot reopen the task, including after restart. Confirm **Stop** before continuing, and inspect any affected app: cancellation does not undo an action the runtime may already have accepted.

Clarification cards are not credential-entry forms. Known credential patterns and requests for secrets are rejected in root questions, author/worker questions and text/voice answers. Worker guards run before private checkpoint persistence, and exact rejected answers do not consume the pending question. These are conservative checks, not universal secret detection. Legacy unsafe room snapshots refuse startup for offline data review; old journals/backups are not automatically erased.

Optional authoring dollar thresholds now participate in admission: zero permits no model call, supported Gateway catalog prices reserve each bounded call, and cumulative estimates survive correction/resume. Missing pricing, unidentified returned models or uncertain prior costs fail closed when a threshold is configured. Token/call/wall-time limits remain separate. Estimates are conservative—not provider invoices or hard account billing caps; set provider-side limits as well.

## Privacy, persistence and migration

- Cloud reasoning receives submitted text, prior turns, recalled personal preferences and permitted tool results, **including approved screen/account content**. New project knowledge requires the exact project's source grant with cloud sharing enabled before disclosure. Revocation stops queued/new broker reads and interrupts guarded in-flight work; it cannot withdraw text already sent to providers or erase it from an existing provider conversation. Review provider policies before using sensitive data. Redaction is best-effort.
- Imported originals and versions remain local immutable files, with SQLite full-text indexes and page/line provenance. Textless PDFs are reported honestly; scanned documents require extraction/OCR outside this importer. Global legacy memories migrate as personal preferences with a backup; project facts/evidence do not silently become personal preferences. Source export, archive/restore and deletion apply to indexed copies, not the original selected file or provider history.
- Wake detection is local where supported. Command microphone PCM and spoken reply text go to ElevenLabs only after session cloud consent. Do not speak secrets; provider retention is separate. Screen images are not saved; recognized screen text can enter persisted/model context.
- Room state uses private local SQLite; inert checkpoints and immutable artifact bytes are private files. Restart reconciles resources without blindly replaying side effects. Explicit settled-room archival writes immutable history before transactional pruning; deduplication and artifact access survive. Unresolved work is never automatically discarded. Versioned migrations back up previous stores. Room histories/artifacts are not encrypted; back them up before upgrades and use FileVault.
- Task/conversation snapshots use private atomic version-2 storage, automatically migrating the old task-array format. Unavailable legacy user input is marked unavailable rather than invented. Opaque Eve session IDs remain server-side. Back up state before upgrading; do not run an old app against the migrated store.
- Retention targets 100 tasks/conversations but protects active/unconfirmed work. This is not encrypted storage. Use FileVault and your macOS account boundary. Deleting a saved memory does not erase copies in history/provider logs.
- To reset, quit the app **and any launcher**, back up notes/knowledge/history, then remove your configured Jarvis data directory and this checkout's `runtime/.eve`. This removes deduplication markers; inspect uncertain actions before resetting. Keychain credentials require separate removal in Settings or Keychain Access. Provider-side retention is separate.

## Development and verification

```sh
# Node 24, pinned dependency install
cd runtime
npm ci
npm run typecheck
npm test
npm run build
cd ..
node scripts/smoke-runtime.mjs
node scripts/smoke-runtime.mjs --assistant

# macOS only: app + helper bundle, debug and release native tests
./scripts/build-macos.sh
swift test --package-path macos
swift test --package-path macos -c release
swift test --package-path macos-control
swift test --package-path macos-control -c release
```

CI builds the app and runs the Swift tests in debug and release on **macos-15**, renders key screens to PNG (the `jarvis-ui-snapshots` artifact), and builds and self-checks the disk images. None of that is acceptance on a physical Mac. Linux runtime tests cover auth, failed durable commits, scope/cloud boundaries, grant revocation, archive recovery, confirmation replay, model budgets, cancellation, provider failures and launcher filtering. The separate `isolated-workers` job installs the pinned controller/image and exercises real Docker controls plus HTTP → kernel → worker integration. Its model transport is deterministic, not live inference. No test count implies live account, acoustic or numerical task acceptance. See [evaluation instructions](evaluations/README.md) for the fixed 30 tasks and fixture recording.

The runtime suite currently has just over 700 tests, with 21 skipped because they need Docker or a paid provider; the exact count is whatever the test run prints. In this environment, the Gateway catalog is blocked and an allowlist change is saved as an unapplied setup draft. Rootless Docker fails the actual resource-enforcement probe, so worker execution correctly remains blocked. All 30 live task evaluations remain unrun. These are open release gates, not successful acceptance results; see [current status](docs/implementation-status.md).

Run real isolated tests locally with `JARVIS_WORKER_DOCKER_TESTS=1 JARVIS_WORKER_CODING_TESTS=1 JARVIS_WORKER_KERNEL_TESTS=1 JARVIS_WORKER_PYTHON="$PWD/runtime/workers/.venv/bin/python" npm --prefix runtime test` after explicitly setting up both platform-pinned images. The coding profile supports offline Node/Python builds and native helpers inside the disposable sandbox; it does not download packages. Declared outputs are published separately from bounded private checkpoint scratch. Optional live fixtures spend provider credits and require explicit opt-in; see [worker tests and setup](runtime/workers/README.md). Do not put production credentials in CI.

For the bounded production-composition live proof, configure your key, pinned image and venv, then run `JARVIS_HARNESS_LIVE_TEST=1 JARVIS_WORKER_MODEL=openai/gpt-6-sol-fast node --experimental-strip-types --test --test-name-pattern='authorized live production' runtime/test/harness-integration.test.ts` from the root. It uses real author/worker calls and checks actual artifact bytes; invalid model responses fail closed rather than retrying silently. This fixture is not voice or native UI acceptance.

**Verification levels:** inspect the exact commit's [Checks](https://github.com/Backpacked333/jarvis-roy/actions/workflows/checks.yml). Earlier documentation recorded bounded Mac fixtures for conversation continuity, approvals, terminal/TextEdit and OCR; those results do not validate the new supervisor, workspace, grants or voice-confirmation path. Current work still requires macOS compile/tests, microphone/speakers/headphones, long pauses, audio-device changes, sleep/wake, permission denial, active/unlocked confirmation, live account scope and actual Docker resource limits on the target Mac. Performance targets—250 ms p95 interruption, 150 ms visible local feedback and 3 s median first meaningful audio—are unmeasured. No personal-account sends or physical device changes were performed in this cloud implementation.

**Known model UX limitation:** the model can ask for approval in chat without proposing a tool card. Ask it to invoke the requested tool explicitly. Plain chat confirmation never authorizes execution; a real runtime approval requires its exact button or the enabled review-and-challenge protocol. Failed tool calls show sanitized, bounded native/runtime errors; do not rely solely on the model's explanation or blindly retry uncertain effects.

For native acceptance: launch, create two threads, confirm separate transcripts/drafts, run a follow-up and restart for continuity, verify busy/interrupted send blocking and approvals, reject then explicitly approve isolated harmless actions, and test Stop all. With a real microphone, verify permission allow/deny, busy/offline transcript retention, thread switches, mute during prompts/retries and speech interruption. Test optional services only with accounts/devices and effects you explicitly authorize.

### Layout

- `macos/`: native SwiftUI workspace, voice, bridge client and tests.
- `macos-control/`: one-shot bounded JSON helper, ScreenCaptureKit/Vision OCR, Accessibility control and privacy metadata.
- `runtime/agent/`: pinned Eve agent, exact root policy, analyst, tool implementations and embedded native scripts.
- `runtime/bridge/`: authenticated API, persistence, approval review, capability reporting.
- `runtime/bridge/assistant/`, `knowledge/`, `research/`: versioned coordination, source/grant storage and bounded evidence synthesis.
- `runtime/test/`: executable isolated tests.
- `evaluations/`: fixed research, mathematics, coding, writing and daily-assistance acceptance tasks.
- `scripts/`: setup, helper/app build and filtered local lifecycle.

The runtime is a source-build checkout: bundled native scripts and shared tool state survive `eve build`; the supervisor and development launcher use the checked-in bridge source with Node 24 and built Eve output. The helper has no source-file dependency at runtime. Public distribution, mobile clients, always-on remote workers and work continuing through Mac sleep remain deferred.
