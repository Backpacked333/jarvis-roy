// Headless smoke test of a built Jarvis.app (or a staged fake app directory on Linux):
// runs the bundled node + supervisor with a dummy model key and a temporary data dir,
// waits for `ready`, checks that /v1/state accepts the token and rejects requests
// without it, closes stdin (the app's lifeline), and asserts a clean `stopped` event,
// exit 0 and released ports. Neither the token nor the dummy key may appear on the
// supervisor's stdout/stderr or in the service logs.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, constants, mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const DUMMY_KEY = 'smoke-test-not-a-real-key';
export const PORTS = Object.freeze([39201, 39202]);
const STATE_URL = 'http://127.0.0.1:39202/v1/state';

export function bundlePaths(app) {
  const root = resolve(app);
  const resources = join(root, 'Contents', 'Resources');
  return {
    app: root,
    resources,
    node: join(resources, 'node', 'bin', 'node'),
    supervisor: join(resources, 'launcher', 'supervisor.mjs'),
    helper: join(root, 'Contents', 'Helpers', 'JarvisControl.app', 'Contents', 'MacOS', 'JarvisControl'),
  };
}

/** The single stdin line the supervisor expects (docs/standalone-app.md). */
export function smokePayload(token) {
  return `${JSON.stringify({ version: 1, token, secrets: { AI_GATEWAY_API_KEY: DUMMY_KEY }, config: { JARVIS_MODEL: 'openai/gpt-4.1-mini' } })}\n`;
}

export function minimalEnvironment({ home, temp }) {
  let user = 'jarvis';
  try { user = userInfo().username; } catch {}
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: temp, USER: user, LOGNAME: user, LANG: 'en_US.UTF-8' };
}

/** Returns the secret-like needles contained in `text` (empty when clean). */
export function leakedSecrets(text, needles) {
  return needles.filter((needle) => needle && text.includes(needle));
}

export function redact(text, needles) {
  let result = text;
  for (const needle of needles) if (needle) result = result.split(needle).join('[REDACTED]');
  return result;
}

export function parseEvent(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' && typeof value.event === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function portAcceptingConnections(port, host = '127.0.0.1') {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host });
    const finish = (value) => { socket.destroy(); resolvePromise(value); };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function stateStatus(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(STATE_URL, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
  let body;
  try { body = await response.json(); } catch {}
  return { status: response.status, body };
}

async function logTails(dataDir, needles) {
  const lines = [];
  try {
    for (const name of await readdir(join(dataDir, 'logs'))) {
      const text = redact(await readFile(join(dataDir, 'logs', name), 'utf8'), needles);
      lines.push(`--- ${name} (last 40 lines) ---`, ...text.trimEnd().split('\n').slice(-40));
    }
  } catch {}
  return lines.join('\n');
}

/**
 * Runs the smoke test. Resolves to { ok, steps, failure? }; never throws for test
 * failures. `readyTimeoutMs` bounds the wait for `ready`, `stopTimeoutMs` the shutdown.
 */
export async function runSmoke({ app, readyTimeoutMs = 90_000, stopTimeoutMs = 70_000, log = () => {} }) {
  const paths = bundlePaths(app);
  const token = randomBytes(32).toString('hex');
  const needles = [token, DUMMY_KEY];
  const steps = [];
  const step = (text) => { steps.push(text); log(`ok - ${text}`); };
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'jarvis-smoke-')));
  const dataDir = join(scratch, 'data');
  const home = join(scratch, 'home');
  let child;
  let exit;
  const events = [];
  const output = { stdout: '', stderr: '' };
  const waiters = new Set();
  const notify = () => { for (const waiter of waiters) waiter(); };
  const waitFor = (predicate, timeoutMs, description) => new Promise((resolvePromise, reject) => {
    const check = () => {
      const result = predicate();
      if (result) { cleanup(); resolvePromise(result); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${description}.`)); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); waiters.delete(check); };
    waiters.add(check);
    check();
  });

  try {
    for (const [name, path] of Object.entries({ node: paths.node, supervisor: paths.supervisor, helper: paths.helper })) {
      try { await access(path, name === 'supervisor' ? constants.R_OK : constants.X_OK); } catch { throw new Error(`Bundle is missing ${name} at ${path}.`); }
    }
    for (const port of PORTS) {
      if (await portAcceptingConnections(port)) throw new Error(`Port ${port} is already in use; stop the other Jarvis instance first.`);
    }
    await mkdir(home, { mode: 0o700 });

    child = spawn(paths.node, [paths.supervisor, '--resources', paths.resources, '--data-dir', dataDir, '--helper', paths.helper], {
      cwd: scratch, env: minimalEnvironment({ home, temp: scratch }), stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output.stdout += chunk;
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        const event = parseEvent(line);
        if (event) { events.push(event); log(`event: ${redact(JSON.stringify(event), needles)}`); }
        else if (line.trim()) events.push({ event: '<invalid>', line });
      }
      notify();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    child.on('exit', (code, signal) => { exit = { code, signal }; notify(); });
    child.on('error', (error) => { exit = { code: null, signal: null, error }; notify(); });
    child.stdin.on('error', () => {});
    child.stdin.write(smokePayload(token));

    const outcome = await waitFor(() => events.find((event) => event.event === 'ready' || event.event === 'failed') ?? (exit && { event: 'exited' }),
      readyTimeoutMs, 'the ready event');
    if (outcome.event !== 'ready') {
      throw new Error(outcome.event === 'failed' ? `Supervisor reported failed: ${outcome.reason ?? '(no reason)'}` : 'Supervisor exited before ready.');
    }
    if (events[0]?.event !== 'starting') throw new Error('First event was not "starting".');
    step('supervisor emitted starting then ready');

    const authorized = await stateStatus(token);
    if (authorized.status !== 200 || authorized.body?.ready !== true) throw new Error(`/v1/state with token returned ${authorized.status} (ready=${authorized.body?.ready}).`);
    step('/v1/state with token is 200 and ready');
    const anonymous = await stateStatus(undefined);
    if (anonymous.status !== 401) throw new Error(`/v1/state without token returned ${anonymous.status}, expected 401.`);
    step('/v1/state without token is 401');
    const wrong = await stateStatus(randomBytes(32).toString('hex'));
    if (wrong.status !== 401) throw new Error(`/v1/state with a wrong token returned ${wrong.status}, expected 401.`);
    step('/v1/state with a wrong token is 401');

    child.stdin.end();
    const stopped = await waitFor(() => events.find((event) => event.event === 'stopped'), stopTimeoutMs, 'the stopped event');
    await waitFor(() => exit, 15_000, 'supervisor exit');
    if (stopped.clean !== true) throw new Error('Supervisor reported stopped with clean:false.');
    if (!events.some((event) => event.event === 'stopping')) throw new Error('Supervisor never emitted "stopping".');
    if (exit.code !== 0) throw new Error(`Supervisor exited with ${exit.code ?? exit.signal}.`);
    step('closing stdin stopped cleanly with exit 0');

    for (const port of PORTS) {
      let open = true;
      for (let attempt = 0; attempt < 20 && open; attempt++) {
        open = await portAcceptingConnections(port);
        if (open) await delay(250);
      }
      if (open) throw new Error(`Port ${port} is still accepting connections after shutdown.`);
    }
    step(`ports ${PORTS.join(' and ')} released`);

    const invalid = events.find((event) => event.event === '<invalid>');
    if (invalid) throw new Error('Supervisor wrote a non-JSON stdout line.');
    const leaks = [...leakedSecrets(output.stdout, needles), ...leakedSecrets(output.stderr, needles)];
    let logText = '';
    try { for (const name of await readdir(join(dataDir, 'logs'))) logText += await readFile(join(dataDir, 'logs', name), 'utf8'); } catch {}
    leaks.push(...leakedSecrets(logText, needles));
    if (leaks.length) throw new Error(`The ${leaks.includes(token) ? 'local token' : 'dummy key'} appeared in supervisor output or logs.`);
    step('no token or key in supervisor output or logs');
    return { ok: true, steps };
  } catch (error) {
    const failure = redact(error instanceof Error ? error.message : String(error), needles);
    const details = await logTails(dataDir, needles);
    const stderr = redact(output.stderr, needles);
    return { ok: false, steps, failure, details: [stderr.trim() && `--- supervisor stderr ---\n${stderr.trim()}`, details].filter(Boolean).join('\n') };
  } finally {
    if (child && !exit) {
      child.stdin.destroy();
      child.kill('SIGTERM');
      const deadline = Date.now() + 60_000;
      while (!exit && Date.now() < deadline) await delay(200);
      if (!exit) child.kill('SIGKILL');
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = process.argv[2];
  if (!app || process.argv.length !== 3) {
    console.error('Usage: node scripts/smoke-bundle.mjs <path/to/Jarvis.app>');
    process.exit(2);
  }
  const result = await runSmoke({ app, log: (line) => console.log(line) });
  if (result.ok) {
    console.log(`Smoke test passed (${result.steps.length} checks).`);
  } else {
    console.error(`Smoke test FAILED: ${result.failure}`);
    if (result.details) console.error(result.details);
    process.exitCode = 1;
  }
}
