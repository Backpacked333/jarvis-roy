#!/bin/bash
# Builds a self-contained Jarvis.app (its own Node.js and runtime inside) and a
# disk image. The result needs no checkout, no terminal and no system Node.
#
#   Default:                         ad-hoc signed, NOT notarized (Gatekeeper asks once).
#   JARVIS_CODESIGN_IDENTITY=<id>    Developer ID signing with hardened runtime + timestamp.
#   JARVIS_NOTARY_PROFILE=<profile>  also notarize + staple (requires an identity).
#   JARVIS_NOTARY_KEYCHAIN=<path>    optional keychain holding that notarytool profile.
#   JARVIS_SKIP_SMOKE=1              skip the headless check of the bundled services.
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
  arm64) ARCH=arm64; ARCH_LABEL="Apple-Silicon" ;;
  x86_64) ARCH=x64; ARCH_LABEL="Intel" ;;
  *) echo "Unsupported architecture $(uname -m)." >&2; exit 1 ;;
esac

IDENTITY="${JARVIS_CODESIGN_IDENTITY:-}"
NOTARY_PROFILE="${JARVIS_NOTARY_PROFILE:-}"
if [[ -n "$NOTARY_PROFILE" && -z "$IDENTITY" ]]; then
  echo "JARVIS_NOTARY_PROFILE is set but JARVIS_CODESIGN_IDENTITY is not. Ad-hoc signed apps cannot be notarized." >&2
  exit 1
fi
if [[ "$IDENTITY" == "-" ]]; then
  echo "JARVIS_CODESIGN_IDENTITY must name a signing identity; leave it unset for ad-hoc signing." >&2
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
NODE_VERSION="$(node --input-type=module -e "import { NODE_VERSION } from '$ROOT/scripts/fetch-node.mjs'; process.stdout.write(NODE_VERSION)")"
NODE_DIR="$CACHE/node-$NODE_VERSION-darwin-$ARCH"
DMG="$ROOT/dist/Jarvis-$VERSION-$ARCH_LABEL.dmg"

echo "==> 1/8 Building the runtime"
npm --prefix "$ROOT/runtime" ci
npm --prefix "$ROOT/runtime" run build

echo "==> 2/8 Building the native app"
"$ROOT/scripts/build-macos.sh"

echo "==> 3/8 Fetching pinned Node.js $NODE_VERSION ($ARCH)"
node "$ROOT/scripts/fetch-node.mjs" --arch "$ARCH" --out "$NODE_DIR" --cache "$CACHE" >/dev/null

echo "==> 4/8 Putting Node.js and the runtime inside the app"
node "$ROOT/scripts/stage-runtime.mjs" --runtime "$ROOT/runtime" --out "$RESOURCES" --node "$NODE_DIR/bin/node"
# A packaged app must not point back at the machine that built it.
rm -f "$RESOURCES/runtime-location.json"

echo "==> 5/8 Signing (inside-out)"
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

if [[ "${JARVIS_SKIP_SMOKE:-}" == 1 ]]; then
  echo "==> 6/8 Bundled-services check skipped (JARVIS_SKIP_SMOKE=1)"
else
  echo "==> 6/8 Checking that the bundled services start on their own"
  # Run from an unrelated directory: nothing may depend on the checkout, and nothing
  # may write inside the bundle. A changed seal afterwards means something did.
  (cd "${TMPDIR:-/tmp}" && node "$ROOT/scripts/smoke-bundle.mjs" "$APP")
  codesign --verify --deep --strict "$APP"
fi

echo "==> 7/8 Creating the disk image"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-dmg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Jarvis.app"
ln -s /Applications "$STAGE/Applications"
if [[ -z "$NOTARY_PROFILE" ]]; then
  cp "$ROOT/scripts/first-launch.txt" "$STAGE/Read me first.txt"
fi
rm -f "$DMG" "$DMG.sha256"
hdiutil create -volname "Jarvis" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
if [[ -n "$IDENTITY" ]]; then
  codesign --force --sign "$IDENTITY" --timestamp "$DMG"
fi

if [[ -n "$NOTARY_PROFILE" ]]; then
  echo "==> 8/8 Notarizing and stapling"
  NOTARY_ARGS=(--keychain-profile "$NOTARY_PROFILE")
  if [[ -n "${JARVIS_NOTARY_KEYCHAIN:-}" ]]; then NOTARY_ARGS+=(--keychain "$JARVIS_NOTARY_KEYCHAIN"); fi
  xcrun notarytool submit "$DMG" "${NOTARY_ARGS[@]}" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
else
  echo "==> 8/8 Notarization skipped (JARVIS_NOTARY_PROFILE not set)"
fi
# The checksum is written last so it covers the stapled image.
(cd "$(dirname "$DMG")" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")

echo
echo "Built $DMG ($(du -h "$DMG" | cut -f 1 | tr -d ' '))"
echo "SHA-256: $(cut -d ' ' -f 1 "$DMG.sha256")"
if [[ -z "$IDENTITY" ]]; then
  echo "This build is ad-hoc signed and NOT notarized. macOS will ask once before opening it;"
  echo "the disk image includes 'Read me first.txt' with the steps."
elif [[ -z "$NOTARY_PROFILE" ]]; then
  echo "Signed but NOT notarized. macOS will ask once before opening it."
else
  echo "Signed with Developer ID, notarized and stapled."
fi
