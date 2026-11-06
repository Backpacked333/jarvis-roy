import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { homedir } from "node:os";
import { appleScripts, type AppleScriptName } from "./scripts.ts";
import { cancelled, ConnectedServiceError } from "./errors.ts";

export interface AppleProcessOptions {
  signal?: AbortSignal;
  mutation?: boolean;
}

export interface AppleProcessDependencies {
  spawn?: (command: string, argv: readonly string[], options: SpawnOptions) => ChildProcess;
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  timeoutMs?: number;
  killGraceMs?: number;
}

export type AppleRunner = (script: AppleScriptName, argv: string[], options: AppleProcessOptions) => Promise<unknown>;

export function createAppleRunner(dependencies: AppleProcessDependencies = {}): AppleRunner {
  const spawnProcess = dependencies.spawn ?? spawn;
  const killGroup = dependencies.killGroup ?? ((pid, signal) => { process.kill(-pid, signal); });
  return async (name, argv, options) => {
    cancelled(options.signal);
    const script = appleScripts[name];
    if (!script || argv.some((arg) => arg.includes("\0") || Buffer.byteLength(arg) > 100_000)) {
      throw new ConnectedServiceError("invalid_input", "Invalid native service arguments.");
    }
    return await new Promise<unknown>((resolve, reject) => {
      let child: ChildProcess;
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const error = (code: string, text: string) => {
        const uncertain = options.mutation === true && !safeNativeFailures.has(code);
        return new ConnectedServiceError(code,
          text + (uncertain ? " The action may already have taken effect. Check the local app; do not retry automatically." : ""), uncertain);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      };
      const fail = (failure: ConnectedServiceError, terminate = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (terminate && child?.pid) {
          const pid = child.pid;
          try { killGroup(pid, "SIGTERM"); } catch { /* The helper may already have exited. */ }
          const escalation = setTimeout(() => {
            try { killGroup(pid, "SIGKILL"); } catch { /* Reap remaining group members if any. */ }
          }, dependencies.killGraceMs ?? 250);
          escalation.unref();
        }
        reject(failure);
      };
      const abort = () => fail(error("cancelled", "Native service action cancelled; stopping its helper, not rolling back the app."), true);
      try {
        child = spawnProcess("/usr/bin/osascript", ["-l", script.language, "-e", script.source, "--", ...argv], {
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { HOME: homedir(), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
        });
      } catch {
        fail(new ConnectedServiceError("native_unavailable", "Cannot start /usr/bin/osascript. This connector requires local macOS apps."));
        return;
      }
      child.stdout?.on("data", (data: Buffer) => {
        if (settled) return;
        if (stdout.length + data.length > 128_000) return fail(error("output_limit", "Native service response exceeded the safe output limit."), true);
        stdout = Buffer.concat([stdout, data]);
      });
      child.stderr?.on("data", (data: Buffer) => {
        if (settled) return;
        if (stderr.length + data.length > 8_000) return fail(error("output_limit", "Native service error exceeded the safe output limit."), true);
        stderr = Buffer.concat([stderr, data]);
      });
      child.once("error", () => fail(error("native_unavailable", "Native service helper failed. Verify that the local app is installed and configured."), true));
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          const denied = /(?:-1743|not authorized to send apple events)/i.test(stderr.toString("utf8"));
          fail(error(denied ? "permission_denied" : "apple_error", denied ? permissionHelp : "The local app rejected the action. Verify its account/service and Automation permission; this macOS version may not support the requested scripting action."));
          return;
        }
        let envelope: unknown;
        try { envelope = JSON.parse(stdout.toString("utf8")); } catch {
          fail(error("invalid_response", "Native service returned an invalid response."));
          return;
        }
        if (!envelope || typeof envelope !== "object" || !("ok" in envelope)) {
          fail(error("invalid_response", "Native service returned an invalid response."));
          return;
        }
        if (envelope.ok !== true || !("data" in envelope)) {
          const code = "code" in envelope && typeof envelope.code === "string" ? envelope.code : "apple_error";
          const message = Object.hasOwn(appleErrors, code) ? appleErrors[code] : "The local app could not complete the action. Verify the account and Automation permission; scripting support varies by macOS version.";
          fail(error(Object.hasOwn(appleErrors, code) ? code : "apple_error", message));
          return;
        }
        settled = true;
        cleanup();
        resolve(envelope.data);
      });
      timeout = setTimeout(() => fail(error("timeout", "Native service timed out. Open the local app and check for account or permission prompts."), true), dependencies.timeoutMs ?? 15_000);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  };
}

const permissionHelp = "Automation permission denied. Open System Settings → Privacy & Security → Automation and allow the launching app (Jarvis or Terminal) to control the connected Mail, Calendar or Messages app, then relaunch.";
const safeNativeFailures = new Set(["permission_denied", "account_unavailable", "sender_not_in_account", "calendar_not_found", "calendar_read_only", "mail_auto_copy"]);
const appleErrors: Record<string, string> = {
  permission_denied: permissionHelp,
  apple_error: "The local app rejected the action. Check its account setup and Automation permission; scripting support varies by macOS version.",
  message_not_found: "That message is no longer in the inbox. Approve a fresh inbox listing and explicitly select a message ID.",
  account_unavailable: "The selected Mail account is unavailable or disabled. Configure it in Mail and list accounts again.",
  sender_not_in_account: "The approved sender does not belong to the selected Mail account. Select an exact address from list_accounts.",
  mail_auto_copy: "Mail is configured to copy outgoing messages to unapproved recipients. Disable its automatic Cc/Bcc setting yourself before requesting another send; Jarvis will not change your preferences.",
  mail_content_changed: "Mail changed the approved content or added recipients/attachments. Nothing was intentionally sent; inspect the draft and disable automatic signatures/Bcc before a new request.",
  send_not_confirmed: "Mail did not confirm submission. Inspect Sent and Outbox; do not retry automatically.",
  calendar_not_found: "The selected calendar is unavailable. Configure Calendar and list calendars again.",
  calendar_read_only: "The selected calendar is read-only. Select a writable calendar; no calendar was substituted.",
  unsupported: "The requested action is not supported by this native connector.",
};
