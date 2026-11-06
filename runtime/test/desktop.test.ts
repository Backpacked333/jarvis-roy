import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import {
  controlApp, controlInputSchema, controlToolSchema, desktopStatus, inspectApp, isDesktopEnabled, isTerminalEnabled,
  readScreen, runTerminal, terminalInputSchema, type DesktopOptions,
} from "../agent/lib/desktop.ts";
import { redactDesktopText, sanitizedEnvironment } from "../agent/lib/desktop-process.ts";
import controlTool from "../agent/tools/control_app.ts";
import inspectTool from "../agent/tools/inspect_app.ts";
import screenTool from "../agent/tools/read_screen.ts";
import terminalTool from "../agent/tools/run_terminal.ts";

const terminalOptions: DesktopOptions = { environment: { JARVIS_ENABLE_TERMINAL: "1" } };
const bundleId = "com.example.JarvisFixture";

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-desktop-test-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function helper(directory: string, script: string): Promise<DesktopOptions> {
  const executable = path.join(directory, "fixture-helper");
  await writeFile(executable, `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { platform: "darwin", environment: { JARVIS_ENABLE_DESKTOP: "1", JARVIS_NATIVE_HELPER: executable } };
}

function fixtureBody(handler: string) {
  return `let body = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => body += chunk);
    process.stdin.on('end', () => { const request = JSON.parse(body); ${handler} });`;
}

const inspection = {
  kind: "inspection", bundleId, processId: 123, launchTimestamp: 100, treeDigest: "a".repeat(64),
  elements: [{ elementId: "root/0", path: [0], role: "AXButton", label: "Fixture", value: "", secure: false }], truncated: false,
};

test("desktop and terminal opt-ins are exact, independent, and off by default; status does not claim permissions", async () => {
  assert.equal(isDesktopEnabled({}), false);
  assert.equal(isTerminalEnabled({}), false);
  assert.equal(isDesktopEnabled({ JARVIS_ENABLE_DESKTOP: "true" }), false);
  assert.equal(isTerminalEnabled({ JARVIS_ENABLE_TERMINAL: "yes" }), false);
  assert.equal(isDesktopEnabled({ JARVIS_ENABLE_DESKTOP: "1" }), true);
  assert.equal(isTerminalEnabled({ JARVIS_ENABLE_TERMINAL: "1" }), true);
  const status = desktopStatus({ JARVIS_ENABLE_DESKTOP: "1", JARVIS_NATIVE_HELPER: "relative/helper" }, "linux");
  assert.equal(status.permissions, "not_checked");
  assert.equal(status.helperConfigured, false);
  assert.equal(status.desktopSupported, false);
  await assert.rejects(readScreen(undefined, { environment: {}, platform: "darwin" }), /disabled/);
  await assert.rejects(runTerminal({ executable: "/bin/echo", args: [], cwd: "/" }, undefined, { environment: {} }), /disabled/);
});

test("unsupported platforms refuse before attempting a process", async () => {
  await assert.rejects(readScreen(undefined, { environment: { JARVIS_ENABLE_DESKTOP: "1" }, platform: "linux" }), /require macOS/);
  await assert.rejects(runTerminal({ executable: "/bin/echo", args: [], cwd: "/" }, undefined, { ...terminalOptions, platform: "win32" }), /only macOS and Linux/);
});

test("all four tools require always approval, remain unavailable in subagents, and have no model-selectable helper", () => {
  for (const tool of [controlTool, inspectTool, screenTool, terminalTool]) {
    assert.equal(typeof tool.approval, "function");
    assert.equal(tool.availableInSubagents, false);
    assert.equal((tool.approval as Function)({}, {}), "user-approval");
  }
  assert.equal(controlInputSchema.safeParse({ action: "focus", bundleId, helper: "/bin/echo" }).success, false);
  assert.equal(controlInputSchema.safeParse({ action: "click", bundleId, path: [0] }).success, false);
});

test("desktop tools expose object-root model schemas without top-level unions", () => {
  assert.equal(controlTool.inputSchema, controlToolSchema);
  for (const tool of [controlTool, inspectTool, screenTool, terminalTool]) {
    const json = z.toJSONSchema(tool.inputSchema as z.ZodType);
    assert.equal(json.type, "object");
    assert.equal("oneOf" in json, false);
    assert.equal("anyOf" in json, false);
  }
});

test("the model-facing control schema preserves exact per-action validation", () => {
  const observed = { bundleId, observationId: "e1d9b622-4a2a-4f4d-9444-fb0df45dc4c7", elementId: "root/0" };
  const valid = [
    { action: "focus", bundleId },
    { action: "click", ...observed },
    { action: "set_text", ...observed, text: "Exact fixture text" },
    { action: "press_key", ...observed, stroke: "tab", modifiers: [] },
  ];
  for (const input of valid) assert.deepEqual(controlToolSchema.parse(input), controlInputSchema.parse(input));
  for (const input of [
    { action: "click", bundleId }, { action: "set_text", ...observed },
    { action: "press_key", ...observed, stroke: "tab" },
    { action: "press_key", ...observed, stroke: "unknown", modifiers: [] },
    { action: "focus", ...observed }, { ...valid[1], text: "unrelated" },
    { ...valid[2], stroke: "return" }, { ...valid[3], script: "unrelated" },
    { ...valid[2], text: "password=not-reviewable" },
  ]) {
    assert.equal(controlInputSchema.safeParse(input).success, false);
    assert.equal(controlToolSchema.safeParse(input).success, false);
  }
});

test("terminal forwards the exact approved argument array and cwd without shell expansion", async () => {
  await withDirectory(async (directory) => {
    const args = ["literal space", "$(touch should-not-exist)", "; echo nope", "*.txt", "a\nb", "\"quotes\"", ""];
    const result = await runTerminal({ executable: process.execPath,
      args: ["-e", "console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd()}))", "--", ...args], cwd: directory }, undefined, terminalOptions);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { args, cwd: directory });
    await assert.rejects(readFile(path.join(directory, "should-not-exist")));
  });
});

test("terminal validates absolute paths, existing directory, NUL and argument limits", async () => {
  const valid = { executable: process.execPath, args: [], cwd: tmpdir() };
  for (const input of [
    { ...valid, executable: "node" }, { ...valid, cwd: "relative" },
    { ...valid, args: ["a\0b"] }, { ...valid, args: Array(65).fill("x") },
    { ...valid, args: ["x".repeat(4097)] }, { ...valid, args: Array(5).fill("x".repeat(4096)) },
  ]) {
    assert.equal(terminalInputSchema.safeParse(input).success, false);
    await assert.rejects(runTerminal(input, undefined, terminalOptions), /absolute executable/);
  }
  await assert.rejects(runTerminal({ ...valid, cwd: process.execPath }, undefined, terminalOptions), /existing directory/);
  await assert.rejects(runTerminal({ ...valid, executable: "/jarvis-fixture-missing-executable" }, undefined, terminalOptions), /accessible executable/);
});

test("spawned commands receive only an allowlisted environment, not inherited integration or Node injection secrets", async () => {
  const previous = process.env.JARVIS_DESKTOP_TEST_SECRET;
  process.env.JARVIS_DESKTOP_TEST_SECRET = "fixture-secret-not-a-real-credential";
  try {
    const result = await runTerminal({ executable: process.execPath, args: ["-e", "console.log(JSON.stringify(process.env))"], cwd: tmpdir() }, undefined, terminalOptions);
    assert.equal(result.ok, true);
    const environment = JSON.parse(result.stdout);
    assert.deepEqual(environment, sanitizedEnvironment());
    for (const key of ["AI_GATEWAY_API_KEY", "JARVIS_LOCAL_TOKEN", "JARVIS_DESKTOP_TEST_SECRET", "SUPABASE_ACCESS_TOKEN", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"]) {
      assert.equal(environment[key], undefined);
    }
  } finally {
    if (previous === undefined) delete process.env.JARVIS_DESKTOP_TEST_SECRET;
    else process.env.JARVIS_DESKTOP_TEST_SECRET = previous;
  }
});

test("nonzero exit, timeout, cancellation and output-limit results never report success", async () => {
  const base = { executable: process.execPath, cwd: tmpdir() };
  const failed = await runTerminal({ ...base, args: ["-e", "console.error('fixture error');process.exit(7)"] }, undefined, terminalOptions);
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.status, "failed");
  assert.match(failed.stderr, /fixture error/);
  const timeout = await runTerminal({ ...base, args: ["-e", "setInterval(()=>{},1000)"] }, undefined, { ...terminalOptions, timeoutMs: 100 });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.status, "timed_out");
  const limited = await runTerminal({ ...base, args: ["-e", "process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"] }, undefined, { ...terminalOptions, maxOutputBytes: 100 });
  assert.equal(limited.ok, false);
  assert.equal(limited.status, "output_limit");
  assert.equal(limited.truncated, true);
  assert.equal(limited.stdout.length, 100);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(runTerminal({ ...base, args: [] }, abort.signal, terminalOptions), /cancelled before execution/);
});

test("redacts known and credential-shaped output, including a secret split at the output cap", async () => {
  await withDirectory(async (directory) => {
    const secret = "fixture-known-value-never-real";
    const environment = { JARVIS_ENABLE_TERMINAL: "1", AI_GATEWAY_API_KEY: secret };
    const fixture = path.join(directory, "output.cjs");
    await writeFile(fixture, `console.log(${JSON.stringify(secret)});console.error('password=fixture-only')`);
    const result = await runTerminal({ executable: process.execPath, args: [fixture], cwd: directory }, undefined, { environment });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.stdout, /fixture-known/);
    assert.doesNotMatch(result.stderr, /fixture-only/);
    assert.equal(redactDesktopText(`prefix ${secret.slice(0, 10)}`, environment), "prefix [REDACTED]");
    assert.doesNotMatch(redactDesktopText("-----BEGIN PRIVATE KEY-----\nfixture key material", {}), /fixture key material/);
  });
});

function processRunning(pid: number): boolean {
  try {
    const status = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return status.length > 0 && !status.startsWith("Z");
  } catch { return false; }
}

for (const reason of ["cancel", "timeout", "leader_exit"] as const) {
  test(`${reason} terminates the entire fixture process group, including a child ignoring SIGTERM`, async () => {
    await withDirectory(async (directory) => {
      const pidFile = path.join(directory, "child-pid");
      const childCode = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
      const script = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');
        process.on('SIGTERM',()=>{});
        const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});
        writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
        ${reason === "leader_exit" ? "child.unref();setTimeout(()=>process.exit(0),100)" : "setInterval(()=>{},1000)"};`;
      const controller = new AbortController();
      const pending = runTerminal({ executable: process.execPath, args: ["-e", script], cwd: directory }, controller.signal,
        { ...terminalOptions, timeoutMs: reason === "timeout" ? 700 : 3000 });
      let pid = 0;
      try {
        for (let tries = 0; tries < 100; tries++) {
          try { pid = Number(await readFile(pidFile, "utf8")); break; } catch { await delay(10); }
        }
        assert.ok(pid > 1, "fixture child started");
        if (reason === "cancel") controller.abort();
        const result = await pending;
        assert.equal(result.status, reason === "cancel" ? "cancelled" : reason === "timeout" ? "timed_out" : "completed");
        assert.equal(result.ok, reason === "leader_exit");
        for (let tries = 0; tries < 100 && processRunning(pid); tries++) await delay(10);
        assert.equal(processRunning(pid), false, "no running descendant remains");
      } finally {
        controller.abort();
        await pending;
        if (pid > 1) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
      }
    });
  });
}

test("helper path is operator-only, absolute and executable", async () => {
  await assert.rejects(readScreen(undefined, { platform: "darwin", environment: { JARVIS_ENABLE_DESKTOP: "1", JARVIS_NATIVE_HELPER: "relative" } }), /absolute operator-configured/);
  await assert.rejects(readScreen(undefined, { platform: "darwin", environment: { JARVIS_ENABLE_DESKTOP: "1", JARVIS_NATIVE_HELPER: "/missing-jarvis-helper" } }), /unavailable/);
});

test("injected helper transport is single JSON stdin/response, sanitized, bounded and labels screen data untrusted", async () => {
  await withDirectory(async (directory) => {
    const options = await helper(directory, fixtureBody(`
      if(request.version!==1 || request.operation!=='read_screen' || process.argv.length!==2 || Object.keys(process.env).some(k=>/TOKEN|KEY|SECRET/.test(k))) process.exit(9);
      console.log(JSON.stringify({ok:true,result:{kind:'screen',text:'password=fixture-only',truncated:false,contentLabel:'UNTRUSTED SCREEN CONTENT'}}));`));
    const result = await readScreen(undefined, options);
    assert.match(result.contentLabel, /UNTRUSTED SCREEN CONTENT/);
    assert.doesNotMatch(result.text, /fixture-only/);
  });
});

test("helper protocol errors, unavailable permissions, wrong kinds and oversized output are honest failures", async () => {
  await withDirectory(async (directory) => {
    let options = await helper(directory, "console.log('not JSON')");
    await assert.rejects(readScreen(undefined, options), /invalid JSON/);
    options = await helper(directory, "console.log(JSON.stringify({ok:true,result:{kind:'screen',text:'unlabelled',truncated:false}}))");
    await assert.rejects(readScreen(undefined, options), /incompatible response/);
    options = await helper(directory, "console.log(JSON.stringify({ok:false,error:{code:'SCREEN_PERMISSION',message:'Enable System Settings → Privacy & Security → Screen Recording'}}))");
    await assert.rejects(readScreen(undefined, options), /SCREEN_PERMISSION.*System Settings/);
    options = await helper(directory, `console.log(JSON.stringify({ok:true,result:${JSON.stringify(inspection)}}))`);
    await assert.rejects(readScreen(undefined, options), /wrong response kind/);
    options = await helper(directory, "process.stdout.write('x'.repeat(600000));setInterval(()=>{},1000)");
    await assert.rejects(readScreen(undefined, options), /output_limit/);
    options = await helper(directory, "setInterval(()=>{},1000)");
    await assert.rejects(readScreen(undefined, { ...options, timeoutMs: 100 }), /timed_out/);
  });
});

test("observations are owner/app-bound, consume once, and forward only server-observed path and identity", async () => {
  await withDirectory(async (directory) => {
    const capture = path.join(directory, "request.json");
    const options = await helper(directory, fixtureBody(`
      if(request.operation==='inspect_app') console.log(JSON.stringify({ok:true,result:${JSON.stringify(inspection)}}));
      else { require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify(request));console.log(JSON.stringify({ok:true,result:{kind:'control',action:request.action,bundleId:request.bundleId}})); }`));
    const observation = await inspectApp({ bundleId }, "owner", undefined, options);
    assert.equal("path" in observation.elements[0], false);
    const action = { action: "click" as const, bundleId, observationId: observation.observationId, elementId: "root/0" };
    await assert.rejects(controlApp(action, "other-owner", undefined, options), /another app\/session/);
    await assert.rejects(controlApp({ ...action, bundleId: "com.example.Other" }, "owner", undefined, options), /another app\/session/);
    await assert.rejects(controlApp({ ...action, elementId: "unknown" }, "owner", undefined, options), /Unknown or secure/);
    await controlApp(action, "owner", undefined, options);
    const request = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(request.operation, "control_app");
    assert.deepEqual(request.path, [0]);
    assert.equal(request.expectedTreeDigest, inspection.treeDigest);
    assert.equal(request.expectedProcessId, inspection.processId);
    assert.equal(request.expectedLaunchTimestamp, inspection.launchTimestamp);
    await assert.rejects(controlApp(action, "owner", undefined, options), /missing, expired/);
  });
});

test("expired, secure and changed native targets are refused; a failed attempt consumes its observation", async () => {
  await withDirectory(async (directory) => {
    let options = await helper(directory, fixtureBody(`console.log(JSON.stringify({ok:true,result:${JSON.stringify(inspection)}}))`));
    const observation = await inspectApp({ bundleId }, "owner", undefined, options);
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 91_000;
      await assert.rejects(controlApp({ action: "click", bundleId, observationId: observation.observationId, elementId: "root/0" }, "owner", undefined, options), /expired/);
    } finally { Date.now = originalNow; }
    const secure = { ...inspection, elements: [{ ...inspection.elements[0], secure: true }] };
    options = await helper(directory, fixtureBody(`console.log(JSON.stringify({ok:true,result:${JSON.stringify(secure)}}))`));
    const secureObservation = await inspectApp({ bundleId }, "owner", undefined, options);
    await assert.rejects(controlApp({ action: "set_text", text: "fixture", bundleId, observationId: secureObservation.observationId, elementId: "root/0" }, "owner", undefined, options), /secure/);
    options = await helper(directory, fixtureBody(`console.log(JSON.stringify(request.operation==='inspect_app'?{ok:true,result:${JSON.stringify(inspection)}}:{ok:false,error:{code:'STALE_TARGET',message:'Tree changed; inspect again'}}))`));
    const changed = await inspectApp({ bundleId }, "owner", undefined, options);
    const action = { action: "click" as const, bundleId, observationId: changed.observationId, elementId: "root/0" };
    await assert.rejects(controlApp(action, "owner", undefined, options), /STALE_TARGET/);
    await assert.rejects(controlApp(action, "owner", undefined, options), /missing, expired/);
  });
});

test("focus needs only a bundleId and does not pretend to confirm other business outcomes", async () => {
  await withDirectory(async (directory) => {
    const options = await helper(directory, fixtureBody(`
      if(request.action!=='focus'||request.path!==undefined) process.exit(8);
      console.log(JSON.stringify({ok:true,result:{kind:'control',action:'focus',bundleId:request.bundleId}}));`));
    const result = await controlApp({ action: "focus", bundleId }, "owner", undefined, options);
    assert.equal(result.action, "focus");
    assert.match(result.message, /does not confirm an external/);
  });
});

test("overlapping native actions are refused and cancellation releases the one-shot transport", async () => {
  await withDirectory(async (directory) => {
    const ready = path.join(directory, "ready");
    let options = await helper(directory, fixtureBody(`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`));
    const controller = new AbortController();
    const pending = readScreen(controller.signal, options);
    const cancelled = assert.rejects(pending, /cancelled/);
    try {
      let started = false;
      for (let attempts = 0; attempts < 100; attempts++) {
        try { await readFile(ready); started = true; break; } catch { await delay(10); }
      }
      assert.equal(started, true);
      await assert.rejects(readScreen(undefined, options), /Another desktop read\/action/);
    } finally { controller.abort(); await cancelled; }
    options = await helper(directory, fixtureBody("console.log(JSON.stringify({ok:true,result:{kind:'screen',text:'fixture',truncated:false,contentLabel:'UNTRUSTED SCREEN CONTENT'}}))"));
    assert.equal((await readScreen(undefined, options)).text, "fixture");
  });
});

test("credential-shaped action inputs hidden by bridge redaction are refused, while named strokes remain visible", async () => {
  assert.equal(terminalInputSchema.safeParse({ executable: process.execPath, args: ["-e", "password=fixture"], cwd: tmpdir() }).success, false);
  assert.equal(controlInputSchema.safeParse({ action: "set_text", bundleId, observationId: "dc1c4c55-0807-42fe-a17e-a927450c5b8b", elementId: "root/0", text: "password=fixture" }).success, false);
  await withDirectory(async (directory) => {
    const options = await helper(directory, fixtureBody(`
      if(request.operation==='inspect_app') console.log(JSON.stringify({ok:true,result:${JSON.stringify(inspection)}}));
      else { if(request.key!=='return'||request.modifiers[0]!=='command') process.exit(8);console.log(JSON.stringify({ok:true,result:{kind:'control',action:request.action,bundleId:request.bundleId}})); }`));
    const observation = await inspectApp({ bundleId }, "owner", undefined, options);
    const result = await controlApp({ action: "press_key", stroke: "return", modifiers: ["command"], bundleId, observationId: observation.observationId, elementId: "root/0" }, "owner", undefined, options);
    assert.match(result.message, /delivery and effects are not confirmed/);
  });
});
