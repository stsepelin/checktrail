// Internal synthetic acceptance bookkeeping; no legal or upstream-build verdict.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { Buffer } from "node:buffer";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { checkReviewRuntimeSelection } from "./review-runtime-evidence.mjs";
import { requireProvenanceSourceBuild } from "./native-provenance-source-build.mjs";
export const provenanceRuntimeProfile = "native-license-provenance";
export const provenanceRuntimeKinds = Object.freeze([
  "broken",
  "fixed",
  "near-miss",
  "prerequisite",
  "stale",
  "empty",
  "privacy",
  "lifecycle",
  "installed",
]);
export const provenanceInstalledPrograms = Object.freeze([
  "scripts/native-provenance-coordinator.mjs",
  "scripts/native-provenance-adapter.mjs",
  "scripts/native-provenance-audit-child.mjs",
  "scripts/audit-dependencies.mjs",
  "scripts/audit-selected-artifact-evidence.mjs",
  "scripts/pango-complete-text-binding.mjs",
]);
export const provenanceRuntimeHarnessFiles = Object.freeze([
  "package.json",
  "package-lock.json",
  "docs/gate-a-profiles.v1.json",
  "dist/test/gate-native-license-provenance.test.js",
  "dist/test/native-license-provenance-fixture.js",
  "dist/test/helpers.js",
  "dist/test/tool-fixture.js",
  "scripts/verify-native-provenance-runtime.mjs",
  "scripts/verify-native-provenance-runtime-package.mjs",
  "scripts/native-provenance-runtime-evidence.mjs",
  "scripts/native-provenance-source-build.mjs",
  "scripts/review-runtime-evidence.mjs",
  "scripts/required-native-tests.json",
  "scripts/required-test-evidence.mjs",
  "scripts/compiled-engine-evidence.mjs",
  "scripts/install-acceptance-package.mjs",
  "scripts/runtime-installation-capture.mjs",
  ...provenanceInstalledPrograms,
]);
export const provenanceRuntimeHash = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const digest = (value) =>
  assert.match(value ?? "", /^[a-f0-9]{64}$/u, "Required SHA-256 identity");
export function selectProvenanceRuntimeRequirements(definitions, inventory) {
  const profiles = inventory.extensionProfiles.filter(
    (p) => p.id === provenanceRuntimeProfile,
  );
  assert.equal(profiles.length, 1, "Unique provenance profile required");
  const p = profiles[0];
  assert.equal(p.runtime, "engine-matrix");
  assert.equal(
    p.acceptanceFile,
    "dist/test/gate-native-license-provenance.test.js",
  );
  assert.deepEqual(
    p.acceptanceCases.map((c) => c.id),
    provenanceRuntimeKinds,
  );
  const required = p.acceptanceCases.map((c) => ({
    file: p.acceptanceFile,
    name: c.name,
  }));
  assert.deepEqual(
    definitions[provenanceRuntimeProfile],
    required,
    "Required provenance callbacks differ from plan",
  );
  return required;
}
export function provenanceRuntimeArgument(args) {
  assert.equal(args.length, 1, "Pass an exact runtime slot or --development");
  assert.ok(
    args[0] === "--development" || /^[a-z][a-z0-9-]+$/u.test(args[0]),
    "Malformed runtime selection",
  );
  return args[0] === "--development" ? null : args[0];
}
export async function captureProvenanceRuntime(inventory, slot) {
  let distributionBytes = null;
  const distribution = new Map();
  if (process.platform === "linux") {
    distributionBytes = await readFile("/etc/os-release");
    assert.ok(distributionBytes.length <= 16384);
    for (const line of distributionBytes.toString("utf8").split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/u.exec(line);
      if (m) distribution.set(m[1], m[2].replace(/^"(.*)"$/u, "$1"));
    }
  }
  const runtime = {
    slot,
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
    osVersion: os.version(),
    distributionId: distribution.get("ID") ?? null,
    distributionVersion: distribution.get("VERSION_ID") ?? null,
    distributionSha256: distributionBytes
      ? provenanceRuntimeHash(distributionBytes)
      : null,
    imageOS: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    containerImageId: process.env.CHECKTRAIL_REVIEW_RUNTIME_IMAGE_ID ?? null,
    nodeExecutableSha256: provenanceRuntimeHash(
      await readFile(process.execPath),
    ),
    hostedImageMetadataAttested: false,
    containerImageMetadataAttested: false,
  };
  return {
    ...runtime,
    selectedRuntime: checkReviewRuntimeSelection(
      inventory,
      slot,
      runtime,
      slot !== null && process.env.GITHUB_ACTIONS === "true",
    ),
  };
}
export async function captureProvenanceSource(repository) {
  const run = (args) =>
    execFileSync(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      {
        cwd: repository,
        timeout: 10000,
        maxBuffer: 2 * 1048576,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_NO_LAZY_FETCH: "1",
        },
      },
    );
  const head = run(["rev-parse", "HEAD"]).toString("utf8").trim();
  assert.match(head, /^[a-f0-9]{40}$/u);
  const status = run([
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
    "-z",
  ]);
  return {
    gitHead: head,
    worktreeClean: status.length === 0,
    statusSha256: provenanceRuntimeHash(status),
    compiledFromSourceVerified: false,
  };
}
export async function readProvenanceInput(
  file,
  maximum = 4 * 1048576,
  privateMode = false,
) {
  const before = await lstat(file, { bigint: true });
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.size > 0n &&
      before.size <= BigInt(maximum),
    "Bounded regular provenance input required",
  );
  if (privateMode && process.platform !== "win32") {
    assert.equal(before.uid, BigInt(process.getuid()));
    assert.equal(before.mode & 0o777n, 0o600n);
    assert.equal(before.nlink, 1n);
  }
  const fd = await open(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  const same = (left, right) =>
    ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
      (key) => left[key] === right[key],
    );
  try {
    const opened = await fd.stat({ bigint: true });
    assert.ok(same(opened, before), "Provenance input rebound");
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = await fd.read(buffer, count, buffer.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    assert.equal(BigInt(count), opened.size, "Provenance input size changed");
    assert.ok(
      same(opened, await fd.stat({ bigint: true })) &&
        same(opened, await lstat(file, { bigint: true })),
      "Provenance input changed while capturing",
    );
    return buffer.subarray(0, count);
  } finally {
    await fd.close();
  }
}
export async function captureProvenanceHarness(repository) {
  return Promise.all(
    provenanceRuntimeHarnessFiles.map(async (file) => {
      const raw = await readProvenanceInput(path.join(repository, file));
      return { file, bytes: raw.length, sha256: provenanceRuntimeHash(raw) };
    }),
  );
}
export function requireProvenanceRuntimeCases(
  receipt,
  requirements,
  acceptanceSha256,
) {
  assert.equal(receipt.complete, true);
  assert.equal(receipt.required, 9);
  assert.equal(receipt.passed, 9);
  assert.deepEqual(receipt.problems, []);
  const ledger = receipt.ledger;
  assert.equal(ledger.truncated, false);
  assert.equal(ledger.terminalEventCount, 9);
  assert.equal(ledger.events.length, 9);
  assert.equal(ledger.cases.length, 9);
  assert.equal(ledger.files.length, 1);
  const file = ledger.files[0];
  assert.equal(file.stable, true);
  assert.deepEqual(file.before, { state: "present", sha256: acceptanceSha256 });
  assert.deepEqual(file.after, file.before);
  assert.deepEqual(
    ledger.cases.map((c) => c.name).sort(),
    requirements.map((c) => c.name).sort(),
  );
  assert.equal(new Set(ledger.cases.map((c) => c.name)).size, 9);
  const sequences = [];
  for (const c of ledger.cases) {
    assert.equal(c.fileId, file.id);
    assert.equal(c.outcome, "passed");
    assert.equal(c.terminalSequences.length, 1);
    const sequence = c.terminalSequences[0];
    assert.ok(Number.isInteger(sequence) && sequence >= 1 && sequence <= 9);
    sequences.push(sequence);
    const event = ledger.events[sequence - 1];
    assert.equal(event.sequence, sequence);
    assert.equal(event.fileId, file.id);
    assert.equal(event.name, c.name);
    assert.equal(event.outcome, "passed");
    assert.equal(event.kind, "test");
    assert.equal(event.required, true);
    assert.equal(event.nameTruncated, false);
  }
  assert.equal(new Set(sequences).size, 9);
  return receipt;
}
export async function requireProvenanceInstalledLayout(repository, context) {
  assert.equal(context.schemaVersion, 1);
  assert.equal(context.mode, "installed");
  const packageRoot = await realpath(context.installedPackageRoot),
    engineRoot = await realpath(path.join(repository, "dist/src"));
  assert.equal(packageRoot, context.installedPackageRoot);
  assert.equal(engineRoot, path.join(packageRoot, "dist/src"));
  assert.equal(engineRoot, context.installedEngineRoot);
  assert.notEqual(
    engineRoot,
    context.sourceEngineRoot,
    "Installed harness resolved checkout engine",
  );
  const relative = path.relative(packageRoot, await realpath(repository));
  assert.ok(
    relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative),
    "Harness must be outside installed package",
  );
  assert.equal(
    await realpath(
      process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED_PACKAGE ?? "",
    ),
    packageRoot,
    "Installed helper root differs",
  );
  for (const file of provenanceInstalledPrograms) {
    const raw = await readFile(path.join(packageRoot, file));
    const expected = context.inputSources.find((row) => row.file === file);
    assert.ok(expected, "Missing installed helper identity");
    assert.equal(raw.length, expected.bytes);
    assert.equal(
      provenanceRuntimeHash(raw),
      expected.sha256,
      "Installed helper source differs",
    );
  }
  return {
    engineLocation: "fresh-installed-package",
    helperLocation: "fresh-installed-package",
    harnessOutsideInstalledPackage: true,
  };
}
// Admission identifies a runtime; only complete observed case accounting can qualify it.
export function provenanceRuntimeQualified(runtime, report, sourceBuild) {
  return (
    runtime.slot !== null &&
    sourceBuild?.state === "current-source-typescript-build-reconciled" &&
    sourceBuild.currentArtifactsMatchFreshBuild === true &&
    report.complete === true &&
    report.required === 9 &&
    report.passed === 9 &&
    Array.isArray(report.problems) &&
    report.problems.length === 0
  );
}
function requireProvenanceRuntimeBindings(evidence, expected) {
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.profile, "native-provenance-runtime-v1");
  assert.equal(evidence.installed, expected.installed);
  assert.equal(evidence.installedEvidence, null);
  assert.match(evidence.sourceBinding.gitHead, /^[a-f0-9]{40}$/u);
  digest(evidence.sourceBinding.statusSha256);
  assert.equal(evidence.sourceBinding.compiledFromSourceVerified, false);
  assert.deepEqual(evidence.runtime, expected.runtime);
  assert.deepEqual(evidence.sourceBinding, expected.sourceBinding);
  assert.deepEqual(
    evidence.sourceBuild,
    expected.sourceBuild,
    "Installed source-build witness differs",
  );
  requireProvenanceSourceBuild(evidence.sourceBuild, expected);
  assert.deepEqual(evidence.inputSources, expected.inputSources);
  assert.equal(evidence.harnessSha256, expected.harnessSha256);
  assert.equal(evidence.harnessInputsUnchanged, true);
  assert.equal(evidence.requirementsSha256, expected.requirementsSha256);
  assert.equal(
    evidence.selectedSlotQualified,
    provenanceRuntimeQualified(
      expected.runtime,
      evidence,
      evidence.sourceBuild,
    ),
  );
  if (evidence.selectedSlotQualified)
    assert.equal(
      evidence.sourceBinding.worktreeClean,
      true,
      "Selected qualification requires clean source",
    );
  for (const key of [
    "schemaVersion",
    "fileCount",
    "bytes",
    "treeSha256",
    "manifestSha256",
  ])
    assert.equal(
      evidence.compiledEngine[key],
      expected.compiledEngine[key],
      "Engine differs from selected source",
    );
  assert.equal(evidence.compiledEngine.beforeAfterByteIdentitiesMatch, true);
  assert.equal(
    evidence.compiledEngine.afterTreeSha256,
    evidence.compiledEngine.treeSha256,
  );
  assert.equal(
    evidence.compiledEngine.afterManifestSha256,
    evidence.compiledEngine.manifestSha256,
  );
  assert.equal(
    evidence.executionBinding.engineLocation,
    expected.installed ? "fresh-installed-package" : "current-source",
  );
  assert.equal(
    evidence.executionBinding.helperLocation,
    expected.installed ? "fresh-installed-package" : "current-source",
  );
  assert.equal(
    evidence.executionBinding.harnessOutsideInstalledPackage,
    expected.installed,
  );
  for (const key of [
    "inferenceInvoked",
    "fieldEvaluationExecuted",
    "gateAComplete",
    "upstreamProducerClosureVerified",
    "completeOriginalNoticeClosureVerified",
  ])
    assert.equal(evidence[key], false);
  return evidence;
}
export function requireProvenanceRuntimeEvidence(evidence, expected) {
  requireProvenanceRuntimeBindings(evidence, expected);
  const accepted = expected.inputSources.find(
    (x) => x.file === expected.requirements[0].file,
  );
  assert.ok(accepted, "Acceptance file missing from harness");
  requireProvenanceRuntimeCases(
    evidence,
    expected.requirements,
    accepted.sha256,
  );
  return evidence;
}
export function requireProvenanceRuntimeInstallation(
  receipt,
  source,
  requirements,
) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.profile, "native-provenance-installed-v1");
  assert.equal(receipt.offlineProductionInstall, true);
  assert.equal(receipt.lifecycleScriptsExecuted, false);
  assert.equal(receipt.harnessOutsideInstalledPackage, true);
  digest(receipt.tarballSha256);
  digest(receipt.productionDependencyLockSha256);
  assert.equal(receipt.harnessSha256, source.harnessSha256);
  requireProvenanceRuntimeEvidence(receipt.evidence, {
    ...source,
    installed: true,
    requirements,
  });
  for (const key of [
    "inferenceInvoked",
    "fieldEvaluationExecuted",
    "gateAComplete",
  ])
    assert.equal(receipt[key], false);
  return receipt;
}

// Internal operator artifact retention. It does not observe the publisher host's
// runtime: an ARM carrier can supply its independently pinned inner context.
export async function publishProvenanceRuntimeReceipt(
  rawBytes,
  destination,
  expected,
) {
  const maximum = 4 * 1048576;
  assert.ok(
    Buffer.isBuffer(rawBytes) || typeof rawBytes === "string",
    "Exact UTF-8 receipt bytes required",
  );
  const length = Buffer.isBuffer(rawBytes)
    ? rawBytes.length
    : Buffer.byteLength(rawBytes, "utf8");
  assert.ok(
    length > 0 && length <= maximum,
    "Runtime receipt byte bound exceeded",
  );
  const bytes = Buffer.from(rawBytes),
    packet = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  assert.equal(
    expected.installed,
    false,
    "Only source plus fresh-install envelopes are retained",
  );
  assert.equal(typeof packet.complete, "boolean");
  const source = { ...packet, installedEvidence: null };
  requireProvenanceRuntimeBindings(source, expected);
  if (packet.complete) {
    requireProvenanceRuntimeEvidence(source, expected);
    requireProvenanceRuntimeInstallation(
      packet.installedEvidence,
      source,
      expected.requirements,
    );
  } else {
    assert.equal(
      packet.installedEvidence,
      null,
      "Incomplete source cannot reuse an installed receipt",
    );
    assert.equal(packet.selectedSlotQualified, false);
    assert.equal(packet.required, 9);
    assert.ok(
      Number.isInteger(packet.passed) &&
        packet.passed >= 0 &&
        packet.passed <= 9,
    );
    assert.ok(
      Array.isArray(packet.problems) && packet.problems.length > 0,
      "Incomplete accounting requires explicit problems",
    );
    assert.equal(packet.ledger.files.length, 1);
    const file = packet.ledger.files[0],
      accepted = expected.inputSources.find(
        (row) => row.file === expected.requirements[0].file,
      );
    assert.equal(file.stable, true);
    assert.deepEqual(file.before, {
      state: "present",
      sha256: accepted.sha256,
    });
    assert.deepEqual(file.after, file.before);
    assert.equal(packet.ledger.cases.length, 9);
    assert.deepEqual(
      packet.ledger.cases.map((row) => row.name).sort(),
      expected.requirements.map((row) => row.name).sort(),
    );
  }
  assert.ok(
    typeof destination === "string" &&
      path.isAbsolute(destination) &&
      path.resolve(destination) === destination,
    "Canonical absolute receipt destination required",
  );
  const parent = path.dirname(destination);
  assert.notEqual(parent, destination);
  assert.equal(
    await realpath(parent),
    parent,
    "Canonical physical receipt parent required",
  );
  const parentBefore = await lstat(parent, { bigint: true });
  assert.ok(
    parentBefore.isDirectory() && !parentBefore.isSymbolicLink(),
    "Physical receipt parent required",
  );
  try {
    await lstat(destination);
    assert.fail("Runtime receipt destination already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(
    parent,
    ".checktrail-provenance-" + randomUUID() + ".tmp",
  );
  let handle,
    owned,
    staged = false,
    published = false,
    failure;
  const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
  try {
    handle = await open(
      temporary,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    staged = true;
    owned = await handle.stat({ bigint: true });
    assert.ok(owned.isFile() && owned.nlink === 1n && owned.size === 0n);
    if (process.platform === "win32") {
      const { ensureWindowsTaskAccess } =
        await import("../dist/src/windows-task-access.js");
      ensureWindowsTaskAccess(temporary, "file", true);
    } else {
      assert.equal(owned.uid, BigInt(process.getuid()));
      assert.equal(owned.mode & 0o777n, 0o600n);
    }
    await handle.writeFile(bytes);
    await handle.sync();
    const readback = Buffer.alloc(bytes.length + 1);
    let count = 0;
    while (count < readback.length) {
      const read = await handle.read(
        readback,
        count,
        readback.length - count,
        count,
      );
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    assert.equal(count, bytes.length);
    assert.deepEqual(
      readback.subarray(0, count),
      bytes,
      "Runtime receipt readback differs",
    );
    const written = await handle.stat({ bigint: true });
    assert.ok(
      sameInode(owned, written) &&
        written.size === BigInt(bytes.length) &&
        written.nlink === 1n,
    );
    assert.ok(sameInode(written, await lstat(temporary, { bigint: true })));
    await handle.close();
    handle = undefined;
    // A same-directory hard link publishes already complete bytes atomically and
    // fails if any file, directory or symlink already occupies the destination.
    await link(temporary, destination);
    published = true;
    await unlink(temporary);
    staged = false;
    const final = await lstat(destination, { bigint: true });
    assert.ok(
      final.isFile() &&
        !final.isSymbolicLink() &&
        sameInode(owned, final) &&
        final.nlink === 1n &&
        final.size === BigInt(bytes.length),
    );
    if (process.platform !== "win32") {
      assert.equal(final.uid, BigInt(process.getuid()));
      assert.equal(final.mode & 0o777n, 0o600n);
    }
    const parentAfter = await lstat(parent, { bigint: true });
    for (const key of ["dev", "ino", "mode", "uid", "gid"])
      assert.equal(
        parentAfter[key],
        parentBefore[key],
        "Receipt parent changed during publication",
      );
    assert.equal(
      await realpath(destination),
      destination,
      "Published receipt path rebound",
    );
    if (process.platform !== "win32") {
      const dir = await open(
        parent,
        constants.O_RDONLY |
          (constants.O_DIRECTORY ?? 0) |
          (constants.O_NOFOLLOW ?? 0),
      );
      try {
        assert.ok(sameInode(parentBefore, await dir.stat({ bigint: true })));
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (handle) await handle.close();
    } catch (error) {
      failure = failure ?? error;
    }
    if (failure) {
      const cleanup = [];
      for (const [created, file] of [
        [published, destination],
        [staged, temporary],
      ])
        if (created) {
          try {
            const named = await lstat(file, { bigint: true });
            assert.ok(
              owned && sameInode(named, owned),
              "Failed receipt custody changed; preserve foreign inode",
            );
            await unlink(file);
          } catch (error) {
            if (error.code !== "ENOENT") cleanup.push(error);
          }
        }
      if (cleanup.length)
        failure = new AggregateError(
          [failure, ...cleanup],
          "Runtime receipt publication/cleanup incomplete",
        );
    }
  }
  if (failure) throw failure;
  return {
    file: destination,
    bytes: bytes.length,
    sha256: provenanceRuntimeHash(bytes),
    complete: packet.complete,
    selectedSlotQualified: packet.selectedSlotQualified,
  };
}
