#!/bin/bash
# Surface compiler/test diagnostics as CI annotations as well as full logs.
set -uo pipefail
log="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/jarvis-native.XXXXXX")"
trap 'rm -f "$log"' EXIT
"$@" 2>&1 | tee "$log"
result=${PIPESTATUS[0]}
if [[ "$result" -ne 0 ]]; then
  python3 - "$log" <<'PY'
import sys
lines = open(sys.argv[1], errors='replace').read().splitlines()
errors = [line for line in lines if 'error:' in line or 'failed' in line or 'missing' in line]
for line in (errors or lines[-12:])[:40]:
    print('::error::' + line.replace('%','%25').replace('\r','%0D').replace('\n','%0A'))
PY
fi
exit "$result"
