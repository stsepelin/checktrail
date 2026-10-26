import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
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
async function observeWindowsGo() {
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
  const value = spawnSync(executable, ["version"], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 4096,
    windowsHide: true,
    env: { ...process.env, GOTOOLCHAIN: "local" },
  });
  assert.equal(value.status, 0);
  assert.ok(!value.error && !value.signal);
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
  const go = selected.go ? await observeWindowsGo() : null,
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
  assert.equal(execution.exitCode, 0, execution.stderr);
  assert.ok(
    !execution.errorCode &&
      !execution.signal &&
      !execution.timedOut &&
      !execution.cancelled &&
      !execution.truncated,
    "Windows resource worker is incomplete",
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
  if (go) assert.deepEqual(await observeWindowsGo(), go);
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
