#!/usr/bin/env node
// Preflight for a source checkout: says exactly what is missing before Jarvis
// can start and reason. Read-only apart from one probe file in the data
// directory. Never prints a credential, and makes no paid provider call.
import { execFile } from 'node:child_process';
import { access, constants, mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = join(ROOT, 'runtime');
const DEFAULT_MODEL = 'openai/gpt-6-sol-fast';
const GATEWAY = 'https://ai-gateway.vercel.sh';
const KEYCHAIN_SERVICE = 'ai.backpacked.jarvisroy.providers';

export const STATUS = { ok: 'ok', warn: 'warn', fail: 'fail', skip: 'skip' };

function run(command, args, timeout = 5_000) {
  return new Promise(resolvePromise => {
    execFile(command, args, { timeout, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' } },
      (error, stdout) => resolvePromise({ ok: !error, stdout: String(stdout).trim() }));
  });
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

export function dataDirectory(env = process.env, platform = process.platform) {
  const configured = env.JARVIS_DATA_DIR;
  if (configured) {
    if (configured === '~') return homedir();
    return configured.startsWith('~/') ? resolve(homedir(), configured.slice(2)) : resolve(configured);
  }
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'JarvisRoy');
  const xdg = env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'share'), 'jarvis-roy');
}

function portFree(port) {
  return new Promise(resolvePromise => {
    const probe = createServer();
    probe.once('error', () => resolvePromise(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePromise(true)));
  });
}

/** Presence only. `security` without -w returns attributes, never the secret. */
async function keychainHas(account) {
  if (process.platform !== 'darwin') return false;
  return (await run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account])).ok;
}

async function credential(name) {
  if ((process.env[name] ?? '').trim()) return 'environment';
  return await keychainHas(name) ? 'Keychain' : null;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function describeModel(catalog, model) {
  const entries = Array.isArray(catalog?.data) ? catalog.data : [];
  const entry = entries.find(value => value?.id === model && value?.type === 'language');
  if (!entry) return null;
  const perMillion = value => Number.isFinite(Number(value)) ? `$${(Number(value) * 1e6).toFixed(2)}` : 'unknown';
  return { contextWindow: entry.context_window ?? null,
    input: perMillion(entry.pricing?.input), output: perMillion(entry.pricing?.output) };
}

export async function diagnose({ offline = false, env = process.env } = {}) {
  const checks = [];
  const add = (id, status, title, detail, fix) => checks.push({ id, status, title, detail, ...(fix ? { fix } : {}) });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major === 24 ? STATUS.ok : STATUS.fail, 'Node.js 24', `Running ${process.version} from ${process.execPath}.`,
    major === 24 ? undefined : 'Install Node.js 24 LTS (https://nodejs.org/en/download) and run this again with it.');

  const installed = await exists(join(RUNTIME, 'node_modules/eve/package.json'));
  add('dependencies', installed ? STATUS.ok : STATUS.fail, 'Runtime dependencies',
    installed ? 'runtime/node_modules is installed.' : 'runtime/node_modules is missing.',
    installed ? undefined : 'cd runtime && npm ci');

  const built = await exists(join(RUNTIME, '.output/server/index.mjs'));
  add('build', built ? STATUS.ok : STATUS.fail, 'Built agent runtime',
    built ? 'runtime/.output/server/index.mjs is present.' : 'The Eve agent has not been built.',
    built ? undefined : 'cd runtime && npm run build');

  for (const [port, role] of [[39201, 'agent runtime'], [39202, 'bridge']]) {
    const free = await portFree(port);
    add(`port-${port}`, free ? STATUS.ok : STATUS.warn, `Port ${port} (${role})`,
      free ? 'Free on 127.0.0.1.' : 'Already in use. This is expected only while Jarvis is running.',
      free ? undefined : 'Quit any running Jarvis (or the developer launcher) before starting another.');
  }

  const data = dataDirectory(env);
  let dataStatus = STATUS.ok, dataDetail = `${data} is writable.`, dataFix;
  try {
    let existing = data;
    while (!await exists(existing) && dirname(existing) !== existing) existing = dirname(existing);
    if (!(await stat(existing)).isDirectory()) throw new Error('not a directory');
    if (existing === data) await rm(await mkdtemp(join(data, '.doctor-')), { recursive: true });
    else { await access(existing, constants.W_OK); dataDetail = `${data} will be created on first start.`; }
  } catch {
    dataStatus = STATUS.fail; dataDetail = `${data} cannot be written.`;
    dataFix = 'Fix its permissions, or point JARVIS_DATA_DIR at a private directory you own.';
  }
  add('data', dataStatus, 'Private data directory', dataDetail, dataFix);

  const gateway = await credential('AI_GATEWAY_API_KEY');
  add('gateway-key', gateway ? STATUS.ok : STATUS.fail, 'Vercel AI Gateway key',
    gateway ? `Present in the ${gateway}. Its value is never shown.` : 'No reasoning credential was found.',
    gateway ? undefined : (process.platform === 'darwin'
      ? 'Open Jarvis → Settings → Provider credentials and save a Vercel AI Gateway key (https://vercel.com/ai-gateway).'
      : 'Export AI_GATEWAY_API_KEY for the developer launcher (https://vercel.com/ai-gateway).'));

  const model = (env.JARVIS_MODEL ?? '').trim() || DEFAULT_MODEL;
  if (offline) {
    add('model', STATUS.skip, `Model ${model}`, 'Skipped: --offline.');
  } else {
    try {
      const described = describeModel(await fetchJson(`${GATEWAY}/v1/models`), model);
      add('model', described ? STATUS.ok : STATUS.fail, `Model ${model}`,
        described ? `Listed by the gateway: ${described.contextWindow ?? 'unknown'}-token window, ${described.input} input and ${described.output} output per million tokens.`
          : 'The gateway does not list this as a language model.',
        described ? undefined : 'Correct JARVIS_MODEL, or the interactive model in Settings → Provider preferences.');
    } catch (error) {
      add('model', STATUS.warn, `Model ${model}`, `The gateway model list could not be read (${error.message}).`,
        'Check your network connection. Jarvis needs ai-gateway.vercel.sh to reason.');
    }
    const key = (env.AI_GATEWAY_API_KEY ?? '').trim();
    if (key) {
      try {
        const credits = await fetchJson(`${GATEWAY}/v1/credits`, { authorization: `Bearer ${key}` });
        const balance = Number(credits?.balance);
        add('credits', Number.isFinite(balance) && balance <= 0 ? STATUS.fail : STATUS.ok, 'Gateway credits',
          Number.isFinite(balance) ? `The gateway accepted the key. Balance: $${balance.toFixed(2)}.` : 'The gateway accepted the key.',
          Number.isFinite(balance) && balance <= 0 ? 'Add credits in the Vercel AI Gateway dashboard.' : undefined);
      } catch (error) {
        add('credits', STATUS.fail, 'Gateway credits', `The gateway did not accept the key (${error.message}).`,
          'Create a new key at https://vercel.com/ai-gateway and save it again.');
      }
    }
  }

  for (const [name, title, purpose] of [['ELEVENLABS_API_KEY', 'ElevenLabs key', 'voice'], ['TAVILY_API_KEY', 'Tavily key', 'live web research']]) {
    const source = await credential(name);
    add(name.toLowerCase(), source ? STATUS.ok : STATUS.skip, `${title} (optional)`,
      source ? `Present in the ${source}.` : `Not set; ${purpose} stays off.`);
  }

  if (process.platform === 'darwin') {
    const tools = await run('/usr/bin/xcode-select', ['-p']);
    add('xcode', tools.ok ? STATUS.ok : STATUS.fail, 'Xcode Command Line Tools', tools.ok ? tools.stdout : 'Not installed.',
      tools.ok ? undefined : 'xcode-select --install');
    const app = await exists(join(ROOT, 'dist/Jarvis.app/Contents/MacOS/Jarvis'));
    add('app', app ? STATUS.ok : STATUS.warn, 'Built Jarvis.app', app ? 'dist/Jarvis.app is present.' : 'dist/Jarvis.app has not been built.',
      app ? undefined : './scripts/setup-macos.sh');
  } else {
    add('app', STATUS.skip, 'Native Mac app', 'Not on macOS: only the runtime can run here.');
  }

  return { ready: !checks.some(check => check.status === STATUS.fail), checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some(value => !['--offline', '--json'].includes(value))) {
    console.error('Usage: node scripts/doctor.mjs [--offline] [--json]');
    process.exit(2);
  }
  const report = await diagnose({ offline: args.includes('--offline') });
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const mark = { ok: '✓', warn: '!', fail: '✗', skip: '–' };
    for (const check of report.checks) {
      console.log(`${mark[check.status]} ${check.title}: ${check.detail}`);
      if (check.fix) console.log(`    → ${check.fix}`);
    }
    console.log(report.ready ? '\nReady: nothing blocks Jarvis from starting.' : '\nNot ready: fix the ✗ items above, then run this again.');
  }
  process.exitCode = report.ready ? 0 : 1;
}
