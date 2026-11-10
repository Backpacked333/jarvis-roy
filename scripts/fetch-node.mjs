// Fetches the pinned official Node.js 24 macOS build for the standalone app bundle.
// The tarball is cached under dist/.cache, its SHA-256 is verified against the pin
// below BEFORE anything is extracted, and only <dir>/bin/node and <dir>/LICENSE are
// extracted (system tar, explicit member names, no shell). There is deliberately no
// option to supply a hash: an unpinned hash is never trusted.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const NODE_VERSION = 'v24.22.2';
export const NODE_SHA256 = Object.freeze({
  arm64: 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a',
  x64: 'd5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52',
});
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CACHE_DIR = join(ROOT, 'dist', '.cache');
const STAMP = '.jarvis-node.sha256';

export function normalizeArch(arch) {
  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64' || arch === 'x86_64') return 'x64';
  throw new Error(`Unsupported architecture "${arch}". Use arm64 or x64.`);
}

/** Pinned download description for a macOS architecture. */
export function nodeDistribution(arch) {
  const normalized = normalizeArch(arch);
  const directory = `node-${NODE_VERSION}-darwin-${normalized}`;
  const fileName = `${directory}.tar.gz`;
  return Object.freeze({
    arch: normalized,
    version: NODE_VERSION,
    directory,
    fileName,
    url: `https://nodejs.org/dist/${NODE_VERSION}/${fileName}`,
    sha256: NODE_SHA256[normalized],
  });
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Throws unless the file's SHA-256 equals the expected (pinned) lowercase hex digest. */
export async function verifySha256(path, expected) {
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error('Refusing to verify against a malformed hash.');
  }
  const actual = await sha256File(path);
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${path}: expected ${expected}, got ${actual}.`);
  return actual;
}

async function defaultDownload(url, destination) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(600_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}.`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { mode: 0o644 }));
}

async function exists(path) {
  try { await lstat(path); return true; } catch { return false; }
}

/**
 * Extracts only `<directory>/bin/node` and `<directory>/LICENSE` from a tarball that
 * has ALREADY been verified, into `outDir/bin/node` and `outDir/LICENSE`.
 */
export async function extractNodeMembers(tarball, outDir, directory) {
  if (!/^node-v\d+\.\d+\.\d+-darwin-(arm64|x64)$/.test(directory)) throw new Error('Unexpected archive directory name.');
  const parent = dirname(resolve(outDir));
  await mkdir(parent, { recursive: true });
  const temp = await mkdtemp(join(parent, '.node-extract-'));
  try {
    const members = [`${directory}/bin/node`, `${directory}/LICENSE`];
    const result = spawnSync('tar', ['-x', '-o', '-z', '-f', tarball, '-C', temp, ...members], { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    if (result.error || result.status !== 0) {
      throw new Error(`tar failed to extract the Node binary: ${result.error?.message ?? String(result.stderr).trim()}`);
    }
    const node = join(temp, directory, 'bin', 'node');
    const license = join(temp, directory, 'LICENSE');
    for (const path of [node, license]) {
      const info = await lstat(path);
      if (!info.isFile()) throw new Error(`Extracted ${path} is not a regular file.`);
    }
    const staged = join(temp, 'out');
    await mkdir(join(staged, 'bin'), { recursive: true });
    await rename(node, join(staged, 'bin', 'node'));
    await rename(license, join(staged, 'LICENSE'));
    await chmod(join(staged, 'bin', 'node'), 0o755);
    await chmod(join(staged, 'LICENSE'), 0o644);
    await rm(outDir, { recursive: true, force: true });
    await rename(staged, outDir);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * Ensures `outDir/bin/node` is the pinned Node build for `arch`. Idempotent: a cached,
 * verified tarball is reused and extraction is skipped when the stamp matches.
 * `download` is injectable for tests; the hash is not.
 */
/**
 * Extraction replaces the output directory wholesale, so refuse to touch an existing
 * directory that holds anything other than a previous extraction (a mistyped --out
 * must never delete unrelated files).
 */
export async function assertReplaceableOutput(outDir) {
  let entries;
  try {
    if (!(await lstat(outDir)).isDirectory()) throw new Error(`--out ${outDir} exists and is not a directory.`);
    entries = await readdir(outDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const allowed = new Set(['bin', 'LICENSE', STAMP]);
  const unexpected = entries.filter((name) => !allowed.has(name));
  if (entries.includes('bin')) {
    const bin = join(outDir, 'bin');
    if (!(await lstat(bin)).isDirectory()) unexpected.push('bin');
    else unexpected.push(...(await readdir(bin)).filter((name) => name !== 'node').map((name) => `bin/${name}`));
  }
  if (unexpected.length) {
    throw new Error(`Refusing to replace ${outDir}: it contains ${unexpected.slice(0, 5).join(', ')}, which a Node extraction did not create.`);
  }
}

export async function ensureNode({ arch = process.arch, outDir, cacheDir = DEFAULT_CACHE_DIR, download = defaultDownload, log = () => {} } = {}) {
  const dist = nodeDistribution(arch);
  const out = resolve(outDir ?? join(cacheDir, dist.directory));
  await assertReplaceableOutput(out);
  await mkdir(cacheDir, { recursive: true });
  const tarball = join(resolve(cacheDir), dist.fileName);

  if (await exists(tarball)) {
    try {
      await verifySha256(tarball, dist.sha256);
    } catch {
      log(`Cached ${dist.fileName} failed verification; downloading again.`);
      await rm(tarball, { force: true });
    }
  }
  if (!(await exists(tarball))) {
    const partial = `${tarball}.${randomBytes(6).toString('hex')}.partial`;
    try {
      log(`Downloading ${dist.url}`);
      await download(dist.url, partial);
      await verifySha256(partial, dist.sha256);
      await rename(partial, tarball);
    } finally {
      await rm(partial, { force: true });
    }
  }
  // Re-verify immediately before extraction; never extract an unverified archive.
  await verifySha256(tarball, dist.sha256);

  const node = join(out, 'bin', 'node');
  const stamp = join(out, STAMP);
  let current = false;
  try {
    current = (await readFile(stamp, 'utf8')).trim() === dist.sha256 && (await lstat(node)).isFile() && (await lstat(join(out, 'LICENSE'))).isFile();
  } catch {}
  if (!current) {
    await extractNodeMembers(tarball, out, dist.directory);
    await writeFile(stamp, `${dist.sha256}\n`, { mode: 0o644 });
    log(`Extracted Node ${dist.version} (${dist.arch}) to ${out}`);
  } else {
    log(`Node ${dist.version} (${dist.arch}) already present at ${out}`);
  }
  return { node, license: join(out, 'LICENSE'), outDir: out, ...dist };
}

export function parseArguments(argv) {
  const options = { arch: process.arch, out: undefined, cache: DEFAULT_CACHE_DIR };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--arch', '--out', '--cache'].includes(flag)) throw new Error(`Unknown argument ${flag}.`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    options[flag.slice(2)] = value;
    index++;
  }
  options.arch = normalizeArch(options.arch);
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await ensureNode({ arch: options.arch, outDir: options.out, cacheDir: resolve(options.cache), log: (line) => console.error(line) });
    process.stdout.write(`${result.node}\n`);
  } catch (error) {
    console.error(`fetch-node: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
