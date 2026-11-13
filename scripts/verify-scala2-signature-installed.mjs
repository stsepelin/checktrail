import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { parseAllDocuments } from "yaml";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { kotlinRead } from "../dist/src/kotlin-io.js";
import {
  scala2ReleaseSignature,
  scala2ReleaseArchiveFilename,
} from "../dist/src/scala2-release-signature.js";
import { scala2Artifacts } from "../dist/src/scala2-artifacts.js";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const hash = (body) => createHash("sha256").update(body).digest("hex");
const runtimeModules = [
  "scala.js",
  "scala2.js",
  "scala2-runner.js",
  "scala2-evidence.js",
  "scala2-release-signature.js",
  "release-signature-proof.js",
];
const caseOutcomes = {
  "qualified-broken": { status: "failed", packetVersion: 2 },
  "qualified-fixed": { status: "passed", packetVersion: 2 },
  "legacy-fixed": { status: "passed", packetVersion: 1 },
  "operator-capture-request-collision-borrowed-pin-packet-and-physical-afterchecks":
    { passed: true },
  "actual-runner-refuses-coherent-wrong-policy": { passed: true },
  "cli-fixed": { exitCode: 0 },
  "cli-broken": { exitCode: 1 },
  "mcp-cannot-promote-authority-and-private-summary": { passed: true },
};
export function validateScala2SignatureCases(value) {
  assert.deepEqual(Object.keys(value).sort(), [
    "requiredCaseIds",
    "schemaVersion",
  ]);
  assert.equal(value.schemaVersion, 1);
  assert.ok(
    Array.isArray(value.requiredCaseIds) && value.requiredCaseIds.length > 0,
  );
  assert.deepEqual(value.requiredCaseIds, Object.keys(caseOutcomes));
  return value;
}
export function parseScala2SignatureCases(text) {
  assert.equal(typeof text, "string");
  assert.ok(
    Buffer.byteLength(text) > 0 && Buffer.byteLength(text) <= 16 * 1024,
  );
  const value = JSON.parse(text),
    documents = parseAllDocuments(text, {
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
    });
  assert.ok(
    documents.length === 1 &&
      !documents[0].errors.length &&
      !documents[0].warnings.length,
    "Signature case manifest JSON is ambiguous",
  );
  return validateScala2SignatureCases(value);
}
export async function readScala2SignatureCases() {
  const body = await kotlinRead(
    fileURLToPath(
      new URL("./scala2-signature-native-cases.v1.json", import.meta.url),
    ),
    16 * 1024,
  );
  const manifest = parseScala2SignatureCases(body.toString("utf8"));
  return { ...manifest, sha256: hash(body) };
}
export function validateScala2SignatureNativeReceipt(
  value,
  expectedRoot,
  cases,
) {
  validateScala2SignatureCases({
    schemaVersion: cases.schemaVersion,
    requiredCaseIds: cases.requiredCaseIds,
  });
  assert.deepEqual(Object.keys(value).sort(), [
    "cases",
    "fullClosureVerified",
    "gateAComplete",
    "packageRoot",
    "state",
  ]);
  assert.equal(value.state, "complete-scoped-native-chain");
  assert.equal(value.packageRoot, expectedRoot);
  assert.equal(value.fullClosureVerified, false);
  assert.equal(value.gateAComplete, false);
  assert.deepEqual(
    value.cases,
    cases.requiredCaseIds.map((id) => ({ id, ...caseOutcomes[id] })),
  );
  return value;
}
export function validateScala2SignatureInstalledReceipt(value, cases) {
  assert.equal(value.state, "complete-scoped-installed-native-chain");
  assert.equal(value.caseManifestSha256, cases.sha256);
  assert.equal(value.keyOwnerTrustEstablished, false);
  assert.equal(value.keyValidityAssessed, false);
  assert.equal(value.distributionSignatureVerified, false);
  assert.equal(value.installation.offlineProductionInstall, true);
  assert.equal(value.installation.lifecycleScriptsExecuted, false);
  assert.match(
    value.installation.productionDependencyLockSha256,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(value.harnessOutsideInstalledPackage, true);
  assert.equal(value.installedRuntimeEvaluated, true);
  assert.equal(value.installedCliEvaluated, true);
  assert.equal(value.installedMcpEvaluated, true);
  assert.equal(value.complete, true);
  assert.equal(value.fullArtifactClosureClaimed, false);
  assert.equal(value.gateAComplete, false);
  assert.deepEqual(
    value.matchingRuntimeModules.map((row) => row.name),
    runtimeModules,
  );
  for (const row of value.matchingRuntimeModules) {
    assert.ok(Number.isSafeInteger(row.bytes) && row.bytes > 0);
    assert.match(row.sha256, /^[a-f0-9]{64}$/);
  }
  validateScala2SignatureNativeReceipt(
    value.native,
    value.installedPackage,
    cases,
  );
  return value;
}
async function observeRuntime(installed) {
  const observed = [];
  for (const name of runtimeModules) {
    const source = await kotlinRead(
        path.join(repository, "dist/src", name),
        1024 * 1024,
      ),
      target = await kotlinRead(
        path.join(installed, "dist/src", name),
        1024 * 1024,
      );
    assert.deepEqual(target, source, "Installed runtime differs: " + name);
    observed.push({ name, bytes: source.length, sha256: hash(source) });
  }
  return observed;
}
export async function verifyScala2SignatureInstalled(qualified, pin) {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "arm64");
  assert.ok(path.isAbsolute(qualified));
  assert.equal(await realpath(qualified), qualified);
  const archive = path.join(qualified, scala2ReleaseArchiveFilename);
  const reference = scala2ReleaseSignature(
    archive,
    await kotlinRead(archive, scala2Artifacts.archiveBytes),
    pin,
  );
  assert.ok(reference);
  const cases = await readScala2SignatureCases(),
    cache = process.env.npm_config_cache;
  assert.ok(
    cache && path.isAbsolute(cache),
    "Select an owned prepared offline npm cache",
  );
  assert.equal(await realpath(cache), cache);
  const temporary = await mkdtemp(
    path.join(tmpdir(), "scala2-signature-installed-"),
  );
  try {
    const packed = JSON.parse(
      runAcceptanceNpm(
        ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
        { cwd: repository, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      ),
    );
    assert.equal(packed.length, 1);
    assert.equal(path.basename(packed[0].filename), packed[0].filename);
    const tarball = path.join(temporary, packed[0].filename),
      consumer = path.join(temporary, "consumer");
    const installation = await installAcceptancePackage(
      repository,
      tarball,
      consumer,
      { cache },
    );
    const manifest = JSON.parse(
      await readFile(path.join(repository, "package.json"), "utf8"),
    );
    const installed = await realpath(
      path.join(consumer, "node_modules", manifest.name),
    );
    const before = await observeRuntime(installed);
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("./verify-scala2-signature-native.mjs", import.meta.url),
        ),
        installed,
        qualified,
        pin,
      ],
      { encoding: "utf8", timeout: 1200000, maxBuffer: 4 * 1024 * 1024 },
    );
    process.stderr.write(result.stderr ?? "");
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const native = validateScala2SignatureNativeReceipt(
      JSON.parse(result.stdout),
      installed,
      cases,
    );
    assert.deepEqual(
      await observeRuntime(installed),
      before,
      "Runtime changed during installed controls",
    );
    scala2ReleaseSignature(
      archive,
      await kotlinRead(archive, scala2Artifacts.archiveBytes),
      pin,
    );
    const body = await readFile(tarball);
    const receipt = {
      schemaVersion: 1,
      state: "complete-scoped-installed-native-chain",
      installation,
      tarball: { bytes: body.length, sha256: hash(body) },
      installedPackage: installed,
      matchingRuntimeModules: before,
      caseManifestSha256: cases.sha256,
      native,
      harnessOutsideInstalledPackage: true,
      installedRuntimeEvaluated: true,
      installedCliEvaluated: true,
      installedMcpEvaluated: true,
      complete: true,
      fullArtifactClosureClaimed: false,
      keyOwnerTrustEstablished: false,
      keyValidityAssessed: false,
      distributionSignatureVerified: false,
      gateAComplete: false,
    };
    return validateScala2SignatureInstalledReceipt(receipt, cases);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  assert.equal(
    process.argv.length,
    4,
    "Pass the qualified cohort root and selected proof SHA-256",
  );
  process.stdout.write(
    JSON.stringify(
      await verifyScala2SignatureInstalled(process.argv[2], process.argv[3]),
    ) + "\n",
  );
}
