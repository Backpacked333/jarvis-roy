import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { explainModelFailure } from "../bridge/provider-errors.ts";
import { JarvisService } from "../bridge/service.ts";
import { FakeDelivery, FakeEveClient, event } from "./helpers.ts";

async function settle(service: JarvisService, id: string) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    let task = (await service.state()).tasks.find((value) => value.id === id);
    if (task && !["starting", "running"].includes(task.status)) {
      // The status changes on the first failure event; the reason arrives with a later one.
      await service.waitForObservedDelivery(id);
      task = (await service.state()).tasks.find((value) => value.id === id);
      if (task) return task;
    }
    if (Date.now() > deadline) throw new Error("Timed out waiting for the task to settle.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// The exact sequence the agent runtime produces when the gateway rejects the model key:
// the delivery fails, the abandoned turn is settled as "cancelled", then the session ends failed.
for (const result of [{ status: "cancelled" }, { status: "failed", error: { message: "AI Gateway rejected the provided API key." } }]) {
  test(`a rejected model key ends as a failure with its reason when the delivery reports ${result.status}`, async (t) => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "jarvis-provider-failure-"));
    t.after(() => rm(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }));
    const client = new FakeEveClient();
    client.session.initial = new FakeDelivery([
      event("turn.started", { turnId: "turn-1" }, 1),
      event("delivery.settled", { deliveryId: "initial", outcome: "failed" }, 2),
      event("turn.settled", { turnId: "turn-1", outcome: "cancelled" }, 3),
      event("session.ended", { outcome: "failed", error: { message: "AI Gateway rejected the provided API key." } }, 4),
    ], result);
    const service = await JarvisService.create({ client, dataDirectory, model: "test/model" });
    const created = await service.createTask("Say hi");
    const task = await settle(service, created.id);
    // Nobody pressed Stop, so this must never read as a cancellation the person asked for.
    assert.equal(task.status, "failed");
    assert.match(task.error ?? "", /rejected the model key/);
    assert.match(task.error ?? "", /Settings → Provider credentials/);
    assert.equal(client.session.cancelCalls, 0);
  });
}

test("a Stop the person asked for is still confirmed as a cancellation", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "jarvis-provider-cancel-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }));
  const client = new FakeEveClient();
  client.session.initial = new FakeDelivery([event("turn.started", { turnId: "turn-1" }, 1)]);
  const service = await JarvisService.create({ client, dataDirectory, model: "test/model" });
  const created = await service.createTask("Long work");
  const deadline = Date.now() + 2_000;
  while ((await service.state()).tasks.find((value) => value.id === created.id)?.status !== "running") {
    if (Date.now() > deadline) throw new Error("The task never started running.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await service.cancel(created.id);
  const task = await settle(service, created.id);
  assert.equal(task.status, "cancelled");
  assert.equal(task.error, undefined);
});

test("known provider failures are explained with the fix, and unknown ones are left as they are", () => {
  assert.match(explainModelFailure("AI Gateway rejected the provided API key."), /rejected the model key/);
  assert.match(explainModelFailure("AI Gateway authentication failed"), /rejected the model key/);
  assert.match(explainModelFailure("Insufficient funds. Please add credits to your account."), /no credits left/);
  assert.match(explainModelFailure("Rate limit exceeded, retry later"), /limiting requests/);
  assert.match(explainModelFailure('Model "vendor/unknown" not found'), /configured model is not available/);
  assert.match(explainModelFailure('Cannot select model "vendor/new" because this build has no context window for it.'), /configured model is not available/);
  assert.match(explainModelFailure("fetch failed"), /could not reach/);
  assert.match(explainModelFailure("getaddrinfo ENOTFOUND ai-gateway.vercel.sh"), /could not reach/);
  assert.match(explainModelFailure("Service Unavailable"), /temporarily unavailable/);
  assert.equal(explainModelFailure("The tool returned malformed JSON."), "The tool returned malformed JSON.");
  assert.match(explainModelFailure("  "), /without giving a reason/);
});
