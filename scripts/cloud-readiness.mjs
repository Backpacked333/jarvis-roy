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
  const names = ['JARVIS_LOCAL_TOKEN', 'JARVIS_NATIVE_TOKEN', 'JARVIS_CLOUD_RUNTIME_TOKEN', 'JARVIS_CLOUD_BOOTSTRAP_TOKEN'];
  const tokens = names.map(name => environment[name] ?? '');
  add('distinct_authorities', tokens.every(token => token.length >= 32 && !/\s/.test(token)) && new Set(tokens).size === tokens.length && !tokens.includes(environment.AI_GATEWAY_API_KEY));
  add('provider_configured', !!environment.AI_GATEWAY_API_KEY && !!environment.JARVIS_MODEL);
  add('worker_image_immutable', /^(?:[A-Za-z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(environment.JARVIS_WORKER_IMAGE ?? ''));
  let origin;
  try { const value = new URL(environment.JARVIS_CLOUD_ORIGIN); if (value.protocol === 'https:' && !value.username && !value.password && !value.search && !value.hash && value.pathname === '/') origin = value.origin; } catch {}
  add('public_tls_origin', !!origin);
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
  await check('private_bridge_ready', async () => {
    const response = await get('http://127.0.0.1:39202/v1/state', { Authorization: `Bearer ${environment.JARVIS_LOCAL_TOKEN ?? ''}` });
    await response.body?.cancel(); return response.status === 200;
  });
  await check('private_gateway_ready', async () => {
    const response = await get('http://127.0.0.1:39300/v1/cloud/health'); await response.body?.cancel(); return response.status === 200;
  });
  await check('public_tls_ready', async () => {
    if (!origin) return false;
    const response = await get(`${origin}/v1/cloud/health`); await response.body?.cancel(); return response.status === 200;
  });
  for (const route of ['/v1/state', '/v1/cloud/native-device', '/v1/cloud/native-command', '/v1/cloud/runtime', '/v1/cloud/runtime/state']) await check(`public_denies_${route.slice(1).replaceAll('/', '_')}`, async () => {
    if (!origin) return false;
    const response = await get(origin + route); await response.body?.cancel(); return response.status === 404;
  });
  await check('model_catalog_available', async () => {
    const metadata = JSON.parse(await readFile(path.join(runtimeDirectory, '.output/.eve/compile/model-metadata.json'), 'utf8'));
    return typeof metadata.fetchedAt === 'string';
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
