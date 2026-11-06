#!/bin/bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
"$PYTHON" -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ is required"'
"$PYTHON" -m venv "$ROOT/runtime/workers/.venv"
"$ROOT/runtime/workers/.venv/bin/python" -m pip install -r "$ROOT/runtime/workers/requirements.txt"
"$ROOT/runtime/workers/.venv/bin/python" -m pip check
printf '\nController ready. No Docker image was pulled or service started.\n'
printf 'export JARVIS_WORKER_PYTHON="%s/runtime/workers/.venv/bin/python"\n' "$ROOT"
printf 'Select and explicitly pull the platform digest documented in runtime/workers/README.md,\nthen export JARVIS_WORKER_IMAGE before running ./scripts/run-macos.sh.\n'
