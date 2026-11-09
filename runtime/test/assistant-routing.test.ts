import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantRuntime } from "../bridge/assistant-runtime.ts";
import type { HarnessRuntime } from "../bridge/harness-runtime.ts";
import { JarvisService } from "../bridge/service.ts";
import type { EveClient, EveSession } from "../bridge/types.ts";
import { event, FakeDelivery } from "./helpers.ts";

class RoutingSession implements EveSession {
  readonly id = randomUUID();
  readonly messages: string[] = [];
  async send(message: string) {
    this.messages.push(message);
    const sequence = this.messages.length;
    return new FakeDelivery([event("turn.started", { turnId: `turn-${sequence}` }, sequence)],
      { status: "completed", reply: `Answer ${sequence}` });
  }
  async respond(): Promise<never> { throw new Error("Routing fixture has no approval"); }
  async cancel() { return new FakeDelivery([], { status: "cancelled" }); }
}

test("room side questions keep an independent conversation while later work resumes the main Eve session", async t => {
  const previous = process.env.JARVIS_ENABLE_ASSISTANT;
  process.env.JARVIS_ENABLE_ASSISTANT = "1";
  const directory = await mkdtemp(join(tmpdir(), "jarvis-assistant-routing-"));
  const sessions = new Map<string, RoutingSession>();
  const client: EveClient = {
    async health() { return { ok: true }; },
    sessions: {
      async create({ message }) {
        const session = new RoutingSession(); sessions.set(session.id, session);
        return { session, delivery: await session.send(message) };
      },
      attach(id) { const session = sessions.get(id); assert.ok(session); return session; },
    },
  };
  const service = await JarvisService.create({ client, dataDirectory: directory, model: "fixture/model" });
  // Only the room existence lookup participates in routing; no worker or provider is involved.
  const harness = { harness: { async state() { return { rooms: [{ id: "research-room" }] }; } } } as unknown as HarnessRuntime;
  const assistant = await createAssistantRuntime(directory, service, harness);
  t.after(async () => {
    await service.drain(); await assistant.close();
    if (previous === undefined) delete process.env.JARVIS_ENABLE_ASSISTANT; else process.env.JARVIS_ENABLE_ASSISTANT = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const session = await assistant.coordinator.createSession({ title: "Research", focus: { kind: "room", roomId: "research-room" } });
  async function turn(text: string, intent: "continue" | "side_question") {
    const turn = await assistant.coordinator.submitTurn(session.id, { expectedRevision: session.revision, text, intent });
    await service.drain();
    for (const task of service.taskSnapshot()) await assistant.coordinator.updateTask(task);
    assert.ok(turn.conversationId); return turn;
  }
  const main = await turn("Investigate the main problem", "continue");
  const side = await turn("Explain this incidental term", "side_question");
  const followup = await turn("Continue the main investigation", "continue");
  assert.notEqual(side.conversationId, main.conversationId);
  assert.equal(followup.conversationId, main.conversationId);
  assert.equal(sessions.size, 2);
  assert.deepEqual([...sessions.values()].map(value => value.messages), [
    ["Investigate the main problem", "Continue the main investigation"], ["Explain this incidental term"],
  ]);
  for (const eve of sessions.values()) assert.equal(service.contextForEveSession(eve.id)!.projectId, "research-room");
});
