import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RoomPolicySchema, RelativePathSchema, ImageRefSchema, defaultRoomPolicy } from "../bridge/harness-contracts/domain.ts";
import { assertAnswerMatches, QuestionSchema, questionBinding } from "../bridge/harness-contracts/interactions.ts";
import { acceptPlan, artifactDigest, canonicalJson, planDigest, validateArtifact, validatePlan } from "../bridge/harness-contracts/validation.ts";
import { HarnessEventsSchema, HarnessStateSchema } from "../bridge/harness-contracts/service.ts";
import { WorkerCheckpointSchema, WorkerSpecSchema } from "../bridge/harness-contracts/worker.ts";
import { parseVoiceClientFrame, VoiceGenerationGate, VoiceServerFrameSchema } from "../bridge/harness-contracts/voice.ts";
import { dialogueWebSocketUrl, recognitionWebSocketUrl, DialogueInitializeSchema, DialogueTextSchema,
  DialogueAudioSchema, DialogueTurnEndSchema, DialogueClosedSchema, RecognitionTranscriptSchema } from "../bridge/harness-contracts/elevenlabs.ts";

const fixture = JSON.parse(readFileSync(new URL("../../contracts/fixtures/harness-v1.json", import.meta.url), "utf8"));
const state = HarnessStateSchema.parse(fixture.state);
const policy = state.rooms[0].policy;
const now = new Date("2026-11-06T18:00:00.000Z");
const draft = () => structuredClone(fixture.draft);

test("shared native/runtime fixture validates with an immutable accepted graph and manifest", () => {
  assert.equal(state.version, 1);
  assert.equal(validatePlan(state.plans[0], policy).digest, planDigest(state.plans[0]));
  assert.equal(validateArtifact(state.artifacts[0], policy).digest, artifactDigest(state.artifacts[0]));
  assert.equal(HarnessEventsSchema.parse(fixture.events).events[0].type, "question.updated");
  assert.equal(QuestionSchema.parse(fixture.authoringQuestion).target.scope, "authoring");
});

test("acceptance clones and freezes the graph; later edits invalidate the accepted digest", () => {
  const input = draft();
  const accepted = acceptPlan(input, policy, now);
  input.nodes[0].instructions = "changed";
  assert.notEqual(accepted.nodes[0].instructions, input.nodes[0].instructions);
  assert.throws(() => { accepted.nodes[0].instructions = "changed"; }, TypeError);
  assert.throws(() => acceptPlan(accepted, policy), /already accepted/);
  const edited = structuredClone(accepted);
  edited.nodes[0].instructions = "changed";
  assert.throws(() => validatePlan(edited, policy), /digest/);
});

test("graph rejects cycles, duplicate IDs, unknown dependencies and unscheduled artifact access", () => {
  const bad = draft(); bad.nodes[0].dependencies = ["verify"];
  assert.throws(() => validatePlan(bad, policy), /cycle/);
  const duplicate = draft(); duplicate.nodes[1].id = duplicate.nodes[0].id;
  assert.throws(() => validatePlan(duplicate, policy), /Duplicate node/);
  const missing = draft(); missing.nodes[0].dependencies = ["missing"];
  assert.throws(() => validatePlan(missing, policy), /Unknown dependency/);
  const unscoped = draft(); unscoped.nodes[0].inputFrom = ["build"];
  assert.throws(() => validatePlan(unscoped, policy), /upstream/);
});

test("policy, fan-out and aggregate reservations bound accepted plans", () => {
  assert.equal(defaultRoomPolicy().sandbox.image, null);
  assert.equal(defaultRoomPolicy().sandbox.network, "none");
  assert.throws(() => defaultRoomPolicy("python:latest"));
  const stale = draft(); stale.policyRevision++;
  assert.throws(() => validatePlan(stale, policy), /stale/);
  assert.throws(() => validatePlan(draft(), { ...policy, maxNodes: 2 }), /node limit/);
  assert.throws(() => validatePlan(draft(), { ...policy, maxDependenciesPerNode: 1 }), /fan-in/);
  const excess = draft(); excess.nodes[0].limits.maxTokens++;
  assert.throws(() => validatePlan(excess, policy), /reservations/);
  const authority = draft(); authority.nodes[0].hostTools = ["terminal"];
  assert.throws(() => validatePlan(authority, policy));
  assert.equal(RoomPolicySchema.safeParse({ ...policy, hostActions: "automatic" }).success, false);
  assert.equal(RoomPolicySchema.safeParse({ ...policy, sandbox: { ...policy.sandbox, network: "host" } }).success, false);
});

test("paths and explicit image pins reject traversal, host paths and mutable images", () => {
  for (const path of ["../secret", "/etc/passwd", "a//b", "a/./b", "C:\\secret", "a\\b", "a\u0000b", "%2e%2e/x", "x%252fy"]) {
    assert.equal(RelativePathSchema.safeParse(path).success, false, path);
  }
  assert.equal(RelativePathSchema.parse("src/index.html"), "src/index.html");
  for (const image of ["python:latest", "python:3.12", "", "sha256:abc"]) assert.equal(ImageRefSchema.safeParse(image).success, false);
  assert.equal(ImageRefSchema.safeParse(`python@sha256:${"a".repeat(64)}`).success, true);
});

test("manifest content changes and excessive artifact budgets are rejected", () => {
  const artifact = structuredClone(state.artifacts[0]); artifact.files[0].sha256 = "0".repeat(64);
  assert.throws(() => validateArtifact(artifact, policy), /digest/);
  const huge = structuredClone(state.artifacts[0]); huge.files[0].bytes = policy.sandbox.maxArtifactBytes + 1;
  assert.throws(() => validateArtifact(huge, policy), /bytes/);
  const duplicate = structuredClone(state.artifacts[0]); duplicate.files.push(duplicate.files[0]);
  assert.throws(() => validateArtifact(duplicate, policy), /Duplicate/);
});

test("answers bind exact room/run/node/attempt/question revision and never accept approvals", () => {
  const question = state.questions[0];
  assert.equal(assertAnswerMatches(question, fixture.answer, now).choiceId, "dark");
  for (const key of ["roomId", "runId", "nodeId", "attemptId"] as const) {
    const answer = structuredClone(fixture.answer); answer.binding.target[key] = "other";
    assert.throws(() => assertAnswerMatches(question, answer, now), /binding/);
  }
  const stale = structuredClone(fixture.answer); stale.binding.revision++;
  assert.throws(() => assertAnswerMatches(question, stale, now), /binding/);
  assert.throws(() => assertAnswerMatches({ ...question, status: "answered" }, fixture.answer, now), /pending/);
  assert.throws(() => assertAnswerMatches(question, fixture.answer, new Date("2026-11-08T00:00:00Z")), /pending/);
  assert.throws(() => assertAnswerMatches(question, { ...fixture.answer, choiceId: "approve" }, now), /Unknown/);
  assert.equal(QuestionSchema.safeParse(state.approvals[0]).success, false);
  assert.deepEqual(questionBinding(question), fixture.answer.binding);
});

test("resume is inert data, tied to a prior attempt and a new isolated execution", () => {
  const checkpoint = WorkerCheckpointSchema.parse(fixture.checkpoint);
  const spec = { version: 1, ref: { ...checkpoint.ref, attemptId: "attempt_build_2" },
    planDigest: state.plans[0].digest, node: state.plans[0].nodes[1], policy, inputs: [], checkpoint, answer: fixture.answer };
  assert.equal(WorkerSpecSchema.parse(spec).checkpoint?.resumeMode, "continue_after_answer");
  assert.equal(WorkerSpecSchema.safeParse({ ...spec, ref: checkpoint.ref }).success, false);
  assert.equal(WorkerSpecSchema.safeParse({ ...spec, answer: null }).success, false);
  assert.equal(WorkerSpecSchema.safeParse({ ...spec, inputs: state.artifacts }).success, false);
  assert.equal(WorkerCheckpointSchema.safeParse({ ...checkpoint, pickle: "gASV" }).success, false);
  const wrong = structuredClone(spec); wrong.answer.binding.target.attemptId = "other";
  assert.equal(WorkerSpecSchema.safeParse(wrong).success, false);
});

test("voice fixture validates canonical PCM bounds and context-scoped transcription", () => {
  for (const frame of fixture.voiceClientFrames) assert.doesNotThrow(() => parseVoiceClientFrame(JSON.stringify(frame)));
  for (const frame of fixture.voiceServerFrames) assert.doesNotThrow(() => VoiceServerFrameSchema.parse(frame));
  const audio = fixture.voiceClientFrames[1];
  for (const pcm of ["bad", "AA==", "AB==", Buffer.alloc(16_002).toString("base64")]) {
    assert.throws(() => parseVoiceClientFrame(JSON.stringify({ ...audio, pcm })));
  }
  assert.throws(() => parseVoiceClientFrame(" ".repeat(32_769)));
  const start = structuredClone(fixture.voiceClientFrames[0]); start.context.roomId = "other";
  assert.throws(() => parseVoiceClientFrame(JSON.stringify(start)));
});

test("voice generations reject stale callbacks, skipped frames and duplicate PCM", () => {
  const gate = new VoiceGenerationGate(); gate.advance("session", 1);
  assert.equal(gate.acceptAudio("session", 1, 0), true);
  assert.equal(gate.acceptAudio("session", 1, 0), false);
  assert.equal(gate.acceptAudio("session", 1, 2), false);
  gate.advance("session", 2);
  assert.equal(gate.accepts("session", 1), false);
  assert.equal(gate.acceptAudio("session", 2, 0), true);
  assert.throws(() => gate.advance("other", 3));
  assert.throws(() => gate.advance("session", 2));
});

test("canonical manifests hash only inert, deterministic JSON", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
  for (const invalid of [NaN, undefined, () => 1, new Date()]) assert.throws(() => canonicalJson(invalid));
});

test("official ElevenLabs TTD and Scribe shapes are not conflated with legacy TTS", () => {
  const provider = fixture.providerExamples;
  assert.equal(new URL(dialogueWebSocketUrl()).pathname, "/v1/text-to-dialogue/stream-input");
  assert.equal(new URL(dialogueWebSocketUrl()).searchParams.get("model_id"), "eleven_v4_turbo");
  assert.equal(new URL(recognitionWebSocketUrl()).searchParams.get("model_id"), "scribe_v2_realtime");
  assert.equal(DialogueInitializeSchema.parse(provider.ttdInitialize).voices.length, 1);
  assert.equal(DialogueTextSchema.parse(provider.ttdText).flush, true);
  assert.equal(DialogueAudioSchema.parse(provider.ttdAudio).audio, "AAAAAA==");
  assert.equal(DialogueTurnEndSchema.parse(provider.ttdEnd).is_final_audio_for_turn, true);
  assert.equal(DialogueClosedSchema.parse(provider.ttdClosed).is_final, true);
  assert.equal(RecognitionTranscriptSchema.parse(provider.sttPartial).message_type, "partial_transcript");
  assert.equal(RecognitionTranscriptSchema.parse(provider.sttCommitted).message_type, "committed_transcript");
  assert.equal(DialogueClosedSchema.safeParse({ isFinal: true }).success, false);
  assert.equal(DialogueInitializeSchema.safeParse({ voices: ["a", "b"] }).success, false);
});
