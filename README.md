# Jarvis for Roy

A native macOS assistant with persistent conversations, opt-in **Hey Jarvis** listening, cloud reasoning, live web research, and explicitly approved desktop/account actions. Inspired by the [Awesome Jarvis blueprint](https://github.com/csells/awesome-jarvis/blob/main/blueprint.md); an independent implementation, not an unrestricted agent or an offline assistant.

**Source-build preview. There is no signed installer or notarized consumer download.** The build ad-hoc signs local app/helper bundles. Configuration is not proof of a working account, permission, or provider. See [verification](#development-and-verification) for what tests do—and do not—prove.

## Implemented

- **Continuous conversations:** create/select a thread in the sidebar, send follow-ups to the same Eve session, and see chronological user/assistant messages. Activity and approval cards are separate from the transcript and scoped to the selected conversation. Up to four threads can work concurrently; an active or unconfirmed thread cannot accept a new turn. Saved memories are intentionally shared, not isolated per thread.
- **Voice:** manual on-device input for review; opt-in rolling English-US recognition for “Hey Jarvis …”; spoken replies; persistent visible microphone state and mute. Wake listening is **off on every launch**. Switch threads and capture mutes, with recognized text retained in the original thread. Busy/offline threads or existing drafts/review text never auto-submit commands. Approvals require buttons, never a spoken “yes.”
- **Desktop:** approved main-screen OCR, bounded Accessibility inspection, and validated focus/click/set-text/navigation-key actions. Approving a control action explicitly activates its named app after you leave the approval card; process identity, observation freshness and target safety are still checked before interaction. Secure or stale controls are refused. No universal app compatibility promise.
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
| Optional voice | Real microphone, Microphone + Speech Recognition permission, on-device English-US support |
| Optional providers | Your Tavily key and/or Home Assistant instance/token |

No Docker daemon, database account, Vercel deployment or speech-provider key is required. Inference and research may be billed by their providers. Dependencies remain pinned to Eve `1.0.0-rc.6` and Zod `4.6.7`; upgrades require protocol/migration review.

## Reproducible setup

```sh
git clone https://github.com/Backpacked333/jarvis-roy.git
cd jarvis-roy
./scripts/setup-macos.sh
./scripts/run-macos.sh
```

The setup script runs `npm ci`, builds Eve, builds both Swift executables and bundles the helper. The launcher prompts for `AI_GATEWAY_API_KEY` without echoing it if missing; it does not persist it. Keep that terminal open. Quitting Jarvis stops the launcher-owned services. Launch with the script, not by double-clicking the app: the script starts authenticated loopback services and supplies a fresh local token.

In the app, choose **New conversation**, then type a message. Ask for an analysis; see the real task state. Ask to save a preference; inspect and deny its approval first. After completion, send a follow-up in the same conversation. Create another thread to keep unrelated context separate.

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
| `AI_GATEWAY_API_KEY` | Required inference credential, runtime only |
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

To disable, unset the relevant flag or key(s) and relaunch. No risky configuration is mutable over the API. Runtime tools refuse disabled/unconfigured services even if the model proposes them.

Tavily setup: [quickstart](https://docs.tavily.com/documentation/quickstart), [Search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract). Queries/URLs go to Tavily; no login/paywall bypass. DNS preflight rejects local/special addresses, but Tavily resolves and fetches downstream pages itself; Jarvis cannot pin its DNS or fully control provider redirects. Retrieval time is not publication time; content may be cached.

Home Assistant setup: [authentication](https://www.home-assistant.io/docs/authentication/), [REST API](https://developers.home-assistant.io/docs/api/rest/). Create a token in your own Home Assistant profile, keep it runtime-only, and use an appropriately restricted account. The app never displays its URL/token. Supported service actions are limited; locks, alarms, doors, scripts, automations and arbitrary services are excluded. State reads omit provider attributes. A submitted service request is not proof a physical device changed.

### macOS permissions and native account setup

1. **Voice:** enable the UI toggle or manual microphone, then allow Microphone and Speech Recognition. If denied, use **System Settings → Privacy & Security → Microphone / Speech Recognition**, then relaunch. Audio is not uploaded by Jarvis; unsupported on-device recognition fails with text-input guidance, never a cloud fallback.
2. **Screen and app control:** opt in via environment. In **Privacy & Security → Accessibility** and **Screen & System Audio Recording** (Screen Recording on macOS 14), grant the responsible JarvisControl/helper or launching terminal identity. The helper is bundled at `dist/Jarvis.app/Contents/Helpers/JarvisControl.app`, has a stable bundle ID and its own embedded/privacy metadata. Checks happen when an approved action runs, not on the configuration screen. No prompt bypass, automatic permission grant or background screen scraping. Ad-hoc signing is not a stable Developer ID signing identity; rebuilding/moving may require granting permissions again.
3. **Apple services:** configure accounts in **Mail**, **Calendar**, and **Messages** yourself. Opt in, request a bounded account/calendar/service listing, approve it, then allow the actual responsible terminal/runtime under **Privacy & Security → Automation** for that app. OSA execution may be attributed to the launching terminal, not the SwiftUI bundle. Privacy declarations explain intent; they do **not** grant access or replace TCC prompts. A permission refusal is an error, not a successful connection.

Mail supports bounded recent inbox headers, explicit inbox message reads and sends with exact account/from/to/subject/body. No attachments, bulk sending, CC/BCC or arbitrary mailboxes. Auto-Cc/Bcc is refused; a content mismatch can leave an unsent draft. Listing sorts a bounded native-order selection, not an exhaustive newest-first inbox scan. Calendar supports explicit-calendar event listing/creation; no attendees, invitations, deletion or recurrence expansion. iMessage requires a selected configured service and one email/E.164 recipient; no history, SMS, attachments or groups. Submission does not prove delivery.

### Wake listening is not a dedicated low-power wake engine

It uses rolling **on-device English-US speech recognition** with 45-second sessions, brief rearming gaps, a wake phrase at the start of an utterance, 1.5 seconds of command silence, a 20-second command bound and 5-second empty-wake timeout. Synthesis pauses capture. Boundary timing can shorten a command; fixed energy thresholds need real microphone tuning. Apple on-device availability varies by hardware, installed language resources and OS. Acoustic accuracy and battery use are not established by unit tests. Mute works while permission requests/retries are pending; Apple prompts themselves cannot be programmatically dismissed.

## Architecture and safety boundaries

```text
SwiftUI → on-device voice + selected conversation + approval UI
  └─ authenticated 127.0.0.1:39202 bridge
       ├─ conversations/tasks/approvals/capabilities/memory
       └─ authenticated 127.0.0.1:39201 Eve runtime
            ├─ Gateway model (cloud), analyst (supplied evidence only)
            ├─ Tavily public research
            └─ explicit approvals → local helper / terminal / Apple apps / Home Assistant
```

`defaultTools: false` remains in both agents. No default shell/browser/filesystem tool is enabled. The narrow authored terminal is independently opt-in. All mutations and private screen/account reads use runtime `always()` approval. Full exact JSON arguments are shown without truncation; missing/redacted/over-131,072-character arguments are deny-only, enforced server-side. Credential-like inputs are conservatively refused, not hidden then approved. Webpages, screen text, emails, calendar entries, memories and tool results are untrusted data, never authorization.

Both local services remain loopback-only and bearer authenticated; the bridge rejects Origin-bearing browser requests. Do not tunnel, proxy or expose the ports. Launch environments are allowlisted: the native UI gets minimal OS context and the ephemeral local token, **no model/integration keys or unrelated environment**. Credentials are never saved in UI defaults. Native process helpers receive minimal secret-free environments. A malicious process running as your OS user is outside this local boundary.

**Stop all / ⌘. immediately mutes capture and interrupts speech before asking for cancellation.** Cancellation needs runtime confirmation; unconfirmed threads stay blocked. Late output is labeled separately. Already-completed effects remain; cancellation is **not rollback**, and deliberately detached terminal descendants may escape cleanup. Do not repeat uncertain sends or mutations: inspect the target app/device. Hashed operation markers persist uncertain writes across sessions; there is no automatic retry/reset button.

## Privacy, persistence and migration

- Cloud reasoning receives submitted text, prior turns, recalled memories and relevant tool results, **including approved screen/account content**. Review provider policies before using sensitive data. Redaction is best-effort, not a guarantee that private text is removed.
- Microphone wake/transcription is local where supported; no background utterance is intentionally submitted. Screen images are not saved; recognized screen text can enter persisted/model context.
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
```

CI uses **macos-15** to build both native executables and run native logic/integration tests. Linux runtime tests use isolated/injected transports: auth, migration, conversation isolation, approvals, cancellation, subprocess bounds, research/provider failures, connected-service guards and launcher environment filtering. Native tests exercise wake logic and thread/voice routing without live accounts or microphone permissions. There is no configured standalone lint script; TypeScript checks, shell syntax and whitespace checks supplement tests.

**Verification levels:** implementation is source-complete; compile/unit results are available in [Checks](https://github.com/Backpacked333/jarvis-roy/actions/workflows/checks.yml). A green build is not live verification. Real cloud-model continuity, native microphone/synthesis, wake acoustics/battery, screen/Accessibility compatibility, TCC attribution, Apple app dictionaries/accounts/delivery, Tavily credentials and Home Assistant devices still require explicit Mac/hardware/provider acceptance. No live personal accounts, sends, purchases, terminal actions on a user's machine, or physical device changes are used as test fixtures.

For native acceptance: launch, create two threads, confirm separate transcripts/drafts, run a follow-up and restart for continuity, verify busy/interrupted send blocking and approvals, reject then explicitly approve isolated harmless actions, and test Stop all. With a real microphone, verify permission allow/deny, busy/offline transcript retention, thread switches, mute during prompts/retries and speech interruption. Test optional services only with accounts/devices and effects you explicitly authorize.

### Layout

- `macos/`: native SwiftUI workspace, voice, bridge client and tests.
- `macos-control/`: one-shot bounded JSON helper, ScreenCaptureKit/Vision OCR, Accessibility control and privacy metadata.
- `runtime/agent/`: pinned Eve agent, exact root policy, analyst, tool implementations and embedded native scripts.
- `runtime/bridge/`: authenticated API, persistence, approval review, capability reporting.
- `runtime/test/`: executable isolated tests.
- `scripts/`: setup, helper/app build and filtered local lifecycle.

The runtime is a source-build checkout: bundled native scripts and shared tool state survive `eve build`; the launcher uses the checked-in bridge source with Node 24 and built Eve output. The helper has no source-file dependency at runtime. Packaging the full Node runtime into a standalone distributable installer remains future work.
