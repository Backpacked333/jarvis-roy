import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_MODEL, configuredModel } from "../agent/lib/model.ts";

test("model selection defaults to GPT-6 Sol Fast and preserves explicit overrides", () => {
  assert.equal(DEFAULT_MODEL, "openai/gpt-6-sol-fast");
  assert.equal(configuredModel(""), DEFAULT_MODEL);
  assert.equal(configuredModel("anthropic/custom-model"), "anthropic/custom-model");
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
