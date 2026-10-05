import { setTimeout as delay } from "node:timers/promises";
import {
  openValidationTasks,
  type ValidationTasks,
  type ValidationTasksOptions,
} from "./validation-tasks.js";
import type { StoredValidationTask } from "./task-store.js";

/** One foreground server owns one lazy worker across SDK discovery instances. */
export class McpValidationTasks {
  private worker: Promise<ValidationTasks> | undefined;
  private starting: Promise<StoredValidationTask> | undefined;
  private activeId: string | undefined;
  private reserved = false;
  private closing: Promise<void> | undefined;
  private closed = false;
  constructor(readonly options: ValidationTasksOptions) {}
  get busy(): boolean {
    return this.reserved || this.activeId !== undefined || this.closed;
  }
  private open(): Promise<ValidationTasks> {
    if (this.closed) throw new Error("Task owner is closing");
    this.worker ??= openValidationTasks(this.options);
    return this.worker;
  }
  async start(
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<StoredValidationTask> {
    if (!this.options.allowExecution || this.busy || signal.aborted)
      throw new Error("Task execution unavailable");
    if (
      timeoutMs !== undefined &&
      timeoutMs !== (this.options.timeoutMs ?? 30000)
    )
      throw new Error("Task timeout is pinned at startup");
    this.reserved = true;
    const operation = (async () => {
      const worker = await this.open();
      if (this.closed || signal.aborted)
        throw new Error("Task creation cancelled");
      const task = await worker.start();
      this.activeId = task.taskId;
      if (signal.aborted || this.closed) {
        await worker.cancel(task.taskId);
        this.activeId = undefined;
        throw new Error("Task creation cancelled");
      }
      void this.watch(worker, task.taskId);
      return task;
    })();
    this.starting = operation;
    try {
      return await operation;
    } finally {
      this.reserved = false;
      this.starting = undefined;
    }
  }
  private async watch(worker: ValidationTasks, id: string): Promise<void> {
    try {
      while (!this.closed && this.activeId === id) {
        const task = await worker.get(id);
        if (task.status !== "working") {
          if (this.activeId === id) this.activeId = undefined;
          return;
        }
        await delay(100);
      }
    } catch {
      // A lost worker may still be cleaning up. Retire the owner and await exit;
      // never release admission merely because polling failed.
      await this.close().catch(() => {});
    }
  }
  async get(id: string): Promise<StoredValidationTask> {
    const task = await (await this.open()).get(id);
    if (this.activeId === id && task.status !== "working")
      this.activeId = undefined;
    return task;
  }
  async cancel(id: string): Promise<void> {
    const task = await (await this.open()).cancel(id);
    if (this.activeId === id && task.status !== "working")
      this.activeId = undefined;
  }
  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      await this.starting?.catch(() => {});
      const worker = await this.worker?.catch(() => undefined);
      await worker?.close();
      this.activeId = undefined;
    })();
    return this.closing;
  }
}
export function taskMetadata(task: StoredValidationTask) {
  return {
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: 250,
  };
}
