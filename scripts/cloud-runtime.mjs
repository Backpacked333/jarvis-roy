#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { environmentFor } from './launch-env.mjs';
import { assertRestoreReviewed } from './cloud-recovery.mjs';

export function cloudEnvironment(role, source = process.env) {
  if (!['runtime', 'bridge', 'gateway'].includes(role)) throw new Error('Invalid cloud runtime role.');
  const environment = role === 'gateway' ? { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } : environmentFor(role, source);
  const common = ['JARVIS_RUNTIME_PROFILE', 'JARVIS_ENABLE_OBJECTIVES', 'JARVIS_ENABLE_CLOUD', 'JARVIS_ENABLE_TELEGRAM', 'JARVIS_ENABLE_GOOGLE', 'JARVIS_ENABLE_PHONE'];
  const privateGateway = ['HOME', 'JARVIS_DATA_DIR', 'JARVIS_CLOUD_HOST', 'JARVIS_CLOUD_PORT', 'JARVIS_CLOUD_ORIGIN', 'JARVIS_CLOUD_BOOTSTRAP_TOKEN', 'JARVIS_LOCAL_TOKEN', 'JARVIS_CLOUD_RUNTIME_TOKEN'];
  privateGateway.push('JARVIS_ENABLE_INTEGRATIONS', 'JARVIS_INTEGRATION_KEY', 'JARVIS_TELEGRAM_BOT_TOKEN', 'JARVIS_TELEGRAM_OWNER_CHAT_ID',
    'JARVIS_GOOGLE_CLIENT_ID', 'JARVIS_GOOGLE_CLIENT_SECRET', 'JARVIS_GOOGLE_REDIRECT_URI', 'JARVIS_TWILIO_ACCOUNT_SID', 'JARVIS_TWILIO_AUTH_TOKEN',
    'JARVIS_TWILIO_FROM_NUMBER', 'JARVIS_OWNER_PHONE_NUMBER', 'JARVIS_PUBLIC_BASE_URL', 'JARVIS_TIME_ZONE', 'JARVIS_INTEGRATION_PROJECT_ID',
    'JARVIS_PRICE_TELEGRAM_REQUEST_USD', 'JARVIS_PRICE_GOOGLE_REQUEST_USD', 'JARVIS_PRICE_TWILIO_REQUEST_USD', 'JARVIS_PRICE_TWILIO_MINUTE_USD',
    'JARVIS_PRICE_ELEVENLABS_STT_MINUTE_USD', 'JARVIS_PRICE_ELEVENLABS_TTS_CHARACTER_USD');
  for (const name of [...common, ...(role === 'gateway' ? privateGateway : [])]) if (source[name] !== undefined) environment[name] = source[name];
  if (role === 'bridge' && source.JARVIS_CLOUD_RUNTIME_TOKEN !== undefined) environment.JARVIS_CLOUD_RUNTIME_TOKEN = source.JARVIS_CLOUD_RUNTIME_TOKEN;
  if (role === 'runtime') {
    environment.WORKFLOW_LOCAL_DATA_DIR = path.join(source.JARVIS_DATA_DIR ?? '/var/lib/jarvis', 'eve-workflows');
    environment.WORKFLOW_LOCAL_BASE_URL = 'http://127.0.0.1:39201';
    environment.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS = '0';
  }
  environment.JARVIS_ENABLE_DESKTOP = '0'; environment.JARVIS_ENABLE_APPLE_SERVICES = '0'; environment.JARVIS_ENABLE_TERMINAL = '0';
  if (role === 'gateway') { environment.JARVIS_CLOUD_HOST = '127.0.0.1'; environment.JARVIS_CLOUD_PORT = '39300'; }
  return environment;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const role = process.argv[2], entries = { runtime: '.output/server/index.mjs', bridge: 'bridge/server.ts', gateway: 'bridge/cloud-main.ts' };
  if (process.versions.node.split('.')[0] !== '24' || !entries[role]) { process.stderr.write('Cloud runtime requires Node 24 and an explicit service role.\n'); process.exitCode = 1; }
  else {
    try { await assertRestoreReviewed(process.env.JARVIS_DATA_DIR ?? '/var/lib/jarvis'); }
    catch { process.stderr.write('Restored state is blocked pending an explicit stopped-service recovery review.\n'); process.exit(1); }
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime');
    const child = spawn(process.execPath, [entries[role]], { cwd: root, env: cloudEnvironment(role), shell: false, stdio: 'inherit' });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
    child.on('error', () => { process.stderr.write('Cloud service could not start. Inspect installation prerequisites.\n'); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  }
}
