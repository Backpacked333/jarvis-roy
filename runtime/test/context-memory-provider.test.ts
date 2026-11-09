import assert from "node:assert/strict";
import test from "node:test";
import { contextMemoryProvider, CONTEXT_RECALL_ID } from "../agent/lib/context-memory.ts";

const token = "context-provider-test-token-with-32-characters";
const context = (signal = new AbortController().signal, parent: object | null = null) => ({
  session: { id: "bound-session", parent }, abortSignal: signal,
}) as never;

test("automatic recall uses one replaceable message and sends no model-supplied scope or transcript", async () => {
  process.env.JARVIS_LOCAL_TOKEN = token;
  const requests: RequestInit[] = [];
  let content = "Approved preference: use SI units";
  const provider = contextMemoryProvider((async (_url, init) => {
    requests.push(init!);
    return Response.json({ version: 1, content });
  }) as typeof fetch);
  const first = await provider.recall["turn.started"](context());
  content = "No currently authorized context.";
  const second = await provider.recall["turn.started"](context());
  assert.equal(first?.messages[0].id, CONTEXT_RECALL_ID);
  assert.equal(second?.messages[0].id, CONTEXT_RECALL_ID);
  assert.equal(second?.messages[0].content, content);
  assert.equal(requests[0].body, "{}");
  assert.equal(new Headers(requests[0].headers).get("x-jarvis-eve-session"), "bound-session");
  assert.equal(new Headers(requests[0].headers).has("x-jarvis-native-token"), false);
  assert.equal("capture" in provider, false);
});

test("unbound first-session receipt may retry, denied recall never falls back to old memory", async () => {
  process.env.JARVIS_LOCAL_TOKEN = token;
  let calls = 0;
  const provider = contextMemoryProvider((async () => {
    calls++;
    return calls === 1 ? new Response("", { status: 425 }) : Response.json({ version: 1, content: "Current authorized data" });
  }) as typeof fetch);
  assert.match((await provider.recall["turn.started"](context()))!.messages[0].content, /Current/);
  assert.equal(calls, 2);
  const denied = contextMemoryProvider((async () => new Response("", { status: 403 })) as typeof fetch);
  await assert.rejects(denied.recall["turn.started"](context()), /Previous recall must not be reused/);
});

test("delegated, aborted, malformed and unsupported context cannot disclose a packet", async () => {
  process.env.JARVIS_LOCAL_TOKEN = token;
  let calls = 0;
  const provider = contextMemoryProvider((async () => { calls++; return Response.json({ version: 2, content: "Invalid" }); }) as typeof fetch);
  const delegated = await provider.recall["turn.started"](context(undefined, {}));
  assert.match(delegated!.messages[0].content, /No personal context/);
  assert.equal(calls, 0);
  await assert.rejects(provider.recall["turn.started"](context(AbortSignal.abort())), /abort/i);
  assert.equal(calls, 0);
  await assert.rejects(provider.recall["turn.started"](context()));
});
