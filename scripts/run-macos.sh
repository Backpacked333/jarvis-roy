#!/bin/bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Jarvis's native app requires macOS 14 or newer." >&2
  exit 1
fi
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  echo "Node.js 24 LTS must be on PATH. See the README." >&2
  exit 1
fi
APP="$ROOT/dist/Jarvis.app/Contents/MacOS/Jarvis"
export JARVIS_NATIVE_HELPER="$ROOT/dist/Jarvis.app/Contents/Helpers/JarvisControl.app/Contents/MacOS/JarvisControl"
NODE="$(command -v node)"
if [[ ! -x "$APP" || ! -x "$JARVIS_NATIVE_HELPER" || ! -f "$ROOT/runtime/.output/server/index.mjs" ]]; then
  echo "Run ./scripts/setup-macos.sh first." >&2
  exit 1
fi
for port in 39201 39202; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "Port $port is already in use. Quit the other Jarvis instance or resolve the conflict first." >&2
    exit 1
  fi
done
if [[ -z "${AI_GATEWAY_API_KEY:-}" ]]; then
  read -r -s -p "Vercel AI Gateway API key (not saved): " AI_GATEWAY_API_KEY
  printf '\n'
  if [[ -z "$AI_GATEWAY_API_KEY" ]]; then echo "A model credential is required." >&2; exit 1; fi
  export AI_GATEWAY_API_KEY
fi
export JARVIS_LOCAL_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export JARVIS_NATIVE_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export JARVIS_DATA_DIR="${JARVIS_DATA_DIR:-$HOME/Library/Application Support/JarvisRoy}"
export JARVIS_MODEL="${JARVIS_MODEL:-openai/gpt-6-sol-fast}"
if [[ -z "${JARVIS_WORKER_PYTHON:-}" && -x "$ROOT/runtime/workers/.venv/bin/python" ]]; then
  export JARVIS_WORKER_PYTHON="$ROOT/runtime/workers/.venv/bin/python"
fi
if [[ -z "${JARVIS_DOCKER_BINARY:-}" ]] && command -v docker >/dev/null; then
  export JARVIS_DOCKER_BINARY="$(command -v docker)"
fi
mkdir -p "$JARVIS_DATA_DIR/logs"
chmod 700 "$JARVIS_DATA_DIR" "$JARVIS_DATA_DIR/logs"
EVE_PID=""
BRIDGE_PID=""
APP_PID=""
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then kill "$APP_PID" 2>/dev/null || true; fi
  # Keep Eve available while the bridge confirms root cancellation and reaps room workers.
  if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill "$BRIDGE_PID" 2>/dev/null || true
    for ((attempt=0; attempt<90; attempt++)); do
      kill -0 "$BRIDGE_PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$BRIDGE_PID" 2>/dev/null; then
      echo "Bridge shutdown is unconfirmed. Worker watchdogs remain bounded; inspect status after restart." >&2
      kill -KILL "$BRIDGE_PID" 2>/dev/null || true
    fi
  fi
  for pid in "$EVE_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
  done
  for pid in "$APP_PID" "$BRIDGE_PID" "$EVE_PID"; do
    if [[ -n "$pid" ]]; then wait "$pid" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$ROOT/runtime"
"$NODE" "$ROOT/scripts/launch-env.mjs" runtime "$NODE" .output/server/index.mjs >"$JARVIS_DATA_DIR/logs/runtime.log" 2>&1 &
EVE_PID=$!
"$NODE" "$ROOT/scripts/launch-env.mjs" bridge "$NODE" bridge/server.ts >"$JARVIS_DATA_DIR/logs/bridge.log" 2>&1 &
BRIDGE_PID=$!
echo "Starting local services…"
if ! node --input-type=module <<'JS'
import { setTimeout } from 'node:timers/promises';
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:39202/v1/state', {
      headers: { Authorization: `Bearer ${process.env.JARVIS_LOCAL_TOKEN}` },
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    });
    if (response.ok && (await response.json()).ready) process.exit(0);
  } catch {}
  await setTimeout(500);
}
console.error('Local services did not become ready. Inspect the runtime and bridge logs in JARVIS_DATA_DIR/logs.');
process.exit(1);
JS
then exit 1; fi
echo "Opening Jarvis. Keep this terminal open; quitting Jarvis stops its services."
"$NODE" "$ROOT/scripts/launch-env.mjs" ui "$APP" &
APP_PID=$!
wait "$APP_PID"
