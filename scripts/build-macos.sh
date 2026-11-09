#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "The native app must be built on macOS 14 or newer." >&2
  exit 1
fi
xcode-select -p >/dev/null
swift build --package-path "$ROOT/macos-control" -c release \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$ROOT/macos-control/Info.plist"
HELPER_BIN="$(swift build --package-path "$ROOT/macos-control" -c release --show-bin-path)"
swift build --package-path "$ROOT/macos" -c release
BIN="$(swift build --package-path "$ROOT/macos" -c release --show-bin-path)"
APP="$ROOT/dist/Jarvis.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/Jarvis" "$APP/Contents/MacOS/Jarvis"
cp "$ROOT/macos/Info.plist" "$APP/Contents/Info.plist"
# Eve's generated manifest contains absolute source paths. This source-build
# bundle launches the prepared checkout rather than claiming a portable runtime.
if command -v node >/dev/null; then
  node - "$ROOT/runtime" "$(command -v node)" "$APP/Contents/Resources/runtime-location.json" <<'JS'
const fs = require('node:fs');
const [runtimeDirectory, nodeExecutable, destination] = process.argv.slice(2);
fs.writeFileSync(destination, JSON.stringify({ runtimeDirectory, nodeExecutable }) + '\n');
JS
else
  rm -f "$APP/Contents/Resources/runtime-location.json"
fi
HELPER="$APP/Contents/Helpers/JarvisControl.app"
mkdir -p "$HELPER/Contents/MacOS"
cp "$HELPER_BIN/JarvisControl" "$HELPER/Contents/MacOS/JarvisControl"
cp "$ROOT/macos-control/Info.plist" "$HELPER/Contents/Info.plist"
codesign --force --sign - --identifier ai.backpacked.jarvisroy.control "$HELPER"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "Built $APP (ad-hoc signed; not notarized)."
if [[ -f "$ROOT/runtime/.output/server/index.mjs" && -f "$APP/Contents/Resources/runtime-location.json" ]]; then
  echo "Open the app to start its prepared local services; configure provider credentials in Settings."
  echo "This source-build app requires this checkout and its Node 24 installation to remain available."
else
  echo "Native bundle only. Run scripts/setup-macos.sh to prepare double-click startup."
fi
