#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, open, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { environmentFor } from './launch-env.mjs';
import { defaultRoomPolicy } from '../runtime/bridge/harness-contracts/domain.ts';

// Run after `npm --prefix runtime run build`. This exercises real local servers,
// with generated credentials and temporary data, without calling a provider.
const arguments_ = process.argv.slice(2);
if (arguments_.some(value => value !== '--assistant') || arguments_.length > 1) {
  console.error('Usage: node scripts/smoke-runtime.mjs [--assistant]');
  process.exitCode = 1;
} else {
  await smoke(arguments_.includes('--assistant')).catch(error => {
    console.error(`Runtime smoke failed: ${error.message}`);
    process.exitCode = 1;
  });
}

async function smoke(assistantEnabled) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const runtimeDirectory = join(root, 'runtime');
  try { await access(join(runtimeDirectory, '.output/server/index.mjs')); }
  catch { throw new Error('Build the runtime first with npm --prefix runtime run build.'); }

  // Binding proves the exact port is available even if another service does not
  // speak HTTP. We never send signals to a process we did not launch.
  for (const port of [39201, 39202]) await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`Port ${port} is occupied or unavailable; stop the existing service before running the smoke check.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
  });

  const directory = await mkdtemp(join(tmpdir(), 'jarvis-runtime-smoke-'));
  const token = randomBytes(32).toString('hex');
  const nativeToken = assistantEnabled ? randomBytes(32).toString('hex') : undefined;
  const source = { ...process.env, JARVIS_LOCAL_TOKEN: token, JARVIS_DATA_DIR: directory };
  for (const name of Object.keys(source)) {
    if (name.startsWith('JARVIS_ENABLE_') || name === 'JARVIS_NATIVE_TOKEN' || name === 'JARVIS_NATIVE_HELPER' ||
        /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY)$/.test(name) ||
        ['HOME_ASSISTANT_URL', 'HOME_ASSISTANT_TOKEN', 'ELEVENLABS_VOICE_ID', 'JARVIS_WORKER_IMAGE'].includes(name)) delete source[name];
  }
  if (assistantEnabled) Object.assign(source, { JARVIS_NATIVE_TOKEN: nativeToken,
    JARVIS_ENABLE_ASSISTANT: '1', JARVIS_ENABLE_KNOWLEDGE: '1', JARVIS_ENABLE_MEMORY: '1', JARVIS_ENABLE_VOICE_APPROVAL: '1' });
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort(new Error('Smoke check interrupted.'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let children = [], generation = 0;
  const alive = record => record.child.exitCode === null && record.child.signalCode === null && !record.error;

  async function request(path, { method = 'GET', body, expected = 200, native = assistantEnabled, auth = true, origin } = {}) {
    const response = await fetch(`http://127.0.0.1:39202${path}`, { method, redirect: 'error',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}),
        ...(native && nativeToken ? { 'x-jarvis-native-token': nativeToken } : {}), ...(origin ? { origin } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(5_000)]),
    });
    assert.equal(response.status, expected, `${method} ${path} returned an unexpected status`);
    return response.json();
  }

  async function start() {
    generation++;
    for (const [role, entry] of [['runtime', '.output/server/index.mjs'], ['bridge', 'bridge/server.ts']]) {
      interrupted.signal.throwIfAborted();
      const log = await open(join(directory, `${role}-${generation}.log`), 'w', 0o600);
      try {
        const child = spawn(process.execPath, [entry], { cwd: runtimeDirectory, env: environmentFor(role, source),
          stdio: ['ignore', log.fd, log.fd] });
        const record = { child, role, error: false, exited: undefined };
        record.exited = new Promise(resolve => {
          child.once('exit', resolve);
          child.once('error', () => { record.error = true; resolve(); });
        });
        children.push(record);
      } finally { await log.close(); }
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      interrupted.signal.throwIfAborted();
      const exited = children.find(record => !alive(record));
      if (exited) throw new Error(`The ${exited.role} service exited before readiness.`);
      try { if ((await request('/v1/state')).ready) return; } catch { /* Startup may not be listening yet. */ }
      await delay(250, undefined, { signal: interrupted.signal });
    }
    throw new Error('Built Eve and bridge did not become ready within 30 seconds.');
  }

  async function stop() {
    let forced = false;
    for (const record of [...children].reverse()) {
      if (alive(record)) {
        record.child.kill('SIGTERM');
        let timer;
        await Promise.race([record.exited, new Promise(resolve => { timer = setTimeout(resolve, 30_000); })]);
        clearTimeout(timer);
        if (alive(record)) { forced = true; record.child.kill('SIGKILL'); await record.exited; }
      }
    }
    children = [];
    if (forced) throw new Error('A smoke-owned service required forced shutdown.');
  }

  let primaryError;
  try {
    await start();
    await request('/v1/state', { auth: false, native: false, expected: 401 });
    await request('/v1/state', { origin: 'http://localhost', expected: 403 });
    const capabilities = await request('/v1/capabilities');
    assert.ok(Array.isArray(capabilities.capabilities) && capabilities.capabilities.length > 0);
    const conversation = await request('/v1/conversations', { method: 'POST', body: { title: 'Runtime smoke conversation' }, expected: 201 });
    const room = await request('/v1/harness/rooms', { method: 'POST', body: { requestId: 'runtime-smoke-room',
      title: 'Runtime smoke room', description: '', policy: defaultRoomPolicy(null) }, expected: 201 });
    await request('/v1/harness/archives', { native: false, expected: 403 });
    let assistantSession, grant, imported, memory;
    if (assistantEnabled) {
      await request('/v1/assistant/state', { native: false, expected: 403 });
      assistantSession = await request('/v1/assistant/sessions', { method: 'POST', expected: 201,
        body: { title: 'Smoke assistant', focus: { kind: 'conversation', conversationId: conversation.id, roomId: null } } });
      grant = await request('/v1/grants', { method: 'POST', expected: 201, body: { projectId: conversation.id,
        resourceKind: 'file', resourceId: 'smoke-selected-document', label: 'Smoke document',
        operations: ['read_document'], cloudAllowed: false, expiresAt: null } });
      imported = await request('/v1/knowledge/import', { method: 'POST', expected: 201, body: {
        projectId: conversation.id, grantId: grant.id, resourceId: grant.resourceId, filename: 'smoke.md',
        title: 'Smoke document', mediaType: 'text/markdown', bytesBase64: Buffer.from('Local smoke evidence.').toString('base64'),
      } });
      const path = `/v1/knowledge/sources/${imported.source.id}?projectId=${conversation.id}`;
      assert.equal((await request(path + '&purpose=local')).passages[0].text, 'Local smoke evidence.');
      await request(path + '&purpose=cloud', { expected: 403 });
      memory = await request('/v1/memory/entries', { method: 'POST', expected: 201, body: {
        kind: 'preference', scope: { kind: 'global' }, text: 'Prefer concise smoke check reports.',
        provenance: { origin: 'explicit_user', references: [] }, confidence: 1, pinned: true,
        expiresAt: null, cloudAllowed: false,
      } });
      const packet = await request('/v1/context/assemble', { method: 'POST', body: {
        version: 1, projectId: conversation.id, query: 'smoke', purpose: 'local', maxTokens: 12000,
      } });
      assert.ok(packet.selections.some(item => item.kind === 'source'));
      assert.ok(packet.selections.some(item => item.kind === 'memory' && item.id === memory.id));
      assert.ok(packet.usage.estimatedTokens <= packet.usage.maxTokens);
      const cloud = await request('/v1/context/assemble', { method: 'POST', body: {
        version: 1, projectId: conversation.id, query: 'smoke', purpose: 'cloud', maxTokens: 12000,
      } });
      assert.equal(cloud.selections.length, 0);
      assert.deepEqual((await request('/v1/harness/archives')).archives, []);
    }
    await request('/v1/stop', { method: 'POST' });
    await stop();
    await start();
    assert.ok((await request('/v1/state')).conversations.some(value => value.id === conversation.id));
    assert.ok((await request('/v1/harness/state')).rooms.some(value => value.id === room.id));
    if (assistantEnabled) {
      assert.ok((await request('/v1/assistant/state')).sessions.some(value => value.id === assistantSession.id));
      const path = `/v1/knowledge/sources/${imported.source.id}?projectId=${conversation.id}&purpose=local`;
      assert.equal((await request(path)).source.id, imported.source.id);
      assert.equal((await request(`/v1/memory/entries/${memory.id}`)).text, memory.text);
      await request(`/v1/memory/entries/${memory.id}/forget`, { method: 'POST', body: { expectedRevision: memory.revision } });
      assert.deepEqual((await request('/v1/memory/entries')).entries, []);
      await request(`/v1/grants/${grant.id}/revoke`, { method: 'POST', body: { expectedRevision: grant.revision } });
      await request(path, { expected: 403 });
      await request('/v1/harness/archives', { native: false, expected: 403 });
      assert.deepEqual((await request('/v1/harness/archives')).archives, []);
    }
    await request('/v1/stop', { method: 'POST' });
  } catch (error) { primaryError = error; }
  finally {
    try { await stop(); } catch (error) { primaryError ??= error; }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await rm(directory, { recursive: true, force: true });
  }
  if (primaryError) throw primaryError;
  console.log(`PASS: built Eve + bridge readiness, auth/Origin, conversation/room restart persistence and Stop${assistantEnabled
    ? '; native assistant session, RAG/context budgets, memory restart/forget, cloud refusal, revocation and archive access' : ''}. No provider inference or native actions.`);
}
