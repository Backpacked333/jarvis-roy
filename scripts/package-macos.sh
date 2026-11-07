#!/bin/bash
# Builds the standalone Jarvis.app (bundled Node + runtime + supervisor) and a DMG.
# See docs/standalone-app.md ("Packaging").
#
#   Default:                         ad-hoc signed, no hardened runtime, NOT notarized.
#   JARVIS_CODESIGN_IDENTITY=<id>    Developer ID signing with hardened runtime + timestamp.
#   JARVIS_NOTARY_PROFILE=<profile>  also notarize + staple (requires an identity).
#   JARVIS_NOTARY_KEYCHAIN=<path>    optional keychain holding that notarytool profile.
#   JARVIS_SKIP_SMOKE=1              skip the headless smoke test of the built app.
set -euo pipefail
umask 022
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Packaging the macOS app requires macOS 14 or newer." >&2
  exit 1
fi
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  echo "Node.js 24 LTS must be on PATH to run the packaging scripts. See the README." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Unsupported architecture $(uname -m)." >&2; exit 1 ;;
esac

IDENTITY="${JARVIS_CODESIGN_IDENTITY:-}"
NOTARY_PROFILE="${JARVIS_NOTARY_PROFILE:-}"
if [[ -n "$NOTARY_PROFILE" && -z "$IDENTITY" ]]; then
  echo "JARVIS_NOTARY_PROFILE is set but JARVIS_CODESIGN_IDENTITY is not. Ad-hoc signed apps cannot be notarized." >&2
  exit 1
fi
if [[ "$IDENTITY" == "-" ]]; then
  echo "JARVIS_CODESIGN_IDENTITY must name a Developer ID identity; leave it unset for ad-hoc signing." >&2
  exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/macos/Info.plist")"
if [[ ! "$VERSION" =~ ^[0-9A-Za-z.+-]+$ ]]; then
  echo "Unexpected CFBundleShortVersionString '$VERSION'." >&2
  exit 1
fi
APP="$ROOT/dist/Jarvis.app"
RESOURCES="$APP/Contents/Resources"
HELPER="$APP/Contents/Helpers/JarvisControl.app"
CACHE="$ROOT/dist/.cache"
NODE_DIR="$CACHE/node-v24.22.2-darwin-$ARCH"
DMG="$ROOT/dist/Jarvis-$VERSION-$ARCH.dmg"

echo "==> 1/7 Building the native app"
"$ROOT/scripts/build-macos.sh"

echo "==> 2/7 Building the runtime"
npm --prefix "$ROOT/runtime" ci
npm --prefix "$ROOT/runtime" run build

echo "==> 3/7 Fetching pinned Node.js ($ARCH)"
node "$ROOT/scripts/fetch-node.mjs" --arch "$ARCH" --out "$NODE_DIR" --cache "$CACHE" >/dev/null

echo "==> 4/7 Staging the bundled runtime"
node "$ROOT/scripts/stage-runtime.mjs" --runtime "$ROOT/runtime" --out "$RESOURCES" \
  --node "$NODE_DIR/bin/node" --launcher "$ROOT/scripts"

echo "==> 5/7 Signing (inside-out)"
xattr -cr "$APP"
if [[ -n "$IDENTITY" ]]; then
  SIGN=(codesign --force --sign "$IDENTITY" --options runtime --timestamp)
  NODE_ENTITLEMENTS=(--entitlements "$ROOT/macos/entitlements/node.plist")
  APP_ENTITLEMENTS=(--entitlements "$ROOT/macos/entitlements/jarvis.plist")
else
  SIGN=(codesign --force --sign -)
  NODE_ENTITLEMENTS=()
  APP_ENTITLEMENTS=()
fi
# Native code shipped inside the runtime payload: addons, dylibs and any other Mach-O.
NATIVE_COUNT=0
while IFS= read -r -d '' file; do
  # Capture instead of piping into `grep -q`: under pipefail an early-exiting grep can
  # SIGPIPE `file` and make a Mach-O look like a non-match (left unsigned).
  kind="$(file -b "$file")"
  if [[ "$file" == *.node || "$file" == *.dylib || "$kind" == Mach-O* ]]; then
    "${SIGN[@]}" "$file"
    NATIVE_COUNT=$((NATIVE_COUNT + 1))
  fi
done < <(find "$RESOURCES/runtime" -type f \( -name '*.node' -o -name '*.dylib' -o -perm -u+x \) -print0)
echo "Signed $NATIVE_COUNT native file(s) in the runtime payload."
"${SIGN[@]}" ${NODE_ENTITLEMENTS[@]+"${NODE_ENTITLEMENTS[@]}"} "$RESOURCES/node/bin/node"
"${SIGN[@]}" --identifier ai.backpacked.jarvisroy.control "$HELPER"
"${SIGN[@]}" ${APP_ENTITLEMENTS[@]+"${APP_ENTITLEMENTS[@]}"} "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "==> 6/7 Creating the disk image"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-dmg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Jarvis.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG" "$DMG.sha256"
hdiutil create -volname "Jarvis" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
if [[ -n "$IDENTITY" ]]; then
  codesign --force --sign "$IDENTITY" --timestamp "$DMG"
fi

if [[ -n "$NOTARY_PROFILE" ]]; then
  echo "==> 7/7 Notarizing and stapling"
  NOTARY_ARGS=(--keychain-profile "$NOTARY_PROFILE")
  if [[ -n "${JARVIS_NOTARY_KEYCHAIN:-}" ]]; then NOTARY_ARGS+=(--keychain "$JARVIS_NOTARY_KEYCHAIN"); fi
  xcrun notarytool submit "$DMG" "${NOTARY_ARGS[@]}" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
else
  echo "==> 7/7 Notarization skipped (JARVIS_NOTARY_PROFILE not set)"
fi
# The checksum is written last so it covers the stapled image.
(cd "$(dirname "$DMG")" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")

if [[ "${JARVIS_SKIP_SMOKE:-}" == 1 ]]; then
  echo "Smoke test skipped (JARVIS_SKIP_SMOKE=1)."
else
  echo "==> Smoke-testing the bundled services"
  # Nothing may write inside the bundle; a changed seal means something did. A DMG
  # whose app failed either check must not be left behind next to a valid checksum.
  if ! node "$ROOT/scripts/smoke-bundle.mjs" "$APP" || ! codesign --verify --deep --strict "$APP"; then
    rm -f "$DMG" "$DMG.sha256"
    echo "Smoke test or post-smoke signature check failed; removed $DMG." >&2
    exit 1
  fi
fi

echo
echo "Built $DMG"
echo "SHA-256: $(cut -d ' ' -f 1 "$DMG.sha256")"
if [[ -z "$IDENTITY" ]]; then
  echo "This build is ad-hoc signed and NOT notarized. Gatekeeper will warn on other Macs;"
  echo "it is suitable for local testing only."
elif [[ -z "$NOTARY_PROFILE" ]]; then
  echo "Signed with Developer ID but NOT notarized. Gatekeeper will warn until it is notarized and stapled."
else
  echo "Signed with Developer ID, notarized and stapled."
fi
