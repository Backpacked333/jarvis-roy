#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function deploymentFiles({ domain, checkout = '/opt/jarvis/current', node = '/usr/bin/node' }) {
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain ?? '') ||
      !/^\/[A-Za-z0-9_./-]+$/.test(checkout) || checkout.split('/').includes('..') ||
      !/^\/[A-Za-z0-9_./-]+$/.test(node) || node.split('/').includes('..')) throw new Error('Use a DNS domain and trusted absolute executable/checkout paths.');
  const service = (role, after, options = '') => `[Unit]
Description=Jarvis ${role}
Requires=jarvis-credentials.service
After=network-online.target jarvis-credentials.service ${after}
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
User=jarvis
Group=jarvis
WorkingDirectory=${checkout}/runtime
EnvironmentFile=/etc/jarvis/runtime.env
EnvironmentFile=/run/jarvis/local.env
Environment=JARVIS_DATA_DIR=/var/lib/jarvis
Environment=HOME=/var/lib/jarvis
Environment=JARVIS_RUNTIME_PROFILE=cloud
Environment=JARVIS_CLOUD_HOST=127.0.0.1
Environment=JARVIS_CLOUD_PORT=39300
ExecStart=${node} ${checkout}/scripts/cloud-runtime.mjs ${role}
Restart=on-failure
RestartSec=5
TimeoutStopSec=75
KillMode=mixed
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/jarvis /run/jarvis
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
StandardOutput=journal
StandardError=journal
${options}
[Install]
WantedBy=multi-user.target
`;
  return {
    'jarvis-eve.service': service('runtime', ''),
    'jarvis-bridge.service': service('bridge', 'jarvis-eve.service', 'SupplementaryGroups=docker'),
    'jarvis-gateway.service': service('gateway', 'jarvis-bridge.service'),
    'jarvis-readiness.service': service('readiness', 'jarvis-eve.service jarvis-bridge.service jarvis-gateway.service', 'SupplementaryGroups=docker\nTimeoutStartSec=180')
      .replace('Type=simple', 'Type=oneshot').replace('Restart=on-failure', 'Restart=no')
      .replace(`ExecStart=${node} ${checkout}/scripts/cloud-runtime.mjs readiness`, `ExecStart=${node} ${checkout}/scripts/cloud-readiness.mjs`)
      .replace('[Install]\nWantedBy=multi-user.target\n', ''),
    'jarvis-credentials.service': `[Unit]
Description=Fresh boot-local Jarvis authority
Before=jarvis-eve.service jarvis-bridge.service jarvis-gateway.service
[Service]
Type=oneshot
User=jarvis
Group=jarvis
RuntimeDirectory=jarvis
RuntimeDirectoryMode=0700
UMask=0077
ExecStart=${node} ${checkout}/scripts/cloud-credentials.mjs /run/jarvis/local.env
RemainAfterExit=yes
`,
    'Caddyfile': `${domain} {
  encode zstd gzip
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options nosniff
    Referrer-Policy no-referrer
    -Server
  }
  request_body {
    max_size 10MB
  }
  route {
    @native path /v1/cloud/native-device /v1/cloud/native-command /v1/cloud/native-* /v1/cloud/runtime /v1/cloud/runtime/*
    respond @native 404
    @cloud path /v1/cloud/*
    reverse_proxy @cloud 127.0.0.1:39300 {
        header_up -X-Jarvis-Native-Token
        header_up -X-Jarvis-Local-Token
        header_up -X-Jarvis-Cloud-Runtime-Token
    }
    respond 404
  }
}
`,
    'runtime.env.example': `# Copy to /etc/jarvis/runtime.env with root ownership and 0600 mode.
# All services remain disabled until installation and readiness checks pass.
AI_GATEWAY_API_KEY=
JARVIS_MODEL=
JARVIS_RUNTIME_PROFILE=cloud
JARVIS_ENABLE_ASSISTANT=1
JARVIS_ENABLE_KNOWLEDGE=1
JARVIS_ENABLE_MEMORY=0
JARVIS_ENABLE_SEMANTIC_RETRIEVAL=0
# Optional operator-owned, read-only pinned encoder directory; never downloaded on inference.
JARVIS_E5_MODEL_DIR=
JARVIS_ENABLE_RESEARCH=0
# Required shared budget ledger for cloud conversations; explicitly set 1 before readiness.
JARVIS_ENABLE_OBJECTIVES=0
JARVIS_ENABLE_CLOUD=1
JARVIS_ENABLE_INTEGRATIONS=0
# If integrations are enabled: 32 random bytes encoded as 64 hexadecimal characters.
# Keep this encryption key stable across restarts and separate from backup keys.
JARVIS_INTEGRATION_KEY=
JARVIS_ENABLE_TELEGRAM=0
JARVIS_ENABLE_GOOGLE=0
JARVIS_ENABLE_PHONE=0
# Optional integrations: explicit prices are required; enter 0 only for documented free APIs.
JARVIS_TIME_ZONE=UTC
JARVIS_INTEGRATION_PROJECT_ID=personal
JARVIS_TELEGRAM_BOT_TOKEN=
JARVIS_TELEGRAM_OWNER_CHAT_ID=
JARVIS_PRICE_TELEGRAM_REQUEST_USD=
JARVIS_GOOGLE_CLIENT_ID=
JARVIS_GOOGLE_CLIENT_SECRET=
JARVIS_PRICE_GOOGLE_REQUEST_USD=
JARVIS_TWILIO_ACCOUNT_SID=
JARVIS_TWILIO_AUTH_TOKEN=
JARVIS_TWILIO_FROM_NUMBER=
JARVIS_OWNER_PHONE_NUMBER=
JARVIS_PRICE_TWILIO_REQUEST_USD=
JARVIS_PRICE_TWILIO_MINUTE_USD=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
JARVIS_PRICE_ELEVENLABS_STT_MINUTE_USD=
JARVIS_PRICE_ELEVENLABS_TTS_CHARACTER_USD=
JARVIS_ENABLE_DESKTOP=0
JARVIS_ENABLE_TERMINAL=0
JARVIS_ENABLE_APPLE_SERVICES=0
JARVIS_CLOUD_ORIGIN=https://${domain}
# Dedicated cloud bootstrap authority; never reuse local/native/provider tokens.
JARVIS_CLOUD_BOOTSTRAP_TOKEN=
# Immutable local sha256 or registry@sha256; actual Docker probe must pass.
JARVIS_WORKER_IMAGE=
JARVIS_WORKER_PYTHON=${checkout}/runtime/workers/.venv/bin/python
JARVIS_DOCKER_BINARY=/usr/bin/docker
`,
  };
}
export async function renderDeployment(directory, options) {
  const files = deploymentFiles(options); await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(directory, name), contents, { flag: 'wx', mode: 0o600 });
  return { rendered: Object.keys(files), activated: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [domain, output, checkout] = process.argv.slice(2);
  if (!domain || !output || process.argv.length > 5) { process.stderr.write('Usage: cloud-render.mjs DOMAIN OUTPUT_DIR [TRUSTED_CHECKOUT]\n'); process.exitCode = 1; }
  else renderDeployment(output, { domain, ...(checkout ? { checkout } : {}) }).then(value => process.stdout.write(JSON.stringify(value) + '\n'))
    .catch(() => { process.stderr.write('Deployment rendering failed. Use a valid domain and an empty output directory; no services were installed.\n'); process.exitCode = 1; });
}
