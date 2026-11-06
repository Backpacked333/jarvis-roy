#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "The native app must be built on macOS 14 or newer." >&2
  exit 1
fi
xcode-select -p >/dev/null
swift build --package-path "$ROOT/macos" -c release
BIN="$(swift build --package-path "$ROOT/macos" -c release --show-bin-path)"
APP="$ROOT/dist/Jarvis.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/Jarvis" "$APP/Contents/MacOS/Jarvis"
cp "$ROOT/macos/Info.plist" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
echo "Built $APP (ad-hoc signed; not notarized). Launch with scripts/run-macos.sh."
