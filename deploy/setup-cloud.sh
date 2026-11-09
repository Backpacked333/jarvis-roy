#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ "${EUID}" -ne 0 ]]; then echo "Run the reviewed deployment installer as root on the target Ubuntu host." >&2; exit 1; fi
if [[ $# -ne 2 ]]; then echo "Usage: setup-cloud.sh DOMAIN TRUSTED_CHECKOUT" >&2; exit 2; fi
DOMAIN="$1"
CHECKOUT="$2"
if [[ "$CHECKOUT" != /opt/jarvis/current ]]; then echo "Install the reviewed checkout at /opt/jarvis/current before preparing services." >&2; exit 1; fi
if ! [[ -f /etc/os-release ]] || ! /usr/bin/python3 - <<'PY'
import pathlib
data=dict(line.split('=',1) for line in pathlib.Path('/etc/os-release').read_text().splitlines() if '=' in line)
assert data.get('ID','').strip('"')=='ubuntu' and data.get('VERSION_ID','').strip('"')=='24.04'
PY
then echo "Ubuntu 24.04 is required." >&2; exit 1; fi
for command in node npm python3 docker caddy systemctl; do command -v "$command" >/dev/null || { echo "Install required command: $command" >&2; exit 1; }; done
node -e 'if(process.versions.node.split(".")[0]!=="24")throw Error("Node24required")'
if [[ "$(command -v node)" != /usr/bin/node ]]; then echo "Configure Node 24 at /usr/bin/node for the reviewed service units." >&2; exit 1; fi
if ! id jarvis >/dev/null 2>&1; then useradd --system --home-dir /var/lib/jarvis --create-home --shell /usr/sbin/nologin jarvis; fi
getent group docker >/dev/null || { echo "The local Docker engine and docker group must exist before deployment." >&2; exit 1; }
install -d -m 0700 -o jarvis -g jarvis /var/lib/jarvis
install -d -m 0700 -o root -g root /etc/jarvis
# Dependency and build commands run without deployment secrets. The reviewed
# checkout remains operator-owned; npm install does not execute as the service user.
(cd "$CHECKOUT/runtime" && ONNXRUNTIME_NODE_INSTALL=skip npm ci && npm run typecheck && npm run build)
"$CHECKOUT/scripts/setup-workers.sh"
# Build output was created under a private root umask. Grant only read/traverse
# access to the service group; runtime state stays in /var/lib/jarvis.
chgrp jarvis /opt/jarvis "$CHECKOUT"
chmod g+rx /opt/jarvis "$CHECKOUT"
chgrp -R jarvis "$CHECKOUT/runtime" "$CHECKOUT/scripts"
chmod -R g+rX "$CHECKOUT/runtime" "$CHECKOUT/scripts"
PREPARED="$(mktemp -d /tmp/jarvis-deploy.XXXXXX)"
trap 'rm -rf "$PREPARED"' EXIT
/usr/bin/node "$CHECKOUT/scripts/cloud-render.mjs" "$DOMAIN" "$PREPARED" "$CHECKOUT"
caddy validate --config "$PREPARED/Caddyfile" --adapter caddyfile
for unit in "$PREPARED"/*.service; do install -m 0644 "$unit" /etc/systemd/system/; done
install -m 0644 "$PREPARED/Caddyfile" /etc/jarvis/Caddyfile
if [[ ! -e /etc/jarvis/runtime.env ]]; then install -m 0600 "$PREPARED/runtime.env.example" /etc/jarvis/runtime.env; fi
systemctl daemon-reload
echo "Service files prepared; no Jarvis service was enabled or started."
echo "Fill /etc/jarvis/runtime.env, select and verify the digest-pinned worker image, review Caddy routing, then follow deploy/README.md readiness and activation steps."
