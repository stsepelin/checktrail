import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { inventory } from "../dist/src/inventory.js";
import { runProcess } from "../dist/src/runner.js";
import { windowsExecutionSchema } from "../dist/src/windows-execution.js";
import { ensureWindowsTaskAccess } from "../dist/src/windows-task-access.js";
import {
  resourceHash,
  nativeResourceCases,
} from "./native-resource-workloads.mjs";
const worker = fileURLToPath(
  new URL("./windows-resource-workload-worker.mjs", import.meta.url),
);
const code = (value) =>
  typeof value === "string" && /^[A-Z0-9_-]{1,64}$/.test(value) ? value : null;
const integer = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const flag = (value) => (typeof value === "boolean" ? value : null);
export function windowsResourceFailureContext(
  stage,
  workload,
  value,
  elapsedMs,
) {
  assert.ok(["go-before", "go-after", "worker"].includes(stage));
  assert.ok(nativeResourceCases.some((row) => row.id === workload));
  const stream = (value) => {
    if (!Buffer.isBuffer(value) && typeof value !== "string")
      return { available: false, bytes: null, sha256: null };
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return {
      available: true,
      bytes: bytes.length,
      sha256: resourceHash(bytes),
    };
  };
  const native = value.windowsExecution;
  const diagnostics = [];
  for (const line of (value.stderr ?? "").toString().split("\n").slice(0, 16)) {
    if (Buffer.byteLength(line) > 8192) continue;
    try {
      const row = JSON.parse(line);
      if (row.profile !== "windows-workload-incomplete-diagnostic") continue;
      diagnostics.push({
        workload: nativeResourceCases.some((item) => item.id === row.workload)
          ? row.workload
          : null,
        outcome: ["passed", "failed", "incomplete", "cancelled"].includes(
          row.outcome,
        )
          ? row.outcome
          : null,
        checks: Array.isArray(row.checks)
          ? row.checks.slice(0, 4).map((check) => ({
              processes: Array.isArray(check.processes)
                ? check.processes.slice(0, 4).map((result) => ({
                    exitCode: integer(result.exitCode),
                    signal: code(result.signal),
                    errorCode: code(result.errorCode),
                    timedOut: flag(result.timedOut),
                    cancelled: flag(result.cancelled),
                    truncated: flag(result.truncated),
                    nativeError: integer(result.windowsNativeError),
                  }))
                : [],
            }))
          : [],
      });
    } catch {
      // Raw stderr can contain paths; only the enumerated structured fields leave.
    }
  }
  return {
    profile: "windows-resource-command-failure-v1",
    stage,
    workload,
    timeoutMs: stage === "worker" ? 120000 : 10000,
    elapsedMs: integer(Math.round(elapsedMs)),
    exitCode: integer(stage === "worker" ? value.exitCode : value.status),
    signal: code(value.signal),
    errorCode: code(value.errorCode ?? value.error?.code),
    timedOut: flag(value.timedOut),
    cancelled: flag(value.cancelled),
    truncated: flag(value.truncated),
    stdout: stream(value.stdout),
    stderr: stream(value.stderr),
    native: native
      ? {
          phase: ["assigned", "running", "completed", "failed"].includes(
            native.phase,
          )
            ? native.phase
            : null,
          nativeError: integer(native.nativeError),
          cleanup: ["confirmed", "unavailable", "not-started"].includes(
            native.cleanup,
          )
            ? native.cleanup
            : null,
          activeAfterCleanup: integer(native.activeAfterCleanup),
        }
      : null,
    diagnostics: diagnostics.slice(0, 2),
  };
}
export function windowsResourceWorkerFailureMessage(stderr, context) {
  return context ? stderr + "\n" + JSON.stringify(context) : stderr;
}
async function retainFailure(context) {
  const raw = JSON.stringify(context) + "\n";
  assert.ok(Buffer.byteLength(raw) <= 8192);
  process.stderr.write(raw);
  const directory =
    process.env.CHECKTRAIL_WINDOWS_RESOURCE_DIAGNOSTIC_DIRECTORY;
  if (!directory) return;
  try {
    await mkdir(directory, { recursive: true });
    assert.equal(await realpath(directory), path.resolve(directory));
    await writeFile(
      path.join(directory, context.workload + "-" + context.stage + ".json"),
      raw,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        profile: "windows-resource-diagnostic-retention-failure-v1",
        stage: context.stage,
        workload: context.workload,
        errorCode: code(error.code),
      }) + "\n",
    );
  }
}
async function observeWindowsGo(workload, stage) {
  let executable;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    try {
      executable = await realpath(path.join(directory, "go.exe"));
      break;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  assert.ok(executable, "Pinned Windows Go prerequisite unavailable");
  const started = performance.now();
  const value = spawnSync(executable, ["version"], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 4096,
    windowsHide: true,
    env: { ...process.env, GOTOOLCHAIN: "local" },
  });
  const context =
    value.status !== 0 || value.error || value.signal
      ? windowsResourceFailureContext(
          stage,
          workload,
          value,
          performance.now() - started,
        )
      : null;
  if (context) await retainFailure(context);
  assert.equal(value.status, 0, context ? JSON.stringify(context) : undefined);
  assert.ok(
    !value.error && !value.signal,
    context ? JSON.stringify(context) : undefined,
  );
  assert.equal(
    value.stdout.trim(),
    "go version go1.27.1 windows/" +
      (process.arch === "x64" ? "amd64" : process.arch),
  );
  return {
    executable,
    identity: {
      version: value.stdout.trim(),
      executableSha256: resourceHash(await readFile(executable)),
    },
  };
}
/** Operator-only measurement of an original fixture. No execution grant, model
 * invocation or inference follows from this helper or its returned counters. */
export async function measureWindowsResourceSample({
  root,
  expected,
  directory,
}) {
  assert.equal(
    process.platform,
    "win32",
    "Native Windows resource sample unavailable",
  );
  const selected = nativeResourceCases.find((c) => c.id === expected.id);
  assert.ok(selected, "Unknown Windows resource workload");
  for (const key of ["id", "modules", "go", "outputRepeats"])
    assert.equal(expected[key], selected[key]);
  assert.equal(expected.checks, selected.go ? 2 : 1);
  assert.equal(expected.executedTests, expected.checks);
  const go = selected.go
      ? await observeWindowsGo(expected.id, "go-before")
      : null,
    workerBefore = await readFile(worker);
  assert.equal(await realpath(root), root);
  assert.equal(await realpath(directory), directory);
  ensureWindowsTaskAccess(directory, "directory", true);
  const specificationFile = path.join(directory, "fixture.json");
  await writeFile(specificationFile, JSON.stringify(expected) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  const source = await inventory(root);
  assert.equal(source.files.length, expected.files);
  const started = performance.now();
  const execution = await runProcess(
    root,
    {
      executable: await realpath(process.execPath),
      args: [worker, root, directory, specificationFile],
      cwd: ".",
    },
    {
      timeoutMs: 120000,
      maxOutputBytes: 64 * 1024,
      captureRawOutput: true,
      ...(go
        ? {
            environment: {
              PATH: [
                ...new Set([
                  path.dirname(await realpath(process.execPath)),
                  path.dirname(go.executable),
                ]),
              ].join(path.delimiter),
            },
          }
        : {}),
    },
  );
  const context =
    execution.exitCode !== 0 ||
    execution.errorCode ||
    execution.signal ||
    execution.timedOut ||
    execution.cancelled ||
    execution.truncated
      ? windowsResourceFailureContext(
          "worker",
          expected.id,
          execution,
          performance.now() - started,
        )
      : null;
  if (context) await retainFailure(context);
  assert.equal(
    execution.exitCode,
    0,
    windowsResourceWorkerFailureMessage(execution.stderr, context),
  );
  assert.ok(
    !execution.errorCode &&
      !execution.signal &&
      !execution.timedOut &&
      !execution.cancelled &&
      !execution.truncated,
    context ? JSON.stringify(context) : "Windows resource worker is incomplete",
  );
  const receipt = windowsExecutionSchema.parse(execution.windowsExecution);
  assert.equal(receipt.phase, "completed");
  assert.equal(receipt.cleanup, "confirmed");
  assert.equal(receipt.activeAfterCleanup, 0);
  assert.equal(
    receipt.resources?.state,
    "collected",
    "Windows whole-worker resources are unavailable",
  );
  const measurement = JSON.parse(execution.stdout);
  assert.equal(measurement.profile, "windows-native-resource-sample-v1");
  assert.equal(
    receipt.childPid,
    measurement.pid,
    "Windows resource job measured another worker",
  );
  assert.equal(measurement.sourceFingerprint, source.fingerprint);
  assert.equal(
    (await inventory(root)).fingerprint,
    source.fingerprint,
    "Windows resource fixture changed during sampling",
  );
  assert.equal(measurement.checks, expected.checks);
  assert.equal(measurement.executedTests, expected.executedTests);
  const packet = execution.capturedOutput;
  assert.equal(packet.completeForObservedStreams, true);
  assert.equal(packet.observedBytes, execution.outputBytes);
  for (const stream of ["stdout", "stderr"]) {
    const bytes = Buffer.from(packet[stream].base64, "base64");
    assert.equal(bytes.length, packet[stream].bytes);
    assert.equal(resourceHash(bytes), packet[stream].sha256);
  }
  assert.deepEqual(
    await readFile(worker),
    workerBefore,
    "Windows resource worker changed during sampling",
  );
  if (go) assert.deepEqual(await observeWindowsGo(expected.id, "go-after"), go);
  return {
    ...measurement,
    go: go?.identity ?? null,
    observer: receipt,
    workerTransport: {
      observedBytes: execution.outputBytes,
      stdoutBytes: packet.stdout.bytes,
      stderrBytes: packet.stderr.bytes,
      completeForObservedStreams: true,
    },
    fixturesCreatedOutsideMeasurement: true,
    preparationExcludedFromMeasurement: true,
    workerSha256: resourceHash(workerBefore),
  };
}
