import assert from "node:assert/strict";
import test from "node:test";
import { Diagnostics } from "../bridge/diagnostics.ts";

test("diagnostics retain bounded metadata without arbitrary status content or invalid timings", () => {
  const diagnostics = new Diagnostics();
  diagnostics.record("request.finished", { status: "a private message with spaces", durationMs: Number.NaN });
  assert.equal(diagnostics.snapshot()[0].status, undefined);
  assert.equal(diagnostics.snapshot()[0].durationMs, undefined);
  diagnostics.record("task.state", { status: "waiting", durationMs: -10 });
  assert.equal(diagnostics.snapshot()[1].durationMs, 0);
  assert.equal(diagnostics.snapshot()[1].status, "waiting");
  const copy = diagnostics.snapshot(); copy[1].status = "modified";
  assert.equal(diagnostics.snapshot()[1].status, "waiting");
  for (let index = 0; index < 300; index++) diagnostics.record("request.finished", { status: 200 });
  assert.equal(diagnostics.snapshot().length, 256);
});
