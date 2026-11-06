import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { BridgeError } from "./errors.ts";
import { createHarnessKernel } from "./harness-kernel/index.ts";
import { createWorkerRunner } from "./harness-worker/index.ts";
import { createPlanAuthor, createQuestionRouter } from "./harness-interactions/index.ts";
import { createVoiceBridge } from "./harness-voice/index.ts";
import { defaultRoomPolicy, DigestSchema, IdSchema, RelativePathSchema } from "./harness-contracts/domain.ts";
import { AnswerQuestionRequestSchema, VoiceAnswerRequestSchema } from "./harness-contracts/interactions.ts";
import { type VoiceBridge } from "./harness-contracts/voice.ts";
import { type WorkerRunner } from "./harness-contracts/worker.ts";
import {
  AcceptPlanRequestSchema, AuthorPlanRequestSchema, CreateRoomRequestSchema, RetryNodeRequestSchema,
  RunControlRequestSchema, StartRunRequestSchema, UpdatePlanRequestSchema, UpdateRoomRequestSchema,
  type HarnessService, type QuestionRouter,
} from "./harness-contracts/service.ts";
import type { JarvisService } from "./service.ts";

export interface HarnessRuntime {
  harness: HarnessService;
  worker: WorkerRunner;
  questions: QuestionRouter;
  voice: VoiceBridge;
  stopping: boolean;
}

export async function createHarnessRuntime(dataDirectory: string, model: string): Promise<HarnessRuntime> {
  const worker = createWorkerRunner({ dataDirectory, model, dockerBinary: process.env.JARVIS_DOCKER_BINARY });
  const harness = createHarnessKernel({ dataDirectory, worker, author: createPlanAuthor({ model }),
    defaultPolicy: defaultRoomPolicy(process.env.JARVIS_WORKER_IMAGE || null), maxActiveWorkers: 2 });
  await harness.initialize();
  return { harness, worker, questions: createQuestionRouter({ harness }), stopping: false,
    voice: createVoiceBridge({ apiKey: process.env.ELEVENLABS_API_KEY, voiceId: process.env.ELEVENLABS_VOICE_ID }) };
}

const roomStops = new WeakSet<HarnessRuntime>();

export async function stopHarness(runtime: HarnessRuntime, timeoutMs = 20_000): Promise<void> {
  if (roomStops.has(runtime)) throw new BridgeError("Stop is already in progress; refresh for confirmation.", 409);
  roomStops.add(runtime);
  runtime.stopping = true;
  const deadline = performance.now() + timeoutMs;
  const unconfirmed = () => new BridgeError("Room cleanup is unconfirmed. Admission remains closed; inspect runs and explicitly retry Stop all to reconcile.", 503);
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw unconfirmed();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(unconfirmed()), remaining);
      })]);
    } finally { clearTimeout(timer); }
  };
  const settledRun = (run: Awaited<ReturnType<HarnessService["state"]>>["runs"][number]) =>
    run.status === "completed" || (run.status === "cancelled" && run.cancelConfirmed);
  const authoritativeState = async () => {
    const state = await bounded(() => runtime.harness.state());
    if (!state.ready) throw unconfirmed();
    return state;
  };
  try {
    const initial = await authoritativeState();
    const targets = [
      ...initial.authorings.filter((a) => ["authoring", "waiting_question"].includes(a.status)).map((a) => ({ kind: "author" as const, id: a.id })),
      ...initial.runs.filter((r) => !settledRun(r)).map((r) => ({ kind: "run" as const, id: r.id })),
    ];
    const results = await Promise.allSettled(targets.map(async (target) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const state = await authoritativeState();
        const value = target.kind === "author" ? state.authorings.find((a) => a.id === target.id) : state.runs.find((r) => r.id === target.id);
        if (!value) throw unconfirmed();
        if (target.kind === "author" ? ["completed", "failed", "cancelled"].includes(value.status) : settledRun(state.runs.find((r) => r.id === target.id)!)) return;
        try {
          if (target.kind === "author") await bounded(() => runtime.harness.cancelAuthoring(value.roomId, value.id, { expectedRevision: value.revision }));
          else await bounded(() => runtime.harness.cancelRun(value.roomId, value.id, { expectedRevision: value.revision }));
          return;
        } catch (error) { if (!(error instanceof BridgeError) || error.status !== 409 || attempt === 7) throw error; }
      }
    }));
    if (results.some((r) => r.status === "rejected")) throw unconfirmed();
    while (true) {
      const state = await authoritativeState();
      const confirmed = targets.every((target) => target.kind === "run"
        ? state.runs.some((run) => run.id === target.id && settledRun(run))
        : state.authorings.some((author) => author.id === target.id && ["completed", "failed", "cancelled"].includes(author.status)));
      if (confirmed) break;
      await bounded(() => delay(25));
    }
    runtime.stopping = false;
  } finally { roomStops.delete(runtime); }
}

type Reply = { status: number; body: unknown } | { status: number; bytes: Uint8Array };
export async function harnessRoute(method: string, url: URL, body: () => Promise<unknown>, runtime: HarnessRuntime, service: JarvisService): Promise<Reply> {
  if (runtime.stopping && method !== "GET" && !(method === "POST" && /^\/v1\/harness\/rooms\/[^/]+\/(runs|authorings)\/[^/]+\/cancel$/.test(url.pathname))) {
    throw new BridgeError("Rooms are stopping or cleanup is unconfirmed. Inspect status and explicitly retry Stop all.", 409);
  }
  const h = runtime.harness;
  const reply = (body: unknown, status = 200): Reply => ({ status, body });
  const parts = url.pathname.split("/").filter(Boolean).slice(2).map((p) => IdSchema.parse(decodeURIComponent(p)));
  if (method === "GET" && parts.join("/") === "state") {
    return reply({ ...await h.state(), approvals: service.harnessApprovals() });
  }
  if (method === "GET" && parts.join("/") === "events") {
    const after = url.searchParams.get("after") ?? "0";
    if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) throw new BridgeError("Invalid event cursor.", 400);
    return reply(await h.events(Number(after), url.searchParams.has("roomId") ? IdSchema.parse(url.searchParams.get("roomId")) : undefined));
  }
  if (method === "POST" && parts.join("/") === "rooms") return reply(await h.createRoom(CreateRoomRequestSchema.parse(await body())), 201);
  if (parts[0] === "questions" && parts.length === 3 && method === "POST") {
    if (parts[2] === "answer") {
      const input = AnswerQuestionRequestSchema.parse(await body());
      if (input.binding.questionId !== parts[1]) throw new BridgeError("Question URL and binding differ.", 409);
      return reply(await h.answerQuestion(input));
    }
    if (parts[2] === "voice-answer") {
      const input = VoiceAnswerRequestSchema.parse(await body());
      if (input.binding.questionId !== parts[1]) throw new BridgeError("Question URL and binding differ.", 409);
      try { return reply(await runtime.questions.answerVoice(input)); }
      catch (error) { if (error instanceof BridgeError || error instanceof z.ZodError) throw error; throw new BridgeError("Voice answer was not applied. Refresh and use the exact pending question.", 409); }
    }
  }
  if (parts[0] === "rooms" && parts.length >= 2) {
    const room = parts[1];
    if (parts.length === 2 && method === "PATCH") return reply(await h.updateRoom(room, UpdateRoomRequestSchema.parse(await body())));
    if (parts.length === 3 && parts[2] === "author" && method === "POST") return reply(await h.authorPlan(room, AuthorPlanRequestSchema.parse(await body())), 202);
    if (parts.length === 5 && parts[2] === "authorings" && parts[4] === "cancel" && method === "POST") return reply(await h.cancelAuthoring(room, parts[3], RunControlRequestSchema.parse(await body())));
    if (parts[2] === "plans") {
      if (parts.length === 4 && method === "PUT") return reply(await h.updatePlan(room, parts[3], UpdatePlanRequestSchema.parse(await body())));
      if (parts.length === 5 && parts[4] === "accept" && method === "POST") return reply(await h.acceptPlan(room, parts[3], AcceptPlanRequestSchema.parse(await body())));
    }
    if (parts[2] === "runs") {
      if (parts.length === 3 && method === "POST") return reply(await h.startRun(room, StartRunRequestSchema.parse(await body())), 202);
      if (parts.length === 5 && method === "POST" && ["pause", "resume", "cancel"].includes(parts[4])) {
        const input = RunControlRequestSchema.parse(await body());
        return reply(await (parts[4] === "pause" ? h.pauseRun(room, parts[3], input) : parts[4] === "resume" ? h.resumeRun(room, parts[3], input) : h.cancelRun(room, parts[3], input)));
      }
      if (parts.length === 7 && parts[4] === "nodes" && parts[6] === "retry" && method === "POST") return reply(await h.retryNode(room, parts[3], parts[5], RetryNodeRequestSchema.parse(await body())));
      if (parts.length === 7 && parts[4] === "artifacts" && parts[6] === "content" && method === "GET") {
        const path = RelativePathSchema.parse(url.searchParams.get("path"));
        const digest = DigestSchema.parse(url.searchParams.get("digest"));
        const manifest = await h.artifact(room, parts[3], parts[5]);
        if (manifest.digest !== digest) throw new BridgeError("Artifact revision does not match.", 409);
        if (!manifest.files.some((f) => f.path === path)) throw new BridgeError("Artifact file not found.", 404);
        const result = await runtime.worker.artifacts.read({ roomId: room, runId: parts[3], artifactId: parts[5], digest }, path, 64 * 1024 * 1024);
        return { status: 200, bytes: result.bytes };
      }
    }
  }
  throw new BridgeError("Harness route not found.", 404);
}
