#!/usr/bin/env node
// Runs the fixed evaluation tasks that need only a configured model, through
// the same local services and assistant API the Mac app uses, and records what
// Jarvis actually answered.
//
//   node evaluations/live/run.mjs --dry-run
//   node evaluations/live/run.mjs --max-usd 3 [--tasks units,counterexample] [--out DIR]
//
// It spends real credits. --max-usd is a hard stop measured from the gateway's
// own credit balance. Results are provisional machine scores: a task is only
// ever "passed" after a person has reviewed it (see evaluations/README.md), so
// this never writes that status. Output goes outside the checkout by default
// because transcripts can contain private material.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startLocalServices } from '../../scripts/local-services.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const GATEWAY = 'https://ai-gateway.vercel.sh';
export const DEFAULT_JUDGE = 'anthropic/claude-sonnet-5.5';
const TASK_TIMEOUT_MS = 300_000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** Why a task in the fixed suite cannot be run by this headless runner. */
export function blockedReason(task) {
  if (task.category === 'coding') return 'Needs isolated Docker room workers, which this runner does not start.';
  if (task.category === 'daily') return 'Needs the Mac app with granted calendar, mail, voice or screen sources.';
  if (task.id === 'spoken-revision') return 'Needs live voice input.';
  if (task.id === 'conflicting-evidence' || task.id === 'literature-map') return 'Needs live public web search (a Tavily key and reviewed research run).';
  return 'No fixture has been prepared for this task.';
}

export function parseArguments(argv) {
  const options = { dryRun: false, judge: true, tasks: null, maxUsd: null, out: null, judgeModel: DEFAULT_JUDGE, model: null };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value.`);
      return next;
    };
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--no-judge') options.judge = false;
    else if (flag === '--tasks') options.tasks = value().split(',').map(item => item.trim()).filter(Boolean);
    else if (flag === '--max-usd') {
      options.maxUsd = Number(value());
      if (!Number.isFinite(options.maxUsd) || options.maxUsd <= 0 || options.maxUsd > 100) throw new Error('--max-usd must be a positive amount of at most 100.');
    } else if (flag === '--out') options.out = resolve(value());
    else if (flag === '--judge-model') options.judgeModel = value();
    else if (flag === '--model') options.model = value();
    else throw new Error(`Unknown argument ${flag}.`);
  }
  if (!options.dryRun && options.maxUsd === null) throw new Error('A live run needs --max-usd. Use --dry-run to check the plan without spending anything.');
  return options;
}

export async function loadSuite() {
  const suite = JSON.parse(await readFile(join(ROOT, 'evaluations/tasks.json'), 'utf8'));
  const fixtures = new Map();
  const digest = createHash('sha256');
  for (const name of (await readdir(join(HERE, 'fixtures'))).filter(file => file.endsWith('.json')).sort()) {
    const bytes = await readFile(join(HERE, 'fixtures', name));
    digest.update(name).update('\0').update(bytes).update('\0');
    const fixture = JSON.parse(bytes);
    if (fixture.version !== 1 || `${fixture.id}.json` !== name) throw new Error(`Fixture ${name} does not match its id.`);
    if (!suite.tasks.some(task => task.id === fixture.id)) throw new Error(`Fixture ${name} is not a task in the fixed suite.`);
    if (typeof fixture.prompt !== 'string' || typeof fixture.truth !== 'string' || !Array.isArray(fixture.checks) || !Array.isArray(fixture.documents)) {
      throw new Error(`Fixture ${name} is malformed.`);
    }
    fixtures.set(fixture.id, fixture);
  }
  return { tasks: suite.tasks, fixtures, fixtureDigest: digest.digest('hex') };
}

/** Deterministic checks. They can show an answer is wrong; passing them does not show it is right. */
export function runChecks(checks, answer) {
  return checks.map(check => {
    let met;
    if (check.kind === 'includes_any') met = check.values.some(value => answer.toLowerCase().includes(String(value).toLowerCase()));
    else if (check.kind === 'matches') met = new RegExp(check.pattern, 'u').test(answer);
    else if (check.kind === 'excludes') met = !new RegExp(check.pattern, 'u').test(answer);
    else throw new Error(`Unknown check kind ${check.kind}.`);
    return { why: check.why, kind: check.kind, met };
  });
}

/** Readable text of what the assistant showed beside its reply (tables, drafts, sources). */
export function presentationText(presentations) {
  return presentations.map(item => {
    const body = typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? item, null, 1);
    return `[${item.kind ?? 'presentation'}: ${item.title ?? ''}]\n${body}`;
  }).join('\n\n').slice(0, 12_000);
}

function gatewayHeaders() {
  // In a hosted session a proxy may substitute the real credential for this value.
  return { authorization: `Bearer ${(process.env.AI_GATEWAY_API_KEY ?? '').trim()}`, 'content-type': 'application/json' };
}

/** Total spent so far according to the gateway, in dollars. */
export function spentFrom(credits) {
  const used = Number(credits?.total_used ?? credits?.totalUsed);
  if (Number.isFinite(used)) return { value: used, direction: 1 };
  const balance = Number(credits?.balance);
  if (Number.isFinite(balance)) return { value: balance, direction: -1 };
  return null;
}

async function readCredits() {
  const response = await fetch(`${GATEWAY}/v1/credits`, { headers: gatewayHeaders(), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`The gateway refused the credit check (HTTP ${response.status}). The key may be missing or rejected.`);
  const reading = spentFrom(await response.json());
  if (!reading) throw new Error('The gateway did not report a balance, so the spend cap cannot be enforced. Nothing was run.');
  return reading;
}

async function judge(model, task, fixture, answer) {
  const instructions = [
    'You are grading one answer from an AI assistant against a fixed acceptance criterion.',
    'Be strict and literal. Do not reward fluent text that fails the criterion. Do not penalise brevity.',
    'An answer that invents a source, number, quotation, page or tool result that is not in the reference notes scores 0 or 1.',
    'An answer that claims to have run code or a check must be treated as unverified unless the transcript shows a tool result.',
    'Reply with JSON only: {"score": 0-4, "meetsCriterion": true|false, "reasons": "two sentences at most"}.',
    'Scores: 0 wrong or fabricated; 1 mostly fails; 2 partly meets; 3 meets with minor gaps; 4 fully meets.',
  ].join('\n');
  const content = [`TASK\n${fixture.prompt}`, `ACCEPTANCE CRITERION\n${task.acceptance}`, `REFERENCE NOTES (ground truth for the supplied material)\n${fixture.truth}`,
    `ASSISTANT ANSWER\n${answer.slice(0, 24_000) || '(no answer)'}`].join('\n\n');
  const response = await fetch(`${GATEWAY}/v1/chat/completions`, { method: 'POST', headers: gatewayHeaders(), redirect: 'error',
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({ model, temperature: 0, max_tokens: 400, messages: [{ role: 'system', content: instructions }, { role: 'user', content }] }) });
  if (!response.ok) throw new Error(`Judge call failed (HTTP ${response.status}).`);
  const text = String((await response.json())?.choices?.[0]?.message?.content ?? '');
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error('The judge did not return JSON.');
  const parsed = JSON.parse(match[0]);
  const score = Number(parsed.score);
  if (!Number.isInteger(score) || score < 0 || score > 4) throw new Error('The judge returned an invalid score.');
  return { score, meetsCriterion: parsed.meetsCriterion === true, reasons: String(parsed.reasons ?? '').slice(0, 600) };
}

async function runTask(services, task, fixture, { dryRun }) {
  const call = async (path, options = {}) => {
    const response = await services.request(path, { native: true, timeoutMs: 30_000, ...options });
    if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} returned ${response.status}: ${response.text.slice(0, 300)}`);
    return response.json;
  };
  const started = Date.now();
  const conversation = await call('/v1/conversations', { method: 'POST', body: { title: `Evaluation: ${task.id}` } });
  for (const [index, document] of fixture.documents.entries()) {
    const resourceId = `evaluation-${task.id}-${index + 1}`;
    // The model is a cloud model, so the fixture explicitly permits these synthetic sources to be shared with it.
    const grant = await call('/v1/grants', { method: 'POST', body: { projectId: conversation.id, resourceKind: 'file', resourceId,
      label: document.title, operations: ['read_document'], cloudAllowed: true, expiresAt: null } });
    await call('/v1/knowledge/import', { method: 'POST', body: { projectId: conversation.id, grantId: grant.id, resourceId,
      filename: document.filename, title: document.title, mediaType: /\.csv$/i.test(document.filename) ? 'text/csv' : 'text/markdown',
      bytesBase64: Buffer.from(document.text, 'utf8').toString('base64') } });
  }
  const session = await call('/v1/assistant/sessions', { method: 'POST',
    body: { title: `Evaluation: ${task.id}`, focus: { kind: 'conversation', conversationId: conversation.id, roomId: null } } });
  if (dryRun) return { prepared: true, documents: fixture.documents.length, durationMs: Date.now() - started };

  const submitted = await call(`/v1/assistant/sessions/${session.id}/turns`, { method: 'POST',
    body: { expectedRevision: session.revision, text: fixture.prompt, intent: 'continue' } });
  const denied = [], unanswered = [];
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  let turn = submitted, record, timedOut = false;
  for (;;) {
    const assistant = await call('/v1/assistant/state');
    turn = assistant.turns.find(item => item.id === submitted.id) ?? turn;
    const state = await call('/v1/state');
    record = turn.taskId ? state.tasks.find(item => item.id === turn.taskId) : undefined;
    // An evaluation never authorises an action: every approval is denied and recorded.
    for (const approval of record?.approvals ?? []) {
      if (denied.some(item => item.id === approval.id)) continue;
      denied.push({ id: approval.id, title: approval.title, detail: String(approval.detail ?? '').slice(0, 500) });
      await services.request(`/v1/tasks/${record.id}/respond`, { method: 'POST', native: true,
        body: { interactionId: approval.id, optionId: 'deny', expectedRevision: approval.revision ?? 1 } });
    }
    for (const question of record?.questions ?? []) {
      if (!unanswered.some(item => item.id === question.id)) unanswered.push({ id: question.id, title: question.title });
    }
    if (TERMINAL.has(turn.status) && (!record || TERMINAL.has(record.status))) break;
    if (unanswered.length > 0 || Date.now() > deadline) {
      timedOut = Date.now() > deadline;
      await services.request('/v1/stop', { method: 'POST', native: true, timeoutMs: 60_000 });
      break;
    }
    await delay(1_000);
  }
  const assistant = await call('/v1/assistant/state');
  const presentations = [...(assistant.presentations ?? [])].filter(item => item.turnId === submitted.id);
  const reply = String(record?.reply ?? '');
  const shown = presentationText(presentations);
  return { durationMs: Date.now() - started, status: timedOut ? 'timed_out' : unanswered.length ? 'asked_a_question' : turn.status,
    error: record?.error ?? turn.error ?? null, reply, shown, events: record?.events ?? [], approvalsDenied: denied, questionsAsked: unanswered };
}

function commit() {
  try { return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; }
}

export function summarize(results) {
  const ran = results.tasks.filter(task => task.outcome === 'ran');
  const lines = [`# Jarvis live evaluation`, '',
    `- Commit: ${results.commit ?? 'unknown'}`, `- Model: ${results.model}`, `- Judge: ${results.judgeModel ?? 'none'}`,
    `- Spent: $${results.spentUsd.toFixed(2)} of a $${results.maxUsd.toFixed(2)} cap${results.stoppedAtCap ? ' (stopped at the cap)' : ''}`,
    `- Tasks: ${ran.length} ran, ${results.tasks.filter(task => task.outcome === 'blocked').length} blocked, ${results.tasks.filter(task => task.outcome === 'error').length} errored, ${results.tasks.filter(task => task.outcome === 'not_run').length} not run`,
    '', 'Scores are provisional machine judgements. No task counts as passed until a person has reviewed it.', '',
    '| Task | Category | Checks | Judge (0-4) | Meets criterion | Seconds | Note |', '|---|---|---|---|---|---|---|'];
  for (const task of results.tasks) {
    const checks = task.checks ? `${task.checks.filter(check => check.met).length}/${task.checks.length}` : '';
    const note = (task.outcome === 'ran' ? (task.judge?.reasons ?? task.error ?? task.status) : task.reason ?? task.error ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 220);
    lines.push(`| ${task.id} | ${task.category} | ${checks} | ${task.judge?.score ?? ''} | ${task.judge ? (task.judge.meetsCriterion ? 'yes' : 'no') : ''} | ${task.durationMs ? Math.round(task.durationMs / 1000) : ''} | ${task.outcome === 'ran' ? '' : `${task.outcome}: `}${note} |`);
  }
  const judged = ran.filter(task => task.judge);
  if (judged.length) {
    lines.push('', `Mean judge score over ${judged.length} judged tasks: ${(judged.reduce((sum, task) => sum + task.judge.score, 0) / judged.length).toFixed(2)}. `
      + `Meeting the criterion: ${judged.filter(task => task.judge.meetsCriterion).length} of ${judged.length}.`);
  }
  return lines.join('\n') + '\n';
}

export async function main(argv) {
  const options = parseArguments(argv);
  const { tasks, fixtures, fixtureDigest } = await loadSuite();
  for (const id of options.tasks ?? []) if (!tasks.some(task => task.id === id)) throw new Error(`Unknown task ${id}.`);
  const selected = tasks.filter(task => !options.tasks || options.tasks.includes(task.id));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = options.out ?? join(homedir(), 'Jarvis-evaluation', `live-${stamp}`);
  if (out.startsWith(ROOT + '/')) throw new Error('Write results outside the checkout; transcripts can contain private material.');

  const env = { ...process.env, JARVIS_ENABLE_ASSISTANT: '1', JARVIS_ENABLE_KNOWLEDGE: '1', JARVIS_ENABLE_MEMORY: '1' };
  for (const name of ['JARVIS_ENABLE_RESEARCH', 'JARVIS_ENABLE_DESKTOP', 'JARVIS_ENABLE_TERMINAL', 'JARVIS_ENABLE_APPLE_SERVICES',
    'JARVIS_ENABLE_OBJECTIVES', 'JARVIS_ENABLE_CLOUD', 'JARVIS_ENABLE_VOICE_APPROVAL', 'JARVIS_LOCAL_TOKEN', 'JARVIS_NATIVE_TOKEN', 'JARVIS_DATA_DIR',
    'TAVILY_API_KEY', 'ELEVENLABS_API_KEY', 'HOME_ASSISTANT_TOKEN', 'HOME_ASSISTANT_URL']) delete env[name];
  if (options.model) env.JARVIS_MODEL = options.model;
  if (options.dryRun) delete env.AI_GATEWAY_API_KEY;
  else if (!(env.AI_GATEWAY_API_KEY ?? '').trim()) throw new Error('A live run needs AI_GATEWAY_API_KEY.');

  const results = { version: 1, kind: 'provisional-machine-scores', startedAt: new Date().toISOString(), commit: commit(), dryRun: options.dryRun,
    model: env.JARVIS_MODEL || 'openai/gpt-6-sol-fast', judgeModel: options.judge && !options.dryRun ? options.judgeModel : null,
    fixtureDigest, maxUsd: options.maxUsd ?? 0, spentUsd: 0, stoppedAtCap: false, tasks: [] };
  const start = options.dryRun ? null : await readCredits();
  const spent = async () => {
    const now = await readCredits();
    return Math.max(0, (now.value - start.value) * start.direction);
  };

  const data = await mkdtemp(join(await realpath(tmpdir()), 'jarvis-evaluation-'));
  let services;
  try {
    if (!options.dryRun) { await mkdir(join(out, 'transcripts'), { recursive: true, mode: 0o700 }); await chmod(out, 0o700); }
    services = await startLocalServices({ runtimeDirectory: join(ROOT, 'runtime'), dataDirectory: data, env });
    for (const task of selected) {
      const fixture = fixtures.get(task.id);
      const entry = { id: task.id, category: task.category };
      results.tasks.push(entry);
      if (!fixture) { Object.assign(entry, { outcome: 'blocked', reason: blockedReason(task) }); continue; }
      if (results.stoppedAtCap) { Object.assign(entry, { outcome: 'not_run', reason: 'The spend cap was reached before this task.' }); continue; }
      const before = options.dryRun ? 0 : results.spentUsd;
      try {
        const run = await runTask(services, task, fixture, options);
        if (options.dryRun) { Object.assign(entry, { outcome: 'prepared', documents: run.documents }); continue; }
        const answer = [run.reply, run.shown].filter(Boolean).join('\n\n');
        Object.assign(entry, { outcome: 'ran', status: run.status, error: run.error, durationMs: run.durationMs,
          approvalsDenied: run.approvalsDenied.length, questionsAsked: run.questionsAsked.length, checks: runChecks(fixture.checks, answer) });
        if (options.judge && answer.trim()) {
          try { entry.judge = await judge(options.judgeModel, task, fixture, answer); } catch (error) { entry.judgeError = error.message; }
        }
        await writeFile(join(out, 'transcripts', `${task.id}.json`), JSON.stringify({ task, prompt: fixture.prompt, ...run, checks: entry.checks, judge: entry.judge ?? null }, null, 2), { mode: 0o600 });
      } catch (error) {
        Object.assign(entry, { outcome: 'error', error: error.message });
      }
      if (!options.dryRun) {
        results.spentUsd = await spent();
        entry.costUsd = Number((results.spentUsd - before).toFixed(4));
        console.error(`${task.id}: ${entry.outcome}${entry.judge ? `, judge ${entry.judge.score}/4` : ''}, $${entry.costUsd.toFixed(2)} (total $${results.spentUsd.toFixed(2)})`);
        if (results.spentUsd >= options.maxUsd) results.stoppedAtCap = true;
      }
    }
  } finally {
    await services?.stop().catch(() => {});
    await rm(data, { recursive: true, force: true });
  }
  results.finishedAt = new Date().toISOString();
  const summary = summarize(results);
  if (options.dryRun) {
    const prepared = results.tasks.filter(task => task.outcome === 'prepared').length;
    console.log(`Dry run: ${prepared} tasks prepared against real local services (documents imported, sessions opened); `
      + `${results.tasks.filter(task => task.outcome === 'blocked').length} blocked; ${results.tasks.filter(task => task.outcome === 'error').length} errors. No provider was called.`);
    for (const task of results.tasks.filter(item => item.outcome !== 'prepared')) console.log(`  ${task.id}: ${task.outcome} — ${task.reason ?? task.error}`);
    return results;
  }
  await writeFile(join(out, 'auto-results.json'), JSON.stringify(results, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(out, 'summary.md'), summary, { mode: 0o600 });
  console.log(summary);
  console.log(`Results: ${out}`);
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(results => {
    if (results.tasks.some(task => task.outcome === 'error')) process.exitCode = 1;
  }).catch(error => { console.error(`Evaluation did not run: ${error.message}`); process.exitCode = 1; });
}
