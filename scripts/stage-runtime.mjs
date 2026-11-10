// Stages what Jarvis.app needs to run without a checkout or a system Node into
// <Jarvis.app>/Contents/Resources:  node/bin/node, node/LICENSE and runtime/**.
// Production dependencies are installed fresh (`npm ci --omit=dev --ignore-scripts`)
// from a staging copy of package.json and package-lock.json; the checkout's own
// node_modules (with dev dependencies) is never copied. Symlinks that leave their
// tree are refused. Nothing secret (.env*, .eve, virtualenvs) is ever copied.
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Entries of Resources/ that this script owns and replaces on every run. */
export const OWNED_ENTRIES = Object.freeze(['node', 'runtime']);
export const MANIFEST_FILES = Object.freeze(['package.json', 'package-lock.json']);
export const RUNTIME_FILES = Object.freeze([...MANIFEST_FILES, 'service-guard.mjs']);
export const RUNTIME_TREES = Object.freeze(['.output', 'bridge', 'agent']);
export const WORKER_FILES = Object.freeze(['controller.py', 'sandbox_ops.py', 'requirements.txt']);
/**
 * Removed from the production node_modules: build-only native packages, and the
 * on-device embedding stack that the bridge only loads on Linux (macOS uses the
 * native helper for embeddings), which would otherwise add hundreds of megabytes.
 */
export const PRUNED_PACKAGES = Object.freeze(['rolldown', '@rolldown', '@oxc-project',
  '@huggingface', 'onnxruntime-node', 'onnxruntime-web', 'onnxruntime-common', 'sharp', '@img']);
const STAGING_PREFIX = '.jarvis-stage-';

/** Names never copied from source trees, at any depth. */
export function isExcludedName(name) {
  return name.startsWith('.env') || name === '.eve' || name === '.venv' || name === '.DS_Store'
    || name === 'node_modules' || name === '__pycache__';
}

export function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Recursively copies `source` to `destination`. Regular files keep their executable
 * bit (group/other write is stripped). A symlink is recreated (relative) only when its
 * resolved target stays inside `root`; otherwise the copy fails.
 */
export async function copyTree(source, destination, { root = source, exclude = isExcludedName } = {}) {
  const realRoot = await realpath(root);
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    let target;
    try { target = await realpath(source); } catch { throw new Error(`Refusing dangling symlink ${source}.`); }
    if (!isInside(realRoot, target)) throw new Error(`Refusing symlink ${source} that escapes ${root}.`);
    const linkTarget = await readlink(source);
    const resolvedLink = resolve(dirname(source), linkTarget);
    if (!isInside(resolve(root), resolvedLink) && !isInside(realRoot, resolvedLink)) {
      throw new Error(`Refusing symlink ${source} that escapes ${root}.`);
    }
    await symlink(isAbsolute(linkTarget) ? relative(dirname(source), linkTarget) : linkTarget, destination);
    return;
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o755 });
    for (const entry of await readdir(source)) {
      if (exclude(entry)) continue;
      await copyTree(join(source, entry), join(destination, entry), { root, exclude });
    }
    await chmod(destination, 0o755);
    return;
  }
  if (!info.isFile()) throw new Error(`Refusing special file ${source}.`);
  await copyFile(source, destination);
  await chmod(destination, info.mode & 0o111 ? 0o755 : 0o644);
}

/** Removes every PRUNED_PACKAGES entry and every .bin directory from any node_modules depth. */
export async function prunePackages(nodeModules) {
  const removed = [];
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (PRUNED_PACKAGES.includes(entry.name) || entry.name === '.bin') {
        await rm(path, { recursive: true, force: true });
        removed.push(relative(nodeModules, path));
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('@')) await walk(path);
      else await walk(join(path, 'node_modules'));
    }
  }
  await walk(nodeModules);
  return removed;
}

/** Fails if any symlink under `root` is dangling or resolves outside `root`. */
export async function assertContained(root) {
  const realRoot = await realpath(root);
  async function walk(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      let target;
      try { target = await realpath(path); } catch { throw new Error(`Staged tree contains a dangling symlink ${path}.`); }
      if (!isInside(realRoot, target)) throw new Error(`Staged tree contains symlink ${path} escaping the bundle.`);
      return;
    }
    if (info.isDirectory()) for (const entry of await readdir(path)) await walk(join(path, entry));
  }
  await walk(root);
}

function defaultInstall(directory) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: directory, shell: false, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  if (result.error || result.status !== 0) throw new Error(`npm ci --omit=dev failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}.`);
}

async function requireFile(path, description) {
  let info;
  try { info = await lstat(path); } catch { throw new Error(`Missing ${description}: ${path}.`); }
  if (!info.isFile()) throw new Error(`${description} must be a regular file: ${path}.`);
}

/**
 * Stages the payload. `install(dir)` runs the production install (injectable for tests).
 * Returns the staged paths.
 */
export async function stageRuntime({ runtime, out, node, install = defaultInstall, log = () => {} }) {
  for (const [name, value] of Object.entries({ runtime, out, node })) {
    if (typeof value !== 'string' || value === '') throw new Error(`--${name} is required.`);
  }
  const runtimeDir = await realpath(resolve(runtime));
  const outDir = resolve(out);

  await requireFile(join(runtimeDir, '.output', 'server', 'index.mjs'), 'built runtime (run `npm --prefix runtime run build`)');
  for (const file of RUNTIME_FILES) await requireFile(join(runtimeDir, file), `runtime ${file}`);
  for (const file of WORKER_FILES) await requireFile(join(runtimeDir, 'workers', file), `worker ${file}`);
  const nodeBinary = await realpath(resolve(node));
  if (!(await stat(nodeBinary)).isFile()) throw new Error(`Node binary is not a file: ${nodeBinary}.`);
  const license = join(dirname(dirname(nodeBinary)), 'LICENSE');
  await requireFile(license, 'Node LICENSE next to the node binary');

  await mkdir(outDir, { recursive: true, mode: 0o755 });
  // A previous run that was killed mid-way leaves its staging directory inside
  // Resources, where it would be sealed into the signed bundle; remove it first.
  for (const entry of await readdir(outDir)) {
    if (entry.startsWith(STAGING_PREFIX)) await rm(join(outDir, entry), { recursive: true, force: true });
  }
  const staging = await mkdtemp(join(outDir, STAGING_PREFIX));
  const installDir = await mkdtemp(join(tmpdir(), 'jarvis-prod-deps-'));
  try {
    // node/
    await mkdir(join(staging, 'node', 'bin'), { recursive: true, mode: 0o755 });
    await copyFile(nodeBinary, join(staging, 'node', 'bin', 'node'));
    await chmod(join(staging, 'node', 'bin', 'node'), 0o755);
    await copyFile(license, join(staging, 'node', 'LICENSE'));
    await chmod(join(staging, 'node', 'LICENSE'), 0o644);

    // runtime/ sources (checked for escaping symlinks before any install work)
    const stagedRuntime = join(staging, 'runtime');
    await mkdir(join(stagedRuntime, 'workers'), { recursive: true, mode: 0o755 });
    for (const file of RUNTIME_FILES) await copyTree(join(runtimeDir, file), join(stagedRuntime, file), { root: runtimeDir });
    for (const tree of RUNTIME_TREES) {
      // The built output may legitimately bundle its own node_modules; source trees never do.
      const exclude = tree === '.output' ? (name) => name !== 'node_modules' && isExcludedName(name) : isExcludedName;
      await copyTree(join(runtimeDir, tree), join(stagedRuntime, tree), { root: runtimeDir, exclude });
    }
    for (const file of WORKER_FILES) await copyTree(join(runtimeDir, 'workers', file), join(stagedRuntime, 'workers', file), { root: runtimeDir });

    // runtime/node_modules: fresh production install, then prune build-only natives.
    for (const file of MANIFEST_FILES) await copyFile(join(runtimeDir, file), join(installDir, file));
    log('Installing production dependencies (npm ci --omit=dev --ignore-scripts)…');
    await install(installDir);
    const installed = join(installDir, 'node_modules');
    const removed = await prunePackages(installed);
    log(`Pruned ${removed.length ? removed.join(', ') : 'nothing'}.`);
    await copyTree(installed, join(stagedRuntime, 'node_modules'), { root: installed, exclude: (name) => name.startsWith('.env') || name === '.DS_Store' });

    await assertContained(staging);

    for (const entry of OWNED_ENTRIES) await rm(join(outDir, entry), { recursive: true, force: true });
    for (const entry of OWNED_ENTRIES) await rename(join(staging, entry), join(outDir, entry));
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  }
  log(`Staged runtime payload into ${outDir}.`);
  return {
    node: join(outDir, 'node', 'bin', 'node'),
    runtime: join(outDir, 'runtime'),
  };
}

export function parseArguments(argv) {
  const options = {};
  const flags = ['--runtime', '--out', '--node'];
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flags.includes(flag)) throw new Error(`Unknown argument ${flag}.`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    if (options[flag.slice(2)] !== undefined) throw new Error(`${flag} given twice.`);
    options[flag.slice(2)] = value;
    index++;
  }
  for (const flag of flags) if (options[flag.slice(2)] === undefined) throw new Error(`${flag} is required.`);
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    await stageRuntime({ ...options, log: (line) => console.error(line) });
  } catch (error) {
    console.error(`stage-runtime: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
