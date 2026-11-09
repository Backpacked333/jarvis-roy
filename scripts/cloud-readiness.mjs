#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function inspectCloudConfiguration(environment, osRelease, nodeVersion) {
  const checks = [];
  const add = (code, pass) => checks.push({ code, status: pass ? 'pass' : 'fail' });
  add('ubuntu_24', /^ID=ubuntu$/m.test(osRelease) && /^VERSION_ID="?24\.04"?$/m.test(osRelease));
  add('node_24', nodeVersion.split('.')[0] === '24');
  add('cloud_enabled', environment.JARVIS_ENABLE_CLOUD === '1');
  add('cloud_profile', environment.JARVIS_RUNTIME_PROFILE === 'cloud');
  add('cloud_budget_ledger_enabled', environment.JARVIS_ENABLE_OBJECTIVES === '1');
  const names = ['JARVIS_LOCAL_TOKEN', 'JARVIS_NATIVE_TOKEN', 'JARVIS_CLOUD_RUNTIME_TOKEN', 'JARVIS_CLOUD_BOOTSTRAP_TOKEN'];
  const tokens = names.map(name => environment[name] ?? '');
  add('distinct_authorities', tokens.every(token => token.length >= 32 && !/[\s\0]/.test(token)) && new Set(tokens).size === tokens.length && !tokens.includes(environment.AI_GATEWAY_API_KEY));
  add('provider_configured', !!environment.AI_GATEWAY_API_KEY && !!environment.JARVIS_MODEL);
  add('worker_image_immutable', /^(?:[A-Za-z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(environment.JARVIS_WORKER_IMAGE ?? ''));
  let origin;
  try { const value = new URL(environment.JARVIS_CLOUD_ORIGIN); if (value.protocol === 'https:' && !value.username && !value.password && !value.search && !value.hash && value.pathname === '/') origin = value.origin; } catch {}
  add('public_tls_origin', !!origin);
  const enabled = name => environment[name] === '1', configured = name => typeof environment[name] === 'string' && environment[name].trim().length > 0;
  const priced = name => configured(name) && Number.isFinite(Number(environment[name])) && Number(environment[name]) >= 0;
  const integrations = enabled('JARVIS_ENABLE_INTEGRATIONS');
  add('integration_feature_dependencies', !['JARVIS_ENABLE_TELEGRAM', 'JARVIS_ENABLE_GOOGLE', 'JARVIS_ENABLE_PHONE'].some(enabled) || integrations);
  if (integrations) {
    let validTimezone = false;
    try { if (configured('JARVIS_TIME_ZONE')) { new Intl.DateTimeFormat('en-US', { timeZone: environment.JARVIS_TIME_ZONE }).format(); validTimezone = true; } } catch {}
    add('integration_encryption_key', /^[a-fA-F0-9]{64}$/.test(environment.JARVIS_INTEGRATION_KEY ?? ''));
    add('integration_scope', validTimezone && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(environment.JARVIS_INTEGRATION_PROJECT_ID ?? 'personal'));
    if (enabled('JARVIS_ENABLE_TELEGRAM')) add('telegram_configuration', configured('JARVIS_TELEGRAM_BOT_TOKEN') &&
      /^[1-9]\d*$/.test(environment.JARVIS_TELEGRAM_OWNER_CHAT_ID ?? '') && priced('JARVIS_PRICE_TELEGRAM_REQUEST_USD'));
    if (enabled('JARVIS_ENABLE_GOOGLE')) add('google_configuration', configured('JARVIS_GOOGLE_CLIENT_ID') && priced('JARVIS_PRICE_GOOGLE_REQUEST_USD'));
    if (enabled('JARVIS_ENABLE_PHONE')) add('phone_configuration', /^AC[0-9a-fA-F]{32}$/.test(environment.JARVIS_TWILIO_ACCOUNT_SID ?? '') &&
      configured('JARVIS_TWILIO_AUTH_TOKEN') && /^\+[1-9]\d{7,14}$/.test(environment.JARVIS_TWILIO_FROM_NUMBER ?? '') &&
      /^\+[1-9]\d{7,14}$/.test(environment.JARVIS_OWNER_PHONE_NUMBER ?? '') && configured('ELEVENLABS_API_KEY') &&
      /^[A-Za-z0-9_-]{1,128}$/.test(environment.ELEVENLABS_VOICE_ID ?? '') &&
      ['JARVIS_PRICE_TWILIO_REQUEST_USD', 'JARVIS_PRICE_TWILIO_MINUTE_USD', 'JARVIS_PRICE_ELEVENLABS_STT_MINUTE_USD', 'JARVIS_PRICE_ELEVENLABS_TTS_CHARACTER_USD'].every(priced));
  }
  return { checks, origin };
}
export async function runCloudReadiness({ environment = process.env, osRelease, nodeVersion = process.versions.node,
  fetcher = fetch, workerProbe, runtimeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime') } = {}) {
  osRelease ??= await readFile('/etc/os-release', 'utf8');
  const { checks, origin } = inspectCloudConfiguration(environment, osRelease, nodeVersion);
  const check = async (code, action) => {
    try { checks.push({ code, status: await action() ? 'pass' : 'fail' }); }
    catch { checks.push({ code, status: 'fail' }); }
  };
  const get = async (url, headers = {}) => fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
  const boundedJSON = async response => {
    if (!response.ok) { await response.body?.cancel(); throw new Error('Readiness endpoint unavailable'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Readiness response missing');
    const chunks = []; let bytes = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 8_000_000) throw new Error('Readiness response exceeds limit'); chunks.push(part.value); }
    } catch (error) { await reader.cancel(); throw error; }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  await check('private_bridge_ready', async () => {
    const response = await get('http://127.0.0.1:39202/v1/state', { Authorization: `Bearer ${environment.JARVIS_LOCAL_TOKEN ?? ''}` });
    const state = await boundedJSON(response); return state.ready === true && state.model === environment.JARVIS_MODEL && !state.error;
  });
  await check('private_budget_ledger_ready', async () => {
    const response = await fetcher('http://127.0.0.1:39202/v1/cloud/runtime', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${environment.JARVIS_LOCAL_TOKEN ?? ''}`, 'x-jarvis-cloud-runtime-token': environment.JARVIS_CLOUD_RUNTIME_TOKEN ?? '', 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, operation: 'readiness', payload: {} }) });
    const state = await boundedJSON(response);
    return state.version === 1 && state.profile === 'cloud' && state.objectives?.ready === true && state.objectives.stopped === false && state.objectives.unknownReservations === 0;
  });
  await check('service_worker_available', async () => {
    const response = await get('http://127.0.0.1:39202/v1/harness/state', { Authorization: `Bearer ${environment.JARVIS_LOCAL_TOKEN ?? ''}` });
    const state = await boundedJSON(response); return state.ready === true && state.worker?.available === true;
  });
  await check('private_gateway_ready', async () => {
    if (!origin) return false;
    const state = await boundedJSON(await get('http://127.0.0.1:39300/v1/cloud/health', { Host: new URL(origin).host }));
    return state.version === 1 && state.status === 'ready';
  });
  await check('public_tls_ready', async () => {
    if (!origin) return false;
    const state = await boundedJSON(await get(`${origin}/v1/cloud/health`)); return state.version === 1 && state.status === 'ready';
  });
  for (const route of ['/v1/state', '/v1/cloud/native-device', '/v1/cloud/native-command', '/v1/cloud/runtime', '/v1/cloud/runtime/state']) await check(`public_denies_${route.slice(1).replaceAll('/', '_')}`, async () => {
    if (!origin) return false;
    const response = await get(origin + route); await response.body?.cancel(); return response.status === 404;
  });
  await check('model_catalog_available', async () => {
    // The dynamic cloud model supplies its own context bound; build-time Eve
    // metadata may be absent. Exact live pricing is mandatory for paid calls.
    const { gatewayPrices } = await import('../runtime/bridge/gateway-pricing.ts');
    const catalog = await boundedJSON(await get('https://ai-gateway.vercel.sh/v1/models'));
    gatewayPrices(catalog, environment.JARVIS_MODEL);
    if (environment.JARVIS_ENABLE_RESEARCH === '1') gatewayPrices(catalog, environment.JARVIS_DEEP_MODEL || environment.JARVIS_MODEL);
    return true;
  });
  if (environment.JARVIS_ENABLE_SEMANTIC_RETRIEVAL === '1') await check('semantic_encoder_verified', async () => {
    if (!environment.JARVIS_E5_MODEL_DIR) return false;
    const { verifyE5Files } = await import('../runtime/bridge/knowledge/linux-embeddings.ts');
    await verifyE5Files(environment.JARVIS_E5_MODEL_DIR); return true;
  });
  await check('worker_actual_enforcement', async () => {
    if (!checks.find(check => check.code === 'worker_image_immutable') || checks.find(check => check.code === 'worker_image_immutable').status !== 'pass') return false;
    if (workerProbe) return workerProbe(environment.JARVIS_WORKER_IMAGE);
    const [{ Docker }, { defaultRoomPolicy }, { randomUUID }] = await Promise.all([
      import('../runtime/bridge/harness-worker/docker.ts'), import('../runtime/bridge/harness-contracts/domain.ts'), import('node:crypto'),
    ]);
    const docker = new Docker(environment.JARVIS_DOCKER_BINARY ?? '/usr/bin/docker', `cloud-readiness-${randomUUID()}`);
    const ref = { roomId: 'cloud-readiness', runId: randomUUID(), nodeId: 'probe', attemptId: 'attempt' };
    try { await docker.create(ref, defaultRoomPolicy(environment.JARVIS_WORKER_IMAGE), new AbortController().signal, 30_000); return true; }
    finally { if (!await docker.stop(ref)) throw new Error('Probe cleanup unconfirmed'); }
  });
  return { version: 1, ready: checks.every(check => check.status === 'pass'), checks, physicalMacAcceptance: 'not_tested' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCloudReadiness().then(result => { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if (!result.ready) process.exitCode = 1; })
    .catch(() => { process.stderr.write('Readiness could not be evaluated. No services or permissions were enabled.\n'); process.exitCode = 1; });
}
