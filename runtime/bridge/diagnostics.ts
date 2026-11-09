import { performance } from "node:perf_hooks";

export type DiagnosticName = "bridge.started" | "bridge.stopping" | "bridge.stopped" | "task.state" | "task.cancellation" | "request.finished" | "provider.unavailable";
export interface DiagnosticEvent { version: 1; at: string; name: DiagnosticName; durationMs?: number; status?: number | string }
/** Metadata only: callers cannot add prompts, URLs, credentials, transcripts or exception bodies. */
export class Diagnostics {
  private readonly entries: DiagnosticEvent[] = [];
  record(name: DiagnosticName, fields: { durationMs?: number; status?: number | string } = {}): void {
    const event: DiagnosticEvent = { version: 1, at: new Date().toISOString(), name };
    if (Number.isFinite(fields.durationMs)) event.durationMs = Math.max(0, Math.round(fields.durationMs!));
    if (typeof fields.status === "number" && Number.isFinite(fields.status)) event.status = fields.status;
    else if (typeof fields.status === "string" && /^[a-z_]{1,40}$/.test(fields.status)) event.status = fields.status;
    this.entries.push(event);
    if (this.entries.length > 256) this.entries.shift();
    if (process.env.JARVIS_DIAGNOSTICS === "1") process.stderr.write(`${JSON.stringify(event)}\n`);
  }
  snapshot(): DiagnosticEvent[] { return structuredClone(this.entries); }
  timer(name: DiagnosticName): (status?: number | string) => void {
    const start = performance.now();
    return status => this.record(name, { durationMs: performance.now() - start, status });
  }
}
