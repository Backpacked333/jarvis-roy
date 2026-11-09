import assert from "node:assert/strict";
import test from "node:test";
import { assertCloudPaidAdmission } from "../bridge/cloud-paid-admission.ts";

test("cloud HTTP cannot start unreserved paid research, worker plans or Tavily calls", () => {
  const blocked = ["/v1/research/runs", "/v1/harness/rooms/room/author", "/v1/harness/rooms/room/runs",
    "/v1/harness/rooms/room/%61uthor", "/v1/harness/rooms/room/runs/run/resume", "/v1/harness/rooms/room/runs/run/nodes/node/retry", "/v1/knowledge/extract"];
  for (const path of blocked) {
    assert.throws(() => assertCloudPaidAdmission("POST", path, {}, undefined, "cloud"), /capped objective/);
    assert.doesNotThrow(() => assertCloudPaidAdmission("POST", path, {}, undefined, "local"));
  }
  assert.throws(() => assertCloudPaidAdmission("POST", "/v1/knowledge/retrieve", { provider: "tavily" }, undefined, "cloud"), /capped objective/);
  for (const provider of ["arxiv", "crossref"]) assert.doesNotThrow(() => assertCloudPaidAdmission("POST", "/v1/knowledge/retrieve", { provider }, undefined, "cloud"));
});

test("cloud cancellation and reads remain available, paid worker continuations require an exact live reservation", () => {
  const authority = { hasReservedHarnessChild(projectId: string, runId: string) { return projectId === "room" && runId === "run"; } };
  for (const path of ["/v1/research/runs/run/cancel", "/v1/harness/rooms/room/runs/run/cancel", "/v1/harness/rooms/room/runs/run/pause", "/v1/harness/rooms/room/authorings/author/cancel"]) {
    assert.doesNotThrow(() => assertCloudPaidAdmission("POST", path, {}, undefined, "cloud"));
  }
  assert.doesNotThrow(() => assertCloudPaidAdmission("GET", "/v1/research/runs", {}, undefined, "cloud"));
  assert.doesNotThrow(() => assertCloudPaidAdmission("POST", "/v1/harness/rooms/room/runs/run/resume", {}, authority, "cloud"));
  assert.throws(() => assertCloudPaidAdmission("POST", "/v1/harness/rooms/other/runs/run/resume", {}, authority, "cloud"), /capped objective/);
  const question = { binding: { target: { scope: "node", roomId: "room", runId: "run" } } };
  assert.doesNotThrow(() => assertCloudPaidAdmission("POST", "/v1/harness/questions/question/answer", question, authority, "cloud"));
  assert.throws(() => assertCloudPaidAdmission("POST", "/v1/harness/questions/question/voice-answer", question, undefined, "cloud"), /capped objective/);
  assert.throws(() => assertCloudPaidAdmission("POST", "/v1/harness/questions/question/answer", { binding: { target: { scope: "authoring", roomId: "room" } } }, authority, "cloud"), /capped objective/);
});
