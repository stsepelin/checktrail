import { z } from "zod";
import { createPlan, validate, type PlanOptions } from "./engine.js";
import {
  openTaskStore,
  type ValidationTaskStore,
  type StoredValidationTask,
} from "./task-store.js";
import {
  validationTasksOptionsSchema,
  validationTaskRequestSchema,
} from "./validation-tasks-protocol.js";

let store: ValidationTaskStore | undefined;
let options: z.output<typeof validationTasksOptionsSchema> | undefined;
let initializing = false;
let closing: Promise<void> | undefined;
let starting: Promise<StoredValidationTask> | undefined;
let active:
  | { taskId: string; controller: AbortController; done: Promise<void> }
  | undefined;

function send(message: Record<string, unknown>): void {
  if (!process.connected) return;
  try {
    process.send!(message, (failure: Error | null) => {
      if (failure) disconnect();
    });
  } catch {
    disconnect();
  }
}
function reply(id: number, value: StoredValidationTask | null): void {
  send({ id, ok: true, value });
}
function error(id: number, code: string): void {
  send({ id, ok: false, error: code });
}
function planOptions(): PlanOptions {
  const value = options!;
  return {
    ...(value.base !== undefined ? { base: value.base } : {}),
    ...(value.policyOverlay !== undefined
      ? { policyOverlay: value.policyOverlay }
      : {}),
    ...(value.environment !== undefined
      ? { environment: value.environment }
      : {}),
    ...(value.externalAdapters !== undefined
      ? { externalAdapters: value.externalAdapters }
      : {}),
  };
}
async function run(taskId: string, controller: AbortController): Promise<void> {
  try {
    try {
      const report = await validate(options!.root, {
        ...planOptions(),
        trusted: true,
        timeoutMs: options!.timeoutMs,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) store!.complete(taskId, report);
    } catch {
      if (!controller.signal.aborted) store!.interrupt(taskId);
    }
    if (controller.signal.aborted) store!.finishCancellation(taskId);
  } catch {
    // Persistence failure must not release the execution slot as a successful task.
    disconnect();
  } finally {
    active = undefined;
  }
}
async function start(): Promise<StoredValidationTask> {
  const { plan } = await createPlan(options!.root, planOptions());
  if (closing) throw new Error("closing");
  const task = store!.create(plan.sourceFingerprint);
  const controller = new AbortController();
  const done = new Promise<void>((resolve) => {
    setImmediate(() => {
      void run(task.taskId, controller).finally(resolve);
    });
  });
  active = { taskId: task.taskId, controller, done };
  return task;
}
async function cancel(taskId: string): Promise<StoredValidationTask> {
  const task = store!.get(taskId);
  if (task.status !== "working") return task;
  if (active?.taskId !== taskId) throw new Error("No active worker for task");
  store!.requestCancellation(taskId);
  const running = active;
  running.controller.abort();
  await running.done;
  return store!.get(taskId);
}
async function shutdown(): Promise<void> {
  closing ??= (async () => {
    await starting?.catch(() => {});
    const running = active;
    if (running) {
      try {
        store!.requestCancellation(running.taskId);
      } finally {
        running.controller.abort();
        await running.done;
      }
    }
    store?.close();
  })();
  return closing;
}
function disconnect(): void {
  const release = () => {
    try {
      store?.close();
    } finally {
      if (process.connected) process.disconnect();
    }
  };
  void shutdown().then(release, release);
}

process.on("disconnect", disconnect);
process.on("SIGTERM", disconnect);
process.on("SIGINT", disconnect);
process.on("message", (message: unknown) => {
  void (async () => {
    if (!options) {
      if (initializing) {
        error(0, "busy");
        return;
      }
      initializing = true;
      try {
        const initial = z
          .strictObject({ options: validationTasksOptionsSchema })
          .parse(message);
        store = await openTaskStore(initial.options);
        if (closing) {
          store.close();
          return;
        }
        options = initial.options;
        reply(0, null);
      } catch {
        error(0, "unavailable");
        disconnect();
      }
      return;
    }
    const request = validationTaskRequestSchema.safeParse(message);
    if (!request.success) return;
    const { id, method } = request.data;
    if (closing) {
      error(id, "closed");
      return;
    }
    if (method === "close") {
      try {
        await shutdown();
        reply(id, null);
      } finally {
        if (process.connected) process.disconnect();
      }
      return;
    }
    if (method === "start") {
      if (!options.allowExecution) {
        error(id, "denied");
        return;
      }
      if (starting || active) {
        error(id, "busy");
        return;
      }
      starting = start();
      try {
        reply(id, await starting);
      } catch {
        error(id, "invalid");
      } finally {
        starting = undefined;
      }
      return;
    }
    try {
      reply(
        id,
        method === "get"
          ? store!.get(request.data.taskId)
          : await cancel(request.data.taskId),
      );
    } catch {
      error(id, "invalid");
    }
  })().catch(disconnect);
});
