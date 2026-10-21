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
import { loadNativeChildResource } from "./native-child-resource.mjs";
import {
  resourceCounterDelta,
  resourceHash,
  summarizeResourceReport,
} from "./native-resource-workloads.mjs";
const [root, bundle, archiveParent, specificationFile] = process.argv.slice(2);
assert.equal(
  process.argv.length,
  6,
  "Expected own fixture, prepared counter bundle, private archive parent and fixture specification",
);
const expected = JSON.parse(await readFile(specificationFile, "utf8"));
const binding = await loadNativeChildResource(bundle);
const environment = {};
if (expected.go) {
  const cache = path.join(path.dirname(archiveParent), "resource-go-cache");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const information = await lstat(cache);
  assert.equal(
    await realpath(cache),
    cache,
    "Resource Go cache must be canonical",
  );
  assert.ok(
    information.isDirectory() &&
      information.uid === process.getuid() &&
      (information.mode & 0o077) === 0,
    "Resource Go cache must be private and caller owned",
  );
  environment.GOCACHE = cache;
}
const source = await inventory(root);
assert.equal(source.files.length, expected.files);
const before = binding.snapshot(),
  start = performance.now();
const report = await validate(root, {
  trusted: true,
  environment,
  timeoutMs: 120000,
});
const validationWallMs = performance.now() - start,
  afterValidation = binding.snapshot();
assert.equal(report.sourceFingerprint, source.fingerprint);
const accounting = summarizeResourceReport(report, expected);
const counters = resourceCounterDelta(before, afterValidation);
assert.ok(
  counters.children.userCpuMicroseconds +
    counters.children.systemCpuMicroseconds >
    0,
  "Executed resource workload lacks child CPU",
);
assert.ok(
  counters.children.peakRssKiB > 0,
  "Executed resource workload lacks child RSS",
);
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
  } else {
    assert.deepEqual(terminal.result.structuredContent, report);
  }
  if (expected.outputRepeats > 0)
    assert.ok(
      archiveChunks > 1 && archiveBytes > 256 * 1024,
      "Large resource workload must reach multi-chunk report storage",
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
  const information = await stat(path.join(directory, file));
  assert.ok(information.isFile());
  physicalStoreFiles.push({ file, bytes: information.size });
}
const afterStorage = binding.snapshot();
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    sourceFingerprint: source.fingerprint,
    validationWallMs,
    ...accounting,
    counters,
    storage: {
      ...storage,
      physicalStoreFiles,
      physicalStoreBytes: physicalStoreFiles.reduce(
        (n, value) => n + value.bytes,
        0,
      ),
    },
    snapshots: { before, afterValidation, afterStorage },
    validationCpuExcludesArchiveWrites: true,
    wholeWorkerCountersIncludeArchiveWrites: true,
  }) + "\n",
);
