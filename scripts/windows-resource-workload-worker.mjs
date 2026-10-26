import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { validate, openTaskStore } from "../dist/src/index.js";
import { inventory } from "../dist/src/inventory.js";
import { ensureWindowsTaskAccess } from "../dist/src/windows-task-access.js";
import { summarizeWindowsResources } from "./windows-resource-workloads.mjs";
import { resourceHash } from "./native-resource-workloads.mjs";
assert.equal(
  process.platform,
  "win32",
  "Native Windows resource worker unavailable",
);
assert.equal(process.argv.length, 5);
const [root, archiveParent, specificationFile] = process.argv.slice(2);
const expected = JSON.parse(await readFile(specificationFile, "utf8"));
const environment = {};
if (expected.go) {
  const cache = path.join(archiveParent, "resource-go-cache");
  await mkdir(cache, { recursive: true });
  assert.equal(await realpath(cache), cache);
  assert.ok((await lstat(cache)).isDirectory());
  ensureWindowsTaskAccess(cache, "directory", true);
  environment.GOCACHE = cache;
}
const source = await inventory(root);
assert.equal(source.files.length, expected.files);
const snapshot = () => {
  const values = process.resourceUsage();
  for (const field of ["userCPUTime", "systemCPUTime", "maxRSS"])
    assert.ok(Number.isSafeInteger(values[field]) && values[field] >= 0);
  return {
    pid: process.pid,
    userCpuMicroseconds: values.userCPUTime,
    systemCpuMicroseconds: values.systemCPUTime,
    peakRssKiB: values.maxRSS,
  };
};
const before = snapshot(),
  start = performance.now();
const report = await validate(root, {
  trusted: true,
  environment,
  timeoutMs: 120000,
});
const validationWallMs = performance.now() - start,
  afterValidation = snapshot();
assert.equal(report.sourceFingerprint, source.fingerprint);
if (report.outcome !== "passed") {
  process.stderr.write(
    JSON.stringify({
      profile: "windows-workload-incomplete-diagnostic",
      workload: expected.id,
      outcome: report.outcome,
      sourceChanged: report.sourceChanged,
      sourceError: report.sourceError,
      checks: report.checks.map((check) => ({
        checkId: check.checkId,
        status: check.status,
        reason: check.reason,
        processes: check.processes.map((p) => ({
          exitCode: p.exitCode,
          signal: p.signal,
          errorCode: p.errorCode ?? null,
          timedOut: p.timedOut,
          cancelled: p.cancelled,
          truncated: p.truncated,
          windowsPhase: p.windowsExecution?.phase ?? null,
          windowsNativeError: p.windowsExecution?.nativeError ?? null,
          windowsCleanup: p.windowsExecution?.cleanup ?? null,
        })),
      })),
    }) + "\n",
  );
}
const accounting = summarizeWindowsResources(report, expected);
assert.ok(
  accounting.jobCpu.user100ns + accounting.jobCpu.kernel100ns > 0,
  "Executed Windows workload lacks native job CPU",
);
assert.ok(
  accounting.directPeakWorkingSetBytes > 0,
  "Executed Windows workload lacks direct target memory",
);
assert.equal(before.pid, afterValidation.pid);
assert.ok(afterValidation.userCpuMicroseconds >= before.userCpuMicroseconds);
assert.ok(
  afterValidation.systemCpuMicroseconds >= before.systemCpuMicroseconds,
);
const self = {
  userCpuMicroseconds:
    afterValidation.userCpuMicroseconds - before.userCpuMicroseconds,
  systemCpuMicroseconds:
    afterValidation.systemCpuMicroseconds - before.systemCpuMicroseconds,
  peakRssKiB: afterValidation.peakRssKiB,
};
const directory = path.join(archiveParent, "tasks"),
  store = await openTaskStore({ root, directory, detailed: true });
let storage;
try {
  const task = store.create(report.sourceFingerprint);
  assert.equal(store.completeWithArchive(task.taskId, report), "updated");
  const terminal = store.get(task.taskId);
  assert.equal(terminal.status, "completed");
  const inlineEnvelopeBytes = Buffer.byteLength(
    JSON.stringify(terminal.result),
  );
  let archiveBytes = 0,
    archiveChunks = 0,
    reconstructedSha256 = null;
  if (terminal.result.isError === true) {
    const first = store.readArchive(task.taskId, 0),
      chunks = [];
    archiveChunks = first.archive.chunks;
    for (let index = 0; index < archiveChunks; index++) {
      const chunk = store.readArchive(task.taskId, index);
      assert.equal(chunk.index, index);
      assert.deepEqual(chunk.archive, first.archive);
      const bytes = Buffer.from(chunk.bodyBase64, "base64");
      assert.equal(bytes.length, chunk.bytes);
      assert.equal(resourceHash(bytes), chunk.sha256);
      chunks.push(bytes);
    }
    const reconstructed = Buffer.concat(chunks);
    archiveBytes = reconstructed.length;
    reconstructedSha256 = resourceHash(reconstructed);
    assert.equal(archiveBytes, accounting.reportBytes);
    assert.equal(reconstructedSha256, accounting.reportSha256);
  } else assert.deepEqual(terminal.result.structuredContent, report);
  if (expected.outputRepeats > 0)
    assert.ok(
      archiveChunks > 1 && archiveBytes > 256 * 1024,
      "Large Windows workload must reach multi-chunk storage",
    );
  storage = {
    inlineEnvelopeBytes,
    archiveBytes,
    archiveChunks,
    reconstructedSha256,
  };
} finally {
  store.close();
}
const physicalStoreFiles = [];
for (const file of (await readdir(directory)).sort()) {
  const info = await stat(path.join(directory, file));
  assert.ok(info.isFile());
  physicalStoreFiles.push({ file, bytes: info.size });
}
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    profile: "windows-native-resource-sample-v1",
    pid: process.pid,
    sourceFingerprint: source.fingerprint,
    validationWallMs,
    ...accounting,
    self,
    storage: {
      ...storage,
      physicalStoreFiles,
      physicalStoreBytes: physicalStoreFiles.reduce(
        (n, file) => n + file.bytes,
        0,
      ),
    },
    snapshots: { before, afterValidation, afterStorage: snapshot() },
    validationCpuExcludesArchiveWrites: true,
    wholeWorkerCountersIncludeArchiveWrites: true,
  }) + "\n",
);
