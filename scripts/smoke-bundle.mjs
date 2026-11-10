#!/usr/bin/env node
// Proves a staged payload runs on its own: the bundled Node starts the bundled
// runtime with no checkout, from an unrelated working directory, and nothing
// writes inside the bundle (which is signed and must stay byte-identical).
//
//   node scripts/smoke-bundle.mjs <Jarvis.app | Resources directory> [--turn]
//
// --turn additionally sends one real question and requires an answer. It needs
// AI_GATEWAY_API_KEY and spends a few cents; without it no provider is called.
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, readlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalServices } from './local-services.mjs';

/** Digest of every path, mode, size and content under `root`, so any write is detected. */
export async function fingerprint(root) {
  const hash = createHash('sha256');
  let files = 0;
  async function walk(path, name) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) { hash.update(`L ${name} ${await readlink(path)}\n`); return; }
    if (info.isDirectory()) {
      hash.update(`D ${name}\n`);
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry), `${name}/${entry}`);
      return;
    }
    files++;
    hash.update(`F ${name} ${info.mode & 0o777} ${info.size} `);
    hash.update(createHash('sha256').update(await readFile(path)).digest('hex'));
    hash.update('\n');
  }
  await walk(root, '.');
  return { digest: hash.digest('hex'), files };
}

async function resourcesOf(target) {
  const direct = resolve(target);
  const inApp = join(direct, 'Contents', 'Resources');
  try { if ((await stat(join(inApp, 'runtime'))).isDirectory()) return inApp; } catch { /* Not an app bundle. */ }
  return direct;
}

async function askOnce(services) {
  const say = async (path, options) => {
    const response = await services.request(path, { native: true, ...options });
    if (!response.ok) throw new Error(`${options?.method ?? 'GET'} ${path} returned ${response.status}: ${response.text.slice(0, 200)}`);
    return response.json;
  };
  const conversation = await say('/v1/conversations', { method: 'POST', body: { title: 'Bundle smoke' } });
  const task = await say('/v1/tasks', { method: 'POST', timeoutMs: 30_000,
    body: { message: 'Reply with the single word: ready', conversationId: conversation.id } });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const current = (await say('/v1/state')).tasks.find(value => value.id === task.id);
    if (current?.status === 'completed') {
      if (!String(current.reply ?? '').trim()) throw new Error('The turn completed without an answer.');
      return String(current.reply).trim();
    }
    if (current && ['failed', 'cancelled'].includes(current.status)) {
      throw new Error(`The turn ended as ${current.status}: ${current.error ?? 'no reason given'}`);
    }
    await delay(500);
  }
  throw new Error('The turn did not finish within two minutes.');
}

export async function smokeBundle(target, { turn = false, env = process.env } = {}) {
  const resources = await resourcesOf(target);
  const node = join(resources, 'node', 'bin', 'node');
  const runtime = join(resources, 'runtime');
  for (const required of [node, join(runtime, '.output/server/index.mjs'), join(runtime, 'bridge/server.ts'),
    join(runtime, 'service-guard.mjs'), join(runtime, 'node_modules/eve/package.json')]) {
    try { await stat(required); } catch { throw new Error(`The bundle is missing ${required}.`); }
  }
  if (turn && !(env.AI_GATEWAY_API_KEY ?? '').trim()) throw new Error('--turn needs AI_GATEWAY_API_KEY.');
  const before = await fingerprint(resources);
  const data = await mkdtemp(join(tmpdir(), 'jarvis-bundle-smoke-'));
  const source = { ...env };
  for (const name of Object.keys(source)) {
    // Start from a clean slate so the check does not depend on, or leak into, a developer's own settings.
    if (name.startsWith('JARVIS_') || (!turn && /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY)$/.test(name))) delete source[name];
  }
  let services, reply, primary;
  try {
    services = await startLocalServices({ runtimeDirectory: runtime, dataDirectory: data, env: source, node,
      runtimeCwd: join(data, 'runtime-state') });
    const state = (await services.request('/v1/state')).json;
    if (!state?.ready) throw new Error('The bundled services did not report ready.');
    if ((await services.request('/v1/state', { headers: { authorization: 'Bearer wrong' } })).status !== 401) {
      throw new Error('The bundled bridge accepted a wrong credential.');
    }
    if (!Array.isArray((await services.request('/v1/capabilities')).json?.capabilities)) throw new Error('Capabilities were not reported.');
    if (turn) reply = await askOnce(services);
  } catch (error) { primary = error; }
  finally {
    try {
      const stopped = await services?.stop();
      if (stopped?.forced) primary ??= new Error('A bundled service needed a forced stop.');
    } catch (error) { primary ??= error; }
    const after = await fingerprint(resources).catch(() => null);
    if (!primary && after?.digest !== before.digest) primary = new Error('Something wrote inside the bundle while it ran.');
    if (primary) {
      for (const role of ['runtime', 'bridge']) {
        const log = await readFile(join(data, 'logs', `${role}.log`), 'utf8').catch(() => '');
        if (log.trim()) console.error(`--- last ${role} output ---\n${log.split('\n').slice(-15).join('\n')}`);
      }
    }
    await rm(data, { recursive: true, force: true });
  }
  if (primary) throw primary;
  return { files: before.files, reply };
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const args = process.argv.slice(2);
  const turn = args.includes('--turn');
  const targets = args.filter(value => value !== '--turn');
  if (targets.length !== 1) {
    console.error('Usage: node scripts/smoke-bundle.mjs <Jarvis.app | Resources directory> [--turn]');
    process.exit(2);
  }
  try {
    const result = await smokeBundle(targets[0], { turn });
    console.log(`PASS: bundled Node started the bundled runtime from an unrelated directory; ${result.files} bundled files are unchanged.`
      + (turn ? ` One real turn answered: ${JSON.stringify(result.reply.slice(0, 80))}.` : ' No provider was called.'));
  } catch (error) {
    console.error(`Bundle smoke failed: ${error.message}`);
    process.exit(1);
  }
}
