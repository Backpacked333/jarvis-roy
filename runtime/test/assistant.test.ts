import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AssistantCoordinator, assistantRoute, assistantSseFrame, reviewDigest,
  MAX_ASSISTANT_EVENT_HISTORY_BYTES,
  type AssistantOperation, type NativeConfirmationEvent, type ReviewableAction, type VoiceProposal,
} from "../bridge/assistant/index.ts";

const native = { nativeAuthenticated: true };
const active = { appActive: true, sessionUnlocked: true };
const focus = { kind: "conversation" as const, conversationId: "conversation-1", roomId: null };

async function fixture(options: { enabled?: boolean; voiceApprovalEnabled?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-assistant-"));
  let clock = Date.parse("2026-11-08T12:00:00.000Z"), executions = 0;
  const dispatched: AssistantOperation[] = [], stopped: AssistantOperation[] = [];
  let action: ReviewableAction = { taskId: "task-1", interactionId: "approval-1", revision: 1, optionId: "approve",
    toolName: "save_note", exactArguments: '{"title":"Test","content":"hello"}',
    reviewText: 'Tool: save_note\nExact arguments (JSON): {"title":"Test","content":"hello"}', voiceAllowed: true };
  let execution: (() => Promise<void>) | undefined;
  const config = { dataDirectory: directory, enabled: options.enabled ?? true, voiceApprovalEnabled: options.voiceApprovalEnabled ?? true,
    now: () => new Date(clock), adapters: {
      async dispatchTurn(input: AssistantOperation) { dispatched.push(input); return { taskId: `task-${dispatched.length}`, conversationId: "conversation-1" }; },
      async stopWork(input: AssistantOperation) { stopped.push(input); },
      async readAction() { return structuredClone(action); },
      async executeAction(actual: ReviewableAction) { assert.deepEqual(actual, action); executions++; await execution?.(); },
    } };
  let coordinator = await AssistantCoordinator.open(config);
  const session = options.enabled === false ? null : await coordinator.createSession({ title: "Research", focus });
  async function turn() {
    return coordinator.submitTurn(session!.id, { expectedRevision: coordinator.state().sessions[0].revision, text: "Save the note", intent: "continue" });
  }
  async function propose() {
    const task = await turn();
    action.taskId = task.taskId!;
    const proposal = await coordinator.proposeAction(session!.id, task.id, { taskId: action.taskId, interactionId: action.interactionId, revision: action.revision, optionId: action.optionId }, native);
    return { task, proposal };
  }
  function event(proposal: VoiceProposal, details: Record<string, unknown>): NativeConfirmationEvent {
    return { eventId: randomUUID(), proposalId: proposal.id, proposalRevision: proposal.revision, digest: proposal.digest,
      timestamp: new Date(clock).toISOString(), nativeSessionId: "native-session-1", ...details } as NativeConfirmationEvent;
  }
  async function ready(proposal: VoiceProposal) {
    proposal = await coordinator.nativeEvent(event(proposal, { type: "review_displayed", reviewDigest: reviewDigest(action) }), active, native);
    proposal = await coordinator.nativeEvent(event(proposal, { type: "readback_started", reviewDigest: reviewDigest(action), readbackId: "readback-1" }), active, native);
    assert.equal(proposal.challenge, null);
    proposal = await coordinator.nativeEvent(event(proposal, { type: "readback_drained", readbackId: "readback-1" }), active, native);
    return proposal;
  }
  return { directory, config, session, dispatched, stopped, get coordinator() { return coordinator; }, get action() { return action; }, set action(value) { action = value; },
    executions: () => executions, setExecution(fn: () => Promise<void>) { execution = fn; }, advance(ms: number) { clock += ms; },
    event, ready, turn, propose, utterance: (proposal: VoiceProposal, transcript = proposal.challenge!) => event(proposal,
      { type: "utterance", readbackId: "readback-1", transcript, captureStartedAt: new Date(clock).toISOString() }),
    async restart() { await coordinator.close(); coordinator = await AssistantCoordinator.open(config); },
    async cleanup() { await coordinator.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("assistant captures focus and exact selected presentation without retargeting side questions", async () => {
  const f = await fixture();
  try {
    const first = await f.turn();
    const card = await f.coordinator.present({ sessionId: f.session!.id, turnId: first.id, title: "Evidence", content: { kind: "text", markdown: "source A" } });
    await f.coordinator.submitTurn(f.session!.id, { expectedRevision: 1, text: "Explain this", intent: "side_question", presentationRef: { presentationId: card.id, revision: card.revision } });
    assert.equal(f.dispatched[1].intent, "side_question"); assert.deepEqual(f.dispatched[1].capturedFocus, focus);
    assert.equal(f.dispatched[1].capturedPresentation?.content.kind, "text");
    await f.coordinator.present({ id: card.id, expectedRevision: 1, sessionId: f.session!.id, turnId: first.id, title: "New evidence", content: { kind: "text", markdown: "source B" } });
    assert.deepEqual(f.dispatched[1].capturedPresentation?.content, { kind: "text", markdown: "source A" });
    await f.coordinator.submitTurn(f.session!.id, { expectedRevision: 1, text: "Old card", intent: "continue", presentationRef: { presentationId: card.id, revision: 1 } });
    assert.deepEqual(f.dispatched.at(-1)?.capturedPresentation?.content, { kind: "text", markdown: "source A" });
    await f.coordinator.updateFocus(f.session!.id, { expectedRevision: 1, focus: { kind: "room", roomId: "room-2" } });
    await assert.rejects(f.coordinator.submitTurn(f.session!.id, { expectedRevision: 1, text: "stale", intent: "continue" }), /focus changed/);
    assert.deepEqual(f.coordinator.state().turns[0].capturedFocus, focus);
    await f.coordinator.submitTurn(f.session!.id, { expectedRevision: 2, text: "Stop this work", intent: "stop_work" });
    assert.equal(f.stopped.length, 1); assert.deepEqual(f.stopped[0].capturedFocus, { kind: "room", roomId: "room-2" });
  } finally { await f.cleanup(); }
});

test("multibyte presentations are bounded before commit and captured turns fit native SSE frames", async () => {
  const f = await fixture();
  try {
    const turn = await f.turn();
    const before = f.coordinator.state(), events: unknown[] = [];
    const unsubscribe = f.coordinator.subscribe(event => events.push(event));
    const columns = Array.from({ length: 10 }, (_, index) => `Column ${index}`);
    const row = Array.from({ length: 10 }, () => "界".repeat(500));
    await assert.rejects(f.coordinator.present({ sessionId: f.session!.id, turnId: turn.id, title: "Large table",
      content: { kind: "table", columns, rows: Array.from({ length: 30 }, () => row) } }), /exceeds 384 KiB/);
    assert.deepEqual(f.coordinator.state(), before, "A refused frame must not change sequence or durable presentation state");
    assert.equal(events.length, 0);
    const card = await f.coordinator.present({ sessionId: f.session!.id, turnId: turn.id, title: "Bounded table",
      content: { kind: "table", columns, rows: Array.from({ length: 22 }, () => row) } });
    await f.coordinator.submitTurn(f.session!.id, { expectedRevision: 1, text: "界".repeat(16_000), intent: "continue",
      presentationRef: { presentationId: card.id, revision: card.revision } });
    for (const event of f.coordinator.eventsAfter(0).events) {
      assert.ok(Buffer.byteLength(assistantSseFrame(event), "utf8") < 512 * 1024, "Valid card and captured-turn frames fit the native byte limit");
    }
    unsubscribe();
  } finally { await f.cleanup(); }
});

test("large presentation revisions trim replay by bytes while keeping current cards and sequence continuity", async () => {
  const f = await fixture();
  try {
    const turn = await f.turn();
    const content = { kind: "table" as const, columns: Array.from({ length: 10 }, (_, index) => `Column ${index}`),
      rows: Array.from({ length: 22 }, () => Array.from({ length: 10 }, () => "界".repeat(500))) };
    let card = await f.coordinator.present({ sessionId: f.session!.id, turnId: turn.id, title: "Revision 1", content });
    for (let revision = 2; revision <= 15; revision++) {
      card = await f.coordinator.present({ id: card.id, expectedRevision: card.revision, sessionId: f.session!.id,
        turnId: turn.id, title: `Revision ${revision}`, content });
    }
    const sequence = f.coordinator.state().sequence;
    assert.throws(() => f.coordinator.eventsAfter(0), /history expired/);
    const tail = f.coordinator.eventsAfter(sequence - 10).events;
    assert.deepEqual(tail.map(event => event.sequence), Array.from({ length: 10 }, (_, index) => sequence - 9 + index));
    assert.ok(tail.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0) <= MAX_ASSISTANT_EVENT_HISTORY_BYTES);
    await f.restart();
    assert.equal(f.coordinator.state().presentations[0].revision, 15);
    assert.deepEqual(f.coordinator.state().presentations[0].content, content);
  } finally { await f.cleanup(); }
});

test("an oversized review cannot publish an unreadable native confirmation event", async () => {
  const f = await fixture();
  try {
    const turn = await f.turn();
    const exactArguments = JSON.stringify({ content: "界".repeat(90_000) });
    f.action = { ...f.action, taskId: turn.taskId!, exactArguments,
      reviewText: `Tool: save_note\nExact arguments (JSON): ${exactArguments}` };
    const before = f.coordinator.state();
    await assert.rejects(f.coordinator.proposeAction(f.session!.id, turn.id, {
      taskId: turn.taskId!, interactionId: f.action.interactionId, revision: f.action.revision, optionId: "approve",
    }, native), /native stream limit/);
    assert.deepEqual(f.coordinator.state(), before);
    assert.equal(f.executions(), 0);
  } finally { await f.cleanup(); }
});

test("sequenced durable events replay exactly and SSE never interpolates raw markdown", async () => {
  const f = await fixture();
  try {
    const events: number[] = []; const unsubscribe = f.coordinator.subscribe(event => events.push(event.sequence));
    const turn = await f.turn();
    await f.coordinator.present({ sessionId: f.session!.id, turnId: turn.id, title: "Result", content: { kind: "text", markdown: "hello\n\nevent: fake\ndata: malicious" } });
    const before = f.coordinator.state().sequence;
    const replay = f.coordinator.eventsAfter(0);
    assert.deepEqual(replay.events.map(event => event.sequence), Array.from({ length: before }, (_, i) => i + 1));
    assert.ok(events.length >= 3); unsubscribe();
    const frame = assistantSseFrame(replay.events.at(-1)!);
    assert.equal(frame.split("\nevent:").length, 2); assert.equal(frame.split("\ndata:").length, 2);
    await f.restart();
    assert.equal(f.coordinator.state().turns[0].status, "interrupted");
    assert.equal(f.coordinator.state().presentations.length, 1);
    assert.ok(f.coordinator.state().sequence > before);
    assert.equal((await stat(join(f.directory, "assistant", "assistant.sqlite"))).mode & 0o777, 0o600);
  } finally { await f.cleanup(); }
});

test("task projection updates stable presentation revisions and settles from actual task state", async () => {
  const f = await fixture();
  try {
    const turn = await f.turn();
    const task = { id: turn.taskId!, conversationId: "conversation-1", userMessage: "test", title: "Response", status: "running" as const,
      reply: "Part one", createdAt: new Date().toISOString(), events: [], approvals: [] };
    await f.coordinator.updateTask(task);
    const first = f.coordinator.state().presentations[0];
    await f.coordinator.updateTask(task);
    assert.equal(f.coordinator.state().presentations[0].revision, first.revision);
    await f.coordinator.updateTask({ ...task, reply: "Full answer", status: "completed" });
    const final = f.coordinator.state().presentations[0];
    assert.equal(final.id, first.id); assert.equal(final.revision, first.revision + 1);
    assert.equal(f.coordinator.state().turns[0].status, "completed");
  } finally { await f.cleanup(); }
});

test("model-facing presentations cannot claim code, math or artifact verification", async () => {
  const f = await fixture();
  try {
    const turn = await f.turn();
    const code = await f.coordinator.presentForTask(turn.taskId!, { kind: "code", code: "assert false", language: "python", verification: "passed" }, "Check");
    const math = await f.coordinator.presentForTask(turn.taskId!, { kind: "math", latex: "1=2", explanation: "Claim", verification: "formal" }, "Proof");
    const artifact = await f.coordinator.presentForTask(turn.taskId!, { kind: "artifact", roomId: "room-1", runId: "run-1", artifactId: "artifact-1", digest: "a".repeat(64), path: "output.txt", mediaType: "text/plain", verification: "passed" }, "Output");
    for (const card of [code, math, artifact]) assert.equal((card.content as { verification: string }).verification, "unverified");
  } finally { await f.cleanup(); }
});

test("voice confirmation requires complete review, real playback drain and exact single-use challenge", async () => {
  const f = await fixture();
  try {
    const { proposal } = await f.propose();
    const ready = await f.ready(proposal);
    assert.equal(ready.status, "awaiting_confirmation"); assert.match(ready.challenge!, /^confirm [a-z]+ \d{4}$/);
    const utterance = f.utterance(ready);
    const completed = await f.coordinator.nativeEvent(utterance, active, native);
    assert.equal(completed.status, "completed"); assert.equal(f.executions(), 1);
    await assert.rejects(f.coordinator.nativeEvent(utterance, active, native), /no longer pending/);
    assert.equal(f.executions(), 1);
  } finally { await f.cleanup(); }
});

test("reviewed voice confirmation accepts a sentence-final period and one thousands comma", async () => {
  const f = await fixture();
  try {
    const { proposal } = await f.propose(), ready = await f.ready(proposal);
    const transcript = ready.challenge!.replace(/(\d)(\d{3})$/, "$1,$2").replace(/^confirm/, "Confirm") + ".";
    const confirmed = await f.coordinator.nativeEvent(f.utterance(ready, transcript), active, native);
    assert.equal(confirmed.status, "completed"); assert.equal(f.executions(), 1);
    await assert.rejects(f.coordinator.nativeEvent(f.utterance(ready, transcript), active, native), /no longer pending/);
    assert.equal(f.executions(), 1);
  } finally { await f.cleanup(); }
});

test("reviewed voice confirmation permits only bounded ASR orthography", async t => {
  const cases: Array<[string, (challenge: string) => string]> = [
    ["period alone", challenge => `${challenge}.`],
    ["thousands comma alone", challenge => challenge.replace(/(\d)(\d{3})$/, "$1,$2")],
    ["case and whitespace with period", challenge => `  ${challenge.toUpperCase().replaceAll(" ", "  \t")}.  `],
  ];
  for (const [name, transcript] of cases) await t.test(name, async () => {
    const f = await fixture();
    try {
      const { proposal } = await f.propose(), ready = await f.ready(proposal);
      const result = await f.coordinator.nativeEvent(f.utterance(ready, transcript(ready.challenge!)), active, native);
      assert.equal(result.status, "completed"); assert.equal(f.executions(), 1);
    } finally { await f.cleanup(); }
  });
});

test("reviewed voice confirmation rejects ambiguous punctuation, embedded phrases and changed numbers", async t => {
  const cases: Array<[string, (challenge: string) => string]> = [
    ["question", challenge => `${challenge}?`],
    ["exclamation", challenge => `${challenge}!`],
    ["two periods", challenge => `${challenge}..`],
    ["quoted phrase", challenge => `"${challenge}"`],
    ["quoted phrase with period", challenge => `"${challenge}."`],
    ["prefixed phrase", challenge => `please ${challenge}.`],
    ["suffixed phrase", challenge => `${challenge} please.`],
    ["embedded phrase", challenge => `I said ${challenge}, right?`],
    ["generic yes", () => "yes."],
    ["wrong comma position", challenge => challenge.replace(/(\d{2})(\d{2})$/, "$1,$2.")],
    ["two commas", challenge => challenge.replace(/(\d)(\d{3})$/, "$1,,$2.")],
    ["spaced comma", challenge => challenge.replace(/(\d)(\d{3})$/, "$1, $2.")],
    ["different number", challenge => challenge.replace(/\d$/, digit => String((Number(digit) + 1) % 10))],
    ["extra digit", challenge => `${challenge}0.`],
    ["leading zero", challenge => challenge.replace(/(\d{4})$/, "0$1.")],
    ["different word", challenge => challenge.replace(/^confirm [a-z]+ /, "confirm unknown ")],
    ["number alone", challenge => challenge.split(" ").at(-1)!],
  ];
  for (const [name, transcript] of cases) await t.test(name, async () => {
    const f = await fixture();
    try {
      const { proposal } = await f.propose(), ready = await f.ready(proposal);
      await assert.rejects(f.coordinator.nativeEvent(f.utterance(ready, transcript(ready.challenge!)), active, native), /invalidated/);
      assert.equal(f.executions(), 0); assert.equal(f.coordinator.state().proposals[0].status, "invalidated");
      await assert.rejects(f.coordinator.nativeEvent(f.utterance(ready), active, native), /no longer pending/);
      assert.equal(f.executions(), 0);
    } finally { await f.cleanup(); }
  });
});

test("generic yes and ordinary text cannot confirm; unauthenticated native JSON cannot attest", async () => {
  const f = await fixture();
  try {
    const { proposal } = await f.propose(); const ready = await f.ready(proposal);
    await assert.rejects(assistantRoute("POST", "/v1/assistant/native-events", { event: f.utterance(ready), ...active }, f.coordinator), /native confirmation channel/);
    assert.equal(f.executions(), 0);
    await assert.rejects(f.coordinator.nativeEvent(f.utterance(ready, "yes"), active, native), /invalidated/);
    const second = await f.propose(); const ready2 = await f.ready(second.proposal);
    await f.coordinator.submitTurn(f.session!.id, { expectedRevision: 1, text: ready2.challenge, intent: "continue" });
    assert.equal(f.coordinator.state().proposals.at(-1)!.status, "invalidated"); assert.equal(f.executions(), 0);
  } finally { await f.cleanup(); }
});

test("modified, stale, locked, interrupted and expired confirmations fail closed", async t => {
  for (const condition of ["modified", "stale", "locked", "inactive", "expired", "capture-before-drain", "interrupted", "wrong-session"] as const) {
    await t.test(condition, async () => {
      const f = await fixture();
      try {
        const { proposal } = await f.propose(); const ready = await f.ready(proposal);
        let event = f.utterance(ready); let observations = active;
        if (condition === "modified") f.action = { ...f.action, exactArguments: '{"title":"Changed","content":"different"}' };
        if (condition === "stale") event = { ...event, proposalRevision: 1 };
        if (condition === "locked") observations = { ...active, sessionUnlocked: false };
        if (condition === "inactive") observations = { ...active, appActive: false };
        if (condition === "expired") { f.advance(15_001); event = f.utterance(ready); }
        if (condition === "capture-before-drain") event = { ...f.utterance(ready), captureStartedAt: "2026-11-08T11:59:59.000Z" } as NativeConfirmationEvent;
        if (condition === "interrupted") event = f.event(ready, { type: "interrupted" });
        if (condition === "wrong-session") event = { ...event, nativeSessionId: "other-native-session" };
        await assert.rejects(f.coordinator.nativeEvent(event, observations, native), /invalidated/);
        assert.equal(f.executions(), 0); assert.equal(f.coordinator.state().proposals[0].status, "invalidated");
      } finally { await f.cleanup(); }
    });
  }
});

test("drain before review/readback is rejected and complete argument readback is required", async () => {
  const f = await fixture();
  try {
    const { proposal } = await f.propose();
    await assert.rejects(f.coordinator.nativeEvent(f.event(proposal, { type: "readback_drained", readbackId: "readback-1" }), active, native), /invalidated/);
    const turn = await f.turn(); f.action = { ...f.action, taskId: turn.taskId!, reviewText: "A harmless action" };
    await assert.rejects(f.coordinator.proposeAction(f.session!.id, turn.id, { taskId: turn.taskId, interactionId: "approval-1", revision: 1, optionId: "approve" }, native), /full readback/);
  } finally { await f.cleanup(); }
});

test("simultaneous confirmations execute once; uncertain execution cannot retry after restart", async () => {
  const f = await fixture();
  try {
    const { proposal } = await f.propose(); const ready = await f.ready(proposal);
    f.setExecution(async () => { throw new Error("transport lost after dispatch"); });
    const results = await Promise.allSettled([f.coordinator.nativeEvent(f.utterance(ready), active, native), f.coordinator.nativeEvent(f.utterance(ready), active, native)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(f.executions(), 1);
    assert.equal(f.coordinator.state().proposals[0].status, "uncertain");
    await f.restart();
    await assert.rejects(f.coordinator.nativeEvent(f.utterance(ready), active, native), /no longer pending/);
    assert.equal(f.executions(), 1);
  } finally { await f.cleanup(); }
});

test("restart invalidates challenges; disabled flags and unknown routes never execute", async () => {
  const f = await fixture();
  try {
    const { proposal } = await f.propose(); const ready = await f.ready(proposal);
    await f.restart(); assert.equal(f.coordinator.state().proposals[0].status, "invalidated");
    await assert.rejects(f.coordinator.nativeEvent(f.utterance(ready), active, native), /no longer pending/);
    await assert.rejects(assistantRoute("POST", "/v1/assistant/confirm", {}, f.coordinator, native), /not found/);
  } finally { await f.cleanup(); }
  const disabledVoice = await fixture({ voiceApprovalEnabled: false });
  try { await assert.rejects(disabledVoice.propose(), /disabled/); assert.equal(disabledVoice.executions(), 0); } finally { await disabledVoice.cleanup(); }
  const disabled = await fixture({ enabled: false });
  try { assert.throws(() => disabled.coordinator.state(), /disabled/); await assert.rejects(disabled.coordinator.createSession({ title: "test", focus }), /disabled/); }
  finally { await disabled.cleanup(); }
});

test("room plan accept/start require an exact captured room and separate one-use reviews", async () => {
  const f = await fixture();
  try {
    await f.coordinator.updateFocus(f.session!.id, { expectedRevision: 1, focus: { kind: "room", roomId: "room-1" } });
    const turn = await f.turn();
    f.action = { taskId: "room-1", interactionId: "plan-1", revision: 1, optionId: "accept_plan", scope: "room",
      toolName: "harness_accept_plan", exactArguments: '{"roomId":"room-1","planId":"plan-1","revision":1}',
      reviewText: 'Tool: harness_accept_plan\nExact arguments (JSON): {"roomId":"room-1","planId":"plan-1","revision":1}', voiceAllowed: true };
    const ref = { taskId: "room-1", interactionId: "plan-1", revision: 1, optionId: "accept_plan" };
    const proposal = await f.coordinator.proposeAction(f.session!.id, turn.id, ref, native);
    const ready = await f.ready(proposal);
    assert.equal((await f.coordinator.nativeEvent(f.utterance(ready), active, native)).status, "completed");
    await assert.rejects(f.coordinator.proposeAction(f.session!.id, turn.id, ref, native), /already been submitted/);
    f.action = { ...f.action, taskId: "room-2" };
    await assert.rejects(f.coordinator.proposeAction(f.session!.id, turn.id, { ...ref, taskId: "room-2" }, native), /captured task or room/);
    assert.equal(f.executions(), 1);
  } finally { await f.cleanup(); }
});

test("draft edits retain exact old references across restart and reject stale writes or invalid selections", async () => {
  const f = await fixture();
  try {
    const turn = await f.turn();
    const card = await f.coordinator.present({ sessionId: f.session!.id, turnId: turn.id, title: "Draft", content: { kind: "draft", format: "document", title: "Draft", body: "First 😀 paragraph" } });
    const edited = await assistantRoute("PATCH", `/v1/assistant/presentations/${card.id}`, { expectedRevision: 1, body: "Replacement" }, f.coordinator, native);
    assert.equal((edited.body as { revision: number }).revision, 2);
    await assert.rejects(f.coordinator.editDraft(card.id, { expectedRevision: 1, body: "Stale" }), /changed/);
    await f.restart();
    const ref = { presentationId: card.id, revision: 1 };
    await f.coordinator.submitTurn(f.session!.id, { expectedRevision: 1, text: "Rewrite selection", intent: "continue", presentationRef: ref, selection: { kind: "text_range", start: 6, end: 8 } });
    assert.equal(f.dispatched.at(-1)?.capturedPresentation?.revision, 1);
    assert.deepEqual(f.dispatched.at(-1)?.selection, { kind: "text_range", start: 6, end: 8 });
    for (const selection of [{ kind: "text_range", start: 7, end: 8 }, { kind: "table_cell", row: 0, column: 0 }, { kind: "document_passage", passageId: "invented" }]) {
      await assert.rejects(f.coordinator.submitTurn(f.session!.id, { expectedRevision: 1, text: "Invalid", intent: "continue", presentationRef: ref, selection }), /Selection/);
    }
    await assert.rejects(assistantRoute("PATCH", `/v1/assistant/presentations/${card.id}`, { expectedRevision: 2, body: "Untrusted" }, f.coordinator), /Native/);
  } finally { await f.cleanup(); }
});
