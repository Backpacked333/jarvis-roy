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
  inheritance. The bounded workspace is `noexec`; interpreted Python/shell
  source works, but running newly compiled native executables is intentionally
  not enabled. No package downloads or autonomous network research in v1.
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

# Inspected official Python 3.12.12 slim-bookworm linux/amd64 manifest:
export JARVIS_WORKER_IMAGE='python@sha256:2986c55feb36e6cae00fa1fefb454283e4b33f35e75ff8bdd123b134130be301'
docker pull "$JARVIS_WORKER_IMAGE"
```

The corresponding official **linux/arm64/v8 metadata** resolves to
`python@sha256:228390eced221ad2986a3dd77e10b1accca6ba8ceb36f1572de1b346a337cc1a`.
That ARM manifest was inspected, **not executed here**. Select/verify the exact
platform intentionally; never replace these with a mutable `latest` tag.

All controller dependencies, including transitive packages, are pinned in
`requirements.txt`. No root Node dependency or tsconfig edits are necessary.
The tested clean venv is Python 3.10.12 on Linux; generated code uses Python
3.12.12 in the pinned image. `smolagents` is Apache-2.0; inspected upstream
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

Use `worker.artifacts.read` **only after** the kernel's exact scoped artifact
lookup. Artifacts are immutable content-addressed blobs with hashed manifests,
input provenance and scope/path/size checks. Imports copy only individually
verified regular files; there is no archive extraction or host mount. Symlinks,
hardlinks, devices, conflicting imports and traversal fail closed. A `completed`
result requires real files covering all declared output paths. `passed` means
actual sandbox commands exited zero and the captured files still match the last
check snapshot; it is not proof of semantic correctness, and model prose never
sets verification status. A write after a check clears that verification.

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
npm --prefix runtime run build
```

The Docker suite is opt-in to keep the existing tests usable without Docker;
CI for worker acceptance should explicitly set the flag and install/pull the
prerequisites above. Those fixtures run the *real* pinned smolagents agent and
real Docker containers with a deterministic **synthetic model provider**. They
prove file/check/export/import, question/new-attempt resume without replay,
actual controller crash recovery, cancellation, independent watchdog, memory/
PID/tmpfs/network/filesystem boundaries, step/log/time bounds and verification
invalidation. Ordinary unit tests exercise actual parsing, immutable storage,
hash checks, budget accounting and failure paths without Docker.

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

## Inspected sources

- HF release API/source: https://github.com/huggingface/smolagents/tree/v1.26.0
- License: https://github.com/huggingface/smolagents/blob/v1.26.0/LICENSE
- Distribution/dependencies: https://pypi.org/pypi/smolagents/1.26.0/json
- Secure execution guidance: https://huggingface.co/docs/smolagents/v1.26.0/en/tutorials/secure_code_execution
- Gateway API: https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/chat-completions
- Live model catalog: https://ai-gateway.vercel.sh/v1/models
