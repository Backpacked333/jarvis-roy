# Jarvis for Roy

A native macOS assistant with persistent conversations, opt-in **Hey Jarvis** listening, cloud reasoning, live web research, and explicitly approved desktop/account actions. Inspired by the [Awesome Jarvis blueprint](https://github.com/csells/awesome-jarvis/blob/main/blueprint.md); an independent implementation, not an unrestricted agent or an offline assistant.

**Source-build preview. There is no signed installer or notarized consumer download.** The build ad-hoc signs local app/helper bundles. Configuration is not proof of a working account, permission, or provider. See [verification](#development-and-verification) for what tests do—and do not—prove.

## Implemented

- **Continuous conversations:** create/select a thread in the sidebar, send follow-ups to the same Eve session, and see chronological user/assistant messages. Activity and approval cards are separate from the transcript and scoped to the selected conversation. Up to four threads can work concurrently; an active or unconfirmed thread cannot accept a new turn. Saved memories are intentionally shared, not isolated per thread.
- **Rooms:** durable scoped workspaces with validated specialist dependency plans, separate **Accept** and **Start** actions, bounded parallel local Docker workers, immutable artifact previews, exact question cards, cancellation and restart reconciliation. Plan authoring is not execution. Generated code never runs on the host or receives host credentials. Local work stops during sleep/shutdown; this is not an always-on cloud worker service.
- **Voice:** explicit session-only cloud consent, ElevenLabs **v4 Turbo** dialogue streaming and **Scribe v2 realtime**, bounded audio queues, real playback-drain state, visible Listen/Finish/Mute controls, and explicit interruption. Apple recognition is only an optional local “Hey Jarvis” detector, never a transcription/provider fallback. Wake listening is **off on every launch**. Captured room/conversation/question bindings cannot retarget when selection changes. Approvals require exact buttons, never a spoken “yes.” Hands-free acoustic interruption requires separate hardware acceptance.
- **Desktop:** approved main-screen OCR, bounded Accessibility inspection, and validated focus/click/set-text/navigation-key actions. Approving a control action explicitly activates its named app after you leave the approval card; process identity, observation freshness and target safety are still checked before interaction. Document/window controls require unchanged non-menu content across the app, including other windows; menu targets require the entire observed tree unchanged. Secure or stale controls are refused. No universal app compatibility promise.
- **Terminal:** opt-in exact executable/argument-array/cwd execution, per-action approval, timeout/output limits and process-group cancellation. **It runs with your user's privileges, NOT in a security sandbox.** Explicitly approved scripts can access your files and network.
- **Research:** Tavily search and extraction of public HTTPS pages, bounded evidence, actual source URLs and honest partial failures. Opening a URL is not reading it.
- **Apple services:** native Mail, Calendar and iMessage adapters use **accounts already configured in those apps**, not a new login or generic provider integration. Every read and write requires approval. iMessage is **send-only**; no private message database reads.
- **Home Assistant:** optional approved state reads and allowlisted light/switch/fan/climate/media-player actions through your configured instance, not “all brands” or HomeKit support.
- Approved notes and saved preferences; separate analyst for reasoning/drafting from supplied context, with no private tool access.

## Requirements

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
./scripts/run-macos.sh
```

The setup script runs `npm ci`, builds Eve, builds both Swift executables and bundles the helper. The launcher prompts for `AI_GATEWAY_API_KEY` without echoing it if missing; it does not persist it. Keep that terminal open. Quitting Jarvis stops the launcher-owned services. Launch with the script, not by double-clicking the app: the script starts authenticated loopback services and supplies a fresh local token.

In the app, choose **New conversation**, then type a message. Ask for an analysis; see the real task state. Ask to save a preference; inspect and deny its approval first. After completion, send a follow-up in the same conversation. Create another thread to keep unrelated context separate.

### Room worker setup and first run

Install a maintained Docker engine yourself, start it, then run `./scripts/setup-workers.sh`. This creates the trusted Python controller venv and checks pinned dependencies; it does not pull images or start workers. Choose the exact platform digest in [worker setup](runtime/workers/README.md), explicitly run `docker pull "$JARVIS_WORKER_IMAGE"`, and export `JARVIS_WORKER_IMAGE` in the launch shell. The launcher discovers the local venv and Docker binary. Missing prerequisites fail closed, not through a host executor.

In **Rooms**, create two differently named rooms. Select one, enter a bounded goal, and **Author plan**. Inspect its graph, limits and output paths, then **Accept** and explicitly **Start**. Staff states and operations come from real worker events; artifacts appear only after sealed output. A question stops the old container and seals declared files; an exact answer creates a new attempt without replaying old tools. A question answer is not approval for a host action. Review such approvals in their original conversation. Use **Stop all** to stop root work, authors, workers and voice; uncertain stops/restarts require inspection and explicit retry.

The initial Python image is intentionally offline and cannot run arbitrary npm/native builds: there are no dependency downloads, network access or executable scratch binaries. Declare every durable file/directory in plan outputs. [Worker limits](runtime/workers/README.md) describe the exact boundary. Step/call/token/time/resource limits are enforced locally; displayed dollar estimates are **not provider billing caps**. A sleeping/shut-down Mac cannot keep a local run working.

### Opt-in capabilities

Open **Capabilities** in the sidebar for the actual server's configuration status and setup instructions. No credentials can be entered or stored in UI defaults. Set configuration in the launching shell, then quit/relaunch for changes to take effect. Flags require the exact value `1`; unset/empty/`0` is off.

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
| `JARVIS_MODEL` | Default `openai/gpt-4.1-mini` |
| `JARVIS_DATA_DIR` | Default `~/Library/Application Support/JarvisRoy` |
| `JARVIS_ENABLE_DESKTOP` | Default off; enable helper-based screen/AX tools |
| `JARVIS_ENABLE_TERMINAL` | Default off; enable unsandboxed terminal tool |
| `JARVIS_ENABLE_APPLE_SERVICES` | Default off; enable native Mail/Calendar/Messages |
| `TAVILY_API_KEY` | Research off without valid-format key; supplying it opts in, not a connection test |
| `HOME_ASSISTANT_URL`, `HOME_ASSISTANT_TOKEN` | Home Assistant off without both; fixed credential-free origin, no paths/query/fragment |
| `JARVIS_ALLOW_HOME_ASSISTANT_HTTP` | Default off; `1` permits HTTP only to an explicit private/loopback IP; prefer HTTPS |
| `JARVIS_LOCAL_TOKEN` | Fresh ephemeral token generated by launcher; never save/share |
| `JARVIS_NATIVE_HELPER` | Absolute bundled helper path set by launcher; do not point to untrusted code |
| `JARVIS_WORKER_IMAGE` | Explicit local digest-pinned Linux image; mutable tags and automatic pulls are refused |
| `JARVIS_WORKER_PYTHON`, `JARVIS_DOCKER_BINARY` | Trusted absolute interpreter/Docker paths; launcher detects local venv and Docker |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | Bridge-only key and one selected voice; no credentials in native frames, query strings or worker environments |

To disable, unset the relevant flag or key(s) and relaunch. No risky configuration is mutable over the API. Runtime tools refuse disabled/unconfigured services even if the model proposes them.

Tavily setup: [quickstart](https://docs.tavily.com/documentation/quickstart), [Search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract). Queries/URLs go to Tavily; no login/paywall bypass. DNS preflight rejects local/special addresses, but Tavily resolves and fetches downstream pages itself; Jarvis cannot pin its DNS or fully control provider redirects. Retrieval time is not publication time; content may be cached.

Home Assistant setup: [authentication](https://www.home-assistant.io/docs/authentication/), [REST API](https://developers.home-assistant.io/docs/api/rest/). Create a token in your own Home Assistant profile, keep it runtime-only, and use an appropriately restricted account. The app never displays its URL/token. Supported service actions are limited; locks, alarms, doors, scripts, automations and arbitrary services are excluded. State reads omit provider attributes. A submitted service request is not proof a physical device changed.

### macOS permissions and native account setup

1. **Voice:** configure the ElevenLabs key and voice ID, relaunch, then explicitly enable **Cloud voice** for this session before Listen. Microphone PCM goes to Scribe, and spoken reply text goes to ElevenLabs v4 Turbo. The key stays in the bridge. Allow Microphone; optional local wake detection also needs Speech Recognition. If denied, use **System Settings → Privacy & Security → Microphone / Speech Recognition**, then relaunch. Missing/unsupported provider, voice or audio devices leaves typing available; there is no silent Apple/provider downgrade.
2. **Screen and app control:** opt in via environment. In **Privacy & Security → Accessibility** and **Screen & System Audio Recording** (Screen Recording on macOS 14), grant the responsible JarvisControl/helper or launching terminal identity. The helper is bundled at `dist/Jarvis.app/Contents/Helpers/JarvisControl.app`, has a stable bundle ID and its own embedded/privacy metadata. Checks happen when an approved action runs, not on the configuration screen. No prompt bypass, automatic permission grant or background screen scraping. Ad-hoc signing is not a stable Developer ID signing identity; rebuilding/moving may require granting permissions again.
3. **Apple services:** configure accounts in **Mail**, **Calendar**, and **Messages** yourself. Opt in, request a bounded account/calendar/service listing, approve it, then allow the actual responsible terminal/runtime under **Privacy & Security → Automation** for that app. OSA execution may be attributed to the launching terminal, not the SwiftUI bundle. Privacy declarations explain intent; they do **not** grant access or replace TCC prompts. A permission refusal is an error, not a successful connection.

Mail supports bounded recent inbox headers, explicit inbox message reads and sends with exact account/from/to/subject/body. No attachments, bulk sending, CC/BCC or arbitrary mailboxes. Auto-Cc/Bcc is refused; a content mismatch can leave an unsent draft. Listing sorts a bounded native-order selection, not an exhaustive newest-first inbox scan. Calendar supports explicit-calendar event listing/creation; no attendees, invitations, deletion or recurrence expansion. iMessage requires a selected configured service and one email/E.164 recipient; no history, SMS, attachments or groups. Submission does not prove delivery.

### Wake listening is not a dedicated low-power wake engine

Optional wake detection uses rolling **on-device English-US speech recognition**, brief rearming gaps and a wake phrase at the start of an utterance; the subsequent command is a bounded, consented Scribe turn. Apple on-device availability varies by hardware, installed language resources and OS. Mute invalidates late permission/transport results; Apple prompts themselves cannot be programmatically dismissed.

**Hands-free is a separate, default-off session opt-in.** After the cloud disclosure, its own confirmation explains the local echo-cancelled microphone during replies, speech-classified interruption and automatic cloud reply/clarification windows. A window opens only after provider completion **and actual native playback drain**, stays bound to the original conversation or exact question, and closes after eight seconds of silence. Explicit fresh Listen/wake captures use the current target, never an old question. Busy conversations, pending approvals and existing drafts still block automatic submission. Mute/Stop all/sleep disable hands-free and spoken alerts; OS notification preferences are unchanged. Unsupported audio processing fails closed. Physical acoustic echo rejection, interruption accuracy and battery behavior still need real-device acceptance; injected-signal tests are not acoustic proof.

One app-owned room observer remains alive across navigation, with bounded background polling. Attention offers independently opt-in generic OS notifications and spoken questions; quiet rooms suppress proactive alerts. Notifications contain no question text and revalidate the exact target before navigation. They never answer or approve anything. The orb, microphone/playback meters and graph reflect real levels and runtime state; reduced motion removes animated geometry and background audio history is suppressed.

## Architecture and safety boundaries

```text
SwiftUI → Rooms / conversations / separate approval and question cards
  └─ authenticated 127.0.0.1:39202 bridge
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

`defaultTools: false` remains in both agents. No default shell/browser/filesystem tool is enabled. The narrow authored terminal is independently opt-in. All mutations and private screen/account reads use runtime `always()` approval. Full exact JSON arguments are shown without truncation; missing/redacted/over-131,072-character arguments are deny-only, enforced server-side. Credential-like inputs are conservatively refused, not hidden then approved. Webpages, screen text, emails, calendar entries, memories and tool results are untrusted data, never authorization.

Both local services remain loopback-only and bearer authenticated; the bridge rejects Origin-bearing browser requests. Do not tunnel, proxy or expose the ports. Launch environments are allowlisted: the native UI gets minimal OS context and the ephemeral local token, **no model/integration keys or unrelated environment**. Credentials are never saved in UI defaults. Native process helpers receive minimal secret-free environments. A malicious process running as your OS user is outside this local boundary.

**Stop all / ⌘. immediately mutes capture and interrupts speech before asking for cancellation.** Cancellation needs runtime confirmation; unconfirmed threads stay blocked. Late output is labeled separately. Already-completed effects remain; cancellation is **not rollback**, and deliberately detached terminal descendants may escape cleanup. Do not repeat uncertain sends or mutations: inspect the target app/device. Hashed operation markers persist uncertain writes across sessions; there is no automatic retry/reset button.

Stop all fences requests admitted before the stop, including slowly uploaded request bodies, and waits for authoritative room cleanup rather than just a cancellation request. Failed, missing, unavailable or timed-out cleanup returns an explicit unconfirmed error and keeps new work/voice connections blocked. Inspect status and explicitly retry **Stop all** after resources settle; an eventual background result alone never reopens admission. Read-only status and exact cancellation remain available. A genuinely hanging admitted operation cannot safely be bypassed; restart still requires reconciliation.

Clarification cards are not credential-entry forms. Known credential patterns and requests for secrets are rejected in root questions, author/worker questions and text/voice answers. Worker guards run before private checkpoint persistence, and exact rejected answers do not consume the pending question. These are conservative checks, not universal secret detection. Legacy unsafe room snapshots refuse startup for offline data review; old journals/backups are not automatically erased.

Optional authoring dollar thresholds now participate in admission: zero permits no model call, supported Gateway catalog prices reserve each bounded call, and cumulative estimates survive correction/resume. Missing pricing, unidentified returned models or uncertain prior costs fail closed when a threshold is configured. Token/call/wall-time limits remain separate. Estimates are conservative—not provider invoices or hard account billing caps; set provider-side limits as well.

## Privacy, persistence and migration

- Cloud reasoning receives submitted text, prior turns, recalled memories and relevant tool results, **including approved screen/account content**. Review provider policies before using sensitive data. Redaction is best-effort, not a guarantee that private text is removed.
- Wake detection is local where supported. Command microphone PCM and spoken reply text go to ElevenLabs only after session cloud consent. Do not speak secrets; provider retention is separate. Screen images are not saved; recognized screen text can enter persisted/model context.
- Room state uses private local SQLite; inert checkpoints and immutable artifact bytes are private files. Restart reconciles resources without blindly replaying side effects. Room histories/artifacts are not encrypted; back them up before upgrades and use FileVault.
- Task/conversation snapshots use private atomic version-2 storage, automatically migrating the old task-array format. Unavailable legacy user input is marked unavailable rather than invented. Opaque Eve session IDs remain server-side. Back up state before upgrading; do not run an old app against the migrated store.
- Retention targets 100 tasks/conversations but protects active/unconfirmed work. This is not encrypted storage. Use FileVault and your macOS account boundary. Deleting a saved memory does not erase copies in history/provider logs.
- To reset, quit the app **and launcher**, back up notes, then remove your configured Jarvis data directory and this checkout's `runtime/.eve`. This also removes deduplication markers; inspect uncertain actions before resetting. Provider-side retention is separate.

## Development and verification

```sh
# Node 24, pinned dependency install
cd runtime
npm ci
npm run typecheck
npm test
npm run build
cd ..

# macOS only: app + helper bundle, debug and release native tests
./scripts/build-macos.sh
swift test --package-path macos
swift test --package-path macos -c release
swift test --package-path macos-control
swift test --package-path macos-control -c release
```

CI uses **macos-15** to build both native executables and run native logic/integration tests. Linux runtime tests cover auth, migration, isolation, approvals/questions, cancellation, provider failures and launcher filtering. The separate `isolated-workers` job explicitly installs the pinned controller/image and runs real Docker controls plus HTTP → kernel → worker integration: two rooms, dependency artifact handoff, clarification/resume after restart and Stop all. Its model transport is deterministic, not live inference. Native tests exercise logic without live accounts or microphone permissions. There is no standalone lint script; TypeScript, shell syntax and whitespace checks supplement tests.

Run real isolated tests locally with `JARVIS_WORKER_DOCKER_TESTS=1 JARVIS_WORKER_CODING_TESTS=1 JARVIS_WORKER_KERNEL_TESTS=1 JARVIS_WORKER_PYTHON="$PWD/runtime/workers/.venv/bin/python" npm --prefix runtime test` after explicitly setting up both platform-pinned images. The coding profile supports offline Node/Python builds and native helpers inside the disposable sandbox; it does not download packages. Declared outputs are published separately from bounded private checkpoint scratch. Optional live fixtures spend provider credits and require explicit opt-in; see [worker tests and setup](runtime/workers/README.md). Do not put production credentials in CI.

For the bounded production-composition live proof, configure your key, pinned image and venv, then run `JARVIS_HARNESS_LIVE_TEST=1 JARVIS_WORKER_MODEL=openai/gpt-4.1-mini node --experimental-strip-types --test --test-name-pattern='authorized live production' runtime/test/harness-integration.test.ts` from the root. It uses real author/worker calls and checks actual artifact bytes; invalid model responses fail closed rather than retrying silently. This fixture is not voice or native UI acceptance.

**Verification levels:** compile/unit results are available in [Checks](https://github.com/Backpacked333/jarvis-roy/actions/workflows/checks.yml). Recorded Mac acceptance has verified real-model conversation continuity/isolation/restart, approval/denial/cancellation, missing-audio fallback, harmless terminal execution, TextEdit inspection/approved edits, refusal after a document changes, and screen OCR. These are bounded fixture results, not universal app compatibility. Desktop acceptance used existing OS trust, not a newly granted/denied permission flow. Actual microphone/synthesis, wake acoustics/battery, broader controls/menu targets/secure fields, TCC attribution, live Apple accounts/delivery, Tavily credentials and Home Assistant devices still require explicit hardware/provider acceptance. No live personal accounts, sends, purchases, terminal actions on a user's machine, or physical device changes are used as test fixtures.

**Known model UX limitation:** the model can ask for approval in chat without proposing a tool card. Ask it to invoke the requested tool explicitly. Chat confirmation never authorizes execution; only a real runtime approval card does. Failed tool calls show sanitized, bounded native/runtime error messages in task activity; do not rely solely on the model's explanation or blindly retry uncertain effects.

For native acceptance: launch, create two threads, confirm separate transcripts/drafts, run a follow-up and restart for continuity, verify busy/interrupted send blocking and approvals, reject then explicitly approve isolated harmless actions, and test Stop all. With a real microphone, verify permission allow/deny, busy/offline transcript retention, thread switches, mute during prompts/retries and speech interruption. Test optional services only with accounts/devices and effects you explicitly authorize.

### Layout

- `macos/`: native SwiftUI workspace, voice, bridge client and tests.
- `macos-control/`: one-shot bounded JSON helper, ScreenCaptureKit/Vision OCR, Accessibility control and privacy metadata.
- `runtime/agent/`: pinned Eve agent, exact root policy, analyst, tool implementations and embedded native scripts.
- `runtime/bridge/`: authenticated API, persistence, approval review, capability reporting.
- `runtime/test/`: executable isolated tests.
- `scripts/`: setup, helper/app build and filtered local lifecycle.

The runtime is a source-build checkout: bundled native scripts and shared tool state survive `eve build`; the launcher uses the checked-in bridge source with Node 24 and built Eve output. The helper has no source-file dependency at runtime. Packaging the full Node runtime into a standalone distributable installer remains future work.
