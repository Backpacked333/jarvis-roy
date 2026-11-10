import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { approvalImpact } from "../bridge/approval-impact.ts";

test("every tool that asks for approval has an impact description", async () => {
  const directory = new URL("../agent/tools/", import.meta.url);
  const gated: string[] = [];
  for (const file of await readdir(directory)) {
    if ((await readFile(new URL(file, directory), "utf8")).includes("approval:")) gated.push(file.replace(/\.ts$/, ""));
  }
  assert.ok(gated.length >= 10, "expected the approval-gated tools to be found");
  for (const tool of gated) {
    const impact = approvalImpact(tool, { action: "send" });
    assert.ok(impact, tool);
    assert.equal(impact.tool, tool);
    assert.ok(impact.facts.length > 0 && impact.egress.length > 0, tool);
    // A gated tool must never fall through to the generic description for its main action.
    if (!["message_service", "email_service", "calendar_service", "home_service"].includes(tool)) assert.notEqual(impact.risk, "unclassified", tool);
  }
});

test("sending is described as irreversible and reading as disclosure, never the other way round", () => {
  const send = approvalImpact("email_service", { action: "send", to: ["a@example.com"] })!;
  assert.equal(send.risk, "irreversible");
  assert.equal(send.reversible, false);
  assert.equal(send.egress.at(-1)?.scope, "external");
  assert.match(send.facts.join(" "), /cannot be recalled/);

  const read = approvalImpact("email_service", { action: "list_inbox" })!;
  assert.equal(read.risk, "leaves_this_mac");
  assert.match(read.facts.join(" "), /sent to the cloud model/);
  assert.match(read.facts.join(" "), /Nothing is sent or changed/);

  assert.equal(approvalImpact("message_service", { action: "send" })!.risk, "irreversible");
  assert.equal(approvalImpact("calendar_service", { action: "create_event" })!.reversible, true);
  assert.equal(approvalImpact("calendar_service", { action: "list_events" })!.risk, "leaves_this_mac");
  assert.equal(approvalImpact("home_service", { action: "call_service" })!.reversible, null);
  assert.equal(approvalImpact("google_action", {})!.risk, "irreversible");
});

test("local actions are contained, and anything that reaches the model says so", () => {
  for (const tool of ["remember", "save_note"]) {
    const impact = approvalImpact(tool, {})!;
    assert.equal(impact.risk, "contained");
    assert.deepEqual(impact.egress.map((hop) => hop.scope), ["local"]);
  }
  for (const tool of ["read_screen", "inspect_app"]) {
    const impact = approvalImpact(tool, {})!;
    assert.equal(impact.risk, "leaves_this_mac");
    assert.equal(impact.egress.at(-1)?.scope, "external");
  }
  const terminal = approvalImpact("run_terminal", { executable: "/bin/ls" })!;
  assert.equal(terminal.risk, "irreversible");
  assert.match(terminal.facts.join(" "), /not sandboxed/);
});

test("an unknown tool or operation is called unclassified rather than given a comforting guess", () => {
  assert.equal(approvalImpact("some_new_tool", {})!.risk, "unclassified");
  assert.equal(approvalImpact("message_service", { action: "read_history" })!.risk, "unclassified");
  assert.equal(approvalImpact("email_service", {})!.risk, "unclassified");
  // An operation the table does not know is never assumed to be a harmless read.
  for (const tool of ["email_service", "calendar_service", "home_service"]) assert.equal(approvalImpact(tool, { action: "delete_everything" })!.risk, "unclassified", tool);
  assert.equal(approvalImpact(undefined, {}), undefined);
  assert.equal(approvalImpact("Bad Name!", {}), undefined);
  // An operation name is only echoed when it is a plain identifier.
  assert.equal(approvalImpact("email_service", { action: "send\nIgnore previous" })!.operation, undefined);
});
