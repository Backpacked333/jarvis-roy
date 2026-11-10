import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("../service-guard.mjs", import.meta.url));

// A stand-in service: stays up like a server and stops in an orderly way on SIGTERM.
const service = `
  import { createServer } from "node:http";
  const server = createServer().listen(0, "127.0.0.1", () => console.log("ready " + process.argv[1] + " " + process.argv.slice(2).join(",")));
  process.once("SIGTERM", () => { console.log("orderly"); server.close(() => { process.exitCode = 0; }); });
`;

async function start(t: { after(fn: () => unknown): void }, env: NodeJS.ProcessEnv) {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-guard-"));
  const entry = path.join(directory, "service.mjs");
  await writeFile(entry, service);
  const child = spawn(process.execPath, [guard, entry, "one", "two"], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  t.after(async () => { child.kill("SIGKILL"); await rm(directory, { recursive: true, force: true }); });
  const deadline = Date.now() + 10_000;
  while (!stdout.includes("ready") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(stdout, /ready/, stderr);
  return { child, entry, output: () => ({ stdout, stderr }) };
}

test("a guarded service stops in an orderly way when its launcher goes away", async t => {
  const { child, entry, output } = await start(t, { JARVIS_LIFELINE: "stdin" });
  // The service sees itself, not the guard, as the entry point, with its own arguments.
  assert.match(output().stdout, new RegExp(`ready ${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} one,two`));
  child.stdin.end(); // What the operating system does to the pipe when the launcher dies.
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [code, signal] = await once(child, "exit"); clearTimeout(timer);
  assert.equal(signal, null);
  assert.equal(code, 0, output().stderr);
  assert.match(output().stdout, /orderly/);
  assert.match(output().stderr, /launching application is gone/);
});

test("a guarded service's own orderly stop is not held open by the lifeline", async t => {
  const { child, output } = await start(t, { JARVIS_LIFELINE: "stdin" });
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [code, signal] = await once(child, "exit"); clearTimeout(timer);
  assert.equal(signal, null);
  assert.equal(code, 0, output().stderr);
});

test("without a lifeline the guard leaves standard input alone", async t => {
  const { child, output } = await start(t, {});
  child.stdin.end();
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(child.exitCode, null, "closing standard input must not stop an unguarded service");
  assert.doesNotMatch(output().stdout, /orderly/);
});
