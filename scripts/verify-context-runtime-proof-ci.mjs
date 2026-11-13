import assert from "node:assert/strict";
import profiles from "./required-native-tests.json" with { type: "json" };
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { realpathSync, lstatSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { selectedContextRuntimeProof } from "../dist/src/context-runtime-proof.js";
import {
  contextRuntimeAttestationPolicy as policy,
  parseContextAttestationJson,
} from "../dist/src/context-runtime-attestation.js";

export function assertContextRequiredReceipt(report) {
  assert.equal(report.profile, "context-runtime-proof");
  assert.equal(report.required, 29);
  assert.equal(report.passed, 29);
  assert.equal(report.complete, true);
  assert.deepEqual(report.problems, []);
  assert.equal(report.ledger.truncated, false);
  assert.equal(report.ledger.terminalEventCount, 29);
  assert.equal(report.ledger.events.length, 29);
  assert.equal(report.ledger.cases.length, 29);
  for (const event of report.ledger.events)
    assert.equal(
      event.outcome,
      "passed",
      "Skipped or failed context proof event",
    );
  for (const item of report.ledger.cases) {
    assert.equal(item.outcome, "passed");
    assert.equal(item.terminalSequences.length, 1);
  }
  assert.equal(
    new Set(
      report.ledger.cases.map((item) =>
        JSON.stringify([item.fileId, item.name]),
      ),
    ).size,
    29,
  );
  assert.deepEqual(
    report.ledger.cases.map((item) => item.name).sort(),
    profiles["context-runtime-proof"].map((item) => item.name).sort(),
  );
}
export function assertContextPackageReceipt(report) {
  assert.equal(report.state, "passed-context-runtime-proof-package");
  assert.equal(report.sourceCohorts, 6);
  assert.equal(report.installedCohorts, 6);
  assert.equal(report.cohorts.length, 12);
  assert.equal(report.modelCalls, 0);
  const states = [
    "passed-all-qualified-parser-families",
    "passed-qualified-vb-mixed-boundary",
    "passed-warm-cache-physical-guard",
    "passed-final-context-proof-admission",
    "passed-context-proof-transports",
    "passed-context-proof-authority",
  ];
  assert.equal(
    new Set(report.cohorts.map((row) => JSON.stringify([row.mode, row.state])))
      .size,
    12,
  );
  for (const mode of ["source", "installed"])
    assert.deepEqual(
      report.cohorts
        .filter((row) => row.mode === mode)
        .map((row) => row.state)
        .sort(),
      [...states].sort(),
    );
  for (const row of report.cohorts) assert.equal(row.modelCalls, 0);
  for (const field of [
    "fullProducerBuildClosureVerified",
    "completeLicenseClosureVerified",
    "gateAComplete",
  ])
    assert.equal(report[field], false, field);
  assert.equal(report.compiledEngine.sourceInstalledByteIdentitiesMatch, true);
  assert.equal(report.compiledEngine.sourceBeforeAfterMatch, true);
  assert.equal(report.compiledEngine.installedBeforeAfterMatch, true);
  assert.equal(report.compiledEngine.actualModuleLoadsTraced, false);
  assert.ok(
    report.compiledEngine.fileCount > 0 && report.compiledEngine.bytes > 0,
  );
  assert.equal(report.harnessInputsUnchanged, true);
}
export async function verifyContextRuntimeProofCi() {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const root = process.env.CHECKTRAIL_CONTEXT_RUNTIME_PROOF_CI_ROOT;
  assert.ok(
    root &&
      path.isAbsolute(root) &&
      realpathSync(root) === root &&
      lstatSync(root).isDirectory(),
    "Owned canonical CI result directory required",
  );
  const proof = selectedContextRuntimeProof();
  assert.ok(proof, "Explicit startup proof required for native context CI");
  const manifestRows = [
    ["assets/context-grammars/manifest.json", policy.grammarManifestSha256],
    [
      "assets/context-grammars/runtime-manifest.json",
      policy.runtimeManifestSha256,
    ],
    ["assets/context-vb-grammar/manifest.json", policy.vbGrammarManifestSha256],
  ];
  const manifests = async () =>
    Promise.all(
      manifestRows.map(async ([file, sha256]) => {
        const raw = await readFile(path.join(repository, file));
        assert.equal(createHash("sha256").update(raw).digest("hex"), sha256);
        return { file, bytes: raw.length, sha256 };
      }),
    );
  const before = await manifests();
  const run = (file, args = []) => {
    const raw = execFileSync(process.execPath, [file, ...args], {
      cwd: repository,
      env: process.env,
      timeout: 600000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseContextAttestationJson(raw);
  };
  const native = run("scripts/verify-required-native-tests.mjs", [
    "context-runtime-proof",
  ]);
  assertContextRequiredReceipt(native);
  const installed = run("scripts/verify-context-runtime-proof-package.mjs");
  assertContextPackageReceipt(installed);
  assert.deepEqual(await manifests(), before);
  assert.deepEqual(selectedContextRuntimeProof(), proof);
  const result = {
    schemaVersion: 1,
    state: "passed-context-runtime-proof-ci",
    proof,
    sourceManifestPins: before,
    requiredNative: native,
    package: installed,
    modelCalls: 0,
    fullProducerBuildClosureVerified: false,
    grammarSignaturesVerified: false,
    completeLicenseClosureVerified: false,
    ownerCurrentStatusVerified: false,
    gateAComplete: false,
  };
  await writeFile(
    path.join(root, "RESULT.v1.json"),
    JSON.stringify(result) + "\n",
    { flag: "wx", mode: 0o400 },
  );
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  process.stdout.write(
    JSON.stringify(await verifyContextRuntimeProofCi()) + "\n",
  );
