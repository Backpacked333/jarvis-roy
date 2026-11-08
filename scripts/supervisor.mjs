// Bundled service supervisor for the standalone Jarvis.app (see docs/standalone-app.md).
// It receives secrets only on stdin, never prints them, starts Eve and the bridge with
// allowlisted environments and stops them in order when the app goes away.
import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, chmodSync, closeSync, constants, existsSync, fstatSync, fchmodSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { environmentFor } from './launch-env.mjs';

export const RUNTIME_PORT = 39201;
export const BRIDGE_PORT = 39202;
export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const SECRET_KEYS = Object.freeze(['AI_GATEWAY_API_KEY', 'TAVILY_API_KEY', 'HOME_ASSISTANT_TOKEN', 'ELEVENLABS_API_KEY']);
export const CONFIG_KEYS = Object.freeze(['JARVIS_MODEL', 'JARVIS_ENABLE_DESKTOP', 'JARVIS_ENABLE_TERMINAL',
  'JARVIS_ENABLE_APPLE_SERVICES', 'HOME_ASSISTANT_URL', 'JARVIS_ALLOW_HOME_ASSISTANT_HTTP', 'ELEVENLABS_VOICE_ID',
  'JARVIS_WORKER_IMAGE', 'JARVIS_WORKER_PYTHON', 'JARVIS_DOCKER_BINARY']);
export const DOCKER_CANDIDATES = Object.freeze(['/usr/local/bin/docker', '/opt/homebrew/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker']);
export const DEFAULT_TIMEOUTS = Object.freeze({
  payloadMs: 30_000, readinessAttempts: 60, readinessIntervalMs: 500, readinessRequestMs: 1_500,
  bridgeStopMs: 45_000, runtimeStopMs: 10_000, killWaitMs: 5_000,
});
const BASE_ENV_KEYS = ['HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG'];
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** A failure whose reason is a fixed, non-sensitive sentence. */
export class SupervisorError extends Error {
  constructor(reason, exitCode = 1) {
    super(reason);
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

const invalid = (reason) => new SupervisorError(reason, 2);

/** Reduces a reason to short printable text and masks anything shaped like a credential. */
export function sanitizeReason(text) {
  const printable = String(text ?? '').replace(/[^\x20-\x7E…]/g, ' ').replace(/\s+/g, ' ').trim();
  const masked = printable.replace(/[A-Za-z0-9_\-+/=.:]{24,}/g, '[redacted]');
  return (masked.length > 200 ? `${masked.slice(0, 199)}…` : masked) || 'Local services failed.';
}

export function parseArguments(argv) {
  if (!Array.isArray(argv)) throw invalid('Supervisor arguments are invalid.');
  const flags = { '--resources': 'resources', '--data-dir': 'dataDir', '--helper': 'helper' };
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = flags[argv[index]];
    const value = argv[index + 1];
    if (!name || Object.hasOwn(result, name)) throw invalid('Supervisor arguments are invalid.');
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.isAbsolute(value)) {
      throw invalid('Supervisor paths must be absolute.');
    }
    const resolved = path.resolve(value);
    if (resolved === '/' || resolved !== value.replace(/(?<=.)\/+$/, '')) throw invalid('Supervisor paths must be absolute and normalized.');
    result[name] = resolved;
  }
  for (const name of Object.values(flags)) if (!result[name]) throw invalid('Supervisor arguments are incomplete.');
  return result;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function allowlisted(value, allowed, label) {
  if (!plainObject(value)) throw invalid(`Launch ${label} must be an object.`);
  const result = Object.create(null);
  for (const key of Object.keys(value)) {
    // Never echo an unexpected key: a misplaced credential could be in it.
    if (!allowed.includes(key)) throw invalid(`Launch ${label} contain an unsupported key.`);
    const entry = value[key];
    if (typeof entry !== 'string') throw invalid(`Launch ${label} values must be strings.`);
    if (/[\0\r\n]/.test(entry)) throw invalid(`Launch ${label} values contain a forbidden character.`);
    if (entry !== '') result[key] = entry;
  }
  return result;
}

export function parsePayload(line) {
  if (typeof line !== 'string') throw invalid('Launch payload is invalid.');
  if (Buffer.byteLength(line, 'utf8') > MAX_PAYLOAD_BYTES) throw invalid('Launch payload is too large.');
  let value;
  try { value = JSON.parse(line); } catch { throw invalid('Launch payload is not valid JSON.'); }
  if (!plainObject(value)) throw invalid('Launch payload must be an object.');
  for (const key of Object.keys(value)) {
    if (!['version', 'token', 'secrets', 'config'].includes(key)) throw invalid('Launch payload contains an unsupported key.');
  }
  if (value.version !== 1) throw invalid('Launch payload version is unsupported.');
  if (typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token)) throw invalid('Launch token is invalid.');
  const secrets = allowlisted(value.secrets, SECRET_KEYS, 'secrets');
  const config = allowlisted(value.config, CONFIG_KEYS, 'config');
  if (!secrets.AI_GATEWAY_API_KEY) throw invalid('A model credential is required.');
  return { token: value.token, secrets, config };
}

function defaultIsExecutable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Fills unset worker paths from fixed, local locations only. */
export function discoverWorkerDefaults({ config, dataDir, isExecutable = defaultIsExecutable, dockerCandidates = DOCKER_CANDIDATES }) {
  const result = Object.assign(Object.create(null), config);
  if (!result.JARVIS_WORKER_PYTHON) {
    const python = path.join(dataDir, 'workers-venv', 'bin', 'python');
    if (isExecutable(python)) result.JARVIS_WORKER_PYTHON = python;
  }
  if (!result.JARVIS_DOCKER_BINARY) {
    const docker = dockerCandidates.find((candidate) => isExecutable(candidate));
    if (docker) result.JARVIS_DOCKER_BINARY = docker;
  }
  return result;
}

/** The single path from launch inputs to a child environment: always through environmentFor(). */
export function childEnvironment({ target, baseEnv = {}, token, secrets = {}, config = {}, dataDir, helper }) {
  const source = Object.create(null);
  for (const key of BASE_ENV_KEYS) if (typeof baseEnv[key] === 'string') source[key] = baseEnv[key];
  for (const key of CONFIG_KEYS) if (typeof config[key] === 'string' && config[key] !== '') source[key] = config[key];
  for (const key of SECRET_KEYS) if (typeof secrets[key] === 'string' && secrets[key] !== '') source[key] = secrets[key];
  Object.assign(source, {
    JARVIS_LOCAL_TOKEN: token,
    JARVIS_DATA_DIR: dataDir,
    JARVIS_NATIVE_HELPER: helper,
    JARVIS_LAUNCH_MODE: 'app',
  });
  return environmentFor(target, source);
}

/** True when something accepts TCP connections on the loopback port; unknown outcomes fail closed. */
export function defaultPortInUse(port, { host = '127.0.0.1', timeoutMs = 1_000 } = {}) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (inUse) => { socket.destroy(); resolve(inUse); };
    socket.setTimeout(timeoutMs, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(error?.code !== 'ECONNREFUSED'));
  });
}

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory()) throw new SupervisorError('The Jarvis data folder is not a directory.');
  chmodSync(directory, 0o700);
}

/** Resolves symlinks in the longest existing prefix of an absolute path (the rest may not exist yet). */
function realpathOfExisting(target) {
  let existing = target;
  const rest = [];
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  try { return path.join(realpathSync(existing), ...rest); } catch { return target; }
}

const isWithin = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** Nothing may ever be written inside the app bundle: the data dir must lie outside Resources. */
function requireDataOutsideResources(dataDir, resources) {
  const data = [dataDir, realpathOfExisting(dataDir)];
  const bundle = [resources, realpathOfExisting(resources)];
  if (data.some((d) => bundle.some((r) => isWithin(d, r) || isWithin(r, d)))) {
    throw invalid('The Jarvis data folder must be outside the app bundle.');
  }
}

function requireFile(file, reason, executable = false) {
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
    if (executable) accessSync(file, constants.X_OK);
  } catch {
    throw invalid(reason);
  }
}

function openLog(file) {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(file, flags, 0o600);
    if (!fstatSync(fd).isFile()) throw new Error('not a file');
    fchmodSync(fd, 0o600);
    return fd;
  } catch {
    if (fd !== undefined) closeSync(fd);
    throw new SupervisorError('Unable to open the local service logs.');
  }
}

/** Reads one newline-terminated line of at most MAX_PAYLOAD_BYTES; the stream stays open afterwards. */
function readPayloadLine(stdin, timers, timeoutMs, registerCancel = () => {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const done = (error, line) => {
      timers.clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onEnd);
      stdin.off('close', onEnd);
      registerCancel(() => {});
      if (error) reject(error); else resolve(line);
    };
    const onData = (chunk) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      const newline = buffer.indexOf(0x0a);
      const usable = newline === -1 ? buffer : buffer.subarray(0, newline);
      size += usable.length;
      if (size > MAX_PAYLOAD_BYTES) { chunks.length = 0; done(invalid('Launch payload is too large.')); return; }
      chunks.push(usable);
      if (newline !== -1) {
        const line = Buffer.concat(chunks).toString('utf8');
        chunks.length = 0;
        done(null, line);
      }
    };
    const onEnd = () => done(invalid('Launch payload was not received.'));
    const timer = timers.setTimeout(() => done(invalid('Launch payload was not received in time.')), timeoutMs);
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onEnd);
    stdin.once('close', onEnd);
    // A stop request (SIGTERM/SIGINT) while waiting resolves with null instead of waiting out the timeout.
    registerCancel(() => done(null, null));
  });
}

export async function runSupervisor(options = {}) {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    spawn = nodeSpawn,
    fetch = globalThis.fetch,
    portInUse = defaultPortInUse,
    isExecutable = defaultIsExecutable,
    dockerCandidates = DOCKER_CANDIDATES,
    nodePath = process.execPath,
    signals = process,
    timers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout },
  } = options;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };

  let finished = false;
  let failed = false;
  const emit = (event) => {
    if (finished) return;
    try { stdout.write(`${JSON.stringify(event)}\n`); } catch { /* the app is gone; shutdown follows from stdin */ }
  };
  const fail = (reason) => {
    if (failed) return;
    failed = true;
    emit({ event: 'failed', reason: sanitizeReason(reason) });
  };
  const onStdoutError = () => { void requestShutdown(); };
  stdout.on?.('error', onStdoutError);

  const children = [];
  let shuttingDown = false;
  let shutdownPromise = null;
  let stopRequested = false;
  let wakeStartup = () => {};
  let cancelPayload = () => {};
  let shutdownStarted;
  const shutdownBegan = new Promise((resolve) => { shutdownStarted = resolve; });

  const exitedWithin = (child, ms) => new Promise((resolve) => {
    if (child.exit) { resolve(true); return; }
    const timer = timers.setTimeout(() => { child.waiters.delete(onExit); resolve(false); }, ms);
    const onExit = () => { timers.clearTimeout(timer); resolve(true); };
    child.waiters.add(onExit);
  });

  const stopChild = async (child, graceMs) => {
    if (!child) return true;
    let clean = true;
    if (!child.exit) {
      child.termSent = true;
      try { child.process.kill('SIGTERM'); } catch { /* already gone */ }
      if (!(await exitedWithin(child, graceMs))) {
        clean = false;
        try { child.process.kill('SIGKILL'); } catch { /* already gone */ }
        await exitedWithin(child, timeouts.killWaitMs);
      }
    }
    const exit = child.exit;
    if (!exit) return false;
    const terminatedAsAsked = exit.code === null && exit.signal === 'SIGTERM' && child.termSent;
    return clean && (exit.code === 0 || terminatedAsAsked);
  };

  function requestShutdown() {
    stopRequested = true;
    wakeStartup();
    if (shutdownPromise) return shutdownPromise;
    if (!shuttingDown && children.length === 0) return Promise.resolve();
    shuttingDown = true;
    shutdownPromise = (async () => {
      emit({ event: 'stopping' });
      // The bridge reaps room workers through Eve, so Eve stays up until the bridge is gone.
      const bridgeClean = await stopChild(children.find((child) => child.name === 'bridge'), timeouts.bridgeStopMs);
      const runtimeClean = await stopChild(children.find((child) => child.name === 'runtime'), timeouts.runtimeStopMs);
      const clean = bridgeClean && runtimeClean;
      emit({ event: 'stopped', clean });
      return clean;
    })();
    shutdownStarted(shutdownPromise);
    return shutdownPromise;
  }

  // A signal before the payload arrived stops cleanly at once; a closed stdin instead fails the launch.
  const onSignal = () => { cancelPayload(); void requestShutdown(); };
  const onLifelineEnd = () => { void requestShutdown(); };
  const discard = () => {};
  const cleanup = () => {
    for (const signal of ['SIGTERM', 'SIGINT']) signals.off?.(signal, onSignal);
    stdin.off?.('data', discard);
    stdin.off?.('end', onLifelineEnd);
    stdin.off?.('close', onLifelineEnd);
    stdin.off?.('error', onLifelineEnd);
    stdout.off?.('error', onStdoutError);
    // A late EPIPE after the last event must not become an uncaught exception.
    stdout.on?.('error', discard);
    try { stdin.pause?.(); stdin.destroy?.(); } catch { /* ignore */ }
  };
  const finish = (code) => { finished = true; cleanup(); return code; };

  for (const signal of ['SIGTERM', 'SIGINT']) signals.on?.(signal, onSignal);
  // stdin is the lifeline from the first byte: its end or failure means the app is gone.
  stdin.once('end', onLifelineEnd);
  stdin.once('close', onLifelineEnd);
  stdin.once('error', onLifelineEnd);
  emit({ event: 'starting' });

  let launch;
  let paths;
  try {
    paths = parseArguments(argv);
    requireFile(path.join(paths.resources, 'runtime', '.output', 'server', 'index.mjs'), 'The bundled runtime is missing.');
    requireFile(path.join(paths.resources, 'runtime', 'bridge', 'server.ts'), 'The bundled bridge is missing.');
    requireFile(paths.helper, 'The native helper is missing or not executable.', true);
    requireDataOutsideResources(paths.dataDir, paths.resources);
    const line = await readPayloadLine(stdin, timers, timeouts.payloadMs, (cancel) => { cancelPayload = cancel; });
    if (line === null) {
      emit({ event: 'stopping' });
      emit({ event: 'stopped', clean: true });
      return finish(0);
    }
    launch = parsePayload(line);
  } catch (error) {
    fail(error instanceof SupervisorError ? error.reason : 'Supervisor input is invalid.');
    return finish(error instanceof SupervisorError ? error.exitCode : 2);
  }

  // From here further input is ignored; only the end of the stream matters.
  stdin.on('data', discard);
  stdin.resume?.();

  let environments;
  try {
    const logs = path.join(paths.dataDir, 'logs');
    const state = path.join(paths.dataDir, 'runtime-state');
    for (const directory of [paths.dataDir, logs, state]) ensurePrivateDirectory(directory);
    for (const port of [RUNTIME_PORT, BRIDGE_PORT]) {
      if (await portInUse(port)) throw new SupervisorError('Another Jarvis instance appears to be running. Quit it, then try again.');
    }
    const config = discoverWorkerDefaults({ config: launch.config, dataDir: paths.dataDir, isExecutable, dockerCandidates });
    const shared = { baseEnv: env, token: launch.token, secrets: launch.secrets, config, dataDir: paths.dataDir, helper: paths.helper };
    environments = { runtime: childEnvironment({ ...shared, target: 'runtime' }), bridge: childEnvironment({ ...shared, target: 'bridge' }) };
    environments.logs = logs;
    environments.state = state;
  } catch (error) {
    fail(error instanceof SupervisorError ? error.reason : 'Unable to prepare local services.');
    return finish(1);
  }
  const token = launch.token;
  launch = null; // Secrets now live only in the child environments.

  if (stopRequested) {
    emit({ event: 'stopping' });
    emit({ event: 'stopped', clean: true });
    return finish(0);
  }

  const runtimeDir = path.join(paths.resources, 'runtime');
  const specs = [
    { name: 'runtime', args: [path.join(runtimeDir, '.output', 'server', 'index.mjs')], cwd: environments.state, env: environments.runtime, log: 'runtime.log' },
    { name: 'bridge', args: ['bridge/server.ts'], cwd: runtimeDir, env: environments.bridge, log: 'bridge.log' },
  ];
  environments = null;
  try {
    for (const spec of specs) {
      const fd = openLog(path.join(paths.dataDir, 'logs', spec.log));
      let child;
      try {
        child = { name: spec.name, exit: null, termSent: false, waiters: new Set(), process: null };
        child.process = spawn(nodePath, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', fd, fd], shell: false });
      } finally {
        closeSync(fd);
      }
      const settle = (code, signal) => {
        if (child.exit) return;
        child.exit = { code: code ?? null, signal: signal ?? null };
        for (const waiter of child.waiters) waiter();
        child.waiters.clear();
        if (!shuttingDown) {
          fail(child.name === 'runtime' ? 'The local runtime stopped unexpectedly. Inspect runtime.log in the Jarvis logs folder.'
            : 'The local bridge stopped unexpectedly. Inspect bridge.log in the Jarvis logs folder.');
          void requestShutdown();
        }
      };
      child.process.once('exit', settle);
      // 'error' may fire more than once (e.g. a failed kill) and must never be unhandled. It means
      // the child is gone only when it never started; otherwise its 'exit' event follows.
      child.process.on('error', () => { if (child.process.pid === undefined) settle(null, null); });
      children.push(child);
      spec.env = null;
    }
  } catch (error) {
    fail(error instanceof SupervisorError ? error.reason : 'Unable to start local services.');
    await requestShutdown();
    return finish(1);
  }

  let ready = false;
  for (let attempt = 0; attempt < timeouts.readinessAttempts && !stopRequested && !shuttingDown; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/state`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeouts.readinessRequestMs),
        redirect: 'error',
      });
      if (response.ok && (await response.json())?.ready === true) { ready = true; break; }
    } catch { /* not yet listening */ }
    if (stopRequested || shuttingDown) break;
    await new Promise((resolve) => {
      wakeStartup = resolve;
      timers.setTimeout(resolve, timeouts.readinessIntervalMs);
    });
    wakeStartup = () => {};
  }
  if (ready && !stopRequested && !shuttingDown) emit({ event: 'ready' });
  else if (!stopRequested && !shuttingDown) {
    fail('Local services did not become ready. Inspect runtime.log and bridge.log in the Jarvis logs folder.');
    void requestShutdown();
  }

  if (stopRequested) void requestShutdown();
  // Shutdown is always started by a signal, the lifeline or a child exit.
  const clean = await shutdownBegan;
  return finish(clean && !failed ? 0 : 1);
}

function isMainModule() {
  // Node reports the entry's real path in import.meta.url; argv[1] may go through a symlink
  // (for example /var -> /private/var on macOS), so compare real paths.
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMainModule()) {
  if (Number(process.versions.node.split('.')[0]) !== 24) {
    process.stdout.write(`${JSON.stringify({ event: 'failed', reason: 'The bundled Node.js 24 runtime is required.' })}\n`);
    process.exit(1);
  }
  runSupervisor().then((code) => {
    process.exitCode = code;
    // Exit even if a stray handle lingers; stdout to a pipe is flushed by then.
    setTimeout(() => process.exit(code), 2_000).unref();
  }, () => {
    process.stdout.write(`${JSON.stringify({ event: 'failed', reason: 'Supervisor failed unexpectedly.' })}\n`);
    process.exitCode = 1;
  });
}
