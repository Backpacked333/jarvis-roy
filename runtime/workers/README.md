# Isolated room workers

This is the worker implementation behind `createWorkerRunner` in
`bridge/harness-worker/index.ts`. It does real file writing, reading and shell
checks inside a digest-pinned local Docker container. It is not a text-only
worker, a host terminal adapter, an HF Space, or a cloud deployment.

## Trust boundary

- **Trusted controller:** Node validates the frozen contracts, owns the Gateway
  credential, admits/reserves model calls, persists budgets/results and invokes
  Docker. A separate, trusted Python process runs the inspected
  `smolagents==1.26.0` `ToolCallingAgent`, with `add_base_tools=False`, no managed
  agents, no planning loop, one tool call at a time, and only five authored RPC
  tools: `write_file`, `read_file`, `run_check`, `ask_question`, `final_answer`.
  Node validates every returned call against the admitted provider response.
  There is no Hub tool loading, arbitrary controller Python, pickle, CodeAgent,
  LocalPythonExecutor, Jupyter server, HTTP callback port or host execution tool.
- **Generated code:** only Docker exec, as UID/GID 65532. Read-only root, no
  network, dropped capabilities, no-new-privileges, default seccomp, cgroup v2
  CPU/memory/swap/PID limits, bounded tmpfs, private namespaces, no bind mounts,
  no Docker socket, no devices, no published ports, no credential/environment
  inheritance. The bounded workspace stays `noexec` for minimal Python and
  custom images. Only the exact reviewed **coding image pins** below enable
  executable `/workspace` tmpfs for native compiler/test helpers; `/tmp` remains
  `noexec` for every image. No package downloads or autonomous network research.
- **Crash watchdog:** container PID 1 and its finite-lifetime sleep process use
  a *different non-root UID*, 65533. Generated code cannot send signals to stop
  that watchdog. Expiry ends the container even if the Node controller dies;
  stop/cleanup is additionally requested by Node and reconciled on restart.
- A missing daemon, unsupported controls, mutable/missing image, missing Python
  dependency or missing provider credential fails closed. There is no automatic
  pull, host fallback, remote worker deployment or silent provider downgrade.

Docker is an isolation boundary, **not** a guarantee against kernel/runtime
vulnerabilities. Use a maintained Docker installation and review image/package
updates. Local work does not continue through Mac sleep or shutdown.

Executable scratch is an explicit tradeoff selected by the trusted room image
policy, never by a model/tool argument. It grants no host access: the root stays
read-only, `nosuid,nodev`, non-root UIDs, capability/seccomp restrictions, no
network/mounts/credentials and resource/watchdog bounds are unchanged and probed.
The original Python/shell capability already executes arbitrary instructions
inside this boundary; `noexec` was not a complete sandbox. Native executables do
increase attack surface, so unreviewed or merely similarly named Node images do
not automatically receive executable scratch. No permissions survive container
removal. Artifacts retain bytes, not executable modes; rebuild/chmod only inside
a subsequent isolated coding attempt, never execute downloaded artifacts on host.

## Reproducible setup

Requires Node 24, Python 3.10+ and a running local Docker engine with Linux
cgroup v2 and default seccomp. Remote TCP/SSH Docker contexts and images declaring
host volumes are rejected. Docker Desktop must expose those Linux controls;
macOS native/ARM operation still needs verification on the actual Mac.

From the repository root:

```sh
python3 -m venv runtime/workers/.venv
runtime/workers/.venv/bin/python -m pip install -r runtime/workers/requirements.txt
runtime/workers/.venv/bin/python -m pip check
export JARVIS_WORKER_PYTHON="$PWD/runtime/workers/.venv/bin/python"

# Explicit operator setup; each command selects the DOCKER ENGINE architecture,
# pulls only its immutable platform pin, then probes/cleans a disposable sandbox:
node runtime/workers/setup-image.ts python --pull
node runtime/workers/setup-image.ts coding --pull

# Select a room's default policy image. Without --pull this is read-only:
JARVIS_WORKER_IMAGE="$(node runtime/workers/setup-image.ts coding)" && export JARVIS_WORKER_IMAGE
# Use `python` instead of `coding` for the smaller noexec/Python-only profile.
```

Reviewed platform pins (the setup script and runner share one catalog):

| Profile | Platform | Immutable image |
| --- | --- | --- |
| Minimal Python 3.12.12 slim-bookworm | linux/amd64 | `python@sha256:2986c55feb36e6cae00fa1fefb454283e4b33f35e75ff8bdd123b134130be301` |
| Minimal Python | linux/arm64/v8 | `python@sha256:228390eced221ad2986a3dd77e10b1accca6ba8ceb36f1572de1b346a337cc1a` |
| Official Node 24.22.2 bookworm | linux/amd64 | `node@sha256:6b9d4ea31e614e29f364bf75758458731eb1e105b80c99667438dd6b3fe262e0` |
| Official Node 24.22.2 bookworm | linux/arm64/v8 | `node@sha256:0bab91d6a954a4a75de4a887edfda7386ed8711aa8b1eb5fb309ee0f0a2c544f` |

Both AMD64 profiles were executed. ARM manifests/configuration were inspected,
**not executed here**; the script must pass its real probes on the target Mac.
Wrong-platform images fail before launch, rather than silently enabling emulation.
Never substitute mutable `latest`/`24-bookworm` tags. The reviewed Node image was
resolved from the official multi-platform index
`sha256:8fa96264f302f58bbb13aa7339c541547b56975766ce956c875da149452a3e40`;
the actual policy uses the corresponding immutable platform manifest above.

Verified coding tools on AMD64: Node 24.22.2, npm 11.19.1, Python 3.11.2,
GCC/C++ 12.2 and GNU Make 4.3. The image includes public buildpack-deps tools,
not arbitrary project dependencies. Node/npm are absent in the minimal profile.
The operation protocol now uses `python3` on the fixed trusted PATH, not a
Python-image-specific `/usr/local/bin/python` path. Startup rejects missing
Python 3.10+; coding startup additionally checks Node 24, npm, C/C++ and make.

All controller dependencies, including transitive packages, are pinned in
`requirements.txt`. No root Node dependency or tsconfig edits are necessary.
The tested clean venv is Python 3.10.12 on Linux; generated code uses the pinned
image's Python listed above. `smolagents` is Apache-2.0; inspected upstream
release wheel SHA-256:
`70e1cfb1576f782da93190ee31d9bb2659e5ca4bd84fda0c412e1f20498f28b6`.
PyYAML is explicit because the inspected framework imports `yaml` but does not
declare it directly. No optional inference, Docker SDK, browser or remote
executor extras are installed or used. Dependencies remain a trusted supply
chain and should be reviewed when updating the pins.

## Integration (parent-owned wiring)

```ts
const worker = createWorkerRunner({
  dataDirectory, model: configuredWorkerModel,
  pythonBinary: process.env.JARVIS_WORKER_PYTHON,
});
const policy = defaultRoomPolicy(process.env.JARVIS_WORKER_IMAGE ?? null);
```

Do not inject a default image implicitly. `availability()` checks backend
prerequisites, not room policy: each `run` separately verifies the policy's exact
local image and probes kernel enforcement before emitting `started`.
`dockerBinary`, `pythonBinary` and `fetch` are constructor seams for trusted
composition/testing, not model-controlled inputs. The real adapter uses only
`https://ai-gateway.vercel.sh/v1/chat/completions`; it has no provider fallback.

The existing `AI_GATEWAY_API_KEY` stays in Node's environment and request headers.
Neither the Python controller nor generated execution inherits it. No credential
is written to disk, checkpoints, provider prompts, artifacts or events.

Kernel remains the sole durable **question-ID/revision compare-and-consume
authority**. The worker cannot authenticate a question ID allocated by kernel
after a checkpoint is returned. It independently validates the exact saved inert
checkpoint, old room/run/node/attempt binding, allowed answer mode, and new
attempt ID. Questions never authorize any privileged action. Root host/external
actions remain exact approval-card operations; this worker has none.

Public manifests contain **only** files equal to a declared `outputPaths` entry
or beneath that entry followed by `/`, matching the kernel exactly. For example,
`dist` includes `dist/index.html`, not `dist-other/file`; `.` and wildcards are
not allowed. Completion still requires every declared output to exist. Declare
source directories explicitly when a downstream builder needs source, not just
final assets. Inputs and build scratch are not republished implicitly.

At a question, the entire bounded regular-file workspace is sealed separately in
the worker's private `checkpoints` store. Only declared outputs appear in the
frozen checkpoint's public `artifacts` array. The exact durable attempt record
binds private manifests to room/run/node/attempt/plan; a fresh attempt restores
and hashes them without replaying tools. Private blobs cannot be read through
`ArtifactReader` or the HTTP artifact route. Both stores and journals must remain
in `dataDirectory` for resume; missing or altered private snapshots fail closed,
never silently falling back to partial public outputs. Worker journal v2 requires
this snapshot pointer; pre-existing v1 journals remain readable using their
original complete public snapshots. No frozen contract or kernel relaxation is
needed, and early resume failures retain cumulative usage.

Whole-workspace snapshot limits still use `maxArtifactBytes` and
`maxArtifactFiles`, including private scratch; oversized trees fail rather than
silently drop files. Only regular-file bytes persist, not sockets, links, empty
directories or executable bits. Restore uses mode 0600; recreate directories and
rebuild/chmod helpers inside the disposable sandbox when needed. A separate
working-snapshot allowance/metadata format would need a future versioned policy
if larger dependency-heavy workspaces are required.

In the integrated tree, set `JARVIS_WORKER_KERNEL_TESTS=1` in addition to the two
Docker test flags below. Worker-owned HTTP acceptance tests use the actual
authenticated bridge, kernel and Docker worker with synthetic provider calls.
They build the real project, download/hash allowed outputs, reject source,
scratch and lookalike-directory downloads, then exercise a clarification across
bridge/worker restart and verify private files survived without tool replay.
The standalone worker branch lacks kernel/root wiring, so these two tests skip
unless explicitly enabled in the integrated tree.

Worker events and results contain **cumulative full-node Usage**, including
continuations and explicit retries. Kernel must replace/merge monotonically,
not add each event/result as a fresh delta. Worker journals retain wall time and
log consumption across attempts (fields absent from the frozen public Usage).
Time waiting for the person after an inert checkpoint is not active runtime.

Node writes attempt intent and budget reservation before launch/provider calls,
awaits ordered event callbacks, and records terminal results after confirmed
stop. IDs cannot be reused with another specification. Reconcile returns real
running/settled/missing/unknown evidence; it does not replay tools. An orphan
must be explicitly cancelled/reaped, then retried with a fresh attempt. Missing
or corrupt records are not assumed successful. Locks/unknown resources are
retained when cleanup cannot be established.

Event sequences start at zero; a checkpoint records the last emitted sequence.
Transient per-call token reservations stay durably in worker journals, but are
not emitted as kernel usage events: the kernel already reserves the full node,
and clearing a transient partial event would violate its monotonic usage rules.
Settled measured usage is emitted; uncertain terminal usage remains in results.

The inspected smolagents memory is translated into native Chat Completions
assistant/tool messages with exact call IDs, rather than flattening tools into
user prose. This is one in-memory adapter over the agent's existing memory, not
a second scheduler or durable store. Providers that ignore
`parallel_tool_calls:false` get at most one corrective model call per response;
**none** of the rejected batch executes. The repair consumes the same cumulative
call/token/time budget and repeated invalid batches fail closed.

Use `worker.artifacts.read` **only after** the kernel's exact scoped artifact
lookup. Artifacts are immutable content-addressed blobs with hashed manifests,
input provenance and scope/path/size checks. Imports copy only individually
verified regular files; there is no archive extraction or host mount. Symlinks,
hardlinks, devices, conflicting imports and traversal fail closed. A `completed`
result requires real files covering all declared output paths. `passed` means
actual sandbox commands exited zero and the captured files still match the last
check snapshot; it is not proof of semantic correctness, and model prose never
sets verification status. A write after a check clears that verification.

### Practical coding scope

The coding profile supports dependency-free static/web projects, Node built-in
tests, Python stdlib checks and C/C++/make helpers. `npm run build` and `npm test`
work for **already available** tooling; this is not a claim that arbitrary
React/Vite/Next/esbuild projects can install or build offline. npm runs with
offline mode, no audit/update/fund traffic and a bounded `/tmp/npm-cache`;
Docker's no-network namespace remains the hard boundary even if a command changes
those environment variables. The real fixture confirms an uncached esbuild
request fails, not that esbuild is installed. Browser automation, downloaded
browsers, third-party Python packages, missing SDKs and remote APIs remain
unavailable unless independently reviewed/preinstalled in an explicitly pinned
image. Custom images retain noexec unless their exact pins receive code review.

No host repository mount is used. Supply source via immutable upstream artifacts
or worker file tools. The strict artifact snapshot still rejects symlinks,
hardlinks and excess files; typical `node_modules/.bin` links and build caches
must be excluded/removed before completion. Large toolchains/artifacts require
explicit budgets; there is no automatic resource or permission escalation.

## Budget semantics

- Cumulative model calls, tool steps, active wall time, output/observation bytes
  and artifact volume are bounded. Per-call `max_tokens` is sent explicitly.
- Prompt admission uses a conservative UTF-8 byte/formatting allowance, not a
  provider tokenizer or a guaranteed provider billing boundary. Actual returned
  usage is checked; an overrun halts. Missing usage/errors retain conservative
  reservations and halt additional model calls rather than inventing zero.
- With `estimatedUsdLimit`, admission loads documented Gateway model pricing
  and uses the maximum published input/output tier for a conservative estimate.
  Unavailable pricing fails closed. Without that option, dollar usage remains
  `null`, not fake zero. Estimates are **not hard provider billing caps**, and
  cannot account for every provider-side metering/routing change. Configure
  provider-side billing controls separately when required.

## Verification

```sh
npm --prefix runtime run typecheck
npm --prefix runtime test
JARVIS_WORKER_DOCKER_TESTS=1 node --test runtime/test/harness-worker*.test.ts
JARVIS_WORKER_DOCKER_TESTS=1 JARVIS_WORKER_CODING_TESTS=1 npm --prefix runtime test
npm --prefix runtime run build
```

The Docker suites are opt-in to keep the existing tests usable without Docker;
CI for worker acceptance should explicitly set the flag and install/pull the
prerequisites above. Those fixtures run the *real* pinned smolagents agent and
real Docker containers with a deterministic **synthetic model provider**. They
prove file/check/export/import, question/new-attempt resume without replay,
actual controller crash recovery, cancellation, independent watchdog, memory/
PID/tmpfs/network/filesystem boundaries, step/log/time bounds and verification
invalidation. Ordinary unit tests exercise actual parsing, immutable storage,
hash checks, budget accounting and failure paths without Docker.

The coding suite selects the reviewed coding pin for the Docker engine. The
original suite defaults to its matching minimal Python pin, independently of
the app's `JARVIS_WORKER_IMAGE` (advanced tests may use `JARVIS_WORKER_TEST_IMAGE`).
Pull **both** profiles for combined acceptance. Coding fixtures use the real
smolagents controller with an explicitly synthetic provider to create a complete
offline project: HTML/CSS/browser modules, shared search logic, Node unit and
container-only loopback HTTP tests, Python HTML/hash checks, a make-built C
helper, and immutable source/build/binary exports. They verify every emitted
asset hash, real native execution, actual running-Node cancellation, wrong-arch
refusal, minimal-profile noexec, `/tmp` noexec and unavailable package behavior.

An explicit, paid-model opt-in fixture is also supplied:

```sh
# Only with authorized credentials already in the environment:
export JARVIS_WORKER_MODEL='openai/gpt-4.1-mini'
JARVIS_WORKER_LIVE_TEST=1 node runtime/workers/live-fixture.ts
```

It is capped at four model calls/four tool steps, 24,000 admitted total tokens,
512 output tokens per call and 60 seconds, with no external tools/network. One
authorized live run verified a real hello.txt, an actual Python assertion,
immutable artifact bytes and cleanup: three calls/three steps, measured 4,368
input + 123 output tokens. This is separate from the synthetic-provider tests,
not proof of general task quality or native Mac operation.

An additional project-enhancement live fixture uses the selected coding profile:

```sh
JARVIS_WORKER_LIVE_TEST=1 node runtime/workers/live-coding-fixture.ts
```

It first builds genuine source artifacts using a synthetic provider, then gives
the live model a scoped implementation task: extend the shared browser/Node
search logic to match project statuses and add tests. The paid phase is limited
to eight calls/steps, 60,000 admitted total tokens, 2,048 output tokens per call
and 90 seconds. A separate fresh Docker attempt then independently rebuilds and
asserts the generated module behavior and hashes. Generated code never runs on
the host. All resources are cleaned or retained as explicitly uncertain.

The latest verified live enhancement, with declared-output filtering, completed
in five tool steps/five model calls, with measured 10,211 input + 574 output
tokens. Earlier bounded runs exposed a
provider ignoring the no-parallel hint and poor textual tool-history handling;
they failed safely. The native call-ID adapter and budgeted batch repair were
then regression-tested and the complete enhancement/rebuild/export passed.

## Inspected sources

Clarification safety is checked before an `ask_question` is appended to worker
history or persisted, and before a resumed answer/checkpoint can reach the model.
Credential-bearing continuation text is rejected before sealing a private
checkpoint. The authoritative kernel independently repeats these checks. Unsafe
legacy worker journals fail closed and retain their bytes for offline review;
this is not historical secure erasure or a guarantee of recognizing every secret.

- HF release API/source: https://github.com/huggingface/smolagents/tree/v1.26.0
- License: https://github.com/huggingface/smolagents/blob/v1.26.0/LICENSE
- Distribution/dependencies: https://pypi.org/pypi/smolagents/1.26.0/json
- Secure execution guidance: https://huggingface.co/docs/smolagents/v1.26.0/en/tutorials/secure_code_execution
- Gateway API: https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/chat-completions
- Live model catalog: https://ai-gateway.vercel.sh/v1/models
- Official Node image source: https://github.com/nodejs/docker-node/tree/e994dfe115899a82684caa7533380aa7d439aae1/24/bookworm
- Official Node variants: https://github.com/nodejs/docker-node/blob/e994dfe115899a82684caa7533380aa7d439aae1/README.md
- Digest pulls/platform selection: https://docs.docker.com/reference/cli/docker/image/pull/
