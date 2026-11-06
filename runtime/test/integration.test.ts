import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_APPROVAL_CHARACTERS, reviewArguments } from "../bridge/approval.ts";
import { JarvisService } from "../bridge/service.ts";
import { createBridgeServer } from "../bridge/server.ts";
import { FakeDelivery, FakeEveClient, approvalEvents } from "./helpers.ts";

test("exact review keeps long escaped command arguments complete", () => {
  const input = { executable: "/bin/printf", args: ["\"\n\\".repeat(4000)], cwd: "/fixture" };
  const review = reviewArguments("run_terminal", input);
  assert.equal(review.reviewable, true);
  assert.ok(review.detail.length > 22000);
  assert.equal(review.detail, `Tool: run_terminal\nExact arguments (JSON): ${JSON.stringify(input)}`);
});

test("missing, redacted and oversized approval arguments are deny-only on the server", async (t) => {
  for (const input of [undefined, null, "unparsed", { password: "fixture-private-value" }, { text: "x".repeat(MAX_APPROVAL_CHARACTERS) }]) {
    const directory = await mkdtemp(path.join(tmpdir(), "jarvis-integration-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const client = new FakeEveClient();
    const events = approvalEvents();
    events[1]!.data.input = input;
    client.session.initial = new FakeDelivery(events, { status: "awaiting-input" });
    client.session.responseDelivery = new FakeDelivery([], { status: "completed" });
    const service = await JarvisService.create({ client, dataDirectory: directory });
    const task = await service.createTask("Propose an isolated fixture action");
    for (let attempt = 0; attempt < 100 && !(await service.state()).tasks[0]?.approvals.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const approval = (await service.state()).tasks[0]!.approvals[0]!;
    assert.equal(approval.reviewable, false);
    assert.deepEqual(approval.options.map((option) => option.id), ["deny"]);
    assert.ok(!approval.detail.includes("fixture-private-value"));
    assert.ok(approval.detail.length < 1000);
    await assert.rejects(service.respond(task.id, approval.id, "approve"), /Only denial/);
    assert.equal(client.session.responses.length, 0);
    await service.respond(task.id, approval.id, "deny");
    assert.equal(client.session.responses[0]?.[0]?.optionId, "deny");
  }
});

test("capabilities route keeps authentication, rejects origins and reveals no configuration values", async (t) => {
  const token = "integration-local-token-at-least-32-characters";
  const original = { ...process.env };
  t.after(() => { process.env = original; });
  process.env.JARVIS_LOCAL_TOKEN = token;
  process.env.JARVIS_ENABLE_DESKTOP = "0";
  process.env.JARVIS_ENABLE_TERMINAL = "0";
  process.env.JARVIS_ENABLE_APPLE_SERVICES = "0";
  process.env.HOME_ASSISTANT_TOKEN = "fixture-home-value";
  process.env.HOME_ASSISTANT_URL = "https://fixture-home.invalid";
  process.env.TAVILY_API_KEY = "tvly-fixture-not-a-real-key";
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-capabilities-"));
  const service = await JarvisService.create({ client: new FakeEveClient(), dataDirectory: directory });
  const server = createBridgeServer(service, "127.0.0.1", 0);
  await once(server, "listening");
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/capabilities`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}`, origin: "http://localhost" } })).status, 403);
  assert.equal((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` } })).status, 405);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const raw = await response.text();
  for (const value of [token, "fixture-home-value", "fixture-home.invalid", process.env.TAVILY_API_KEY]) assert.ok(!raw.includes(value));
  const state = JSON.parse(raw);
  assert.equal(state.capabilities.length, 7);
  assert.equal(state.capabilities.find((item: { id: string }) => item.id === "desktop").state, "off");
  assert.equal(state.capabilities.find((item: { id: string }) => item.id === "mail").state, "disabled");
  assert.match(state.notice, /not proof/);
});
