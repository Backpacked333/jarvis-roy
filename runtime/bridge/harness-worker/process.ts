import { spawn } from "node:child_process";

export function controllerEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", PYTHONIOENCODING: "utf-8" };
}

export async function command(binary: string, args: string[], options: {
  input?: string; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal;
} = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: controllerEnv(), stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let bytes = 0, failure: Error | undefined;
    const fail = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => fail(new Error("Operation cancelled"));
    const timer = setTimeout(() => fail(new Error("Operation deadline exceeded")), options.timeoutMs ?? 15_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    const capture = (target: Buffer[]) => (data: Buffer) => {
      bytes += data.length;
      if (bytes > (options.maxBytes ?? 65_536)) fail(new Error("Operation output limit exceeded"));
      else target.push(data);
    };
    child.stdout.on("data", capture(out)); child.stderr.on("data", capture(err));
    child.on("error", (error) => { failure ??= error; });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), code: code ?? -1 });
    });
    child.stdin.end(options.input);
  });
}
