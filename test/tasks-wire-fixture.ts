import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fixture, nodeManifest, passingTest } from "./helpers.js";
import { VERSION } from "../src/types.js";

export const extension = "io.modelcontextprotocol/tasks";
export const taskExecutionTimeoutMs =
  process.platform === "win32" ? 20000 : 5000;
export const taskObservationTimeoutMs =
  process.platform === "win32" ? 35000 : 15000;
type Response = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};
const taskCleanups = new WeakMap<
  TestContext,
  Array<() => void | Promise<void>>
>();
function taskResources(t: TestContext) {
  let cleanups = taskCleanups.get(t);
  if (!cleanups) {
    cleanups = [];
    taskCleanups.set(t, cleanups);
    const owned = cleanups;
    // Node runs after hooks in registration order. Close all resources before
    // fixture() can try to unlink their SQLite databases, including on Windows.
    t.after(async () => {
      const failures: unknown[] = [];
      for (const close of owned.splice(0).reverse()) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "Tasks fixture resource cleanup failed",
        );
    });
  }
  return cleanups;
}
export function registerTaskCleanup(
  t: TestContext,
  close: () => void | Promise<void>,
) {
  taskResources(t).push(close);
}
export async function setup(t: TestContext, source = passingTest) {
  taskResources(t);
  const root = await realpath(
    await fixture(t, {
      "package.json": nodeManifest,
      "check.test.js": source,
      ".checktrail/keep": "",
    }),
  );
  const directory = path.join(await realpath(await fixture(t, {})), "tasks");
  return { root, directory };
}
export async function wire(
  t: TestContext,
  opt: { root: string; directory: string },
  args: string[] = ["--allow-execution"],
  configured = true,
) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../src/cli.js", import.meta.url)),
      "serve",
      "--root",
      opt.root,
      ...(configured
        ? [
            "--task-store",
            opt.directory,
            "--timeout-ms",
            String(taskExecutionTimeoutMs),
          ]
        : []),
      ...args,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<
    number,
    { resolve: (value: Response) => void; reject: (error: Error) => void }
  >();
  let sequence = 0,
    exited = false,
    stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + String(bytes)).slice(-4096);
  });
  const exit = once(child, "exit");
  child.on("exit", () => {
    exited = true;
    for (const item of pending.values())
      item.reject(new Error(`Server exited: ${stderr}`));
    pending.clear();
  });
  lines.on("line", (line) => {
    const response = JSON.parse(line) as Response & { id?: number };
    if (response.id !== undefined) {
      pending.get(response.id)?.resolve(response);
      pending.delete(response.id);
    }
  });
  async function close() {
    if (!exited) child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      await exit;
    } finally {
      clearTimeout(timer);
      lines.close();
    }
  }
  registerTaskCleanup(t, close);
  function send(
    method: string,
    params: Record<string, unknown>,
    caps = true,
    id?: number,
  ) {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        ...(id !== undefined ? { id } : {}),
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: caps ? { [extension]: {} } : {},
            },
          },
        },
      }) + "\n",
    );
  }
  async function request(
    method: string,
    params: Record<string, unknown> = {},
    caps = true,
  ): Promise<Response> {
    const id = sequence++;
    const timer = setTimeout(() => {
      pending
        .get(id)
        ?.reject(new Error(`Request timed out: ${method}: ${stderr}`));
      pending.delete(id);
    }, 10000);
    try {
      return await new Promise<Response>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send(method, params, caps, id);
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    pid: child.pid!,
    request,
    close,
    notify: (method: string, params: Record<string, unknown>) =>
      send(method, params),
  };
}
export function acknowledge(response: Response) {
  assert.equal(response.error, undefined);
  assert.deepEqual(response.result, {
    resultType: "complete",
    _meta: {
      "io.modelcontextprotocol/serverInfo": {
        name: "checktrail",
        version: VERSION,
      },
    },
  });
}
export function taskId(response: Response): string {
  assert.equal(response.error, undefined);
  assert.equal(response.result?.resultType, "task", JSON.stringify(response));
  assert.match(String(response.result.taskId), /^[a-f0-9-]{36}$/);
  return String(response.result.taskId);
}
export async function terminal(
  connection: Pick<Awaited<ReturnType<typeof wire>>, "request">,
  id: string,
  timeoutMs = taskObservationTimeoutMs,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("Invalid task observation deadline");
  // Observe the selected fixture execution budget plus persistence/cleanup.
  // This observes completion; it never extends the server's execution deadline.
  const started = performance.now(),
    deadline = started + timeoutMs;
  let polls = 0,
    lastStatus: unknown;
  const expired = () =>
    new Error(
      `Task did not finish within ${timeoutMs}ms (${polls} polls, last status: ${String(lastStatus)})`,
    );
  while (performance.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Response;
    try {
      response = await Promise.race([
        connection.request("tasks/get", { taskId: id }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(expired()),
            Math.max(1, Math.ceil(deadline - performance.now())),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    polls++;
    if (performance.now() >= deadline) throw expired();
    assert.equal(response.error, undefined);
    assert.equal(response.result?.resultType, "complete");
    lastStatus = response.result.status;
    if (lastStatus !== "working") return response.result;
    await delay(Math.min(25, Math.max(0, deadline - performance.now())));
  }
  throw expired();
}
export function report(task: Record<string, unknown>) {
  return (task.result as { structuredContent?: Record<string, unknown> })
    .structuredContent!;
}
export const slow = `import {test} from 'node:test'; import fs from 'node:fs'; import {spawn} from 'node:child_process';
test('waits', async()=> {const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
fs.writeFileSync('.checktrail/started.json',JSON.stringify({pid:process.pid,group:process.ppid,child:child.pid}));
await new Promise(resolve=>setTimeout(resolve,60000));});`;
type Pids = { pid: number; group: number; child: number };
export async function alive(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      return !/\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return false;
    }
  }
  return true;
}
export async function started(t: TestContext, root: string): Promise<Pids> {
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      const value = JSON.parse(
        await readFile(path.join(root, ".checktrail/started.json"), "utf8"),
      ) as Pids;
      t.after(() => {
        try {
          process.kill(-value.group, "SIGKILL");
        } catch {
          /* Cleaned up. */
        }
      });
      assert.equal(await alive(value.pid), true);
      assert.equal(await alive(value.child), true);
      return value;
    } catch {
      await delay(25);
    }
  }
  throw new Error("Native descendants did not start");
}
export async function stopped(pids: Pids) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await alive(pids.pid)) && !(await alive(pids.child))) return;
    await delay(25);
  }
  assert.fail("Native descendants survived terminal cancellation");
}
