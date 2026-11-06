import path from "node:path";
import { ensurePrivateDirectory, getDataDirectory, readPrivateJson, writeJsonAtomically } from "../agent/lib/persistence.ts";
import type { TaskRecord, TaskStatus } from "./types.ts";

const TERMINAL_STATUSES = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function isTaskRecord(value: unknown): value is TaskRecord {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Partial<TaskRecord>;
  return typeof task.id === "string" &&
    typeof task.title === "string" &&
    typeof task.createdAt === "string" &&
    typeof task.reply === "string" &&
    Array.isArray(task.events) &&
    Array.isArray(task.approvals) &&
    typeof task.childTasks === "object" &&
    task.childTasks !== null &&
    typeof task.status === "string";
}

export class TaskStore {
  readonly dataDirectory: string;
  private readonly statePath: string;
  private readonly records = new Map<string, TaskRecord>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDirectory = getDataDirectory()) {
    this.dataDirectory = dataDirectory;
    this.statePath = path.join(dataDirectory, "tasks.json");
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.dataDirectory);
    const saved = await readPrivateJson<unknown>(this.statePath);
    if (saved !== undefined) {
      if (!Array.isArray(saved) || !saved.every(isTaskRecord)) {
        throw new Error("Jarvis task history is invalid.");
      }
      for (const task of saved) this.records.set(task.id, task);
    }

    for (const task of this.records.values()) {
      if (task.status === "interrupted") {
        task.approvals = [];
        task.cancelRequested = false;
      }
      if (!TERMINAL_STATUSES.has(task.status)) {
        task.status = "interrupted";
        task.approvals = [];
        task.cancelRequested = false;
        task.error = "Runtime restarted before this task's outcome was confirmed; it was not reported as cancelled.";
      }
    }
    this.prune();
    await this.persist();
  }

  values(): TaskRecord[] {
    return [...this.records.values()];
  }

  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  async add(task: TaskRecord): Promise<void> {
    this.records.set(task.id, task);
    this.prune();
    await this.persist();
  }

  async update(id: string, update: (task: TaskRecord) => void): Promise<TaskRecord | undefined> {
    const task = this.records.get(id);
    if (!task) return undefined;
    update(task);
    this.prune();
    await this.persist();
    return task;
  }

  private prune(): void {
    while (this.records.size > 100) {
      const removable = [...this.records.values()]
        .filter((task) => TERMINAL_STATUSES.has(task.status) && task.status !== "interrupted")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!removable) return;
      this.records.delete(removable.id);
    }
  }

  private persist(): Promise<void> {
    const write = this.writeChain.then(async () => {
      await writeJsonAtomically(this.statePath, [...this.records.values()]);
    });
    this.writeChain = write.catch(() => undefined);
    return write;
  }
}
