// Starts the two local services (the built Eve agent and the bridge) the same
// way the Mac app does, for development, smoke checks and evaluation runs.
// Only processes started here are ever signalled.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { environmentFor } from './launch-env.mjs';

export const RUNTIME_PORT = 39201;
export const BRIDGE_PORT = 39202;

export function portFree(port) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/**
 * @param {object} options
 * @param {string} options.runtimeDirectory  Directory holding `.output/` and `bridge/`.
 * @param {string} options.dataDirectory     Private data directory (created 0700).
 * @param {NodeJS.ProcessEnv} [options.env]  Source environment; filtered per service.
 * @param {string} [options.node]            Node executable for both services.
 * @param {string} [options.runtimeCwd]      Working directory for the agent runtime (Eve writes its state here).
 * @param {number} [options.readyTimeoutMs]
 */
export async function startLocalServices({ runtimeDirectory, dataDirectory, env = process.env, node = process.execPath,
  runtimeCwd = runtimeDirectory, readyTimeoutMs = 45_000 }) {
  const entries = { runtime: join(runtimeDirectory, '.output/server/index.mjs'), bridge: join(runtimeDirectory, 'bridge/server.ts') };
  const guard = join(runtimeDirectory, 'service-guard.mjs');
  try { await access(entries.runtime); } catch { throw new Error('The agent runtime is not built. Run: cd runtime && npm run build'); }
  for (const port of [RUNTIME_PORT, BRIDGE_PORT]) {
    if (!await portFree(port)) throw new Error(`Port ${port} is already in use. Quit the other Jarvis instance first.`);
  }
  const logs = join(dataDirectory, 'logs');
  await mkdir(logs, { recursive: true, mode: 0o700 });
  await mkdir(runtimeCwd, { recursive: true, mode: 0o700 });
  const token = (env.JARVIS_LOCAL_TOKEN ?? '').length >= 32 ? env.JARVIS_LOCAL_TOKEN : randomBytes(32).toString('hex');
  const nativeToken = (env.JARVIS_NATIVE_TOKEN ?? '').length >= 32 ? env.JARVIS_NATIVE_TOKEN : randomBytes(32).toString('hex');
  const source = { ...env, JARVIS_LOCAL_TOKEN: token, JARVIS_NATIVE_TOKEN: nativeToken, JARVIS_DATA_DIR: dataDirectory };
  const children = [];
  const alive = record => record.child.exitCode === null && record.child.signalCode === null && !record.failed;

  async function stop() {
    let forced = false;
    // The bridge stops first so it can confirm cancellation while the agent runtime is still reachable.
    for (const record of [...children].reverse()) {
      if (!alive(record)) continue;
      record.child.kill('SIGTERM');
      let timer;
      await Promise.race([record.exited, new Promise(resolve => { timer = setTimeout(resolve, 45_000); })]);
      clearTimeout(timer);
      if (alive(record)) { forced = true; record.child.kill('SIGKILL'); await record.exited; }
    }
    children.length = 0;
    return { forced };
  }

  async function request(path, { method = 'GET', body, native = false, headers = {}, timeoutMs = 10_000 } = {}) {
    const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}${path}`, { method, redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(native ? { 'x-jarvis-native-token': nativeToken } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* Non-JSON bodies are returned as text. */ }
    return { status: response.status, ok: response.ok, json, text };
  }

  try {
    for (const [role, cwd] of [['runtime', runtimeCwd], ['bridge', runtimeDirectory]]) {
      const log = await open(join(logs, `${role}.log`), 'a', 0o600);
      try {
        // Standard input is a pipe nothing writes to: if this process dies, it closes and the service stops itself.
        const child = spawn(node, [guard, entries[role]], { cwd, env: { ...environmentFor(role, source), JARVIS_LIFELINE: 'stdin' },
          stdio: ['pipe', log.fd, log.fd] });
        child.stdin.on('error', () => { /* The service has already exited. */ });
        const record = { role, child, failed: false, exited: undefined };
        record.exited = new Promise(resolve => {
          child.once('exit', resolve);
          child.once('error', () => { record.failed = true; resolve(); });
        });
        children.push(record);
      } finally { await log.close(); }
    }
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const exited = children.find(record => !alive(record));
      if (exited) throw new Error(`The ${exited.role} service exited during startup. See ${join(logs, `${exited.role}.log`)}.`);
      try { if ((await request('/v1/state', { timeoutMs: 3_000 })).json?.ready) break; } catch { /* Not listening yet. */ }
      if (Date.now() > deadline) throw new Error(`Local services did not become ready. See the logs in ${logs}.`);
      await delay(250);
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { token, nativeToken, logs, request, stop,
    exited: () => Promise.race(children.map(record => record.exited.then(() => record.role))) };
}
