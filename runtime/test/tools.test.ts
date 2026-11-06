import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deleteMemory,
  listMemories,
  rememberPreference,
} from "../agent/lib/memory.ts";
import {
  openHttpsUrl,
  saveNote,
  validateHttpsUrl,
} from "../agent/lib/tool-actions.ts";

async function withDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-tools-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("memories are private per-entry files with exact-id deletion and credential rejection", async () => {
  await withDirectory(async (directory) => {
    const saved = await rememberPreference("I prefer brief answers.", undefined, directory);
    const memories = await listMemories(directory);
    assert.deepEqual(memories, [saved]);
    assert.equal((await lstat(path.join(directory, "memories"))).mode & 0o777, 0o700);
    assert.equal((await lstat(path.join(directory, "memories", `${saved.id}.json`))).mode & 0o777, 0o600);
    assert.equal(await deleteMemory("not-a-memory-id", directory), false);
    assert.equal(await deleteMemory(saved.id, directory), true);
    assert.deepEqual(await listMemories(directory), []);
    await assert.rejects(
      rememberPreference("api_key=not-a-real-key", undefined, directory),
      /Credentials cannot be saved/,
    );
    await assert.rejects(
      rememberPreference("token: not-a-real-token", undefined, directory),
      /Credentials cannot be saved/,
    );
  });
});

test("notes use generated exclusive paths and honor cancellation", async () => {
  await withDirectory(async (directory) => {
    const notePath = await saveNote({
      title: "Trip plan",
      content: "Bring a jacket.",
    }, undefined, directory);
    assert.equal(path.dirname(notePath), path.join(directory, "notes"));
    assert.match(path.basename(notePath), /^[0-9a-f-]+\.md$/);
    assert.equal(await readFile(notePath, "utf8"), "# Trip plan\n\nBring a jacket.\n");
    assert.equal((await lstat(notePath)).mode & 0o777, 0o600);
    const names = await readdir(path.join(directory, "notes"));
    assert.deepEqual(names, [path.basename(notePath)]);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      saveNote({ title: "Cancelled", content: "" }, controller.signal, directory),
      /cancelled/,
    );
    await assert.rejects(
      saveNote({ title: "x".repeat(121), content: "" }, undefined, directory),
      /titles must contain/,
    );
    await assert.rejects(
      saveNote({ title: "Secret", content: "password=not-a-real-secret" }, undefined, directory),
      /Credentials cannot be saved/,
    );
  });
});

test("website tool permits only credential-free HTTPS and reports non-macOS clearly", async () => {
  assert.equal(validateHttpsUrl("https://example.com/path"), "https://example.com/path");
  assert.throws(() => validateHttpsUrl("http://example.com"), /Only HTTPS/);
  assert.throws(() => validateHttpsUrl("https://user:pass@example.com"), /Only HTTPS/);
  assert.throws(() => validateHttpsUrl("https://example.com/?access_token=secret"), /credential parameters/);
  assert.throws(() => validateHttpsUrl("https://example.com/#token=secret"), /credential parameters/);
  await assert.rejects(
    openHttpsUrl("https://example.com", undefined, "linux"),
    /only on macOS/,
  );
});
