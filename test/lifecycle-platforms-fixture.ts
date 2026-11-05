import assert from "node:assert/strict";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { validate } from "../src/engine.js";
import { processSnapshot, type ProcessIdentity } from "../src/process-tree.js";
import { fixture, nodeManifest } from "./helpers.js";

export const lifecycleCanary = "Original lifecycle diagnostic 8e71.";
export type LifecycleReached = {
  body: number;
  driver: number;
  children: [number, number];
};
export async function lifecycleWait<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 10000,
  reason = "Original lifecycle body readiness was not observed",
): Promise<T> {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(15);
  }
  throw Error(reason);
}
export function lifecycleAlive(pid: number) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
export async function cleanupLifecycleIdentities(rows: ProcessIdentity[]) {
  for (const row of rows) {
    const current = (await processSnapshot(row.pid)).find(
      (p) => p.pid === row.pid,
    );
    if (current?.identity !== row.identity || current.group !== row.group)
      continue;
    try {
      process.kill(row.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await delay(25);
  }
}
export async function lifecycleProject(
  t: TestContext,
  options: { broken?: boolean; stale?: boolean; file?: string } = {},
) {
  const control = await realpath(await fixture(t, {})),
    marker = path.join(control, "reached.json"),
    release = path.join(control, "release"),
    file = options.file ?? "quota.test.js";
  const implementation = options.broken
    ? "export const visible = rows => rows.length;\n"
    : "export const visible = rows => rows.filter(row => row.enabled).length;\n";
  const childBody =
    "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),60000);";
  const root = await realpath(
    await fixture(t, {
      "package.json": nodeManifest,
      "quota.js": implementation,
      [file]: `import{test}from'node:test';import assert from'node:assert/strict';import{spawn}from'node:child_process';import{readFile,writeFile,rename,appendFile}from'node:fs/promises';import{setTimeout as delay}from'node:timers/promises';import{visible}from'./quota.js';
test('original two enabled and one disabled quota',async()=>{
const control=${JSON.stringify(control)},marker=${JSON.stringify(marker)},release=${JSON.stringify(release)};
const children=[0,1].map(i=>spawn(process.execPath,['-e',${JSON.stringify(childBody)},control+'/child-'+i],{stdio:'ignore'}));
for(let i=0;i<children.length;i++){for(;;){try{assert.equal(Number(await readFile(control+'/child-'+i,'utf8')),children[i].pid);break;}catch(error){if(error.code!=='ENOENT')throw error;}await delay(10);}children[i].unref();}
await writeFile(marker+'.partial',JSON.stringify({body:process.pid,driver:process.ppid,children:children.map(child=>child.pid)}));await rename(marker+'.partial',marker);
for(;;){try{await readFile(release);break;}catch(error){if(error.code!=='ENOENT')throw error;}await delay(10);}
${options.stale ? "await appendFile(new URL('./quota.js',import.meta.url),'// Original source changed during execution.\\n');" : ""}
assert.equal(process.env.CHECKTRAIL_LIFECYCLE_SYNTHETIC_SECRET,undefined,'Unlisted operator environment reached the original project');
assert.equal(visible([{enabled:true},{enabled:true},{enabled:false}]),2,${JSON.stringify(lifecycleCanary)});
});\n`,
    }),
  );
  const observe = async () =>
    await lifecycleWait(async () => {
      try {
        return JSON.parse(await readFile(marker, "utf8")) as LifecycleReached;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    });
  const identities = async (reached: LifecycleReached) => {
    const ids = [...reached.children, reached.body, reached.driver];
    assert.equal(new Set(ids).size, 4);
    assert.ok(ids.every((pid) => pid !== process.pid && lifecycleAlive(pid)));
    if (process.platform === "win32") return [];
    const rows = await processSnapshot(ids);
    return ids.map((pid) => {
      const found = rows.find((row) => row.pid === pid);
      assert.ok(found, "Every reached native process must be observable");
      return found;
    });
  };

  return {
    root,
    control,
    marker,
    release,
    file,
    observe,
    identities,
    cleanup: cleanupLifecycleIdentities,
    continue: () => writeFile(release, "Original operator release."),
  };
}
export type LifecycleDiagnostic = {
  operation:
    | "engine"
    | "privacy-engine"
    | "privacy-cli-summary"
    | "privacy-cli-detailed"
    | "privacy-mcp-summary"
    | "privacy-mcp-detailed";
  enabled?: boolean;
};

// Failure presentation only. Never include a command, reason, stream or path.
function lifecycleTerminalMetadata(
  terminal: { value?: unknown; error?: string } | undefined,
  error: unknown,
) {
  const record = (candidate: unknown): Record<string, unknown> | undefined =>
    candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : undefined;
  const choice = (candidate: unknown, allowed: string[]) =>
    candidate === undefined || candidate === null
      ? null
      : typeof candidate === "string" && allowed.includes(candidate)
        ? candidate
        : "other";
  const number = (candidate: unknown, maximum: number) =>
    typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0 &&
    candidate <= maximum
      ? candidate
      : null;
  const boolean = (candidate: unknown) =>
    typeof candidate === "boolean" ? candidate : null;
  const streamBytes = (candidate: unknown) => {
    if (typeof candidate !== "string" || candidate.length > 4 * 1048576)
      return null;
    const bytes = Buffer.byteLength(candidate);
    return bytes <= 4 * 1048576 ? bytes : null;
  };
  const errorCodes = [
    "EACCES",
    "EAGAIN",
    "EINVAL",
    "EIO",
    "EMFILE",
    "ENFILE",
    "ENOENT",
    "ENOMEM",
    "ENOSPC",
    "EPERM",
    "ESRCH",
    "ETIMEDOUT",
    "ABORT_ERR",
    "POSIX_OWNER_UNAVAILABLE",
    "POSIX_OWNER_PLATFORM_UNAVAILABLE",
    "POSIX_OWNER_PROTOCOL_INVALID",
    "PROCESS_TREE_CLEANUP_UNAVAILABLE",
    "WINDOWS_SUPERVISOR_UNAVAILABLE",
    "WINDOWS_OUTPUT_INCOMPLETE",
    "WINDOWS_SOURCE_NOT_EXECUTED",
    "WINDOWS_EXECUTION_INCOMPLETE",
    "WINDOWS_PREPARATION_ERROR",
    "INVALID_WINDOWS_RECEIPT",
    "INVALID_WINDOWS_LAUNCHER",
  ];
  const rejected = terminal !== undefined && "error" in terminal;
  const object = record(terminal?.value);
  const checks = Array.isArray(object?.checks) ? object.checks : undefined;
  return {
    state: rejected
      ? "rejected"
      : terminal !== undefined
        ? "returned"
        : "pending",
    ...(rejected
      ? {
          error: {
            name: choice(record(error)?.name, [
              "Error",
              "TypeError",
              "RangeError",
              "AssertionError",
              "AbortError",
              "TimeoutError",
              "AggregateError",
            ]),
            code: choice(record(error)?.code, errorCodes),
          },
        }
      : {}),
    checkCount: checks ? number(checks.length, 10000) : null,
    checks:
      checks?.slice(0, 1).map((candidate) => {
        const check = record(candidate);
        const processes = Array.isArray(check?.processes)
          ? check.processes
          : undefined;
        return {
          // Omitted role means the exact known node-test fixture check, never unknown.
          ...(check?.id === "javascript.node-test" ? {} : { role: "other" }),
          status: choice(check?.status, [
            "passed",
            "failed",
            "unavailable",
            "skipped",
            "error",
            "inconclusive",
          ]),
          processCount: processes ? number(processes.length, 10000) : null,
          processes:
            processes?.slice(0, 1).map((candidate) => {
              const child = record(candidate);
              return {
                exitCode: number(child?.exitCode, 4294967295),
                signal: choice(child?.signal, [
                  "SIGTERM",
                  "SIGKILL",
                  "SIGABRT",
                  "SIGINT",
                  "SIGSEGV",
                  "SIGBUS",
                  "SIGHUP",
                  "SIGQUIT",
                  "SIGPIPE",
                  "SIGSTOP",
                ]),
                timedOut: boolean(child?.timedOut),
                cancelled: boolean(child?.cancelled),
                truncated: boolean(child?.truncated),
                errorCode: choice(child?.errorCode, errorCodes),
                durationMs: number(child?.durationMs, 600000),
                stdoutBytes: streamBytes(child?.stdout),
                stderrBytes: streamBytes(child?.stderr),
              };
            }) ?? [],
        };
      }) ?? [],
  };
}
export async function lifecycleExecute<T>(
  project: Awaited<ReturnType<typeof lifecycleProject>>,
  start: (signal: AbortSignal) => Promise<T>,
  diagnostic?: LifecycleDiagnostic,
) {
  const diagnose =
    diagnostic !== undefined &&
    (diagnostic.enabled ?? process.env.CHECKTRAIL_LIFECYCLE_DIAGNOSTIC === "1");
  const started = performance.now();
  let phase = "observe";
  let diagnosticError: AggregateError | undefined;
  const controller = new AbortController(),
    running = start(controller.signal);
  let settled = false;
  let terminal: { value?: T; error?: string } | undefined;
  let terminalError: unknown;
  void running.then(
    (value) => {
      settled = true;
      terminal = { value };
    },
    (error: unknown) => {
      settled = true;
      terminalError = error;
      terminal = { error: String(error) };
    },
  );
  let rows: ProcessIdentity[] = [];
  let bodyObserved = false;
  const finish = async () => {
    const settledBeforeAbort = settled;
    controller.abort();
    await Promise.allSettled([running]);
    let failureContext: unknown;
    if (diagnosticError) {
      try {
        const marker = async (file: string) => {
          try {
            await access(file);
            return "present";
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "absent"
              : "unavailable";
          }
        };
        failureContext = {
          observation: "post-abort/pre-cleanup",
          readiness: {
            bodyMarker: await marker(project.marker),
            childMarkers: await Promise.all(
              [0, 1].map((index) =>
                marker(path.join(project.control, "child-" + index)),
              ),
            ),
          },
          execution: lifecycleTerminalMetadata(terminal, terminalError),
        };
      } catch {
        // Presentation must not replace the original failure or its cleanup.
        failureContext = { observation: "unavailable" };
      }
    }
    let cleanup = "confirmed";
    try {
      await project.cleanup(rows);
    } catch (error) {
      if (!diagnosticError) throw error;
      cleanup = "failed";
      diagnosticError.errors.push(error);
    }
    if (diagnosticError) {
      const value = terminal?.value;
      const object =
        value !== null && typeof value === "object"
          ? (value as Record<string, unknown>)
          : undefined;
      const candidate = object?.outcome;
      const outcome =
        typeof candidate === "string" &&
        ["passed", "failed", "incomplete"].includes(candidate)
          ? candidate
          : null;
      diagnosticError.message =
        "Lifecycle operation failed; bounded diagnostic " +
        JSON.stringify({
          schemaVersion: 1,
          operation: diagnostic!.operation,
          phase,
          failureContext,
          elapsedMs: Math.round(performance.now() - started),
          bodyObserved,
          settledBeforeAbort,
          settledAfterAbort: settled,
          outcome,
          cleanup,
          reachedIdentities: rows.length,
          failureCount: diagnosticError.errors.length,
        });
    }
  };
  try {
    const reached = await project.observe();
    bodyObserved = true;
    phase = "identities";
    rows = await project.identities(reached);
    phase = "release";
    await project.continue();
    phase = "execution";
    const value = await running;
    phase = "completion-observation";
    await lifecycleWait(
      async () => {
        const ids = [...reached.children, reached.body, reached.driver];
        return ids.every((pid) => !lifecycleAlive(pid)) ? true : undefined;
      },
      2500,
      "Original reached lifecycle processes survived completion",
    );
    phase = "release-marker";
    await access(project.release);
    return { project, value, reached };
  } catch (error) {
    if (diagnose) {
      diagnosticError = new AggregateError(
        [error],
        "Lifecycle operation failed",
        {
          cause: error,
        },
      );
      throw diagnosticError;
    }
    if (!bodyObserved && settled) {
      const diagnostic = JSON.stringify(terminal, (_key, value: unknown) =>
        typeof value === "string" && value.length > 512
          ? value.slice(0, 512) + " [truncated]"
          : value,
      );
      throw new Error(
        "Lifecycle execution ended before body readiness: " +
          diagnostic.slice(0, 12000),
        { cause: error },
      );
    }
    throw error;
  } finally {
    await finish();
  }
}
export async function validateLifecycleProject(
  t: TestContext,
  options: Parameters<typeof lifecycleProject>[1] = {},
  diagnostic: LifecycleDiagnostic = { operation: "engine", enabled: true },
) {
  const project = await lifecycleProject(t, options);
  const observed = await lifecycleExecute(
    project,
    (signal) =>
      validate(project.root, {
        trusted: true,
        timeoutMs: process.platform === "win32" ? 30000 : 15000,
        signal,
      }),
    diagnostic,
  );
  return {
    project: observed.project,
    report: observed.value,
    reached: observed.reached,
  };
}
