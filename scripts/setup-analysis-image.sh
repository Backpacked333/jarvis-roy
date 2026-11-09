#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ $# -ne 0 ]]; then echo "Usage: $0 (build, offline fixtures, mandatory isolation probe)" >&2; exit 2; fi
if [[ -n "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}" ]]; then
  echo "Use a local Unix-socket Docker context without endpoint/TLS environment overrides for image setup." >&2
  exit 1
fi
node -e 'if(process.versions.node.split(".")[0] !== "24") throw new Error("Node 24 is required")'
# The existing selector rejects remote engines and chooses the reviewed platform pin.
BASE_IMAGE="$(node runtime/workers/setup-image.ts python)"
ANALYSIS_TMP="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-analysis.XXXXXX")"
trap 'rm -rf "$ANALYSIS_TMP"' EXIT

# Keep Docker's configured registry/proxy settings. Mount CA trust during the
# networked build step only; never copy credentials or session CAs into layers.
TRUST_ARGS=()
CA_SOURCE="${CODEX_PROXY_CERT:-${SSL_CERT_FILE:-}}"
if [[ -n "$CA_SOURCE" ]]; then
  [[ -r "$CA_SOURCE" ]] || { echo "Configured build CA is unreadable." >&2; exit 1; }
  if [[ -r /etc/ssl/certs/ca-certificates.crt ]]; then
    cat /etc/ssl/certs/ca-certificates.crt > "$ANALYSIS_TMP/trust.pem"
  elif [[ -r /etc/ssl/cert.pem ]]; then
    cat /etc/ssl/cert.pem > "$ANALYSIS_TMP/trust.pem"
  fi
  cat "$CA_SOURCE" >> "$ANALYSIS_TMP/trust.pem"
  TRUST_ARGS=(--secret "id=proxy_ca,src=$ANALYSIS_TMP/trust.pem")
fi
docker build --progress=plain "${TRUST_ARGS[@]}" --build-arg "BASE_IMAGE=$BASE_IMAGE" \
  --iidfile "$ANALYSIS_TMP/image-id" -f runtime/workers/analysis/Dockerfile runtime/workers/analysis >&2
ANALYSIS_IMAGE="$(cat "$ANALYSIS_TMP/image-id")"
[[ "$ANALYSIS_IMAGE" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Docker did not return an immutable local image ID." >&2; exit 1; }
echo "Built analysis image: $ANALYSIS_IMAGE" >&2

# This validates the libraries offline; actual enforcement is checked separately
# by Docker.create below. No host mounts, credentials, ports or network access.
docker run --rm --pull=never --network=none --read-only --user=65532:65532 --cap-drop=ALL \
  --security-opt=no-new-privileges:true --cpus=1 --memory=512m --memory-swap=512m --pids-limit=64 \
  --ipc=private --cgroupns=private --init --restart=no --ulimit nofile=256:256 --ulimit core=0:0 \
  --tmpfs /workspace:rw,nosuid,nodev,noexec,size=128m,uid=65532,gid=65532,mode=0700 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m,uid=65532,gid=65532,mode=0700 \
  --workdir /workspace --entrypoint /usr/bin/env "$ANALYSIS_IMAGE" -i \
  PATH=/usr/local/bin:/usr/bin:/bin HOME=/workspace LANG=C.UTF-8 \
  OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  python3 -I -B -m pytest -q -p no:cacheprovider /opt/jarvis-analysis/test_analysis.py >&2

if ! node runtime/workers/analysis/probe.ts "$ANALYSIS_IMAGE"; then
  echo "Analysis libraries were built/tested, but worker isolation is NOT verified. No image was enabled." >&2
  exit 1
fi
# stdout is suitable for an explicit operator assignment only after all checks pass.
echo "$ANALYSIS_IMAGE"
