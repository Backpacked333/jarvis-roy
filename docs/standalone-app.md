# Standalone app bundle (design)

Goal: a double-clickable `Jarvis.app` (shipped in a `.dmg`) that runs without the
`scripts/run-macos.sh` terminal launcher, without a system Node install and
without a source checkout. The developer launcher keeps working unchanged.

## Bundle layout

```text
Jarvis.app/Contents/
  Info.plist                      (macos/Info.plist)
  MacOS/Jarvis                    SwiftUI app; supervises local services in app mode
  Helpers/JarvisControl.app       existing native helper
  Resources/
    node/bin/node                 pinned official Node 24 (SHA-256 verified), host arch
    node/LICENSE
    launcher/supervisor.mjs       scripts/supervisor.mjs
    launcher/launch-env.mjs       scripts/launch-env.mjs (environment allowlist)
    runtime/package.json, package-lock.json
    runtime/.output/**            built Eve runtime (self-contained, relocatable)
    runtime/bridge/**             bridge TypeScript source (run by Node 24 type stripping)
    runtime/agent/**              agent source imported by the bridge
    runtime/workers/{controller.py,sandbox_ops.py,requirements.txt}
    runtime/node_modules/**       `npm ci --omit=dev`, minus build-only native
                                  packages (rolldown, @rolldown/*, @oxc-project/*)
```

Nothing ever writes inside the bundle. The Eve runtime's working directory (it
creates `.eve/`) is `<data dir>/runtime-state`. Logs go to `<data dir>/logs`.

## Launch modes

* **Externally supervised (developer launcher):** `JARVIS_LOCAL_TOKEN` is present
  in the app's environment. The app behaves exactly as today and starts no
  services. `scripts/run-macos.sh` is unchanged.
* **App mode:** no `JARVIS_LOCAL_TOKEN` in the environment. The app generates a
  fresh 32-byte token (64 lowercase hex chars, `SecRandomCopyBytes`), keeps it in
  memory only (`LocalSession.token`), and starts the bundled supervisor.

All three native clients (`RuntimeClient`, `HarnessClient`,
`VoiceSocketTransport`) read the token from `LocalSession.token` instead of the
process environment directly.

## Credentials and configuration

* **Secrets** (`AI_GATEWAY_API_KEY`, `TAVILY_API_KEY`, `HOME_ASSISTANT_TOKEN`,
  `ELEVENLABS_API_KEY`) are stored as macOS Keychain generic passwords, service
  `ai.backpacked.jarvisroy`, account = variable name,
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, not synchronizable. The UI only
  writes, deletes and checks presence; it never displays a stored value. Values are
  read only immediately before launch, written once to the supervisor's stdin and
  then dropped. Never in UserDefaults, the app's own environment, argv, logs,
  the config file or any network request from the app.
* **Non-secret settings** live in `<data dir>/standalone-config.json` (mode 0600,
  directory 0700, atomic write), version 1:

  ```json
  {"version":1,"model":"openai/gpt-4.1-mini","enableDesktop":false,
   "enableTerminal":false,"enableAppleServices":false,"homeAssistantURL":"",
   "allowHomeAssistantHTTP":false,"elevenLabsVoiceID":"","workerImage":"",
   "workerPython":"","dockerBinary":""}
  ```

  The data dir in app mode is always `~/Library/Application Support/JarvisRoy`.
  Settings are edited only in the native Settings UI and take effect on the next
  service (re)start. **They are never mutable over the bridge API.**

## Supervisor protocol (`scripts/supervisor.mjs`)

Invocation (argv has no secrets):

```text
<Resources>/node/bin/node <Resources>/launcher/supervisor.mjs \
  --resources <Resources> --data-dir <dir> --helper <abs JarvisControl executable>
```

The app spawns it with a minimal environment: `PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
`HOME`, `TMPDIR`, `USER`, `LOGNAME`, `LANG`.

**stdin:** exactly one JSON line (max 64 KiB), then stdin stays open as a lifeline:

```json
{"version":1,"token":"<64 hex>",
 "secrets":{"AI_GATEWAY_API_KEY":"…","TAVILY_API_KEY":"…"},
 "config":{"JARVIS_MODEL":"…","JARVIS_ENABLE_DESKTOP":"1", …}}
```

* `secrets` keys allowlisted: `AI_GATEWAY_API_KEY` (required, non-empty),
  `TAVILY_API_KEY`, `HOME_ASSISTANT_TOKEN`, `ELEVENLABS_API_KEY`.
* `config` keys allowlisted: `JARVIS_MODEL`, `JARVIS_ENABLE_DESKTOP`,
  `JARVIS_ENABLE_TERMINAL`, `JARVIS_ENABLE_APPLE_SERVICES`, `HOME_ASSISTANT_URL`,
  `JARVIS_ALLOW_HOME_ASSISTANT_HTTP`, `ELEVENLABS_VOICE_ID`, `JARVIS_WORKER_IMAGE`,
  `JARVIS_WORKER_PYTHON`, `JARVIS_DOCKER_BINARY`. All values strings, no NUL/newline.
  Unknown keys, non-string values or a bad token → `failed` and exit 2.
  Empty strings are dropped (feature off).
* Flags are sent as `"1"` only when enabled; omitted otherwise.

**stdout:** newline-delimited JSON events, never containing secrets or the token:

```text
{"event":"starting"}
{"event":"ready"}
{"event":"failed","reason":"<short sanitized text>"}
{"event":"stopping"}
{"event":"stopped","clean":true|false}
```

**Behavior:**

1. Validate argv paths (absolute, exist), payload. Create data dir/logs/runtime-state 0700.
2. Refuse (`failed`) if 127.0.0.1:39201 or :39202 is already accepting connections
   ("Another Jarvis instance appears to be running…").
3. Worker discovery when not configured: `JARVIS_WORKER_PYTHON` defaults to
   `<data dir>/workers-venv/bin/python` if executable; `JARVIS_DOCKER_BINARY` to the
   first executable of `/usr/local/bin/docker`, `/opt/homebrew/bin/docker`,
   `/Applications/Docker.app/Contents/Resources/bin/docker`.
4. Build the child source environment from the minimal process env + token +
   secrets + config + `JARVIS_DATA_DIR`, `JARVIS_NATIVE_HELPER`, and
   `JARVIS_LAUNCH_MODE=app`; pass it through `environmentFor()` from
   `launch-env.mjs` (single allowlist; add `JARVIS_LAUNCH_MODE` to the runtime and
   bridge allowlists there).
5. Spawn runtime: `node <Resources>/runtime/.output/server/index.mjs`, cwd
   `<data dir>/runtime-state`. Spawn bridge: `node bridge/server.ts`, cwd
   `<Resources>/runtime`. `shell:false`, stdout/stderr appended to
   `logs/runtime.log` / `logs/bridge.log` (0600). `node` = `process.execPath`.
6. Poll `GET http://127.0.0.1:39202/v1/state` with the bearer token (≤60 × 500 ms,
   1.5 s timeout, `redirect:"error"`) until `ready:true` → emit `ready`.
   Timeout → `failed` + shutdown.
7. Shutdown on SIGTERM/SIGINT, stdin EOF/error (app died), or unexpected exit of
   either child (emit `failed` first): emit `stopping`; SIGTERM bridge first, wait
   up to 45 s (bridge reaps room workers while Eve stays up), SIGKILL if needed;
   then SIGTERM runtime, wait up to 10 s, SIGKILL. Emit `stopped` with `clean`
   false if any SIGKILL or nonzero exit; exit 0 if clean else 1. Idempotent.

Exports for tests: `parseArguments(argv)`, `parsePayload(line)`,
`childEnvironment({...})`, `discoverWorkerDefaults(...)`, plus a
`runSupervisor(options)` with injectable `spawn`, `fetch`, `portInUse`, clock, and
streams so tests need no real ports.

## Native app

* `Standalone/LocalSession.swift` — `enum LocalSession { static let token; static let isExternallySupervised }`.
* `Standalone/StandaloneConfig.swift` — Codable config above, `load(from:)`,
  `save(to:)` (atomic, 0600), `validationErrors` (model `provider/model` charset;
  HA URL https or http, no credentials/path/query/fragment; image must contain
  `@sha256:` + 64 hex; python/docker absolute paths), and
  `launchConfig() -> [String: String]` producing exactly the supervisor `config` map.
* `Standalone/CredentialStore.swift` — `protocol CredentialStoring` (`contains`,
  `save`, `delete`, `launchSecrets()`), `KeychainCredentialStore`, and
  `InMemoryCredentialStore` for tests. `enum CredentialKey: String, CaseIterable`.
* `Standalone/SupervisorProtocol.swift` — Foundation-only: payload encoding
  (`SupervisorPayload`), event line decoding (`SupervisorEvent`), sanitized reasons.
* `Standalone/ServiceSupervisor.swift` — `@MainActor final class ServiceSupervisor: ObservableObject`
  with `phase: Phase` (`.externallyManaged`, `.needsSetup`, `.starting`,
  `.ready`, `.failed(String)`, `.stopping`, `.stopped`), `start()`, `restart()`,
  `stop() async`, and bundle resource discovery. It uses an injectable process
  launcher protocol for tests. The supervisor process is terminated by closing its
  stdin and sending SIGTERM; the app waits up to 75 s (above the supervisor's
  45 + 5 + 10 + 5 s worst-case ordered stop) before SIGKILL.
* `Standalone/SetupView.swift` — first-run/failed/starting screen and a Settings
  form (keys as `SecureField` with "Saved"/"Not set" state and Remove buttons;
  feature toggles; HA URL; voice ID; worker image/python/docker; Restart services).
  Copy states clearly: keys go to the macOS Keychain on this Mac only; enabling a
  capability does not grant macOS permissions; terminal is unsandboxed.
* `JarvisApp.swift` — owns a `ServiceSupervisor`; shows `WorkspaceView` when
  `.externallyManaged` or `.ready` (and only then calls `model.startObserving()`),
  otherwise `SetupView`. Adds a "Settings…" (⌘,) command in app mode.
  `applicationShouldTerminate` returns `.terminateLater` while the supervisor is
  running and replies after it stops (or the 75 s bound).
* Capabilities screen copy: in app mode say settings are changed in Jarvis →
  Settings; in launcher mode keep the current terminal text.

## Packaging (`scripts/package-macos.sh`)

1. `scripts/build-macos.sh` (unchanged entry point; still produces `dist/Jarvis.app`).
2. `npm --prefix runtime ci && npm --prefix runtime run build`.
3. `node scripts/fetch-node.mjs --arch <arm64|x64> --out <cache>` — pinned version
   `v24.22.2`, pinned SHA-256 per arch (darwin-arm64
   `aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a`, darwin-x64
   `d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52`), cached in
   `dist/.cache`, verified before extraction, extracting only `bin/node` and `LICENSE`.
4. `node scripts/stage-runtime.mjs --runtime runtime --out <Resources>` copies the
   payload listed above (prod deps via `npm ci --omit=dev --ignore-scripts` into a
   staging copy of package.json/lock, then the prune list), the launcher files and
   the node binary. Refuses symlinks escaping the tree.
5. Sign inside-out. Default ad-hoc (`-`) without hardened runtime, as today. With
   `JARVIS_CODESIGN_IDENTITY` set: `--options runtime --timestamp`, entitlements
   `macos/entitlements/node.plist` for node (allow-jit, allow-unsigned-executable-memory,
   disable-library-validation, automation.apple-events) and
   `macos/entitlements/jarvis.plist` for the app (device.audio-input,
   automation.apple-events); helper signed with its identifier.
6. `hdiutil create -fs HFS+ -format UDZO` with the app and an `/Applications`
   symlink → `dist/Jarvis-<CFBundleShortVersionString>-<arch>.dmg` + `.sha256`.
7. With `JARVIS_NOTARY_PROFILE` (and an identity): `xcrun notarytool submit --wait
   --keychain-profile`, then `xcrun stapler staple` the DMG.

`scripts/smoke-bundle.mjs <Jarvis.app>` runs the bundled node + supervisor
headlessly with a dummy key and a temp data dir, waits for `ready`, checks
`/v1/state` with the token and that a request without it is rejected, then closes
stdin and asserts `stopped` clean and ports released. CI runs it on macos-15.
