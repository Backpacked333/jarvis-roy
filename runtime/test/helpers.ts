import type { EveClient, EveDelivery, EveEvent, EveSession } from "../bridge/types.ts";

export function event(
  type: string,
  data: Record<string, unknown>,
  line: number,
  index = 0,
): EveEvent {
  return { type, data, meta: { position: { line, index } } };
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as T;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

export class FakeDelivery implements EveDelivery {
  private readonly queue = new AsyncQueue<unknown>();
  private resolveResult!: (result: unknown) => void;
  private resolveStreamComplete!: () => void;
  private readonly resultPromise = new Promise<unknown>((resolve) => {
    this.resolveResult = resolve;
  });
  readonly streamComplete = new Promise<void>((resolve) => {
    this.resolveStreamComplete = resolve;
  });

  constructor(events: unknown[] = [], result?: unknown) {
    for (const item of events) this.queue.push(item);
    if (result !== undefined) this.finish(result);
  }

  async *stream(): AsyncGenerator<unknown> {
    try {
      for await (const value of this.queue) yield value;
    } finally {
      this.resolveStreamComplete();
    }
  }

  result(): Promise<unknown> {
    return this.resultPromise;
  }

  finish(result: unknown): void {
    this.queue.end();
    this.resolveResult(result);
  }

  emit(value: unknown): void {
    this.queue.push(value);
  }
}

export class FakeSession implements EveSession {
  readonly id = "fake-session";
  initial = new FakeDelivery();
  readonly responses: Array<readonly { interactionId: string; optionId?: string; text?: string }[]> = [];
  responseDelivery = new FakeDelivery();
  cancelDelivery = new FakeDelivery();
  cancelCalls = 0;
  respondGate: Promise<void> | undefined;
  confirmCancellation = true;
  postCancelResult: unknown = { status: "cancelled", outcome: "handled" };

  async respond(
    answers: readonly { interactionId: string; optionId?: string; text?: string }[],
  ): Promise<EveDelivery> {
    this.responses.push(answers);
    if (this.respondGate) await this.respondGate;
    return this.responseDelivery;
  }

  async cancel(): Promise<EveDelivery> {
    this.cancelCalls += 1;
    if (!this.confirmCancellation) {
      this.cancelDelivery = new FakeDelivery([], { status: "completed", outcome: "applied" });
      return this.cancelDelivery;
    }
    const cancelled = event("turn.settled", { turnId: "turn-1", outcome: "cancelled" }, 20);
    this.initial.emit(cancelled);
    this.initial.emit(event("delivery.settled", { deliveryId: "initial", outcome: "handled" }, 21));
    this.initial.finish(this.postCancelResult);
    this.cancelDelivery = new FakeDelivery(
      [
        cancelled,
        event("delivery.settled", { deliveryId: "cancel", outcome: "applied" }, 22),
      ],
      { status: "completed", outcome: "applied" },
    );
    return this.cancelDelivery;
  }
}

export class FakeEveClient implements EveClient {
  readonly session = new FakeSession();
  readonly attachCalls: string[] = [];
  healthResult: unknown = { ok: true, status: "ready", workflowId: "test" };

  async health(): Promise<unknown> {
    return this.healthResult;
  }

  readonly sessions = {
    create: async (_input: { message: string }) => ({
      session: this.session,
      delivery: this.session.initial,
    }),
    attach: (sessionId: string) => {
      this.attachCalls.push(sessionId);
      return this.session;
    },
  };
}

export function approvalEvents(): EveEvent[] {
  return [
    event("turn.started", { turnId: "turn-1" }, 1),
    event("call.requested", {
      callId: "call-1",
      capability: { kind: "tool", name: "remember" },
      input: { text: "I prefer concise answers." },
    }, 2),
    event("interaction.opened", {
      interactionId: "interaction-1",
      subject: { callId: "call-1" },
      request: {
        kind: "approval",
        title: "Save this preference?",
        prompt: "Save this preference?",
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
      },
    }, 3),
    event("turn.paused", {
      turnId: "turn-1",
      awaiting: [{ interactionId: "interaction-1" }],
    }, 4),
    event("delivery.settled", {
      deliveryId: "initial",
      outcome: "awaiting-input",
      turnId: "turn-1",
    }, 5),
  ];
}

export function completedEvents(): EveEvent[] {
  return [
    event("interaction.settled", {
      interactionId: "interaction-1",
      outcome: "accepted",
    }, 6),
    event("turn.started", { turnId: "turn-1" }, 7),
    event("content.completed", {
      partId: "reply-1",
      kind: "text",
      phase: "reply",
      value: "Preference saved.",
    }, 8),
    event("turn.settled", { turnId: "turn-1", outcome: "completed" }, 9),
    event("delivery.settled", {
      deliveryId: "response",
      outcome: "handled",
      turnId: "turn-1",
    }, 10),
  ];
}

/**
 * Serializes tests that bind the fixed service ports 39201/39202 across test
 * files (node --test runs files in parallel processes). Returns a release function.
 */
export async function acquireServicePortsLock(timeoutMs = 240_000): Promise<() => Promise<void>> {
  const { mkdir, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const lock = join(tmpdir(), "jarvis-test-service-ports.lock");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lock);
      return async () => { await rm(lock, { recursive: true, force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Break a lock abandoned by a crashed test process.
      const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > timeoutMs) await rm(lock, { recursive: true, force: true });
      if (Date.now() > deadline) throw new Error("Timed out waiting for the shared service-ports test lock.");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
