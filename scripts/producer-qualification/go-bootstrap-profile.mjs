// Fixed development producer profile. Product CLI/MCP discovery never invokes it.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
const { structuredClone } = globalThis;
import { identifyFile } from "../qualify-binutils-producer.mjs";
export const goBootstrapDirectory = fileURLToPath(
  new URL("./", import.meta.url),
);
export const goBootstrapCatalogSha256 =
  "1ef7849aa70199aa50c7182f1fff7ea754b344ad1d9a0f8efc816f129d33a18b";
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
const catalogPath = new URL("go-bootstrap.v1.json", import.meta.url);
const originalBytes = readFileSync(catalogPath);
assert.equal(
  sha256(originalBytes),
  goBootstrapCatalogSha256,
  "Go catalog source bytes changed",
);
const expected = JSON.parse(originalBytes);
export const originalGoStageIds = Object.freeze(
  expected.requiredStages.slice(),
);
export const goWorkerFiles = Object.freeze([
  "go-bootstrap.v1.json",
  "go-bootstrap-profile.mjs",
  "go-bootstrap-worker.py",
  "go-bootstrap-retention-observer.py",
  "binutils-retention-observer.py",
  "binutils-retention-observer.mjs",
  "binutils-image-identity.mjs",
  "binutils-image-identity.v1.json",
]);
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
export const safeRelative = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 4096 &&
  !/[\\\0\r\n]/u.test(value) &&
  !path.posix.isAbsolute(value) &&
  value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..") &&
  Buffer.from(value).toString() === value;
export function validateGoBootstrapCatalog(catalog) {
  assert.deepEqual(
    catalog,
    expected,
    "Go catalog differs from the closed original commands, source graph and budgets",
  );
  return catalog;
}
export function requireClosedGoProfile(profile) {
  assert.deepEqual(
    profile,
    expected.profiles.find((row) => row.id === profile?.id),
    "Go stage does not match its closed original profile",
  );
  assert.ok(profile);
  return profile;
}
export function inspectGoImageTools(rows) {
  const paths = [
    ["bash", "/bin/bash"],
    ["gcc", "/usr/bin/gcc"],
    ["as", "/usr/bin/as"],
    ["ld", "/usr/bin/ld"],
    ["python3", "/usr/bin/python3"],
    ["cc1", "/usr/lib/gcc/x86_64-linux-gnu/12/cc1"],
    ["collect2", "/usr/lib/gcc/x86_64-linux-gnu/12/collect2"],
    ["loader", "/lib64/ld-linux-x86-64.so.2"],
  ];
  assert.ok(Array.isArray(rows));
  assert.deepEqual(
    rows.map((row) => [row.role, row.invocation]),
    paths,
    "Actual compiler, interpreter, loader or linker bindings are missing or foreign",
  );
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), [
      "bytes",
      "canonicalPath",
      "invocation",
      "mode",
      "role",
      "sha256",
    ]);
    assert.ok(
      typeof row.canonicalPath === "string" &&
        row.canonicalPath.startsWith("/") &&
        !row.canonicalPath.startsWith("/observed/") &&
        !/[\\\0\r\n]/u.test(row.canonicalPath) &&
        Buffer.byteLength(row.canonicalPath) <= 4096,
    );
    assert.ok(
      Number.isSafeInteger(row.bytes) &&
        row.bytes > 0 &&
        row.bytes <= expected.observationLimits.regularLeafBytes,
    );
    assert.match(row.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(
      Number.isSafeInteger(row.mode) &&
        row.mode > 0 &&
        row.mode <= 0o777 &&
        (row.mode & 0o111) !== 0,
    );
  }
  return rows;
}
export async function loadGoBootstrapCatalog() {
  const actual = await identifyFile(fileURLToPath(catalogPath), 128 * 1024);
  assert.equal(actual.sha256, goBootstrapCatalogSha256);
  return validateGoBootstrapCatalog(
    JSON.parse(await readFile(catalogPath, "utf8")),
  );
}
export function goProfile(catalog, id) {
  validateGoBootstrapCatalog(catalog);
  const profile = catalog.profiles.find((row) => row.id === id);
  assert.ok(profile, "Unknown closed Go bootstrap stage");
  return structuredClone(profile);
}
export const asciiJson = (value, spaces) =>
  JSON.stringify(value, null, spaces).replace(/[\u007f-\uffff]/g, (char) =>
    char
      .split("")
      .map((unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0"))
      .join(""),
  );
export function compareGoPaths(a, b) {
  const left = a.split("/"),
    right = b.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const compared = Buffer.compare(
      Buffer.from(left[i]),
      Buffer.from(right[i]),
    );
    if (compared) return compared;
  }
  return left.length - right.length;
}
function ownerMode(value) {
  assert.deepEqual(Object.keys(value).sort(), ["gid", "mode", "uid"]);
  for (const key of ["uid", "gid"])
    assert.ok(
      Number.isSafeInteger(value[key]) &&
        value[key] >= 0 &&
        value[key] <= 4294967294,
    );
  assert.ok(
    Number.isSafeInteger(value.mode) &&
      value.mode >= 0 &&
      value.mode <= 0o777 &&
      !Object.is(value.mode, -0),
  );
}
export function inspectGoPhysicalTree(tree) {
  assert.deepEqual(Object.keys(tree).sort(), [
    "entries",
    "root",
    "schemaVersion",
  ]);
  assert.equal(tree.schemaVersion, 1);
  ownerMode(tree.root);
  assert.ok(
    Array.isArray(tree.entries) &&
      tree.entries.length > 0 &&
      tree.entries.length <= expected.observationLimits.sdkEntries,
    "Go physical inventory is empty or too large",
  );
  const entries = new Map();
  let bytes = 0;
  for (const row of tree.entries) {
    assert.ok(
      safeRelative(row.file) &&
        row.file.split("/").length <= expected.observationLimits.sdkDepth &&
        !entries.has(row.file),
      "Go SDK path is duplicate, foreign or outside its physical root",
    );
    assert.ok(["file", "directory", "symlink"].includes(row.kind));
    ownerMode({ mode: row.mode, uid: row.uid, gid: row.gid });
    const keys = ["file", "kind", "mode", "uid", "gid"];
    if (row.kind !== "directory") {
      keys.push("bytes", "sha256");
      assert.ok(
        Number.isSafeInteger(row.bytes) &&
          row.bytes >= 0 &&
          row.bytes <= expected.observationLimits.regularLeafBytes,
      );
      assert.match(row.sha256, /^[a-f0-9]{64}$/u);
      bytes += row.bytes;
    }
    if (row.kind === "symlink") {
      keys.push("target");
      assert.ok(
        typeof row.target === "string" &&
          Buffer.byteLength(row.target) <= 4096 &&
          !/[\0\r\n\\]/u.test(row.target) &&
          !path.posix.isAbsolute(row.target),
      );
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(row.file), row.target),
      );
      assert.ok(
        target !== ".." && !target.startsWith("../"),
        "Go SDK link escapes the sealed root",
      );
      assert.equal(row.bytes, Buffer.byteLength(row.target));
      assert.equal(row.sha256, sha256(row.target));
    }
    assert.deepEqual(Object.keys(row).sort(), keys.sort());
    entries.set(row.file, row);
  }
  assert.ok(bytes <= expected.observationLimits.workBytes);
  assert.deepEqual(
    tree.entries.map((row) => row.file),
    [...entries.keys()].sort(compareGoPaths),
    "Go SDK manifest ordering differs from original Python path ordering",
  );
  for (const row of tree.entries) {
    const parent = path.posix.dirname(row.file);
    if (parent !== ".")
      assert.equal(
        entries.get(parent)?.kind,
        "directory",
        "Go SDK has an omitted or linked parent",
      );
  }
  const regular = tree.entries
    .filter((row) => row.kind === "file")
    .map((row) => ({ file: row.file, bytes: row.bytes, sha256: row.sha256 }));
  return {
    schemaVersion: 1,
    fullManifestSha256: sha256(asciiJson(tree) + "\n"),
    regularManifestSha256: sha256(asciiJson(regular, 2) + "\n"),
    regularFiles: regular.length,
    regularBytes: regular.reduce((n, row) => n + row.bytes, 0),
    symlinks: tree.entries.filter((row) => row.kind === "symlink").length,
    entries: tree.entries.length,
  };
}
export function requireGoSourceUnchanged(before, after) {
  inspectGoPhysicalTree(before);
  inspectGoPhysicalTree(after);
  const current = new Map(after.entries.map((row) => [row.file, row]));
  for (const row of before.entries)
    if (row.kind !== "directory") {
      const found = current.get(row.file);
      assert.ok(
        found &&
          found.kind === row.kind &&
          found.bytes === row.bytes &&
          found.sha256 === row.sha256 &&
          (row.kind !== "symlink" || found.target === row.target),
        "Original provided Go source bytes changed during build",
      );
    }
}
export function requireCurrentGoPredecessor(
  profile,
  completed,
  sourceFrame,
  chainAttempt,
) {
  assert.ok(uuid(chainAttempt), "Fresh source chain attempt is unavailable");
  assert.ok(originalGoStageIds.includes(profile.id));
  const frozen = expected.profiles.find((row) => row.id === profile.id);
  assert.deepEqual(profile, frozen);
  if (!profile.predecessor) return null;
  const previous = completed.get(profile.predecessor.stage);
  assert.ok(
    previous && previous.freshNativeUpstreamSourceAncestryComplete === true,
    "Current original-source predecessor did not complete",
  );
  assert.equal(previous.stage, profile.predecessor.stage);
  assert.equal(previous.sourceFrameSha256, sourceFrame);
  assert.equal(
    previous.chainAttempt,
    chainAttempt,
    "A previous source-chain attempt cannot replace the current parent",
  );
  assert.ok(uuid(previous.attempt));
  const observed = inspectGoPhysicalTree(previous.sdkTree);
  assert.deepEqual(
    previous.seal,
    observed,
    "Current predecessor seal differs from actual complete physical SDK inventory",
  );
  return {
    stage: previous.stage,
    attempt: previous.attempt,
    sourceFrameSha256: sourceFrame,
    chainAttempt,
    seal: observed,
    historicalRegularManifestComparison:
      observed.regularManifestSha256 ===
      profile.predecessor.historicalSdkManifestSha256
        ? "match"
        : "differs",
  };
}
export function requireGoPredecessorUnchanged(binding, tree) {
  if (binding === null) {
    assert.equal(tree, null);
    return;
  }
  assert.deepEqual(
    inspectGoPhysicalTree(tree),
    binding.seal,
    "Current predecessor SDK changed before or after child execution",
  );
}
export function requireOriginalGoPhase(profile, phase, result, text) {
  requireClosedGoProfile(profile);
  assert.deepEqual(
    phase,
    profile.originalCommands.find((row) => row.phase === phase.phase),
  );
  assert.deepEqual(
    {
      exitCode: result.exitCode,
      signal: result.signal,
      reason: result.reason,
      stopError: result.stopError,
    },
    { exitCode: 0, signal: null, reason: null, stopError: null },
    "Original Go command did not complete",
  );
  if (phase.phase === "bootstrap-preflight")
    assert.equal(
      text,
      "go version " + profile.predecessor.version + " linux/amd64\n",
      "Original Go bootstrap version check failed",
    );
  if (phase.phase === "built-version")
    assert.equal(
      text.trim(),
      "go version " +
        (profile.id === "supported-c-bootstrap"
          ? profile.internalVersionFile
          : profile.id) +
        " linux/amd64",
      "Original Go built-version check failed",
    );
  if (phase.phase === "built-sdk-config") {
    const config = JSON.parse(text);
    assert.ok(
      config.GOROOT === "/work/go" &&
        config.GOHOSTARCH === "amd64" &&
        config.GOARCH === "amd64" &&
        config.GOHOSTOS === "linux" &&
        config.GOOS === "linux" &&
        config.CGO_ENABLED === "0",
      "Original Go SDK configuration check failed",
    );
  }
}
export function completeGoStage({
  profile,
  attempt,
  sourceFrameSha256,
  chainAttempt,
  phases,
  before,
  sdkTree,
  predecessor,
}) {
  assert.deepEqual(
    profile,
    expected.profiles.find((row) => row.id === profile.id),
  );
  assert.ok(uuid(attempt) && uuid(chainAttempt));
  assert.match(sourceFrameSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    phases.map((row) => row.phase),
    profile.originalCommands.map((row) => row.phase),
    "Original Go command inventory is incomplete",
  );
  assert.equal(new Set(phases.map((row) => row.attempt)).size, phases.length);
  for (const [i, row] of phases.entries()) {
    assert.ok(uuid(row.attempt));
    assert.equal(row.originalAssertionsSatisfied, true);
    assert.equal(row.ownedContainerAbsent, true);
    assert.deepEqual(row.command, profile.originalCommands[i]);
    assert.equal(row.terminal.exitCode, 0);
    assert.equal(row.terminal.reason, null);
    assert.equal(row.terminal.signal, null);
    assert.equal(row.terminal.stopError, null);
    assert.ok(
      Number.isSafeInteger(row.raw.bytes) &&
        row.raw.bytes >= 0 &&
        row.raw.bytes <= expected.observationLimits.commandOutputBytes,
    );
    assert.match(row.raw.sha256, /^[a-f0-9]{64}$/u);
  }
  requireGoSourceUnchanged(before, sdkTree);
  const seal = inspectGoPhysicalTree(sdkTree),
    files = new Map(sdkTree.entries.map((row) => [row.file, row]));
  for (const file of profile.id === "supported-c-bootstrap"
    ? [
        "bin/go",
        "bin/gofmt",
        "pkg/tool/linux_amd64/6g",
        "pkg/tool/linux_amd64/6c",
        "pkg/tool/linux_amd64/6l",
        "pkg/tool/linux_amd64/6a",
      ]
    : [
        "bin/go",
        "bin/gofmt",
        "pkg/tool/linux_amd64/compile",
        "pkg/tool/linux_amd64/link",
        "pkg/tool/linux_amd64/asm",
      ])
    assert.ok(
      files.get(file)?.kind === "file" && (files.get(file).mode & 0o111) !== 0,
      "Actual built Go SDK tool is missing",
    );
  assert.equal(Boolean(predecessor), Boolean(profile.predecessor));
  if (predecessor) {
    assert.equal(predecessor.stage, profile.predecessor.stage);
    assert.equal(predecessor.sourceFrameSha256, sourceFrameSha256);
    assert.equal(predecessor.chainAttempt, chainAttempt);
  }
  return {
    stage: profile.id,
    attempt,
    sourceFrameSha256,
    chainAttempt,
    sdkTree,
    seal,
    predecessor,
    phases,
    originalSourceTree: before,
    freshNativeUpstreamSourceAncestryComplete: true,
    exactHistoricalPrivateInputReplay: false,
    historicalBootstrapRegularInputsMatched:
      predecessor === null
        ? null
        : predecessor.historicalRegularManifestComparison === "match",
    historicalRegularOutputComparison:
      seal.regularManifestSha256 === profile.historicalOutputManifest.sha256
        ? "match"
        : "differs",
    originalRuntimeSuiteExecuted: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    gateAComplete: false,
  };
}
export function completeGoChain(rows, sourceFrameSha256, chainAttempt) {
  assert.ok(uuid(chainAttempt));
  assert.deepEqual(
    rows.map((row) => row.stage),
    originalGoStageIds,
    "All eight original Go source stages remain required",
  );
  assert.equal(new Set(rows.map((row) => row.attempt)).size, rows.length);
  assert.equal(
    new Set(rows.flatMap((row) => row.phases.map((phase) => phase.attempt)))
      .size,
    expected.originalCommands,
    "Original Go process attempts cannot be reused across source stages",
  );
  const completed = new Map();
  for (const row of rows) {
    assert.equal(row.freshNativeUpstreamSourceAncestryComplete, true);
    assert.equal(row.sourceFrameSha256, sourceFrameSha256);
    assert.equal(row.chainAttempt, chainAttempt);
    const profile = expected.profiles.find(
      (profile) => profile.id === row.stage,
    );
    const parent = requireCurrentGoPredecessor(
      profile,
      completed,
      sourceFrameSha256,
      chainAttempt,
    );
    assert.deepEqual(row.predecessor, parent);
    const verified = completeGoStage({
      profile,
      attempt: row.attempt,
      sourceFrameSha256,
      chainAttempt,
      phases: row.phases,
      before: row.originalSourceTree,
      sdkTree: row.sdkTree,
      predecessor: parent,
    });
    assert.deepEqual(
      row,
      verified,
      "Go stage packet claims differ from its original commands, source and physical seal",
    );
    completed.set(row.stage, verified);
  }
  return {
    freshNativeUpstreamSourceAncestryComplete: true,
    originalStages: rows.length,
    originalCommands: expected.originalCommands,
    exactHistoricalPrivateInputReplay: false,
    historicalBootstrapRegularInputsMatched: rows
      .filter((row) => row.predecessor !== null)
      .every((row) => row.historicalBootstrapRegularInputsMatched === true),
    historicalRegularOutputComparisons: rows.map((row) => ({
      stage: row.stage,
      state: row.historicalRegularOutputComparison,
    })),
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    gateAComplete: false,
  };
}
