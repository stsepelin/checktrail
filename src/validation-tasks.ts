import { fork, type Serializable } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  validationTasksOptionsSchema,
  validationTaskRequestSchema,
  validationTaskResponseSchema,
  type ValidationTasksOptions,
} from "./validation-tasks-protocol.js";
import type { StoredValidationTask } from "./task-store.js";

export type { ValidationTasksOptions } from "./validation-tasks-protocol.js";
export interface ValidationTasks {
  start(): Promise<StoredValidationTask>;
  get(taskId: string): Promise<StoredValidationTask>;
  cancel(taskId: string): Promise<StoredValidationTask>;
  close(): Promise<void>;
}

/** Own a local validation worker and durable result store; no MCP transport is implied. */
export async function openValidationTasks(
  input: ValidationTasksOptions,
): Promise<ValidationTasks> {
  const options = validationTasksOptionsSchema.parse(input);
  options.root = await realpath(options.root);
  options.directory = path.resolve(options.directory);
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
  ])
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  const child = fork(
    new URL("./validation-task-worker.js", import.meta.url),
    [],
    {
      execArgv: [],
      env: environment,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  let sequence = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Map<
    number,
    {
      resolve: (value: StoredValidationTask | null) => void;
      reject: (error: Error) => void;
    }
  >();
  function fail(): void {
    closed = true;
    for (const entry of pending.values())
      entry.reject(new Error("Validation task worker unavailable"));
    pending.clear();
  }
  const exited = new Promise<void>((resolve) => {
    const finish = () => {
      fail();
      resolve();
    };
    // With ignored streams, exit is sufficient; concurrent IPC disconnects can omit close.
    child.once("exit", finish);
    child.once("close", finish);
    child.on("error", () => {
      fail();
      if (!child.pid) resolve();
    });
  });
  child.on("message", (message: unknown) => {
    const result = validationTaskResponseSchema.safeParse(message);
    if (!result.success) {
      fail();
      if (child.connected) child.disconnect();
      return;
    }
    const entry = pending.get(result.data.id);
    if (!entry) return;
    pending.delete(result.data.id);
    if (result.data.ok) {
      const value = result.data.value;
      if (value) {
        const { result: payload, ...metadata } = value;
        entry.resolve({
          ...metadata,
          ...(payload !== undefined ? { result: payload } : {}),
        });
      } else entry.resolve(null);
    } else
      entry.reject(new Error(`Validation task request ${result.data.error}`));
  });
  async function send(
    id: number,
    message: Serializable,
  ): Promise<StoredValidationTask | null> {
    if (closed || !child.connected)
      throw new Error("Validation task worker is closed");
    if (pending.size >= 32)
      throw new Error("Too many pending validation task requests");
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.send(message, (error) => {
        if (error) {
          pending.delete(id);
          reject(new Error("Validation task request could not be delivered"));
        }
      });
    });
  }
  const startupTimer = setTimeout(() => {
    fail();
    child.kill("SIGKILL");
  }, 10000);
  try {
    await send(0, { options });
  } catch (error) {
    if (child.connected) child.disconnect();
    await exited;
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
  async function request(
    method: "start" | "get" | "cancel",
    taskId?: string,
  ): Promise<StoredValidationTask> {
    if (closing) throw new Error("Validation task worker is closing");
    const id = ++sequence;
    const message = validationTaskRequestSchema.parse({
      id,
      method,
      ...(taskId !== undefined ? { taskId } : {}),
    });
    const result = await send(id, message);
    if (!result) throw new Error("Validation task response is missing");
    return result;
  }
  return {
    start: () => request("start"),
    get: (taskId) => request("get", taskId),
    cancel: (taskId) => request("cancel", taskId),
    close: () => {
      closing ??= (async () => {
        try {
          if (!closed && child.connected) {
            const id = ++sequence;
            await send(id, { id, method: "close" });
          }
        } finally {
          if (child.connected) child.disconnect();
          await exited;
        }
      })();
      return closing;
    },
  };
}
