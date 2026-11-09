#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-run}"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Jarvis's native build/run workflow requires macOS 14 or newer." >&2
  exit 1
fi
case "$MODE" in run|--debug|--logs|--telemetry|--verify) ;; *) echo "Usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2; exit 2 ;; esac
if pgrep -x Jarvis >/dev/null; then
  /usr/bin/osascript -e 'tell application id "ai.backpacked.jarvisroy" to quit'
  for ((attempt=0; attempt<120; attempt++)); do
    pgrep -x Jarvis >/dev/null || break
    sleep 0.5
  done
  if pgrep -x Jarvis >/dev/null; then
    echo "Jarvis has not confirmed shutdown. Inspect its active work before rebuilding." >&2
    exit 1
  fi
fi
"$ROOT/scripts/setup-macos.sh"
/usr/bin/open -n "$ROOT/dist/Jarvis.app"
case "$MODE" in
  --logs|--telemetry)
    /usr/bin/log stream --info --style compact --predicate 'subsystem == "ai.backpacked.jarvisroy"'
    ;;
  --debug|--verify)
    for ((attempt=0; attempt<30; attempt++)); do
      pgrep -x Jarvis >/dev/null && break
      sleep 0.2
    done
    pgrep -x Jarvis >/dev/null || { echo "Jarvis did not launch." >&2; exit 1; }
    if [[ "$MODE" == --debug ]]; then lldb -n Jarvis; fi
    if [[ "$MODE" == --verify ]]; then echo "Jarvis launched. Inspect its readiness banner; a PID alone does not verify provider access."; fi
    ;;
esac
