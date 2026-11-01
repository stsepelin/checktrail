// Fixed operator-only original producer. Product discovery never imports Node source.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  lstatSync,
} from "node:fs";
import path from "node:path";
import { URL } from "node:url";
export const nodeOriginalCatalogSha256 =
  "7869b5297b9b4f3b319b6961e84827fcfae6e1830267f1a327ef137f008924c0";
function readClosedCatalog(file) {
  const before = lstatSync(file, { bigint: true });
  assert.ok(before.isFile() && before.size > 0n && before.size <= 131072n);
  const frame = (row) => [
    row.dev,
    row.ino,
    row.mode,
    row.uid,
    row.gid,
    row.nlink,
    row.size,
    row.mtimeNs,
    row.ctimeNs,
  ];
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let failure, raw;
  try {
    assert.deepEqual(frame(fstatSync(fd, { bigint: true })), frame(before));
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const size = readSync(fd, bytes, count, bytes.length - count, null);
      if (size === 0) break;
      count += size;
    }
    assert.equal(
      BigInt(count),
      before.size,
      "Closed Node catalog grew or was truncated",
    );
    assert.deepEqual(frame(fstatSync(fd, { bigint: true })), frame(before));
    assert.deepEqual(frame(lstatSync(file, { bigint: true })), frame(before));
    raw = bytes.subarray(0, count);
  } catch (error) {
    failure = error;
  } finally {
    try {
      closeSync(fd);
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            "Catalog read and close failed",
            { cause: failure },
          )
        : error;
    }
  }
  if (failure) throw failure;
  return raw;
}
const raw = readClosedCatalog(
  new URL("node-original.v1.json", import.meta.url),
);
assert.equal(
  createHash("sha256").update(raw).digest("hex"),
  nodeOriginalCatalogSha256,
);
const expected = JSON.parse(raw);
const { structuredClone } = globalThis;
const hex = (value, size) =>
  typeof value === "string" &&
  new RegExp("^[a-f0-9]{" + size + "}$", "u").test(value);
const safe = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 4096 &&
  !/[\\\0\r\n]/u.test(value) &&
  !path.posix.isAbsolute(value) &&
  value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
export function nodeOriginalCatalog() {
  return structuredClone(expected);
}
export function requireNodeOriginalCatalog(value) {
  assert.deepEqual(
    value,
    expected,
    "Original Node source, vectors, defaults or limits differ",
  );
  return value;
}
export function inspectNodeDocArchiveManifest(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [
    "artifacts",
    "lockGitBlob",
    "lockSha256",
    "packageJsonSha256",
    "schemaVersion",
  ]);
  assert.equal(value.schemaVersion, 1);
  for (const key of ["packageJsonSha256", "lockSha256", "lockGitBlob"])
    assert.equal(
      value[key],
      expected.docCache[key],
      "Original documentation source binding differs",
    );
  assert.ok(Array.isArray(value.artifacts));
  assert.equal(
    value.artifacts.length,
    expected.docCache.artifactCount,
    "All144 exact local archives are required before body",
  );
  const byId = new Map();
  for (const row of value.artifacts) {
    assert.ok(row && typeof row === "object" && !Array.isArray(row));
    assert.deepEqual(Object.keys(row).sort(), [
      "bytes",
      "file",
      "id",
      "integrity",
      "logicalOccurrences",
      "sha256",
      "sha512Hex",
      "url",
    ]);
    assert.ok(!byId.has(row.id), "Duplicate document artifact identity");
    byId.set(row.id, row);
  }
  for (const artifact of expected.docCache.artifacts) {
    const row = byId.get(artifact.id);
    assert.ok(row, "Missing exact document artifact");
    assert.equal(
      row.file,
      "docs/" + artifact.id + ".tgz",
      "Closed bundle archive path differs",
    );
    assert.ok(safe(row.file));
    assert.ok(
      Number.isSafeInteger(row.bytes) &&
        row.bytes > 0 &&
        row.bytes <= 32 * 1024 ** 2,
    );
    assert.ok(hex(row.sha256, 64));
    for (const key of [
      "url",
      "integrity",
      "sha512Hex",
      "logicalOccurrences",
      "bytes",
      "sha256",
    ])
      assert.deepEqual(
        row[key],
        artifact[key],
        "Original lock artifact identity differs",
      );
    byId.delete(artifact.id);
  }
  assert.equal(byId.size, 0, "Foreign document artifact identity");
  return structuredClone(value);
}
export function inspectNodeImageTools(rows) {
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, expected.tools.length);
  for (let index = 0; index < expected.tools.length; index++) {
    const actual = rows[index],
      selected = expected.tools[index];
    assert.ok(actual && typeof actual === "object");
    assert.deepEqual(Object.keys(actual).sort(), [
      "bytes",
      "canonicalPath",
      "invocation",
      "mode",
      "role",
      "sha256",
    ]);
    for (const key of [
      "role",
      "invocation",
      "canonicalPath",
      "bytes",
      "sha256",
    ])
      assert.equal(
        actual[key],
        selected[key],
        "Selected compiler/interpreter/tool body differs",
      );
    assert.ok(
      Number.isSafeInteger(actual.mode) &&
        actual.mode > 0 &&
        actual.mode <= 0o777 &&
        (actual.mode & 0o111) !== 0,
    );
  }
  return structuredClone(rows);
}
export function inspectNodePythonSelection(rows) {
  assert.ok(Array.isArray(rows));
  assert.deepEqual(
    rows.map((row) => row.candidate),
    expected.pythonCandidatesInOrder,
  );
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), [
      "bytes",
      "candidate",
      "canonicalPath",
      "executable",
      "sha256",
    ]);
    assert.equal(typeof row.executable, "boolean");
    if (!row.executable)
      assert.deepEqual(
        [row.canonicalPath, row.bytes, row.sha256],
        [null, null, null],
      );
  }
  const selected = rows.find((row) => row.executable);
  assert.ok(selected, "Original configure has no admitted Python candidate");
  const python = expected.tools.find((row) => row.role === "tool-python3");
  assert.equal(
    selected.canonicalPath,
    python.canonicalPath,
    "A different Python would precede the selected interpreter",
  );
  assert.equal(selected.bytes, python.bytes);
  assert.equal(selected.sha256, python.sha256);
  return structuredClone(selected);
}
export function requireNodeOriginalEnvironment(environment) {
  assert.ok(environment && typeof environment === "object");
  for (const key of ["CC", "CXX", "CI_SKIP_TESTS"])
    assert.ok(
      !Object.hasOwn(environment, key),
      "Original default selector unexpectedly overridden: " + key,
    );
  for (const [key, value] of [
    ["BUILDTYPE", "Release"],
    ["FLAKY_TESTS", "run"],
    ["TEST_CI_ARGS", ""],
    ["GTEST_FILTER", "*"],
  ])
    if (Object.hasOwn(environment, key))
      assert.equal(
        environment[key],
        value,
        "Original test setting changed: " + key,
      );
  const npmKeys = new Set();
  for (const [key, value] of Object.entries(environment)) {
    const normalized = key.toLowerCase();
    if (!normalized.startsWith("npm_config_")) continue;
    assert.ok(!npmKeys.has(normalized), "Duplicate normalized npm setting");
    npmKeys.add(normalized);
    assert.equal(
      normalized,
      "npm_config_cache",
      "Unexpected npm setting override",
    );
    assert.equal(
      value,
      "/work/npm-cache",
      "Only the owned cache location is routed",
    );
  }
  return structuredClone(environment);
}
export function nodeOriginalCommand(id) {
  const selected = expected.originalCommands.find((row) => row.id === id);
  assert.ok(selected, "Unknown original Node stage");
  return structuredClone(selected);
}
export function nodeOriginalCacheCommand(id) {
  assert.ok(
    expected.docCache.artifacts.some((row) => row.id === id),
    "Unknown closed document artifact",
  );
  return [
    "/work/" + expected.source.root + "/out/Release/node",
    "/work/" + expected.source.root + "/deps/npm/bin/npm-cli.js",
    "--cache=/work/npm-cache",
    "cache",
    "add",
    "/bundle/docs/" + id + ".tgz",
  ];
}
export function classifyNodeOriginalCompletion(stages, binary, bindings) {
  assert.deepEqual(Object.keys(stages).sort(), [
    "build",
    "configure",
    "upstream-tests",
  ]);
  const terminal = (row) =>
    row?.invoked === true &&
    row.terminalObserved === true &&
    Number.isInteger(row.exitCode) &&
    row.exitCode >= 0 &&
    row.signal === null &&
    row.error === null &&
    row.reason === null &&
    row.stopError === null;
  const succeeded = (row) => terminal(row) && row.exitCode === 0;
  const output =
    binary?.file === "out/Release/node" &&
    Number.isSafeInteger(binary.bytes) &&
    binary.bytes > 0 &&
    binary.bytes <= expected.limits.observedWorkBytes &&
    hex(binary.sha256, 64) &&
    Number.isInteger(binary.mode) &&
    binary.mode > 0 &&
    binary.mode <= 0o777 &&
    (binary.mode & 0o111) !== 0;
  const selectedBuild =
    succeeded(stages.configure) &&
    succeeded(stages.build) &&
    output &&
    bindings?.coldSourceMatched === true &&
    bindings.imageAndToolsStable === true &&
    bindings.outputCustodyVerified === true;
  return {
    selectedOriginalNodeBuildCompletionVerified: Boolean(selectedBuild),
    originalTestCommandInvoked: stages["upstream-tests"].invoked === true,
    originalTestCommandCompleted: terminal(stages["upstream-tests"]),
    originalTestCommandExitCode: terminal(stages["upstream-tests"])
      ? stages["upstream-tests"].exitCode
      : null,
    allUpstreamTestsPassed: false,
    upstreamOutcomeScope:
      "Original reached outcomes and unrun groups remain in retained results; command completion is separate from every test passing.",
    publishedBinaryEqualityVerified: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    gateAComplete: false,
  };
}

// Shared closed acquisition/controller interface: one source plus144 doc archives.
export function nodeOriginalInputRows() {
  const catalog = nodeOriginalCatalog();
  return [
    catalog.source.archive,
    ...catalog.docCache.artifacts.map((row) => ({
      ...row,
      file: "docs/" + row.id + ".tgz",
    })),
  ];
}
