import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { controllerEnv } from "./process.ts";

export const CONTROLLER_PATH = fileURLToPath(new URL("../../workers/controller.py", import.meta.url));
const RpcSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("model"), id: z.number().int().positive(), request: z.record(z.string(), z.unknown()) }),
  z.strictObject({ type: z.literal("tool"), id: z.number().int().positive(), name: z.string().max(80), arguments: z.record(z.string(), z.unknown()) }),
]);
export type Rpc = z.infer<typeof RpcSchema>;
const DoneSchema = z.strictObject({ type: z.literal("done"), status: z.enum(["completed", "waiting_question", "failed"]), summary: z.string().max(4000).optional() });

export async function runController(python: string, init: object, signal: AbortSignal,
  handle: (message: Rpc) => Promise<unknown>): Promise<z.infer<typeof DoneSchema>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-I", "-u", CONTROLLER_PATH], { env: controllerEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "", bytes = 0, stderrBytes = 0, lastId = 0, busy = false;
    let done: z.infer<typeof DoneSchema> | undefined, failure: Error | undefined;
    const fail = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => fail(new Error("Worker controller cancelled or timed out"));
    signal.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 65_536) fail(new Error("Controller diagnostic bound exceeded"));
    });
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 32_000_000) { fail(new Error("Controller lifetime output bound exceeded")); return; }
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1_000_000) { fail(new Error("Controller frame bound exceeded")); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (busy || buffer.length || done) { fail(new Error("Out-of-order controller frames")); return; }
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "done") { done = DoneSchema.parse(parsed); return; }
        const message = RpcSchema.parse(parsed);
        if (message.id !== ++lastId) throw new Error("Controller sequence mismatch");
        busy = true;
        void handle(message).then(value => {
          busy = false;
          if (!failure && !signal.aborted) child.stdin.write(JSON.stringify({ id: message.id, ok: true, value }) + "\n");
        }, error => { busy = false; fail(error instanceof Error ? error : new Error("Controller operation failed")); });
      } catch (error) { fail(error as Error); }
    });
    child.on("error", fail);
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0 || !done || buffer || busy) reject(new Error("Pinned worker controller failed or is unavailable"));
      else resolve(done);
    });
    child.stdin.write(JSON.stringify(init) + "\n");
  });
}
