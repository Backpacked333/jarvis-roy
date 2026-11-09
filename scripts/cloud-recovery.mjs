#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const RESTORE_REVIEW_MARKER = '.jarvis-restore-review-required.json';
const SERVICES = ['jarvis-eve.service', 'jarvis-bridge.service', 'jarvis-gateway.service'];
async function privateJSON(file, maxBytes = 32768) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) || info.size > maxBytes) throw new Error('Recovery records must be bounded private regular files.');
  return JSON.parse(await readFile(file, 'utf8'));
}
async function durableJSON(file, value) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  const parent = await open(path.dirname(file), 'r'); try { await parent.sync(); } finally { await parent.close(); }
}
export async function markRestoredDirectory(directory, { archiveSha256, backupCreatedAt, now = new Date() }) {
  const marker = { version: 1, restoreId: randomUUID(), archiveSha256, backupCreatedAt, restoredAt: now.toISOString(),
    state: 'operator_review_required', reason: 'Effects or scheduled work after this backup may have occurred. Do not replay uncertain actions.' };
  await durableJSON(path.join(directory, RESTORE_REVIEW_MARKER), marker);
  return marker;
}
export async function assertRestoreReviewed(directory) {
  try { await lstat(path.join(directory, RESTORE_REVIEW_MARKER)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Restored state requires an explicit stopped-service recovery review before startup.');
}
function active(service) {
  return new Promise((resolve, reject) => {
    const child = spawn('systemctl', ['is-active', '--quiet', service], { shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('Service state is unavailable.')); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(true); else if (code === 3 || code === 4) resolve(false); else reject(new Error('Service state could not be verified.')); });
  });
}
export async function reviewRestoration({ directory, reviewFile, isActive = active, now = new Date() }) {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Recovery requires a real restored directory.');
  for (const service of SERVICES) if (await isActive(service)) throw new Error('Stop every Jarvis service before reviewing restored state.');
  const markerPath = path.join(directory, RESTORE_REVIEW_MARKER), marker = await privateJSON(markerPath), review = await privateJSON(reviewFile);
  if (marker.version !== 1 || marker.state !== 'operator_review_required' || !/^[a-f0-9]{64}$/.test(marker.archiveSha256) ||
      review.version !== 1 || review.restoreId !== marker.restoreId || review.archiveSha256 !== marker.archiveSha256 ||
      typeof review.reviewer !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(review.reviewer) ||
      !Number.isFinite(Date.parse(review.reviewedAt)) || Date.parse(review.reviewedAt) < Date.parse(marker.restoredAt) ||
      Date.parse(review.reviewedAt) > now.getTime() + 60000 || now.getTime() - Date.parse(review.reviewedAt) > 86400000 ||
      review.pendingActionsReviewed !== true || review.effectsAfterBackupReconciled !== true || review.previouslyScheduledWorkReviewed !== true ||
      review.providerCredentialsReviewed !== true || review.unresolvedEffects !== 'remain_unknown_do_not_retry') throw new Error('Recovery review does not match this restore or its required decisions.');
  const receipt = { version: 1, restoreId: marker.restoreId, archiveSha256: marker.archiveSha256, backupCreatedAt: marker.backupCreatedAt,
    restoredAt: marker.restoredAt, reviewedAt: review.reviewedAt, reviewer: review.reviewer,
    pendingActionsReviewed: true, effectsAfterBackupReconciled: true, previouslyScheduledWorkReviewed: true,
    providerCredentialsReviewed: true, unresolvedEffects: 'remain_unknown_do_not_retry', activated: false };
  const receiptPath = path.join(directory, `.jarvis-recovery-${marker.restoreId}.json`);
  try { await durableJSON(receiptPath, receipt); }
  catch (error) { if (error.code !== 'EEXIST' || JSON.stringify(await privateJSON(receiptPath)) !== JSON.stringify(receipt)) throw error; }
  await unlink(markerPath);
  const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
  return { version: 1, reviewed: true, activated: false, restoreId: marker.restoreId };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const valid = args.length === 5 && args[0] === 'review' && args[1] === '--directory' && args[3] === '--review-file';
  (valid ? reviewRestoration({ directory: args[2], reviewFile: args[4] }) : Promise.reject(new Error('Invalid recovery command.')))
    .then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(() => {
      process.stderr.write('Recovery review failed. Keep Jarvis stopped; inspect the private restore marker, matching review decisions, and service state.\n'); process.exitCode = 1;
    });
}
