import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

const directory = "docs/measurements/artifact-identities-2026-10-21";
const indexName = "artifact-evidence-index.v1.json";
const records = {
  "scala2.json": "scala2",
  "fantomas.json": "fantomas",
  "random-provider.json": "random-provider",
  "wasm-toolchain.json": "wasm-toolchain",
};
const referenceKeys = new Set([
  "retainedDistributionNotices",
  "retainedSignatureAndNoticeInputs",
  "retainedNoticeInputs",
  "retainedNotices",
  "retainedInputs",
  "retainedInput",
  "publicKey",
  "signature",
]);
const maximumFile = 2 * 1024 * 1024;
const maximumTotal = 8 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function relative(value) {
  assert.ok(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 512 &&
      !/[\\\0:]/u.test(value) &&
      !path.posix.isAbsolute(value) &&
      !path.win32.isAbsolute(value) &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
    "Noncanonical relative evidence path",
  );
  return value;
}
function entries(values, label) {
  assert.ok(Array.isArray(values) && values.length > 0 && values.length <= 256);
  const result = new Map();
  for (const entry of values) {
    const name = relative(entry.file);
    assert.ok(!result.has(name), label + " contains a duplicate path: " + name);
    assert.ok(
      Number.isSafeInteger(entry.bytes) &&
        entry.bytes > 0 &&
        entry.bytes <= maximumFile,
      "Invalid declared byte count: " + name,
    );
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u, "Invalid SHA-256: " + name);
    result.set(name, entry);
  }
  return result;
}
try {
  assert.equal(
    process.argv.length,
    3,
    "Usage: audit-selected-artifact-evidence.mjs ROOT",
  );
  const root = realpathSync(process.argv[2]);
  const evidence = path.join(root, directory);
  let totalBytes = 0;
  function read(base, name, expected) {
    relative(name);
    const file = path.join(base, ...name.split("/"));
    assert.equal(
      realpathSync(file),
      file,
      "Evidence crosses a symlink: " + name,
    );
    const fd = openSync(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = fstatSync(fd);
      assert.ok(
        stat.isFile() && stat.size > 0 && stat.size <= maximumFile,
        "File bound or type violated: " + name,
      );
      assert.ok(
        totalBytes + stat.size <= maximumTotal,
        "Total evidence byte bound exceeded",
      );
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(
          fd,
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (count === 0) break;
        length += count;
      }
      assert.equal(
        length,
        stat.size,
        "Evidence changed during reading: " + name,
      );
      totalBytes += length;
      const bytes = buffer.subarray(0, length);
      if (expected) {
        assert.equal(
          length,
          expected.bytes,
          "Evidence byte count mismatch: " + name,
        );
        assert.equal(
          digest(bytes),
          expected.sha256,
          "Evidence digest mismatch: " + name,
        );
      }
      return bytes;
    } finally {
      closeSync(fd);
    }
  }
  const parse = (bytes) =>
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assert.equal(
    realpathSync(evidence),
    evidence,
    "Evidence directory crosses a symlink",
  );
  const index = parse(read(evidence, indexName));
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.observationsOnly, true);
  assert.ok(
    Number.isSafeInteger(index.retainedReferences) &&
      index.retainedReferences > 0 &&
      index.retainedReferences <= 4096,
    "Invalid retained-reference count",
  );
  const files = entries(index.files, "Artifact index");
  assert.ok(!files.has(indexName), "The index cannot hash itself");
  const sources = entries(index.repositoryInputs, "Repository input index");
  for (const name of sources.keys()) {
    assert.ok(
      name.startsWith("src/") ||
        name.startsWith("scripts/") ||
        name === "assets/context-grammars/manifest.json" ||
        name === "docs/measurements/context-grammar-build-2026-10-08.json",
      "Unsupported source input path",
    );
  }
  const actual = [];
  let directoryEntries = 0;
  function inventory(folder, prefix = "", depth = 0) {
    assert.ok(depth <= 8, "Evidence directory depth exceeded");
    for (const name of readdirSync(folder)) {
      assert.ok(
        ++directoryEntries <= 512,
        "Evidence directory entry bound exceeded",
      );
      const local = prefix + name;
      relative(local);
      const file = path.join(folder, name);
      const stat = lstatSync(file);
      assert.ok(!stat.isSymbolicLink(), "Evidence crosses a symlink: " + local);
      if (stat.isDirectory()) inventory(file, local + "/", depth + 1);
      else {
        assert.ok(stat.isFile(), "Evidence must be regular files: " + local);
        actual.push(local);
      }
    }
  }
  inventory(evidence);
  assert.deepEqual(
    actual.sort(),
    [...files.keys(), indexName].sort(),
    "Unindexed or missing evidence files",
  );
  const documents = new Map();
  for (const [name, entry] of files) {
    const bytes = read(evidence, name, entry);
    if (name.endsWith(".json")) documents.set(name, parse(bytes));
  }
  const sourceNames = new Set();
  for (const [name, scope] of Object.entries(records)) {
    const record = documents.get(name);
    assert.ok(record, "Missing required artifact record: " + name);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.scope, scope);
    for (const flag of [
      "gateAComplete",
      "completeArtifactAndNoticeClosureVerified",
      "preparationAndReceiptIntegrationVerified",
    ]) {
      assert.equal(
        record[flag],
        false,
        "Static artifact observations cannot promote " + flag,
      );
    }
    assert.ok(
      Array.isArray(record.repositoryInputs) &&
        record.repositoryInputs.length > 0,
      "Missing record source bindings",
    );
    for (const input of record.repositoryInputs) {
      const declared = sources.get(relative(input.file));
      assert.ok(declared, "Unindexed repository input: " + input.file);
      assert.equal(
        input.sha256,
        declared.sha256,
        "Stale record source binding: " + input.file,
      );
      sourceNames.add(input.file);
    }
  }
  assert.deepEqual(
    [...sourceNames].sort(),
    [...sources.keys()].sort(),
    "Unreferenced repository inputs",
  );
  for (const [name, entry] of sources) read(root, name, entry);
  let references = 0;
  let nodes = 0;
  function walk(value, label, retained = false, depth = 0) {
    assert.ok(
      ++nodes <= 100000 && depth <= 64,
      "Evidence JSON structural bound exceeded",
    );
    if (!value || typeof value !== "object") return;
    for (const flag of [
      "gateAComplete",
      "qualityAssessed",
      "inferenceInvoked",
      "fieldEvaluationExecuted",
    ]) {
      if (Object.hasOwn(value, flag))
        assert.equal(
          value[flag],
          false,
          "Static evidence cannot promote " + flag + " at " + label,
        );
    }
    if (retained && !Array.isArray(value) && Object.hasOwn(value, "file")) {
      const name = relative(value.file);
      const entry = files.get(name);
      assert.ok(entry, "Missing retained input: " + name);
      assert.equal(
        value.bytes,
        entry.bytes,
        "Retained input byte count mismatch: " + label,
      );
      assert.equal(
        value.sha256,
        entry.sha256,
        "Retained input digest mismatch: " + label,
      );
      references += 1;
    }
    for (const [key, child] of Object.entries(value)) {
      walk(
        child,
        label + "/" + key,
        retained || referenceKeys.has(key),
        depth + 1,
      );
    }
  }
  for (const [name, document] of documents) walk(document, name);
  assert.equal(
    references,
    index.retainedReferences,
    "Retained-reference graph changed",
  );
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      evidenceConsistent: true,
      files: files.size,
      retainedReferences: references,
      repositoryInputs: sources.size,
      observedBytes: totalBytes,
      cryptographicVerificationPerformedByAudit: false,
      nativeAcceptanceAssessed: false,
      gateAComplete: false,
      qualityAssessed: false,
    }) + "\n",
  );
} catch (error) {
  const message =
    error.code && error.code !== "ERR_ASSERTION"
      ? error.code + " while reading declared evidence"
      : error.message;
  process.stderr.write("Artifact evidence audit failed: " + message + "\n");
  process.exitCode = 2;
}
