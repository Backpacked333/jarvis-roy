import { randomUUID } from "node:crypto";
import { Docker } from "../../bridge/harness-worker/docker.ts";
import { defaultRoomPolicy, ImageRefSchema } from "../../bridge/harness-contracts/domain.ts";

try {
  const image = ImageRefSchema.parse(process.argv[2]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Use the exact locally built image ID");
  const docker = new Docker("docker", `analysis-setup-${randomUUID()}`);
  const ref = { roomId: "analysis-setup", runId: randomUUID(), nodeId: "probe", attemptId: "attempt" };
  try {
    await docker.create(ref, defaultRoomPolicy(image), new AbortController().signal, 30_000);
    console.error("Jarvis resource, filesystem and security enforcement probes passed.");
  } finally {
    if (!await docker.stop(ref)) throw new Error("Analysis probe cleanup is unconfirmed; inspect Docker before retrying");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Analysis isolation probe failed");
  process.exitCode = 1;
}
