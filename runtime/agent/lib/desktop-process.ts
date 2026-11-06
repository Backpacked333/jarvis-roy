import { spawn } from "node:child_process";
import { homedir } from "node:os";

export const TERMINAL_TIMEOUT_MS = 30_000;
export const TERMINAL_OUTPUT_BYTES = 32_768;

export function sanitizedEnvironment(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir(), LANG: "en_US.UTF-8" };
}

export function redactDesktopText(text: string, environment = process.env): string {
  let result = text;
  const secrets = Object.entries(environment)
    .filter(([key, value]) => /key|token|secret|password|credential|authorization/i.test(key) && value && value.length >= 4)
    .map(([, value]) => value!).sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    result = result.split(secret).join("[REDACTED]");
    // A bounded stream may end partway through a credential.
    for (let length = Math.min(secret.length - 1, result.length); length >= 4; length--) {
      if (result.endsWith(secret.slice(0, length))) {
        result = `${result.slice(0, -length)}[REDACTED]`;
        break;
      }
    }
  }
  return result
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|token|client[_-]?secret|credential)["']?\s*[:=]\s*["']?[^\s,;}]+/gi, "[REDACTED CREDENTIAL]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]");
}

export interface ProcessResult {
  status: "completed" | "failed" | "cancelled" | "timed_out" | "output_limit";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface ProcessOptions {
  signal?: AbortSignal;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  environment?: NodeJS.ProcessEnv;
  redactOutput?: boolean;
}

export async function runBoundedProcess(
  executable: string, args: string[], cwd: string, options: ProcessOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new Error("Action cancelled before execution.");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > TERMINAL_TIMEOUT_MS ||
      !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1 || options.maxOutputBytes > 524_288) {
    throw new Error("Invalid local process limits.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, env: sanitizedEnvironment(), shell: false, detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stopped: ProcessResult["status"] | undefined;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let bytes = 0;
    let truncated = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { /* Already exited. */ }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      killGroup("SIGKILL");
      cleanup();
      const output = (chunks: Buffer[]) => {
        const value = Buffer.concat(chunks).toString("utf8");
        return options.redactOutput === false ? value : redactDesktopText(value, options.environment);
      };
      resolve({
        status: stopped ?? (exitCode === 0 ? "completed" : "failed"), exitCode, signal: exitSignal,
        stdout: output(stdout), stderr: output(stderr), truncated,
      });
    };
    const stop = (reason: ProcessResult["status"]) => {
      if (stopped || settled) return;
      stopped = reason;
      killGroup("SIGTERM");
      killTimer = setTimeout(finish, 200);
    };
    const abort = () => stop("cancelled");
    const timeout = setTimeout(() => stop("timed_out"), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (target: Buffer[], chunk: Buffer) => {
      const remaining = options.maxOutputBytes - bytes;
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      bytes += Math.min(remaining, chunk.length);
      if (chunk.length > remaining) { truncated = true; stop("output_limit"); }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", () => { /* Child may exit without consuming input. */ });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      killGroup("SIGKILL");
      cleanup();
      reject(new Error("Could not start the configured executable. Check that it exists and is executable."));
    });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // Do not leave background children running after a foreground command exits.
      if (!stopped) killGroup("SIGKILL");
    });
    child.on("close", () => { if (!stopped) finish(); });
    child.stdin.end(options.stdin ?? "");
  });
}
