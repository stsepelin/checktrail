import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  link,
  unlink,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { createPlan } from "../dist/src/engine.js";
import { parseCapturedProcessOutput } from "../dist/src/process-output.js";
import { cppExtensionsEvidence } from "../dist/src/cpp-extensions-evidence.js";
import { cppExtensionsPacketSchema } from "../dist/src/cpp-extensions-packet.js";
import { cppExtensionsToolNames } from "../dist/src/cpp-extensions-native.js";
import { captureCompiledEngine } from "./compiled-engine-evidence.mjs";
import { consumerWitnessCaptureParent } from "../dist/test/consumer-witness-fixture.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );
const usedResults = new WeakSet();
const variants = ["broken", "fixed", "near-miss"];
const origins = ["source", "installed"];
const moduleRoot = fileURLToPath(new URL("../", import.meta.url));
export const selectedClangWitnessScenarios = Object.freeze([
  {
    variant: "broken",
    phase: "canonical",
    scenario: "mixed-graph",
    modes: ["build", "ctest"],
    failed: true,
  },
  {
    variant: "fixed",
    phase: "repeat",
    scenario: "repair-before",
    modes: ["build", "ctest", "clang-format", "clang-tidy"],
    failed: true,
  },
  {
    variant: "fixed",
    phase: "canonical",
    scenario: "mixed-graph",
    modes: ["build", "ctest", "clang-format", "clang-tidy"],
    failed: false,
  },
  {
    variant: "near-miss",
    phase: "canonical",
    scenario: "private-link",
    modes: ["build", "ctest"],
    failed: false,
  },
  {
    variant: "near-miss",
    phase: "repeat",
    scenario: "adjacent-template",
    modes: ["build", "ctest"],
    failed: false,
  },
  {
    variant: "near-miss",
    phase: "repeat",
    scenario: "private-leaf",
    modes: ["build", "ctest"],
    failed: false,
  },
  {
    variant: "near-miss",
    phase: "repeat",
    scenario: "pure-c",
    modes: ["build", "ctest"],
    failed: false,
  },
]);
const address = (row) =>
  JSON.stringify([row.variant, row.origin, row.phase, row.scenario]);
function scenarioFor(variant, phase, scenario) {
  const found = selectedClangWitnessScenarios.filter(
    (row) =>
      row.variant === variant &&
      row.phase === phase &&
      row.scenario === scenario,
  );
  assert.equal(found.length, 1, "Unknown selected Clang original scenario");
  return found[0];
}
function outside(root, target) {
  const relative = path.relative(root, target);
  return (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(".." + path.sep)
  );
}
async function physical(filename, maximum = 4 * 1048576, source = true) {
  const canonical = await realpath(filename);
  if (source)
    assert.equal(canonical, filename, "Selected Clang source crosses a link");
  const fd = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat({ bigint: true });
    assert.ok(
      before.isFile() && before.size >= 0n && before.size <= BigInt(maximum),
    );
    const parts = [];
    let count = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65536, maximum + 1 - count));
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      assert.ok(count <= maximum);
      parts.push(buffer.subarray(0, bytesRead));
    }
    const after = await fd.stat({ bigint: true }),
      linked = await lstat(canonical, { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      assert.equal(before[key], after[key]);
      assert.equal(after[key], linked[key]);
    }
    assert.equal(BigInt(count), before.size);
    const bytes = Buffer.concat(parts, count);
    return {
      bytes: count,
      sha256: hash(bytes),
      base64: bytes.toString("base64"),
    };
  } finally {
    await fd.close();
  }
}
async function nodeIdentity() {
  const { bytes, sha256 } = await physical(
    process.execPath,
    256 * 1048576,
    false,
  );
  return { bytes, sha256 };
}
async function privateDirectory(destination, root) {
  assert.notEqual(
    process.platform,
    "win32",
    "Selected Clang native collector requires its selected POSIX runtime",
  );
  assert.ok(path.isAbsolute(destination));
  assert.equal(await realpath(destination), destination);
  const stat = await lstat(destination);
  assert.ok(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o777) === 0o700,
  );
  assert.ok(
    outside(root, destination) &&
      outside(await realpath(moduleRoot), destination),
  );
  assert.ok((await readdir(destination)).length < 512);
  return { dev: stat.dev, ino: stat.ino };
}
async function publish(capture, value, name) {
  assert.equal(
    capture.storageFailure,
    null,
    "Earlier selected Clang storage failure leaves capture incomplete",
  );
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  assert.ok(
    bytes.length <= 32 * 1048576,
    "Selected Clang retained file exceeds bound",
  );
  assert.deepEqual(
    await privateDirectory(capture.destination, capture.root),
    capture.storageIdentity,
  );
  const pending = path.join(capture.destination, ".pending-" + randomUUID());
  try {
    const fd = await open(pending, "wx", 0o600);
    try {
      await fd.writeFile(bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await link(pending, path.join(capture.destination, name));
  } finally {
    await unlink(pending).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  assert.deepEqual(
    await privateDirectory(capture.destination, capture.root),
    capture.storageIdentity,
  );
  return { file: name, bytes: bytes.length, sha256: hash(bytes) };
}
export async function captureSelectedClangConsumerCode() {
  const engineRoot = await realpath(path.join(moduleRoot, "dist/src"));
  const files = [
    "dist/test/selected-clang-consumer-fixture.js",
    "dist/test/gate-cpp-extensions.test.js",
    "dist/test/cpp-extensions-surfaces.test.js",
    "dist/test/cpp-extensions-cancel.test.js",
    "dist/test/cpp-extensions-fixture.js",
    "scripts/selected-clang-consumer-witness.mjs",
    "scripts/compiled-engine-evidence.mjs",
  ];
  const identities = await Promise.all(
    files.map(async (file) => ({
      path: file,
      ...(await physical(path.join(moduleRoot, file))),
    })),
  );
  const requirements = await selectSelectedClangRequirements(moduleRoot);
  const inventoryBytes = await readFile(
    path.join(moduleRoot, "docs/gate-a-profiles.v1.json"),
  );
  return {
    engineSha256: (await captureCompiledEngine(engineRoot)).treeSha256,
    inventorySha256: hash(inventoryBytes),
    harnessSha256: hash(
      JSON.stringify(
        identities.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
      ),
    ),
    requirementsSha256: hash(JSON.stringify(requirements)),
    packageManifestSha256: hash(
      await readFile(
        path.join(path.dirname(path.dirname(engineRoot)), "package.json"),
      ),
    ),
    installedOutsidePackage: outside(
      path.dirname(path.dirname(engineRoot)),
      await realpath(moduleRoot),
    ),
  };
}
async function sources(root, files) {
  assert.ok(files.length > 0 && files.length <= 32);
  let total = 0;
  const result = [];
  for (const file of files) {
    assert.ok(
      typeof file === "string" &&
        !path.isAbsolute(file) &&
        file
          .split("/")
          .every((part) => part && part !== "." && part !== "..") &&
        !/[\\:\0]/.test(file),
    );
    const data = await physical(path.join(root, file));
    total += data.bytes;
    assert.ok(total <= 64 * 1048576);
    result.push({ path: file, ...data });
  }
  return result;
}
/** Optional operator-maintenance capture only; never grants project execution trust. */
export async function beginSelectedClangWitness(
  root,
  variant,
  phase,
  scenario,
) {
  const destination = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR;
  if (destination === undefined) return null;
  scenarioFor(variant, phase, scenario);
  assert.equal(await realpath(root), root);
  const storageIdentity = await privateDirectory(destination, root);
  const { plan } = await createPlan(root);
  assert.deepEqual(
    plan.checks.map((check) => check.id),
    scenarioFor(variant, phase, scenario).modes.map(
      (mode) => "cpp." + mode + "-extensions",
    ),
  );
  const paths = plan.checks[0].scope;
  for (const check of plan.checks) {
    assert.equal(check.unavailableReason, undefined);
    assert.equal(check.commands.length, 1);
    assert.deepEqual(check.scope, paths);
  }
  return {
    root,
    destination,
    storageIdentity,
    witnessId: randomUUID(),
    variant,
    phase,
    scenario,
    origin:
      process.env.CHECKTRAIL_CPP_EXTENSIONS_INSTALLED === "1"
        ? "installed"
        : "source",
    before: await sources(root, paths),
    checks: plan.checks,
    code: await captureSelectedClangConsumerCode(),
    node: await nodeIdentity(),
    attempts: [],
    storageFailure: null,
  };
}
/** Persist every actual outer result first; original native packets retain their own actual build/test commands and nonzero exits. */
export async function finishSelectedClangWitness(capture, report) {
  if (!capture) return;
  assert.equal(capture.storageFailure, null);
  try {
    for (const [checkIndex, check] of report.checks.entries())
      for (const processResult of check.processes) {
        assert.equal(
          usedResults.has(processResult),
          false,
          "Selected Clang ProcessResult reused",
        );
        const attemptId = randomUUID(),
          { stdout, stderr, ...result } = processResult;
        let physicalOutputAvailable = false;
        try {
          parseCapturedProcessOutput(result.capturedOutput);
          physicalOutputAvailable = true;
        } catch {
          /* Returned text remains retained if physical capture is unavailable. */
        }
        const value = {
          schemaVersion: 1,
          profile: "selected-clang-process-result-observation-v1",
          family: "cpp",
          attemptId,
          witnessId: capture.witnessId,
          variant: capture.variant,
          origin: capture.origin,
          phase: capture.phase,
          scenario: capture.scenario,
          checkIndex,
          checkId: check.id,
          result,
          stdoutSha256: hash(stdout),
          stderrSha256: hash(stderr),
          textFallback: physicalOutputAvailable
            ? null
            : { stdout, stderr, physicalCaptureAvailable: false },
          processStartAcknowledgementRetained: false,
          nativeTerminalObserved:
            processResult.errorCode === undefined &&
            (processResult.exitCode !== null || processResult.signal !== null),
          gateAComplete: false,
        };
        capture.attempts.push(
          await publish(capture, value, "attempt-" + attemptId + ".json"),
        );
        usedResults.add(processResult);
      }
    const after = await sources(
      capture.root,
      capture.before.map((file) => file.path),
    );
    assert.deepEqual(
      after,
      capture.before,
      "Selected Clang physical sources changed",
    );
    assert.deepEqual(
      await captureSelectedClangConsumerCode(),
      capture.code,
      "Selected Clang harness or engine changed",
    );
    assert.deepEqual(await nodeIdentity(), capture.node);
    const row = {
      schemaVersion: 1,
      profile: "selected-clang-consumer-witness-observation-v1",
      family: "cpp",
      witnessId: capture.witnessId,
      variant: capture.variant,
      origin: capture.origin,
      phase: capture.phase,
      scenario: capture.scenario,
      before: capture.before,
      after,
      checks: capture.checks,
      attempts: capture.attempts,
      code: capture.code,
      node: { bytes: capture.node.bytes, sha256: capture.node.sha256 },
      runtime: {
        node: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
        hostAttestationPerformed: false,
      },
      report: {
        sourceFingerprint: report.sourceFingerprint,
        finalSourceFingerprint: report.finalSourceFingerprint,
        sourceChanged: report.sourceChanged,
        sourceError: report.sourceError,
        outcome: report.outcome,
        checks: report.checks.map((check) => ({
          id: check.id,
          status: check.status,
          tests: check.tests ?? null,
        })),
      },
      hostAttestationPerformed: false,
      wholeRuntimeClosureVerified: false,
      gateAComplete: false,
    };
    await publish(
      capture,
      row,
      ["cpp", capture.variant, capture.phase, capture.witnessId].join("-") +
        ".json",
    );
  } catch (error) {
    capture.storageFailure = String(error).slice(0, 1024);
    throw error;
  }
}
function decodeResult(value) {
  const result = value.result;
  assert.equal(
    value.textFallback,
    null,
    "Selected Clang physical output unavailable",
  );
  const output = parseCapturedProcessOutput(result.capturedOutput);
  assert.equal(output.completeForObservedStreams, true);
  const stdout = Buffer.from(output.stdout.base64, "base64").toString("utf8"),
    stderr = Buffer.from(output.stderr.base64, "base64").toString("utf8");
  assert.equal(hash(stdout), value.stdoutSha256);
  assert.equal(hash(stderr), value.stderrSha256);
  assert.equal(hash(stdout), output.stdout.sha256);
  assert.equal(hash(stderr), output.stderr.sha256);
  assert.equal(result.exitCode, 0, "Selected Clang outer collection failed");
  assert.equal(result.signal, null);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.truncated, false);
  assert.equal(value.processStartAcknowledgementRetained, false);
  assert.equal(value.nativeTerminalObserved, true);
  assert.equal(value.gateAComplete, false);
  return { ...result, stdout, stderr };
}
/** Rebuild only retained synthetic input files, then use the original strict data parser. No native/project command is executed here. */
export async function inspectSelectedClangConsumerWitnesses(
  collection,
  binding = null,
) {
  assert.ok(
    collection &&
      Array.isArray(collection.observations) &&
      collection.observations.length <= 64,
  );
  assert.ok(
    Array.isArray(collection.attemptRecords) &&
      collection.attemptRecords.length <= 256,
  );
  const records = new Map(),
    used = new Set(),
    reached = new Map();
  let retained = 0;
  for (const item of collection.attemptRecords) {
    const value = item.value;
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.profile, "selected-clang-process-result-observation-v1");
    assert.equal(value.family, "cpp");
    assert.ok(uuid(value.attemptId) && uuid(value.witnessId));
    assert.equal(
      records.has(value.attemptId),
      false,
      "Duplicate selected Clang attempt",
    );
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    assert.equal(item.file, "attempt-" + value.attemptId + ".json");
    assert.equal(item.bytes, bytes.length);
    assert.equal(item.sha256, hash(bytes));
    retained += bytes.length;
    assert.ok(bytes.length <= 32 * 1048576 && retained <= 256 * 1048576);
    records.set(value.attemptId, item);
  }
  const toolIdentities = [],
    sdkIdentities = [];
  for (const row of collection.observations) {
    assert.equal(row.schemaVersion, 1);
    assert.equal(row.profile, "selected-clang-consumer-witness-observation-v1");
    assert.equal(row.family, "cpp");
    assert.ok(uuid(row.witnessId));
    assert.ok(variants.includes(row.variant) && origins.includes(row.origin));
    const expected = scenarioFor(row.variant, row.phase, row.scenario);
    assert.equal(
      reached.has(address(row)),
      false,
      "Duplicate selected Clang original scenario",
    );
    reached.set(address(row), row);
    assert.equal(row.hostAttestationPerformed, false);
    assert.equal(row.wholeRuntimeClosureVerified, false);
    assert.equal(row.gateAComplete, false);
    assert.deepEqual(row.after, row.before);
    assert.ok(
      Array.isArray(row.before) &&
        row.before.length > 0 &&
        row.before.length <= 32,
    );
    assert.deepEqual(
      row.checks.map((check) => check.id),
      expected.modes.map((mode) => "cpp." + mode + "-extensions"),
    );
    assert.equal(
      row.attempts.length,
      row.checks.length,
      "Selected Clang process denominator differs",
    );
    assert.equal(row.report.sourceChanged, false);
    assert.equal(row.report.sourceError, false);
    assert.ok(sha(row.report.sourceFingerprint));
    assert.equal(
      row.report.sourceFingerprint,
      row.report.finalSourceFingerprint,
    );
    assert.equal(row.report.outcome, expected.failed ? "failed" : "passed");
    for (const key of [
      "engineSha256",
      "inventorySha256",
      "harnessSha256",
      "requirementsSha256",
      "packageManifestSha256",
    ])
      assert.ok(sha(row.code[key]));
    assert.equal(row.code.installedOutsidePackage, row.origin === "installed");
    assert.ok(
      sha(row.node.sha256) &&
        Number.isSafeInteger(row.node.bytes) &&
        row.node.bytes > 0,
    );
    const parent = await realpath(os.tmpdir()),
      temporary = await realpath(
        await mkdtemp(path.join(parent, "checktrail-clang-data-")),
      );
    try {
      const names = new Set();
      let total = 0;
      for (const file of row.before) {
        assert.ok(
          typeof file.path === "string" &&
            file.path
              .split("/")
              .every((part) => part && part !== "." && part !== "..") &&
            !/[\\:\0]/.test(file.path),
        );
        assert.equal(path.isAbsolute(file.path), false);
        assert.equal(names.has(file.path), false);
        names.add(file.path);
        const bytes = Buffer.from(file.base64, "base64");
        assert.equal(bytes.toString("base64"), file.base64);
        assert.equal(bytes.length, file.bytes);
        assert.equal(hash(bytes), file.sha256);
        total += bytes.length;
        assert.ok(bytes.length <= 4 * 1048576 && total <= 64 * 1048576);
        const target = path.join(temporary, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      }
      for (const [index, check] of row.checks.entries()) {
        const reference = row.attempts[index],
          item = [...records.values()].find(
            (item) => item.file === reference.file,
          );
        assert.ok(item, "Missing selected Clang retained process");
        assert.deepEqual(reference, {
          file: item.file,
          bytes: item.bytes,
          sha256: item.sha256,
        });
        const value = item.value;
        assert.equal(
          used.has(value.attemptId),
          false,
          "Selected Clang attempt reused",
        );
        used.add(value.attemptId);
        for (const key of [
          "witnessId",
          "variant",
          "origin",
          "phase",
          "scenario",
        ])
          assert.equal(value[key], row[key]);
        assert.equal(value.checkIndex, index);
        assert.equal(value.checkId, check.id);
        assert.equal(check.commands.length, 1);
        const result = decodeResult(value);
        assert.deepEqual(result.command, check.commands[0]);
        const parsed = cppExtensionsPacketSchema.parse(
          JSON.parse(result.stdout),
        );
        assert.equal(parsed.config.clangVersion, "22.1.3");
        assert.equal(parsed.config.cmakeVersion, "4.2.3");
        assert.equal(parsed.config.makeVersion, "4.4.1");
        assert.equal(parsed.config.binutilsVersion, "2.45.1");
        assert.equal(parsed.config.platform, "aarch64-alpine-linux-musl");
        assert.equal(
          parsed.sdkBeforeSha256,
          hash(JSON.stringify(parsed.config.sdk)),
        );
        assert.equal(parsed.sdkAfterSha256, parsed.sdkBeforeSha256);
        sdkIdentities.push(parsed.sdkBeforeSha256);
        assert.deepEqual(
          parsed.tools.map((tool) => tool.name),
          [...cppExtensionsToolNames],
        );
        toolIdentities.push(hash(JSON.stringify(parsed.tools)));
        const evidence = cppExtensionsEvidence(check, [result], temporary);
        const failed = expected.failed && check.id === "cpp.ctest-extensions";
        assert.equal(
          evidence.status,
          failed ? "failed" : "passed",
          evidence.reason,
        );
        assert.deepEqual(row.report.checks[index], {
          id: check.id,
          status: evidence.status,
          tests: evidence.tests ?? null,
        });
        if (check.id === "cpp.ctest-extensions")
          assert.deepEqual(evidence.tests, {
            total: 2,
            passed: failed ? 0 : 2,
            failed: failed ? 2 : 0,
            skipped: 0,
          });
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  assert.equal(
    used.size,
    records.size,
    "Unreferenced selected Clang failed or incomplete attempts",
  );
  assert.ok(
    new Set(toolIdentities).size <= 1,
    "Selected Clang tools changed across original scenarios",
  );
  assert.ok(
    new Set(sdkIdentities).size <= 1,
    "Selected Clang SDK changed across original scenarios",
  );
  const missing = selectedClangWitnessScenarios.flatMap((scope) =>
    origins.flatMap((origin) =>
      reached.has(address({ ...scope, origin }))
        ? []
        : [
            {
              variant: scope.variant,
              origin,
              phase: scope.phase,
              scenario: scope.scenario,
            },
          ],
    ),
  );
  const unqualified = [];
  if (!binding)
    unqualified.push("actual-selected-OCI-controller-binding-missing");
  else {
    assert.match(binding.imageId, /^sha256:[a-f0-9]{64}$/);
    assert.ok(sha(binding.definitionSha256) && sha(binding.sdkPinsSha256));
    assert.equal(binding.hostAttestationPerformed, false);
    assert.equal(binding.wholeRuntimeClosureVerified, false);
    for (const digest of sdkIdentities)
      assert.equal(
        digest,
        binding.sdkPinsSha256,
        "Selected Clang native SDK differs from actual prepared controller",
      );
    assert.equal(binding.runtime.node, "22.23.2");
    assert.equal(binding.runtime.platform, "linux");
    assert.equal(binding.runtime.architecture, "arm64");
    assert.ok(sha(binding.runtime.nodeSha256));
    for (const row of reached.values()) {
      assert.deepEqual(row.runtime, {
        node: binding.runtime.node,
        platform: binding.runtime.platform,
        architecture: binding.runtime.architecture,
        hostAttestationPerformed: false,
      });
      assert.equal(row.node.sha256, binding.runtime.nodeSha256);
    }
    for (const row of reached.values())
      for (const key of [
        "engineSha256",
        "inventorySha256",
        "harnessSha256",
        "requirementsSha256",
        "packageManifestSha256",
      ])
        assert.equal(
          row.code[key],
          binding.code[key],
          "Selected Clang controller code identity differs",
        );
  }
  for (const scope of selectedClangWitnessScenarios) {
    const pair = origins.map((origin) =>
      reached.get(address({ ...scope, origin })),
    );
    if (pair.every(Boolean)) {
      for (const key of [
        "engineSha256",
        "inventorySha256",
        "harnessSha256",
        "requirementsSha256",
        "packageManifestSha256",
      ])
        assert.equal(
          pair[0].code[key],
          pair[1].code[key],
          "Selected Clang source/fresh code differs",
        );
      assert.deepEqual(
        pair[0].node,
        pair[1].node,
        "Selected Clang source/fresh Node differs",
      );
    }
  }
  return {
    schemaVersion: 1,
    profile: "selected-clang-producer-consumer-witnesses-v1",
    requiredWitnesses: 6,
    requiredObservations: selectedClangWitnessScenarios.length * 2,
    observations: collection.observations.length,
    attemptRecords: records.size,
    missing,
    unqualified,
    complete: missing.length === 0 && unqualified.length === 0,
    compiler: "22.1.3",
    supplementaryGccQualifies: false,
    hostAttestationPerformed: false,
    wholeRuntimeClosureVerified: false,
    gateAComplete: false,
  };
}
export async function selectedClangControllerBinding(
  root,
  imageId,
  prepared,
  runtime,
) {
  assert.equal(await realpath(root), await realpath(moduleRoot));
  assert.equal(imageId, prepared.image);
  const sdk = JSON.parse(
    await readFile(
      path.join(root, ".checktrail/cpp-extensions-runtime/sdk.json"),
      "utf8",
    ),
  );
  assert.equal(sdk.pinsSha256, hash(JSON.stringify(sdk.pins)));
  assert.equal(prepared.sdkPinsSha256, sdk.pinsSha256);
  assert.equal(prepared.wholeRuntimeClosureVerified, false);
  return {
    imageId,
    runtime,
    definitionSha256: hash(
      await readFile(
        path.join(root, "scripts/verify-cpp-extensions-container.mjs"),
      ),
    ),
    sdkPinsSha256: sdk.pinsSha256,
    code: await captureSelectedClangConsumerCode(),
    hostAttestationPerformed: false,
    wholeRuntimeClosureVerified: false,
  };
}
export function requireSelectedClangConsumerWitnesses(report) {
  assert.equal(
    report.complete,
    true,
    "Selected Clang original source/fresh producer/consumer witnesses remain incomplete",
  );
  return report;
}

/** Successful raw packets remain in private operator storage; final CI output contains only the verified receipt. */
export async function persistSelectedClangConsumerPacket(packet) {
  const bytes = Buffer.from(JSON.stringify(packet) + "\n");
  assert.ok(
    bytes.length <= 288 * 1048576,
    "Selected Clang combined packet exceeds bound",
  );
  const parent = await consumerWitnessCaptureParent(
    process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT,
  );
  const directory = await realpath(
    await mkdtemp(path.join(parent, "checktrail-clang-receipt-")),
  );
  const identity = await privateDirectory(
    directory,
    await realpath(moduleRoot),
  );
  const filename = path.join(directory, "packet.json"),
    fd = await open(filename, "wx", 0o600);
  try {
    await fd.writeFile(bytes);
    await fd.sync();
  } finally {
    await fd.close();
  }
  assert.deepEqual(
    await privateDirectory(directory, await realpath(moduleRoot)),
    identity,
  );
  const stat = await lstat(filename);
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.nlink, 1);
  const observed = await physical(filename, 288 * 1048576);
  assert.equal(observed.bytes, bytes.length);
  assert.equal(observed.sha256, hash(bytes));
  return {
    profile: "private-selected-clang-consumer-packet-v1",
    path: filename,
    bytes: observed.bytes,
    sha256: observed.sha256,
    hostAttestationPerformed: false,
    gateAComplete: false,
  };
}

/** Derive the complete frozen callback denominator from both declarations. */
export async function selectSelectedClangRequirements(root) {
  const inventory = JSON.parse(
    await readFile(path.join(root, "docs/gate-a-profiles.v1.json"), "utf8"),
  );
  const profiles = JSON.parse(
    await readFile(
      path.join(root, "scripts/required-native-tests.json"),
      "utf8",
    ),
  );
  const matches = inventory.extensionProfiles.filter(
    (profile) => profile.id === "cpp-extensions",
  );
  assert.equal(matches.length, 1);
  const selected = matches[0];
  assert.equal(selected.runtime, "native-linux-arm64-node22");
  assert.equal(
    selected.acceptanceFile,
    "dist/test/gate-cpp-extensions.test.js",
  );
  const fileFor = (row) =>
    row.id === "privacy"
      ? "dist/test/cpp-extensions-surfaces.test.js"
      : row.id === "lifecycle"
        ? "dist/test/cpp-extensions-cancel.test.js"
        : selected.acceptanceFile;
  const expected = selected.acceptanceCases.map((row) => ({
    file: fileFor(row),
    name: row.name,
  }));
  expected.push({
    file: selected.acceptanceFile,
    name: "cpp-extensions compiler formatter analyzer acceptance",
  });
  assert.ok(
    expected.length > 0 &&
      expected.length <= 64 &&
      new Set(expected.map((row) => JSON.stringify(row))).size ===
        expected.length,
  );
  const sorted = (rows) => rows.map((row) => JSON.stringify(row)).sort();
  assert.deepEqual(
    sorted(profiles["cpp-extensions"]),
    sorted(expected),
    "Original selected Clang callback inventory differs",
  );
  return profiles["cpp-extensions"].map((row) => ({ ...row }));
}
