#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmod, open, rename, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export async function writeBootCredentials(file) {
  if (file !== '/run/jarvis/local.env') throw new Error('Boot credentials may only be written under the private runtime directory.');
  const temporary = `${file}.${randomBytes(12).toString('hex')}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`JARVIS_LOCAL_TOKEN=${randomBytes(32).toString('hex')}\nJARVIS_NATIVE_TOKEN=${randomBytes(32).toString('hex')}\nJARVIS_CLOUD_RUNTIME_TOKEN=${randomBytes(32).toString('hex')}\n`);
    await handle.sync(); await handle.close(); await rename(temporary, file); await chmod(file, 0o600);
  } finally { await handle.close().catch(() => {}); await rm(temporary, { force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeBootCredentials(process.argv[2]).catch(() => { process.stderr.write('Could not create private boot credentials.\n'); process.exitCode = 1; });
}
