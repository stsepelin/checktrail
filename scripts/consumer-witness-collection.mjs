import process from "node:process";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdtemp,
  readdir,
  lstat,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { consumerWitnessCaptureParent } from "../dist/test/consumer-witness-fixture.js";
import { ensureWindowsTaskAccess } from "../dist/src/windows-task-access.js";
import {
  registerConsumerCaptureNamespace,
  finishConsumerCaptureRegistration,
} from "./consumer-native-capture-registry.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function privateMode(stat, mode) {
  return (
    process.platform === "win32" ||
    (stat.uid === BigInt(process.getuid()) &&
      (stat.mode & 0o777n) === BigInt(mode))
  );
}
function collectionBounds(scope) {
  assert.ok(
    ["native-consumer", "selected-clang-producer-consumer"].includes(scope),
  );
  return scope === "selected-clang-producer-consumer"
    ? { fileBytes: 32 * 1048576, totalBytes: 256 * 1048576 }
    : { fileBytes: 2097152, totalBytes: 32 * 1048576 };
}
export async function readConsumerWitnessNamespace(
  namespace,
  scope = "native-consumer",
) {
  const bounds = collectionBounds(scope);
  assert.equal(await realpath(namespace), namespace);
  const identity = await lstat(namespace, { bigint: true });
  assert.ok(
    identity.isDirectory() &&
      !identity.isSymbolicLink() &&
      privateMode(identity, 0o700),
  );
  if (process.platform === "win32")
    ensureWindowsTaskAccess(namespace, "directory", false);
  const names = (await readdir(namespace))
    .filter((name) => name !== "controller.json")
    .sort();
  assert.ok(names.length <= 512);
  const observations = [],
    attemptRecords = [];
  let retainedBytes = 0;
  for (const name of names) {
    assert.match(
      name,
      /^(?:(?:go|python|php|rust|ruby|c|cpp|java|kotlin|scala|csharp|fsharp|vb|hcl|yaml|swift|javascript|typescript|shared-json)-(?:broken|fixed|near-miss)-(?:canonical|caller-change|restored|repeat)|attempt)-[a-f0-9-]{36}\.json$/,
    );
    const filename = path.join(namespace, name),
      before = await lstat(filename, { bigint: true });
    assert.ok(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.nlink === 1n &&
        before.size <= BigInt(bounds.fileBytes) &&
        privateMode(before, 0o600),
    );
    if (process.platform === "win32")
      ensureWindowsTaskAccess(filename, "file", false);
    const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const current = await fd.stat({ bigint: true });
      for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
        assert.equal(current[key], before[key]);
      const parts = [];
      let count = 0;
      for (;;) {
        const chunk = Buffer.alloc(
            Math.min(65536, bounds.fileBytes + 1 - count),
          ),
          { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        count += bytesRead;
        assert.ok(count <= bounds.fileBytes);
        parts.push(chunk.subarray(0, bytesRead));
      }
      bytes = Buffer.concat(parts, count);
      assert.equal(BigInt(bytes.length), before.size);
      const after = await fd.stat({ bigint: true }),
        linked = await lstat(filename, { bigint: true });
      for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
        assert.equal(before[key], after[key]);
        assert.equal(after[key], linked[key]);
      }
      assert.ok(
        linked.isFile() &&
          !linked.isSymbolicLink() &&
          linked.nlink === 1n &&
          privateMode(linked, 0o600),
      );
    } finally {
      await fd.close();
    }
    retainedBytes += bytes.length;
    assert.ok(retainedBytes <= bounds.totalBytes);
    const value = JSON.parse(bytes.toString("utf8"));
    if (scope === "selected-clang-producer-consumer") {
      assert.equal(value.family, "cpp");
      assert.ok(
        [
          "selected-clang-consumer-witness-observation-v1",
          "selected-clang-process-result-observation-v1",
        ].includes(value.profile),
      );
    } else
      assert.ok(
        bytes.length <=
          (["hcl", "javascript", "typescript", "shared-json"].includes(
            value.family,
          )
            ? 2097152
            : 262144),
      );
    if (name.startsWith("attempt-"))
      attemptRecords.push({
        file: name,
        bytes: bytes.length,
        sha256: hash(bytes),
        value,
      });
    else observations.push(value);
  }
  const after = await lstat(namespace, { bigint: true });
  assert.equal(after.dev, identity.dev);
  assert.equal(after.ino, identity.ino);
  assert.ok(
    after.isDirectory() && !after.isSymbolicLink() && privateMode(after, 0o700),
  );
  return { observations, attemptRecords, retainedBytes };
}
/** Internal operator/native-test collection; never a product tool or execution trust grant. */
export async function collectConsumerWitnesses(
  operation,
  qualify,
  { scope = "native-consumer" } = {},
) {
  collectionBounds(scope);
  assert.equal(
    typeof qualify,
    "function",
    "Consumer collection requires scoped reconciliation before cleanup",
  );
  assert.equal(typeof operation, "function");
  const previous = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR;
  assert.equal(
    previous,
    undefined,
    "Nested consumer collection would mix independent namespaces",
  );
  const parent = await consumerWitnessCaptureParent(
      process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT,
    ),
    namespace = await realpath(
      await mkdtemp(path.join(parent, "checktrail-consumer-witness-")),
    );
  if (process.platform === "win32")
    ensureWindowsTaskAccess(namespace, "directory", true);
  let completed = false,
    registration = null;
  async function checkpoint(state) {
    const pending = path.join(namespace, ".controller.pending"),
      fd = await open(pending, "wx", 0o600);
    try {
      if (process.platform === "win32")
        ensureWindowsTaskAccess(pending, "file", true);
      await fd.writeFile(
        JSON.stringify({
          schemaVersion: 1,
          state,
          gateAComplete: false,
          inferenceInvoked: false,
          fieldEvaluationExecuted: false,
        }) + "\n",
      );
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(pending, path.join(namespace, "controller.json"));
  }
  try {
    registration = await registerConsumerCaptureNamespace(namespace, scope);
    process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR = namespace;
    await checkpoint("running");
    const result = await operation(),
      capture = await readConsumerWitnessNamespace(namespace, scope),
      qualified = await qualify(result, capture);
    assert.ok(
      qualified && typeof qualified === "object",
      "Scoped consumer reconciliation returned no packet",
    );
    await checkpoint("collected-scoped");
    await finishConsumerCaptureRegistration(registration, "collected-retained");
    completed = true;
    return qualified;
  } catch (error) {
    try {
      await finishConsumerCaptureRegistration(registration, "failed-retained");
    } catch (storageError) {
      process.stderr.write(
        "Consumer registry failure retained: " +
          String(storageError).slice(0, 1024) +
          "\n",
      );
    }
    try {
      await checkpoint("failed-incomplete");
    } catch (storageError) {
      process.stderr.write(
        "Consumer failure checkpoint unavailable: " +
          String(storageError).slice(0, 1024) +
          "\n",
      );
    }
    process.stderr.write(
      "Incomplete consumer capture retained at " + namespace + "\n",
    );
    throw error;
  } finally {
    if (previous === undefined)
      delete process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR;
    else process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR = previous;
    if (completed && registration === null)
      await rm(namespace, { recursive: true, force: true });
  }
}
