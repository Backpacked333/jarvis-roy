import { acquireServicePortsLock } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The supervisor is JavaScript so the bundled Node runs it without a build step.
const supervisorUrl = new URL("../../scripts/supervisor.mjs", import.meta.url);
const supervisor = await import(supervisorUrl.href);
const { parseArguments, parsePayload, childEnvironment, discoverWorkerDefaults, runSupervisor, sanitizeReason, SECRET_KEYS, CONFIG_KEYS } = supervisor;

const TOKEN = "ab".repeat(32);
const SECRETS = {
  AI_GATEWAY_API_KEY: "fixture-gateway-secret-value-0001",
  TAVILY_API_KEY: "fixture-tavily-secret-value-0002",
  HOME_ASSISTANT_TOKEN: "fixture-home-secret-value-0003",
  ELEVENLABS_API_KEY: "fixture-eleven-secret-value-0004",
};
const SENSITIVE = [TOKEN, ...Object.values(SECRETS)];
const payload = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, token: TOKEN, secrets: { ...SECRETS }, config: { JARVIS_MODEL: "openai/gpt-4.1-mini" }, ...overrides });

function rejectsWith(line: string, pattern: RegExp) {
  assert.throws(() => parsePayload(line), (error: { reason: string; exitCode: number }) => {
    assert.equal(error.exitCode, 2);
    assert.match(error.reason, pattern);
    for (const value of SENSITIVE) assert.ok(!error.reason.includes(value));
    return true;
  });
}

test("argument parsing requires each absolute path flag exactly once", () => {
  assert.deepEqual(parseArguments(["--resources", "/r", "--data-dir", "/d/x", "--helper", "/h/bin"]),
    { resources: "/r", dataDir: "/d/x", helper: "/h/bin" });
  assert.deepEqual(parseArguments(["--helper", "/h", "--resources", "/r/", "--data-dir", "/d"]), { resources: "/r", dataDir: "/d", helper: "/h" });
  for (const argv of [
    [],
    ["--resources", "/r", "--data-dir", "/d"],
    ["--resources", "relative", "--data-dir", "/d", "--helper", "/h"],
    ["--resources", "/r", "--data-dir", "/d/../etc", "--helper", "/h"],
    ["--resources", "/r", "--data-dir", "/d", "--helper", "/h", "--extra", "/x"],
    ["--resources", "/r", "--resources", "/r", "--data-dir", "/d", "--helper", "/h"],
    ["--resources", "/r", "--data-dir", "/d", "--helper"],
    ["--resources", "/", "--data-dir", "/d", "--helper", "/h"],
    ["--resources", "/r\0x", "--data-dir", "/d", "--helper", "/h"],
  ]) assert.throws(() => parseArguments(argv), (error: { exitCode: number }) => error.exitCode === 2, JSON.stringify(argv));
});

test("payload parsing accepts only the allowlisted shape and drops empty values", () => {
  const parsed = parsePayload(payload({ config: { JARVIS_MODEL: "openai/gpt-4.1-mini", JARVIS_ENABLE_TERMINAL: "1", HOME_ASSISTANT_URL: "" } }));
  assert.equal(parsed.token, TOKEN);
  assert.deepEqual({ ...parsed.secrets }, SECRETS);
  assert.deepEqual({ ...parsed.config }, { JARVIS_MODEL: "openai/gpt-4.1-mini", JARVIS_ENABLE_TERMINAL: "1" });
  assert.deepEqual({ ...parsePayload(payload({ secrets: { AI_GATEWAY_API_KEY: "k", TAVILY_API_KEY: "" }, config: {} })).secrets }, { AI_GATEWAY_API_KEY: "k" });
  for (const key of CONFIG_KEYS) assert.equal(parsePayload(payload({ config: { [key]: "v" } })).config[key], "v");
  for (const key of SECRET_KEYS) assert.ok(parsePayload(payload({ secrets: { AI_GATEWAY_API_KEY: "k", [key]: "v" } })).secrets[key]);
});

test("payload parsing rejects every malformed or unexpected input without echoing it", () => {
  rejectsWith("not json", /not valid JSON/);
  rejectsWith("[]", /must be an object/);
  rejectsWith("null", /must be an object/);
  rejectsWith(JSON.stringify({ version: 1, token: TOKEN, secrets: SECRETS, config: {}, extra: SECRETS.AI_GATEWAY_API_KEY }), /unsupported key/);
  rejectsWith(payload({ version: 2 }), /version/);
  rejectsWith(payload({ version: "1" }), /version/);
  rejectsWith(payload({ token: TOKEN.toUpperCase() }), /token/);
  rejectsWith(payload({ token: TOKEN.slice(1) }), /token/);
  rejectsWith(payload({ token: `${TOKEN}0` }), /token/);
  rejectsWith(payload({ token: 7 }), /token/);
  rejectsWith(payload({ token: undefined }), /token/);
  rejectsWith(payload({ secrets: undefined }), /secrets must be an object/);
  rejectsWith(payload({ config: undefined }), /config must be an object/);
  rejectsWith(payload({ config: [] }), /config must be an object/);
  rejectsWith(payload({ secrets: { ...SECRETS, [SECRETS.TAVILY_API_KEY]: "x" } }), /unsupported key/);
  rejectsWith(payload({ secrets: { ...SECRETS, OPENAI_API_KEY: "x" } }), /unsupported key/);
  rejectsWith(payload({ config: { NODE_OPTIONS: "--inspect" } }), /unsupported key/);
  rejectsWith(payload({ config: { JARVIS_LOCAL_TOKEN: TOKEN } }), /unsupported key/);
  rejectsWith(payload({ config: { JARVIS_LAUNCH_MODE: "app" } }), /unsupported key/);
  rejectsWith(payload({ config: { JARVIS_ENABLE_DESKTOP: true } }), /must be strings/);
  rejectsWith(payload({ config: { JARVIS_ENABLE_DESKTOP: 1 } }), /must be strings/);
  rejectsWith(payload({ secrets: { ...SECRETS, TAVILY_API_KEY: null } }), /must be strings/);
  rejectsWith(payload({ secrets: { ...SECRETS, TAVILY_API_KEY: { nested: "x" } } }), /must be strings/);
  rejectsWith(payload({ config: { JARVIS_MODEL: "a\nb" } }), /forbidden character/);
  rejectsWith(payload({ config: { JARVIS_MODEL: "a\rb" } }), /forbidden character/);
  rejectsWith(payload({ secrets: { ...SECRETS, AI_GATEWAY_API_KEY: `${SECRETS.AI_GATEWAY_API_KEY}\0` } }), /forbidden character/);
  rejectsWith(payload({ secrets: { TAVILY_API_KEY: SECRETS.TAVILY_API_KEY } }), /model credential is required/);
  rejectsWith(payload({ secrets: { AI_GATEWAY_API_KEY: "" } }), /model credential is required/);
  rejectsWith('{"version":1,"token":"' + TOKEN + '","secrets":{"__proto__":{"AI_GATEWAY_API_KEY":"x"}},"config":{}}', /unsupported key/);
  rejectsWith(payload({ config: { JARVIS_MODEL: "x".repeat(70 * 1024) } }), /too large/);
  assert.throws(() => parsePayload(undefined), (error: { exitCode: number }) => error.exitCode === 2);
});

test("child environments route each secret only where environmentFor allows it", () => {
  const baseEnv = { HOME: "/Users/fixture", TMPDIR: "/tmp/fixture", USER: "fixture", LOGNAME: "fixture", LANG: "en_GB.UTF-8",
    PATH: "/untrusted", NODE_OPTIONS: "--inspect", DYLD_INSERT_LIBRARIES: "/x", JARVIS_ENABLE_TERMINAL: "1", AI_GATEWAY_API_KEY: "ambient" };
  const config = { JARVIS_MODEL: "openai/gpt-4.1-mini", JARVIS_ENABLE_DESKTOP: "1", ELEVENLABS_VOICE_ID: "voice", JARVIS_WORKER_PYTHON: "/p", HOME_ASSISTANT_URL: "https://ha.invalid" };
  const shared = { baseEnv, token: TOKEN, secrets: SECRETS, config, dataDir: "/data", helper: "/helper" };
  const runtime = childEnvironment({ ...shared, target: "runtime" });
  const bridge = childEnvironment({ ...shared, target: "bridge" });
  const ui = childEnvironment({ ...shared, target: "ui" });
  assert.equal(runtime.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(runtime.HOST, "127.0.0.1");
  assert.equal(runtime.PORT, "39201");
  for (const environment of [runtime, bridge]) {
    assert.equal(environment.JARVIS_LAUNCH_MODE, "app");
    assert.equal(environment.JARVIS_LOCAL_TOKEN, TOKEN);
    assert.equal(environment.JARVIS_DATA_DIR, "/data");
    assert.equal(environment.JARVIS_NATIVE_HELPER, "/helper");
    assert.equal(environment.AI_GATEWAY_API_KEY, SECRETS.AI_GATEWAY_API_KEY);
    assert.equal(environment.TAVILY_API_KEY, SECRETS.TAVILY_API_KEY);
    assert.equal(environment.HOME_ASSISTANT_TOKEN, SECRETS.HOME_ASSISTANT_TOKEN);
    assert.equal(environment.JARVIS_ENABLE_DESKTOP, "1");
    assert.equal(environment.JARVIS_ENABLE_TERMINAL, undefined, "ambient flags are never inherited");
    for (const key of ["NODE_OPTIONS", "DYLD_INSERT_LIBRARIES"]) assert.equal(environment[key], undefined);
  }
  assert.equal(bridge.ELEVENLABS_API_KEY, SECRETS.ELEVENLABS_API_KEY);
  assert.equal(bridge.ELEVENLABS_VOICE_ID, "voice");
  assert.equal(bridge.JARVIS_WORKER_PYTHON, "/p");
  assert.equal(runtime.ELEVENLABS_API_KEY, undefined);
  assert.equal(runtime.JARVIS_WORKER_PYTHON, undefined);
  for (const value of Object.values(SECRETS)) assert.ok(!Object.values(ui).includes(value), "UI never receives secrets");
  assert.equal(ui.JARVIS_LAUNCH_MODE, undefined);
  assert.deepEqual(Object.keys(ui).sort(), ["HOME", "JARVIS_LOCAL_TOKEN", "LANG", "LOGNAME", "PATH", "TMPDIR", "USER"]);
});

test("worker defaults are discovered only from fixed local paths and never override settings", () => {
  const executable = new Set(["/data/workers-venv/bin/python", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"]);
  const isExecutable = (file: string) => executable.has(file);
  assert.deepEqual({ ...discoverWorkerDefaults({ config: {}, dataDir: "/data", isExecutable }) },
    { JARVIS_WORKER_PYTHON: "/data/workers-venv/bin/python", JARVIS_DOCKER_BINARY: "/opt/homebrew/bin/docker" });
  assert.deepEqual({ ...discoverWorkerDefaults({ config: { JARVIS_WORKER_PYTHON: "/x", JARVIS_DOCKER_BINARY: "/y" }, dataDir: "/data", isExecutable }) },
    { JARVIS_WORKER_PYTHON: "/x", JARVIS_DOCKER_BINARY: "/y" });
  assert.deepEqual({ ...discoverWorkerDefaults({ config: {}, dataDir: "/other", isExecutable: () => false }) }, {});
});

test("reasons are sanitized and credential-shaped text is masked", () => {
  assert.equal(sanitizeReason(`bad ${TOKEN}\n\u0007 end`), "bad [redacted] end");
  assert.ok(!sanitizeReason(`x ${SECRETS.AI_GATEWAY_API_KEY}`).includes(SECRETS.AI_GATEWAY_API_KEY));
  assert.ok(sanitizeReason("y".repeat(500)).length <= 200);
  assert.equal(sanitizeReason(""), "Local services failed.");
});

test("the default port probe reports listening and free ports", async (t) => {
  const { createServer } = await import("node:net");
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  assert.equal(await supervisor.defaultPortInUse(port), true);
  server.close();
  await once(server, "close");
  assert.equal(await supervisor.defaultPortInUse(port), false);
});

// ---------------------------------------------------------------- runSupervisor with fakes

class FakeChild extends EventEmitter {
  signals: string[] = [];
  exited = false;
  readonly name: string;
  private readonly log: string[];
  private readonly onKill: (child: FakeChild, signal: string) => void;
  constructor(name: string, log: string[], onKill: (child: FakeChild, signal: string) => void) {
    super();
    this.name = name;
    this.log = log;
    this.onKill = onKill;
  }
  kill(signal: string) {
    this.signals.push(signal);
    this.log.push(`${this.name}:${signal}`);
    if (!this.exited) this.onKill(this, signal);
    return true;
  }
  exit(code: number | null, signal: string | null = null) {
    if (this.exited) return;
    this.exited = true;
    this.log.push(`${this.name}:exit`);
    setImmediate(() => this.emit("exit", code, signal));
  }
}

type Harness = Awaited<ReturnType<typeof harness>>;
async function harness(t: { after(fn: () => unknown): void }, options: {
  onKill?: (child: FakeChild, signal: string) => void;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  portInUse?: (port: number) => Promise<boolean>;
  timeouts?: Record<string, number>;
  argv?: string[];
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-supervisor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = path.join(root, "Resources");
  await mkdir(path.join(resources, "runtime", ".output", "server"), { recursive: true });
  await mkdir(path.join(resources, "runtime", "bridge"), { recursive: true });
  await writeFile(path.join(resources, "runtime", ".output", "server", "index.mjs"), "");
  await writeFile(path.join(resources, "runtime", "bridge", "server.ts"), "");
  const helper = path.join(root, "JarvisControl");
  await writeFile(helper, "#!/bin/sh\n");
  await chmod(helper, 0o755);
  const dataDir = path.join(root, "data");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });
  const log: string[] = [];
  const spawned: Array<{ child: FakeChild; command: string; args: string[]; options: { cwd: string; env: Record<string, string>; shell: boolean; stdio: unknown[] } }> = [];
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const signals = new EventEmitter();
  const onKill = options.onKill ?? ((child: FakeChild, signal: string) => { if (signal === "SIGTERM") child.exit(0); });
  const run = runSupervisor({
    argv: options.argv ?? ["--resources", resources, "--data-dir", dataDir, "--helper", helper],
    env: { HOME: root, TMPDIR: root, USER: "fixture", LOGNAME: "fixture", LANG: "en_US.UTF-8", AI_GATEWAY_API_KEY: "ambient-should-not-pass" },
    stdin, stdout, signals,
    nodePath: "/fixture/node",
    isExecutable: () => false,
    spawn: (command: string, args: string[], spawnOptions: Harness["spawned"][number]["options"]) => {
      const child = new FakeChild(args[0].endsWith("index.mjs") ? "runtime" : "bridge", log, onKill);
      spawned.push({ child, command, args, options: spawnOptions });
      return child;
    },
    fetch: async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      return options.fetch ? options.fetch(url, init) : Response.json({ ready: true });
    },
    portInUse: options.portInUse ?? (async () => false),
    timeouts: { readinessIntervalMs: 1, bridgeStopMs: 200, runtimeStopMs: 200, killWaitMs: 200, payloadMs: 2_000, ...options.timeouts },
  });
  const events = () => output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const waitFor = async (name: string) => {
    for (let index = 0; index < 400; index++) {
      if (events().some((event) => event.event === name)) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`event ${name} not seen; got ${output}`);
  };
  const assertNoSecrets = () => { for (const value of [...SENSITIVE, "ambient-should-not-pass"]) assert.ok(!output.includes(value), "stdout must not contain secrets"); };
  return { root, resources, dataDir, helper, stdin, stdout, signals, log, spawned, fetches, run, events, waitFor, assertNoSecrets, output: () => output };
}

test("supervisor starts both services with filtered environments, logs and lifeline shutdown order", async (t) => {
  const h = await harness(t);
  h.stdin.write(`${payload({ config: { JARVIS_MODEL: "openai/gpt-4.1-mini", JARVIS_ENABLE_DESKTOP: "1" } })}\n`);
  await h.waitFor("ready");
  assert.equal(h.spawned.length, 2);
  const [runtime, bridge] = h.spawned;
  assert.equal(runtime.command, "/fixture/node");
  assert.deepEqual(runtime.args, [path.join(h.resources, "runtime", ".output", "server", "index.mjs")]);
  assert.equal(runtime.options.cwd, path.join(h.dataDir, "runtime-state"));
  assert.deepEqual(bridge.args, ["bridge/server.ts"]);
  assert.equal(bridge.options.cwd, path.join(h.resources, "runtime"));
  for (const { options } of h.spawned) {
    assert.equal(options.shell, false);
    assert.equal(options.env.JARVIS_LAUNCH_MODE, "app");
    assert.equal(options.env.JARVIS_ENABLE_DESKTOP, "1");
    assert.equal(options.env.AI_GATEWAY_API_KEY, SECRETS.AI_GATEWAY_API_KEY);
    assert.equal(options.env.JARVIS_NATIVE_HELPER, h.helper);
  }
  assert.equal(runtime.options.env.ELEVENLABS_API_KEY, undefined);
  assert.equal(bridge.options.env.ELEVENLABS_API_KEY, SECRETS.ELEVENLABS_API_KEY);
  const [{ url, init }] = h.fetches;
  assert.equal(url, "http://127.0.0.1:39202/v1/state");
  assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.redirect, "error");
  for (const directory of [h.dataDir, path.join(h.dataDir, "logs"), path.join(h.dataDir, "runtime-state")]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }
  for (const file of ["runtime.log", "bridge.log"]) assert.equal((await stat(path.join(h.dataDir, "logs", file))).mode & 0o777, 0o600);

  h.stdin.end();
  assert.equal(await h.run, 0);
  assert.deepEqual(h.log, ["bridge:SIGTERM", "bridge:exit", "runtime:SIGTERM", "runtime:exit"]);
  assert.deepEqual(h.events(), [{ event: "starting" }, { event: "ready" }, { event: "stopping" }, { event: "stopped", clean: true }]);
  h.assertNoSecrets();
});

test("SIGTERM to the supervisor stops services in order exactly once", async (t) => {
  const h = await harness(t);
  h.stdin.write(`${payload()}\n`);
  await h.waitFor("ready");
  h.signals.emit("SIGTERM");
  h.signals.emit("SIGINT");
  h.stdin.end();
  assert.equal(await h.run, 0);
  assert.deepEqual(h.log, ["bridge:SIGTERM", "bridge:exit", "runtime:SIGTERM", "runtime:exit"]);
  assert.equal(h.events().filter((event) => event.event === "stopped").length, 1);
  assert.equal(h.signals.listenerCount("SIGTERM"), 0);
});

test("unresponsive children are escalated to SIGKILL and the stop is reported unclean", async (t) => {
  const h = await harness(t, {
    onKill: (child, signal) => { if (signal === "SIGKILL") child.exit(null, "SIGKILL"); },
    timeouts: { bridgeStopMs: 30, runtimeStopMs: 30 },
  });
  h.stdin.write(`${payload()}\n`);
  await h.waitFor("ready");
  h.stdin.end();
  assert.equal(await h.run, 1);
  assert.deepEqual(h.log, ["bridge:SIGTERM", "bridge:SIGKILL", "bridge:exit", "runtime:SIGTERM", "runtime:SIGKILL", "runtime:exit"]);
  assert.deepEqual(h.events().at(-1), { event: "stopped", clean: false });
});

test("a nonzero exit during shutdown is reported unclean", async (t) => {
  const h = await harness(t, { onKill: (child, signal) => { if (signal === "SIGTERM") child.exit(child.name === "runtime" ? 1 : 0); } });
  h.stdin.write(`${payload()}\n`);
  await h.waitFor("ready");
  h.stdin.end();
  assert.equal(await h.run, 1);
  assert.deepEqual(h.events().at(-1), { event: "stopped", clean: false });
});

test("an unexpected child exit fails and stops the other service", async (t) => {
  const h = await harness(t);
  h.stdin.write(`${payload()}\n`);
  await h.waitFor("ready");
  h.spawned[0].child.exit(1);
  assert.equal(await h.run, 1);
  const names = h.events().map((event) => event.event);
  assert.deepEqual(names, ["starting", "ready", "failed", "stopping", "stopped"]);
  assert.match(h.events()[2].reason, /runtime stopped unexpectedly/);
  assert.deepEqual(h.log, ["runtime:exit", "bridge:SIGTERM", "bridge:exit"]);
  assert.equal(h.spawned[0].child.signals.length, 0, "an exited runtime is not signalled");
  h.assertNoSecrets();
});

test("a bridge crash during startup fails before ready", async (t) => {
  let crashed = false;
  const h = await harness(t, {
    fetch: async () => { throw new TypeError("fetch failed"); },
  });
  h.stdin.write(`${payload()}\n`);
  for (let index = 0; index < 200 && h.spawned.length < 2; index++) await new Promise((resolve) => setTimeout(resolve, 2));
  h.spawned[1].child.emit("error", new Error(`spawn failed ${SECRETS.AI_GATEWAY_API_KEY}`));
  crashed = true;
  assert.equal(await h.run, 1);
  assert.ok(crashed);
  const names = h.events().map((event) => event.event);
  assert.ok(!names.includes("ready"));
  assert.deepEqual(names, ["starting", "failed", "stopping", "stopped"]);
  assert.match(h.events()[1].reason, /bridge stopped unexpectedly/);
  h.assertNoSecrets();
});

test("readiness waits for ready:true and times out into failed plus shutdown", async (t) => {
  let calls = 0;
  const eventually = await harness(t, { fetch: async () => (++calls < 4 ? Response.json({ ready: false }) : Response.json({ ready: true })) });
  eventually.stdin.write(`${payload()}\n`);
  await eventually.waitFor("ready");
  assert.equal(calls, 4);
  eventually.stdin.end();
  assert.equal(await eventually.run, 0);

  const never = await harness(t, {
    fetch: async (_url, init) => {
      if ((init.headers as Record<string, string>).Authorization !== `Bearer ${TOKEN}`) return new Response(null, { status: 401 });
      return new Response(`not json ${TOKEN}`, { status: 200 });
    },
    timeouts: { readinessAttempts: 5 },
  });
  never.stdin.write(`${payload()}\n`);
  assert.equal(await never.run, 1);
  assert.equal(never.fetches.length, 5);
  assert.deepEqual(never.events().map((event) => event.event), ["starting", "failed", "stopping", "stopped"]);
  assert.match(never.events()[1].reason, /did not become ready/);
  assert.deepEqual(never.log, ["bridge:SIGTERM", "bridge:exit", "runtime:SIGTERM", "runtime:exit"]);
  never.assertNoSecrets();
});

test("an occupied port is refused before anything starts", async (t) => {
  const checked: number[] = [];
  const h = await harness(t, { portInUse: async (port) => { checked.push(port); return port === 39202; } });
  h.stdin.write(`${payload()}\n`);
  assert.equal(await h.run, 1);
  assert.deepEqual(checked, [39201, 39202]);
  assert.equal(h.spawned.length, 0);
  assert.deepEqual(h.events(), [{ event: "starting" }, { event: "failed", reason: "Another Jarvis instance appears to be running. Quit it, then try again." }]);
});

test("invalid payloads fail with exit 2, start nothing and never echo secrets", async (t) => {
  const bad = [
    payload({ token: "short" }),
    payload({ config: { UNKNOWN: SECRETS.TAVILY_API_KEY } }),
    payload({ secrets: { TAVILY_API_KEY: SECRETS.TAVILY_API_KEY } }),
    `{"version":1,"token":"${TOKEN}","secrets":${JSON.stringify(SECRETS)}`,
  ];
  for (const line of bad) {
    const h = await harness(t);
    h.stdin.write(`${line}\n`);
    assert.equal(await h.run, 2, line);
    assert.equal(h.spawned.length, 0);
    assert.deepEqual(h.events().map((event) => event.event), ["starting", "failed"]);
    h.assertNoSecrets();
  }
  const oversized = await harness(t);
  oversized.stdin.write(`{"version":1,"token":"${TOKEN}","secrets":{"AI_GATEWAY_API_KEY":"${"k".repeat(70 * 1024)}`);
  assert.equal(await oversized.run, 2);
  assert.match(oversized.events()[1].reason, /too large/);

  const closed = await harness(t);
  closed.stdin.end(payload());
  assert.equal(await closed.run, 2, "a payload without its newline means the app went away");
  assert.equal(closed.spawned.length, 0);

  const silent = await harness(t, { timeouts: { payloadMs: 20 } });
  assert.equal(await silent.run, 2);
  assert.match(silent.events()[1].reason, /not received in time/);

  const badArgs = await harness(t, { argv: ["--resources", "relative"] });
  assert.equal(await badArgs.run, 2);
  const missingHelper = await harness(t, { argv: ["--resources", "/nonexistent-resources", "--data-dir", "/tmp/x", "--helper", "/nonexistent"] });
  assert.equal(await missingHelper.run, 2);
  assert.match(missingHelper.events()[1].reason, /runtime is missing/);
});

test("payload split across chunks is accepted and trailing lifeline data is ignored", async (t) => {
  const h = await harness(t);
  const line = `${payload()}\n`;
  h.stdin.write(line.slice(0, 10));
  h.stdin.write(line.slice(10) + "ignored trailing bytes");
  await h.waitFor("ready");
  h.stdin.write("more ignored input\n");
  h.stdin.end();
  assert.equal(await h.run, 0);
});

test("a signal while waiting for the payload stops at once without starting anything", async (t) => {
  const h = await harness(t, { timeouts: { payloadMs: 60_000 } });
  await h.waitFor("starting");
  const started = Date.now();
  h.signals.emit("SIGTERM");
  assert.equal(await h.run, 0);
  assert.ok(Date.now() - started < 5_000, "does not wait out the payload timeout");
  assert.equal(h.spawned.length, 0);
  assert.deepEqual(h.events(), [{ event: "starting" }, { event: "stopping" }, { event: "stopped", clean: true }]);
});

test("a data folder inside the bundle Resources is refused before anything is written", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-supervisor-inside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = await harness(t);
  for (const dataDir of [path.join(probe.resources, "data"), probe.resources, path.dirname(probe.resources)]) {
    const h = await harness(t, { argv: ["--resources", probe.resources, "--data-dir", dataDir, "--helper", probe.helper] });
    h.stdin.write(`${payload()}\n`);
    assert.equal(await h.run, 2, dataDir);
    assert.match(h.events()[1].reason, /outside the app bundle/);
    assert.equal(h.spawned.length, 0);
  }
  assert.ok(!existsSync(path.join(probe.resources, "data")));
  // Through a symlink as well.
  const link = path.join(root, "linked-resources");
  await symlink(probe.resources, link);
  const viaLink = await harness(t, { argv: ["--resources", probe.resources, "--data-dir", path.join(link, "data"), "--helper", probe.helper] });
  viaLink.stdin.write(`${payload()}\n`);
  assert.equal(await viaLink.run, 2);
  assert.ok(!existsSync(path.join(probe.resources, "data")));
});

test("a child error event after spawn neither crashes the supervisor nor marks a live child exited", async (t) => {
  const h = await harness(t);
  h.stdin.write(`${payload()}\n`);
  await h.waitFor("ready");
  const bridge = h.spawned[1].child as FakeChild & { pid?: number };
  bridge.pid = 4242;
  bridge.emit("error", new Error("kill EPERM"));
  bridge.emit("error", new Error("kill EPERM again"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!h.events().some((event) => event.event === "failed"));
  h.stdin.end();
  assert.equal(await h.run, 0);
  assert.deepEqual(h.log, ["bridge:SIGTERM", "bridge:exit", "runtime:SIGTERM", "runtime:exit"]);
});

test("the script entry point runs when invoked through a symlinked path", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-supervisor-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "real"));
  for (const file of ["supervisor.mjs", "launch-env.mjs"]) {
    await writeFile(path.join(root, "real", file), await readFile(new URL(`../../scripts/${file}`, import.meta.url)));
  }
  await symlink(path.join(root, "real"), path.join(root, "link"));
  const child = realSpawn(process.execPath, [path.join(root, "link", "supervisor.mjs"), "--resources", "relative"], {
    env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  const [code] = await once(child, "exit");
  assert.equal(code, 2);
  assert.deepEqual(output.trim().split("\n").map((line) => JSON.parse(line).event), ["starting", "failed"]);
});

// ---------------------------------------------------------------- real end-to-end

const repoRuntime = fileURLToPath(new URL("..", import.meta.url));
const builtRuntime = path.join(repoRuntime, ".output", "server", "index.mjs");

function portAccepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

test("end to end: the real supervisor starts, authenticates and stops the real services", {
  skip: !existsSync(builtRuntime) ? "runtime/.output is not built" : false,
  timeout: 120_000,
}, async (t) => {
  const release = await acquireServicePortsLock();
  t.after(release);
  if ((await portAccepting(39201)) || (await portAccepting(39202))) { t.skip("ports 39201/39202 are in use"); return; }
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-supervisor-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Resources layout without a bundled node: the supervisor uses process.execPath.
  const resources = path.join(root, "Resources");
  await mkdir(path.join(resources, "launcher"), { recursive: true });
  await symlink(repoRuntime, path.join(resources, "runtime"));
  const scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));
  for (const file of ["supervisor.mjs", "launch-env.mjs"]) await writeFile(path.join(resources, "launcher", file), await readFile(path.join(scripts, file)));
  const dataDir = path.join(root, "data");
  const token = randomBytes(32).toString("hex");
  const key = "dummy-gateway-key-for-supervisor-e2e";
  const child = realSpawn(process.execPath, [path.join(resources, "launcher", "supervisor.mjs"),
    "--resources", resources, "--data-dir", dataDir, "--helper", process.execPath], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, TMPDIR: root, USER: "fixture", LOGNAME: "fixture", LANG: "en_US.UTF-8" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  const exited = once(child, "exit");
  child.stdin.write(`${JSON.stringify({ version: 1, token, secrets: { AI_GATEWAY_API_KEY: key }, config: { JARVIS_MODEL: "openai/gpt-4.1-mini" } })}\n`);
  for (let index = 0; index < 1_200 && !/"event":"(ready|failed)"/.test(output); index++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(output, /"event":"ready"/, `supervisor output: ${output} ${errors}`);

  const url = "http://127.0.0.1:39202/v1/state";
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${"0".repeat(64)}` } })).status, 401);
  const state = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).ready, true);
  assert.equal((await stat(path.join(dataDir, "logs", "bridge.log"))).mode & 0o777, 0o600);
  assert.ok(existsSync(path.join(dataDir, "runtime-state", ".eve")), "Eve state lives in the data dir, not the bundle");

  child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0, `supervisor output: ${output} ${errors}`);
  const events = output.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.event), ["starting", "ready", "stopping", "stopped"]);
  assert.equal(events.at(-1).clean, true);
  for (const value of [token, key]) assert.ok(!output.includes(value) && !errors.includes(value));
  for (const file of ["runtime.log", "bridge.log"]) assert.ok(!(await readFile(path.join(dataDir, "logs", file), "utf8")).includes(token));
  assert.equal(await portAccepting(39201), false);
  assert.equal(await portAccepting(39202), false);
});
