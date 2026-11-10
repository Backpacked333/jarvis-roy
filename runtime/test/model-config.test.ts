import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_MODEL, configuredContextWindowTokens, configuredModel, selectModel } from "../agent/lib/model.ts";

test("model selection defaults to GPT-6 Sol Fast and preserves explicit overrides", () => {
  assert.equal(DEFAULT_MODEL, "openai/gpt-6-sol-fast");
  assert.equal(configuredModel(""), DEFAULT_MODEL);
  assert.equal(configuredModel("anthropic/custom-model"), "anthropic/custom-model");
});

test("local model selection never depends on the build-time gateway catalog", () => {
  const previous = { profile: process.env.JARVIS_RUNTIME_PROFILE, model: process.env.JARVIS_MODEL, window: process.env.JARVIS_CONTEXT_WINDOW_TOKENS };
  try {
    delete process.env.JARVIS_RUNTIME_PROFILE;
    delete process.env.JARVIS_CONTEXT_WINDOW_TOKENS;
    process.env.JARVIS_MODEL = "vendor/published-after-build";
    // Eve only consults its baked catalog when a selection omits the window.
    assert.deepEqual(selectModel({} as never), { model: "vendor/published-after-build", modelContextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS });
    process.env.JARVIS_CONTEXT_WINDOW_TOKENS = "64000";
    assert.deepEqual(selectModel({} as never), { model: "vendor/published-after-build", modelContextWindowTokens: 64_000 });
  } finally {
    for (const [name, value] of [["JARVIS_RUNTIME_PROFILE", previous.profile], ["JARVIS_MODEL", previous.model], ["JARVIS_CONTEXT_WINDOW_TOKENS", previous.window]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("the context window override accepts only a bounded whole number", () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW_TOKENS, 200_000);
  assert.equal(configuredContextWindowTokens(undefined), 200_000);
  assert.equal(configuredContextWindowTokens(""), 200_000);
  assert.equal(configuredContextWindowTokens(" 128000 "), 128_000);
  assert.equal(configuredContextWindowTokens("16384"), 16_384);
  for (const invalid of ["16383", "2000001", "0", "-5", "1e6", "128000.5", "abc", "0128000", "9999999999"]) {
    assert.equal(configuredContextWindowTokens(invalid), 200_000, invalid);
  }
});

for (const override of [undefined, "", "openai/custom-model"]) {
  test(`launcher, Eve agents and bridge agree with JARVIS_MODEL=${JSON.stringify(override)}`, async () => {
    const env = { ...process.env };
    delete env.JARVIS_MODEL;
    if (override !== undefined) env.JARVIS_MODEL = override;
    const expected = override || DEFAULT_MODEL;
    const script = await readFile(new URL("../../scripts/run-macos.sh", import.meta.url), "utf8");
    const assignment = script.split("\n").find((line) => line.startsWith("export JARVIS_MODEL="));
    assert.ok(assignment);
    assert.equal(execFileSync("bash", ["-c", `${assignment}\nprintf '%s' "$JARVIS_MODEL"`], { env, encoding: "utf8" }), expected);

    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { mkdtemp, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import path from "node:path";
      import agent from "./agent/agent.ts";
      import analyst from "./agent/subagents/analyst/agent.ts";
      import { configuredModel, modelSelection } from "./agent/lib/model.ts";
      import { JarvisService } from "./bridge/service.ts";
      import { FakeEveClient } from "./test/helpers.ts";
      const dataDirectory = await mkdtemp(path.join(tmpdir(), "jarvis-model-"));
      try {
        const client = new FakeEveClient();
        const service = await JarvisService.create({ client, dataDirectory });
        const explicit = await JarvisService.create({ client, dataDirectory, model: "fixture/explicit" });
        assert.equal(explicit.model, "fixture/explicit");
        assert.equal(agent.model, modelSelection);
        assert.equal(analyst.model, modelSelection);
        console.log(JSON.stringify([configuredModel(), service.model, (await service.state()).model]));
      } finally { await rm(dataDirectory, { recursive: true, force: true }); }
    `], { cwd: new URL("../", import.meta.url), env, encoding: "utf8", timeout: 15_000 });
    assert.deepEqual(JSON.parse(output), [expected, expected, expected]);
  });
}
