#!/usr/bin/env node
// Development start for the two local services without the Mac app:
//   cd runtime && npm run start:all
// Uses the same per-service environment filtering as the Mac launcher.
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from './doctor.mjs';
import { BRIDGE_PORT, startLocalServices } from './local-services.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error(`Jarvis needs Node.js 24; this is ${process.version}.`);
  process.exit(1);
}
const data = dataDirectory();
await mkdir(data, { recursive: true, mode: 0o700 });
let services;
try {
  services = await startLocalServices({ runtimeDirectory: join(root, 'runtime'), dataDirectory: data });
} catch (error) {
  console.error(`Jarvis could not start: ${error.message}`);
  console.error('Run `npm run doctor` in runtime/ to see what is missing.');
  process.exit(1);
}
// The loopback token is written for local tools instead of being printed into terminal scrollback.
const run = join(data, 'run');
await mkdir(run, { recursive: true, mode: 0o700 });
const tokenFile = join(run, 'local-token');
await writeFile(tokenFile, services.token + '\n', { mode: 0o600 });
await chmod(tokenFile, 0o600);
const state = (await services.request('/v1/state')).json;
console.log(`Jarvis local services are ready on http://127.0.0.1:${BRIDGE_PORT} (model ${state.model}).`);
console.log(state.providerConfigured ? 'A reasoning credential is configured.'
  : 'No AI_GATEWAY_API_KEY is set: the services run, but Jarvis cannot reason until one is provided.');
console.log(`Logs: ${services.logs}\nLoopback token: ${tokenFile}\nPress Ctrl-C to stop.`);

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping local services…');
  const { forced } = await services.stop();
  await rm(tokenFile, { force: true });
  if (forced) console.error('A service needed a forced stop; check worker state on the next start.');
  process.exit(forced ? 1 : code);
}
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
void services.exited().then(role => {
  if (!stopping) { console.error(`The ${role} service exited unexpectedly. See ${services.logs}.`); void stop(1); }
});
