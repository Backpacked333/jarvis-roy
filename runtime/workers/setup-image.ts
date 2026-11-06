import { randomUUID } from "node:crypto";
import { Docker } from "../bridge/harness-worker/docker.ts";
import { WORKER_IMAGES } from "../bridge/harness-worker/images.ts";
import { command } from "../bridge/harness-worker/process.ts";
import { defaultRoomPolicy } from "../bridge/harness-contracts/domain.ts";

try {
  const [profile, action, ...extra] = process.argv.slice(2);
  if (!["python", "coding"].includes(profile) || action && action !== "--pull" || extra.length) {
    throw new Error("Usage: node runtime/workers/setup-image.ts <python|coding> [--pull]. Without --pull, prints the engine-matched pin only.");
  }
  const docker = new Docker("docker", `setup-${randomUUID()}`);
  const architecture = await docker.available();
  const image = WORKER_IMAGES[profile as keyof typeof WORKER_IMAGES][architecture];
  if (action === "--pull") {
    console.error(`Explicit setup: pulling ${image} for linux/${architecture}`);
    const pulled = await command("docker", ["pull", "--platform", `linux/${architecture}`, image], { timeoutMs: 600_000 });
    if (pulled.code !== 0) throw new Error("Explicit image pull failed; no policy image has been configured");
    const ref = { roomId: "setup", runId: randomUUID(), nodeId: "probe", attemptId: "attempt" };
    try {
      await docker.create(ref, defaultRoomPolicy(image), new AbortController().signal, 30_000);
      console.error("Image toolchain and isolation probes passed; disposable probe container removed below.");
    } finally {
      if (!await docker.stop(ref)) throw new Error("Setup probe cleanup unconfirmed; inspect local Docker before retrying");
    }
  }
  console.log(image);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Image setup failed");
  process.exitCode = 1;
}
