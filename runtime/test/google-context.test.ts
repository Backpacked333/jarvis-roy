import assert from "node:assert/strict";
import { test } from "node:test";
import { createRetainedContextProviders } from "../bridge/retained-context.ts";
import { createContextAssembler } from "../bridge/context/index.ts";
const entry = { id: "retained-message", accountId: "account", projectId: "project", provider: "gmail", resourceId: "INBOX", externalId: "message-id",
  sourceRevision: "3:provider-version", accountRevision: 3, updatedAt: "2026-11-09T12:00:00.000Z", content: { subject: "Research meeting", text: "Discuss fatigue calculations tomorrow." }, cloudAllowed: true, retentionAllowed: true };
const request = { scope: { projectId: "project", conversationId: "conversation", taskId: "task" }, purpose: "cloud", query: "fatigue calculations", currentTurn: { text: "Prepare for the research meeting" } };
function fixture(value = entry) {
  let allowed = true, checks = 0;
  const providers = createRetainedContextProviders({ runtimeToken: "private-runtime-token-at-least-32-characters", fetch: (async (input, init) => {
    assert.equal(new Headers(init?.headers).get("x-jarvis-cloud-runtime-token"), "private-runtime-token-at-least-32-characters");
    const body = JSON.parse(String(init?.body)); assert.equal(body.projectId, "project");
    if (String(input).endsWith("google-context/authorize")) { checks++; assert.deepEqual(body.references, [{ id: entry.id, sourceRevision: entry.sourceRevision }]); return Response.json({ version: 1, authorized: allowed }); }
    if (String(input).endsWith("google-context")) return Response.json({ version: 1, entries: [value] });
    if (String(input).endsWith("/authorize")) return Response.json({ version: 1, authorized: true });
    return Response.json({ version: 1, snapshots: [] });
  }) as typeof fetch });
  return { assembler: createContextAssembler({ providers, authorizeScope() {} }), revoke() { allowed = false; }, checks: () => checks };
}
test("approved Google retained records enter scoped context with exact account revision and fresh consent checks", async () => {
  const f = fixture(); const packet = await f.assembler.assemble(request);
  assert.equal(packet.selections.length, 1); const selection = packet.selections[0];
  assert.equal(selection.provenance.origin, "account_context"); assert.equal(selection.accountContext!.sourceRevision, entry.sourceRevision);
  assert.equal(selection.accountContext!.provider, "gmail"); assert(selection.text.includes("fatigue calculations")); assert(f.checks() > 0);
  f.revoke(); await assert.rejects(f.assembler.revalidateAsync(packet), /permission changed/);
  await assert.rejects(f.assembler.assemble(request), /permission changed/);
  assert.equal((await f.assembler.assemble({ ...request, purpose: "local" })).selections.length, 0);
});
test("Google retained context refuses other projects or absent cloud/retention consent", async () => {
  for (const value of [{ ...entry, projectId: "foreign" }, { ...entry, cloudAllowed: false }, { ...entry, retentionAllowed: false }]) {
    await assert.rejects(fixture(value).assembler.assemble(request), /project or consent/);
  }
});
test("daily planning can inspect selected retained calendar records without a literal tomorrow keyword", async () => {
  const f = fixture({ ...entry, provider: "calendar", resourceId: "selected-calendar", content: { subject: "Design review", text: "2026-11-10T10:00:00Z" } });
  const packet = await f.assembler.assemble({ ...request, query: "Plan tomorrow", currentTurn: { text: "Plan tomorrow" } });
  assert.equal(packet.selections.length, 1); assert.equal(packet.selections[0].accountContext!.provider, "calendar");
  assert(packet.selections[0].retrievalReasons!.some(reason => reason.includes("not a complete agenda")));
});
