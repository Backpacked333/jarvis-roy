#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Run this setup on macOS 14 or newer." >&2
  exit 1
fi
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  echo 'Install Node.js 24 LTS and put node/npm on PATH first: https://nodejs.org/en/download' >&2
  exit 1
fi
xcode-select -p >/dev/null || { echo 'Install Xcode Command Line Tools: xcode-select --install' >&2; exit 1; }
cd "$ROOT/runtime"
npm ci
npm run build
"$ROOT/scripts/build-macos.sh"
