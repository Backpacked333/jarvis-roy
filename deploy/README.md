# Private cloud deployment

This prepares an operator-supplied **Ubuntu 24.04** host. No VM or domain is
provisioned by these files, and this repository's Linux checks do not establish
that a public deployment or Mac hardware fixture works.

Install Node 24 at `/usr/bin/node`, Python 3 with venv support, Docker with actual
cgroup enforcement, Caddy, OpenSSH client and Git using their supported signed
repositories. The service account's Docker access controls the local engine;
keep the host dedicated to this trusted control plane. Open only TCP 443 and the
administrative SSH path needed by the operator. ACME HTTP validation may also
require TCP 80, or configure Caddy DNS validation explicitly.

Place a reviewed checkout at `/opt/jarvis/current`. Run:

```sh
sudo /opt/jarvis/current/deploy/setup-cloud.sh jarvis.example.com /opt/jarvis/current
```

The installer verifies Ubuntu/Node, installs locked dependencies with
`ONNXRUNTIME_NODE_INSTALL=skip` for bundled CPU ONNX execution, typechecks, builds
Eve, prepares the isolated worker controller, validates Caddy syntax and installs
disabled systemd units. Dependency TLS and hashes are never disabled. Setup
does not install a cloud language model or bypass an unavailable model catalog.

Fill `/etc/jarvis/runtime.env` (root-owned, mode 0600). Keep the dedicated cloud
bootstrap token distinct from provider credentials. New features start off in
the example except the assistant, knowledge and cloud transport prerequisites.
Optional integrations require `JARVIS_INTEGRATION_KEY`: 32 random bytes encoded
as exactly 64 hexadecimal characters. Preserve it securely across restarts and
restores; use a separate backup encryption key. Provider-specific setup is in
[the integration guide](../runtime/bridge/integrations/README.md).
Build/select a digest-pinned analysis image with `scripts/setup-analysis-image.sh`;
its mandatory kernel enforcement probe must pass. A rootless engine without
delegated cgroups is insufficient. Do not replace the digest with a mutable tag.

Review `/etc/jarvis/Caddyfile` and activate it through the host's Caddy service.
The ordered route exposes only `/v1/cloud/*`, explicitly rejects native-only
routes, strips native authority headers and keeps Eve/bridge/gateway listeners
on loopback ports 39201, 39202 and 39300. Gateway authentication and its own route
allowlist remain required; Caddy is not an authorization replacement.

Start the units for verification (do not enable boot startup yet):

```sh
sudo systemctl start jarvis-credentials jarvis-eve jarvis-bridge jarvis-gateway
sudo bash -c 'set -a; . /etc/jarvis/runtime.env; . /run/jarvis/local.env; set +a; node /opt/jarvis/current/scripts/cloud-readiness.mjs'
```

The readiness CLI checks private services, public TLS and denied private routes,
model-catalog availability, distinct credentials and actual Docker enforcement.
It reports fixed status codes and never prints credentials. Only after its gates
pass, inspect service health and perform a real device pairing and task fixture,
then explicitly enable the three service units. Fresh local/native/runtime
broker tokens are generated under private `/run/jarvis` each boot. Eve never
receives the native or cloud-runtime authority, and the public gateway never
receives the native token. Restart reconciles durable work; it does not replay
uncertain commands.

## Encrypted off-host backup and restore drill

Keep a random 32-byte key encoded as 64 lowercase hex characters in a root-owned
0600 file **outside `/var/lib/jarvis`**. Store a recovery copy separately from the
VM and backup host. Configure SSH keys and pin the backup host's key; the backup
tool requires `BatchMode=yes` and `StrictHostKeyChecking=yes`.

```sh
sudo node scripts/cloud-backup.mjs create --source /var/lib/jarvis --output /var/backups/jarvis-2026-11-09T120000Z.jvb --key-file /etc/jarvis/backup.key --remote backup@backup.example.com:/srv/jarvis
sudo node scripts/cloud-backup.mjs restore --archive /var/backups/jarvis-2026-11-09T120000Z.jvb --destination /var/lib/jarvis-restored-drill --key-file /etc/jarvis/backup.key
```

Creation stops and verifies inactivity of the three writer services, captures
SQLite files/WALs and immutable source files together, encrypts with AES-256-GCM,
restarts only services previously active, uploads ciphertext, verifies its remote
SHA-256 and then removes this tool's remote archives older than 30 days. A failed
upload keeps the local encrypted archive and does not prune remote backups.
Provider credential files and the backup key belong outside the backed-up state.

Restore authenticates the entire archive before exposing restored files, checks
all paths and file hashes, and writes only to a new private directory. It never
replaces the live state or starts services. Inspect the restored data and run a
separate stopped-host recovery drill before choosing an activation cutover.
Every restore includes `.jarvis-restore-review-required.json`; all cloud service
launchers refuse to start while it exists. Effects and scheduled work after the
backup may already have happened. Review unresolved actions against authoritative
provider/device receipts, review previously scheduled work, and keep uncertain
effects unknown without retrying them. Disable or reconcile stale scheduled and
ready objectives before removing the startup block: work that was pending at the
backup may have completed later. Create a private `0600` review JSON with:

```json
{"version":1,"restoreId":"COPY_FROM_MARKER","archiveSha256":"COPY_FROM_MARKER","reviewer":"Operator","reviewedAt":"CURRENT_UTC_ISO_TIMESTAMP","pendingActionsReviewed":true,"effectsAfterBackupReconciled":true,"previouslyScheduledWorkReviewed":true,"providerCredentialsReviewed":true,"unresolvedEffects":"remain_unknown_do_not_retry"}
```

With every Jarvis service stopped, run
`sudo node scripts/cloud-recovery.mjs review --directory /var/lib/jarvis-restored-drill --review-file /root/recovery-review.json`.
This validates the review's exact restore binding and persists an audit receipt
before removing the startup block. It does not start services or choose a cutover.
Restore inspection alone cannot prove external effects did not occur after backup.
Record an actual off-host restore result and recovery duration before calling
the deployment production-ready. No off-host transfer has been performed here.

## Mac profiles

Local and cloud profiles are explicit. Device tokens live in a separate macOS
Keychain service; local/native tokens never leave the Mac. Pairing pins the cloud
receipt verification key. The outbound WSS channel delegates commands only to
the existing local execution authority after durable receipt preparation.
Duplicate commands return their original receipt. A restart during dispatch
returns `unknown`, never a replay. Historical local IDs and unresolved local
actions are not migrated or retargeted when selecting the cloud profile.
