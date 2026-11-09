#!/usr/bin/env node
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { markRestoredDirectory, RESTORE_REVIEW_MARKER } from './cloud-recovery.mjs';

const MAGIC = Buffer.from('JARVIS-BACKUP-1\n');
const MAX_FILES = 100_000, MAX_MANIFEST = 16 * 1024 * 1024, MAX_BYTES = 64 * 1024 ** 3;
const SERVICES = ['jarvis-gateway.service', 'jarvis-bridge.service', 'jarvis-eve.service'];
const failure = message => new Error(message);
function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\\') && !value.includes('\0') &&
    !path.posix.isAbsolute(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
async function hashFile(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function syncFile(file) { const handle = await open(file, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function readKey(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 128) throw failure('Backup key must be a private regular file (0600 or stricter).');
  const value = (await readFile(file, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw failure('Backup key must contain exactly 32 random bytes encoded as lowercase hexadecimal.');
  return Buffer.from(value, 'hex');
}
async function inventory(root) {
  const files = []; let bytes = 0;
  async function walk(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safeRelative(relative)) throw failure('Backup contains an unsupported path.');
      const absolute = path.join(root, relative), info = await lstat(absolute);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw failure('Backup refuses symbolic links and special files.');
      if (info.isDirectory()) { await walk(absolute, relative); continue; }
      bytes += info.size;
      if (files.length >= MAX_FILES || bytes > MAX_BYTES) throw failure('Backup exceeds the bounded archive size.');
      files.push({ path: relative, bytes: info.size, sha256: await hashFile(absolute) });
    }
  }
  await walk(root); return files;
}

/** Caller must quiesce writers; CLI stops owned services and verifies inactivity. */
export async function createEncryptedBackup({ source, output, key, now = new Date() }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw failure('Invalid backup encryption key.');
  source = path.resolve(source); output = path.resolve(output);
  if (output === source || output.startsWith(source + path.sep)) throw failure('Backup output must be outside its source directory.');
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('Backup source must be a real directory.');
  const files = await inventory(source);
  const manifest = Buffer.from(JSON.stringify({ version: 1, createdAt: now.toISOString(), files }));
  if (manifest.length > MAX_MANIFEST) throw failure('Backup manifest exceeds its bound.');
  const length = Buffer.alloc(4); length.writeUInt32BE(manifest.length);
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(MAGIC);
  const temporary = `${output}.${randomBytes(12).toString('hex')}.partial`;
  let published = false;
  try {
    try { await lstat(output); throw failure('Backup output already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const handle = await open(temporary, 'wx', 0o600);
    await handle.write(Buffer.concat([MAGIC, iv])); await handle.close();
    async function* content() {
      yield length; yield manifest;
      for (const item of files) {
        const absolute = path.join(source, item.path), before = await lstat(absolute);
        if (!before.isFile() || before.isSymbolicLink() || before.size !== item.bytes) throw failure('Backup source changed; services must remain stopped.');
        let count = 0; const hash = createHash('sha256');
        for await (const chunk of createReadStream(absolute)) { count += chunk.length; hash.update(chunk); yield chunk; }
        if (count !== item.bytes || hash.digest('hex') !== item.sha256) throw failure('Backup source changed during snapshot.');
      }
    }
    await pipeline(Readable.from(content()), cipher, createWriteStream(temporary, { flags: 'a', mode: 0o600 }));
    const final = await open(temporary, 'a'); try { await final.write(cipher.getAuthTag()); await final.sync(); } finally { await final.close(); }
    // Hard-link publication is exclusive: a concurrent output creator cannot be overwritten.
    await link(temporary, output); await rm(temporary); published = true;
    await syncFile(path.dirname(output));
    return { version: 1, fileCount: files.length, archiveBytes: (await stat(output)).size, sha256: await hashFile(output), encrypted: true };
  } finally { if (!published) await rm(temporary, { force: true }); }
}

export async function restoreEncryptedBackup({ archive, destination, key }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw failure('Invalid backup encryption key.');
  destination = path.resolve(destination);
  try { await lstat(destination); throw failure('Restore destination must not exist. Restore into a new directory and inspect before activation.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const info = await lstat(archive);
  if (!info.isFile() || info.isSymbolicLink() || info.size < MAGIC.length + 12 + 16 + 4 || info.size > MAX_BYTES + MAX_MANIFEST + 64) throw failure('Invalid encrypted archive.');
  const scratch = await mkdtemp(path.join(path.dirname(destination), '.jarvis-restore-')); await chmod(scratch, 0o700);
  const payload = path.join(scratch, 'payload'), staging = path.join(scratch, 'restored');
  try {
    const handle = await open(archive, 'r'), header = Buffer.alloc(MAGIC.length + 12), tag = Buffer.alloc(16);
    try { await handle.read(header, 0, header.length, 0); await handle.read(tag, 0, 16, info.size - 16); } finally { await handle.close(); }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw failure('Unsupported encrypted backup version.');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length)); decipher.setAAD(MAGIC); decipher.setAuthTag(tag);
    try { await pipeline(createReadStream(archive, { start: header.length, end: info.size - 17 }), decipher, createWriteStream(payload, { flags: 'wx', mode: 0o600 })); }
    catch { throw failure('Backup authentication failed. Nothing was restored.'); }
    // Authentication completes before any source file is exposed in the target.
    const input = await open(payload, 'r'); let offset = 4;
    try {
      const length = Buffer.alloc(4); await input.read(length, 0, 4, 0); const size = length.readUInt32BE();
      if (size < 1 || size > MAX_MANIFEST) throw failure('Invalid authenticated manifest size.');
      const bytes = Buffer.alloc(size); const read = await input.read(bytes, 0, size, 4); offset += size;
      if (read.bytesRead !== size) throw failure('Truncated backup manifest.');
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) throw failure('Unsupported backup manifest.');
      const seen = new Set(); let total = 0;
      for (const item of manifest.files) {
        if (!safeRelative(item.path) || item.path === RESTORE_REVIEW_MARKER || seen.has(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw failure('Invalid backup file record.');
        seen.add(item.path); total += item.bytes;
      }
      if (total > MAX_BYTES || (await stat(payload)).size !== offset + total) throw failure('Backup payload length is invalid.');
      await mkdir(staging, { mode: 0o700 });
      for (const item of manifest.files) {
        const output = path.join(staging, item.path); await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
        if (item.bytes) await pipeline(createReadStream(payload, { start: offset, end: offset + item.bytes - 1 }), createWriteStream(output, { flags: 'wx', mode: 0o600 }));
        else { const empty = await open(output, 'wx', 0o600); await empty.close(); }
        offset += item.bytes;
        if (await hashFile(output) !== item.sha256) throw failure('Restored file checksum mismatch.');
        await syncFile(output);
      }
      const marker = await markRestoredDirectory(staging, { archiveSha256: await hashFile(archive), backupCreatedAt: manifest.createdAt });
      await rename(staging, destination); await syncFile(path.dirname(destination));
      return { version: 1, fileCount: manifest.files.length, authenticated: true, activated: false, reviewRequired: true, restoreId: marker.restoreId };
    } finally { await input.close(); }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export function parseOffhostTarget(value) {
  const match = /^([a-z_][a-z0-9_-]{0,31})@([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?):(\/[A-Za-z0-9_./-]+)$/.exec(value ?? '');
  if (!match || !match[2].includes('.') || /^(localhost|127\.|0\.)/.test(match[2]) || match[2].endsWith('.local') ||
      match[3].split('/').some(part => part === '..' || part === '.')) throw failure('Use a dedicated off-host SSH target user@host.example:/absolute/backup-directory.');
  return { host: `${match[1]}@${match[2]}`, directory: match[3].replace(/\/$/, '') };
}
function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '/root', LANG: 'C.UTF-8' } });
    let output = '', overflow = false;
    child.stdout?.on('data', chunk => { if (output.length + chunk.length > 65536) { overflow = true; child.kill(); } else output += chunk.toString(); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
    child.on('error', () => { clearTimeout(timeout); reject(failure('Required operations executable is unavailable.')); });
    child.on('close', code => { clearTimeout(timeout); resolve({ code: overflow ? 1 : code, output }); });
  });
}
export async function uploadVerifiedBackup(archive, remote, runCommand = run) {
  const target = parseOffhostTarget(remote), name = path.basename(archive);
  if (!/^jarvis-[0-9TZ-]+\.jvb$/.test(name)) throw failure('Off-host archives require a generated Jarvis timestamp filename.');
  const ssh = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
  const directory = `'${target.directory}'`, destination = `${target.directory}/${name}`;
  if ((await runCommand('ssh', [...ssh, target.host, `umask 077; mkdir -p -- ${directory}`])).code !== 0 ||
      (await runCommand('scp', [...ssh, archive, `${target.host}:${destination}`])).code !== 0) throw failure('Encrypted off-host upload failed; local archive was retained.');
  const verify = await runCommand('ssh', [...ssh, target.host, `sha256sum -- '${destination}'`], { capture: true });
  if (verify.code !== 0 || verify.output.trim().split(/\s+/)[0] !== await hashFile(archive)) throw failure('Off-host checksum verification failed; retention pruning was not run.');
  const prune = await runCommand('ssh', [...ssh, target.host, `find ${directory} -maxdepth 1 -type f -name 'jarvis-*.jvb' -mtime +30 -delete`]);
  if (prune.code !== 0) throw failure('Off-host archive verified, but 30-day retention cleanup failed.');
  return { verifiedOffhost: true, retentionDays: 30 };
}

function argumentsFor(argv) {
  const result = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 2) {
    if (!/^--[a-z-]+$/.test(argv[index]) || !argv[index + 1] || result[argv[index].slice(2)] !== undefined) throw failure('Invalid backup arguments.');
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}
export async function main(argv) {
  const args = argumentsFor(argv), key = await readKey(args['key-file']);
  if (args.command === 'restore') return restoreEncryptedBackup({ archive: args.archive, destination: args.destination, key });
  if (args.command !== 'create' || !args.source || !args.output || !args.remote) throw failure('Usage: cloud-backup.mjs create --source DIR --output jarvis-TIMESTAMP.jvb --key-file FILE --remote user@host:/backups; or restore --archive FILE --destination NEW_DIR --key-file FILE');
  parseOffhostTarget(args.remote);
  const source = path.resolve(args.source), keyFile = path.resolve(args['key-file']);
  if (keyFile === source || keyFile.startsWith(source + path.sep)) throw failure('Backup key must be outside the backed-up state.');
  const active = [];
  let snapshot;
  try {
    for (const service of SERVICES) if ((await run('systemctl', ['is-active', '--quiet', service])).code === 0) active.push(service);
    if ((await run('systemctl', ['stop', ...SERVICES])).code !== 0) throw failure('Could not quiesce Jarvis services; no backup created.');
    for (const service of SERVICES) if ((await run('systemctl', ['is-active', '--quiet', service])).code === 0) throw failure('Jarvis still has active writers; no backup created.');
    snapshot = await createEncryptedBackup({ source: args.source, output: args.output, key });
  } finally {
    if (active.length && (await run('systemctl', ['start', ...active.reverse()])).code !== 0) throw failure('Backup operation ended, but Jarvis services could not restart. Inspect systemd status.');
  }
  return { ...snapshot, ...await uploadVerifiedBackup(args.output, args.remote) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(() => {
    // Never echo CLI inputs, source paths, SSH credentials, or child stderr.
    process.stderr.write('Cloud backup operation failed. Check key permissions, quiescence, archive integrity, and the configured SSH host. No automatic restore activation occurred.\n');
    process.exitCode = 1;
  });
}
