import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { runRequiredTests } from "./required-test-evidence.mjs";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (b) => createHash("sha256").update(b).digest("hex");
const defaultProfileId = "multi-candidate-workflow";
export function reviewRuntimeProfile(profileId = defaultProfileId) {
  assert.ok(
    [defaultProfileId, "confidence-provenance"].includes(profileId),
    "Unknown selected review runtime profile",
  );
  const confidence = profileId === "confidence-provenance";
  return {
    id: profileId,
    receiptProfile: profileId + "-runtime-v1",
    acceptanceFile: "dist/test/gate-" + profileId + ".test.js",
    fixtures: [
      confidence
        ? "dist/test/confidence-provenance-fixture.js"
        : "dist/test/review-workflow-findings-fixture.js",
      "dist/test/review-workflow-fixture.js",
      "dist/test/helpers.js",
      "dist/test/tool-fixture.js",
    ],
    installedVariable: confidence
      ? "CHECKTRAIL_CONFIDENCE_PROVENANCE_INSTALLED"
      : "CHECKTRAIL_MULTI_WORKFLOW_INSTALLED",
    receiptVariable: confidence
      ? "CHECKTRAIL_CONFIDENCE_PROVENANCE_INSTALL_RECEIPT"
      : "CHECKTRAIL_MULTI_WORKFLOW_INSTALL_RECEIPT",
    slotVariable: confidence
      ? "CHECKTRAIL_CONFIDENCE_RUNTIME_SLOT"
      : "CHECKTRAIL_REVIEW_RUNTIME_SLOT",
  };
}
export function selectReviewRuntimeRequirements(
  profiles,
  scope,
  profileId = defaultProfileId,
) {
  const configuration = reviewRuntimeProfile(profileId);
  const selected = scope.extensionProfiles.filter((p) => p.id === profileId);
  assert.equal(
    selected.length,
    1,
    "Unique selected review workflow profile required",
  );
  const p = selected[0];
  assert.equal(p.runtime, "engine-matrix");
  assert.equal(p.acceptanceFile, configuration.acceptanceFile);
  const kinds = [
    "broken",
    "fixed",
    "near-miss",
    "prerequisite",
    "stale",
    "empty",
    "privacy",
    "lifecycle",
    "installed",
  ];
  assert.deepEqual(
    p.acceptanceCases.map((c) => [c.id, c.name]),
    kinds.map((k) => [k, profileId + " " + k + " acceptance"]),
  );
  const requirements = p.acceptanceCases.map((c) => ({
    file: p.acceptanceFile,
    name: c.name,
  }));
  assert.deepEqual(
    profiles[profileId],
    requirements,
    "Frozen whole-workflow bindings changed",
  );
  return requirements;
}
/** Observed identities are not independently authenticated host or container attestations. */
export function checkReviewRuntimeSelection(
  scope,
  slot,
  observed,
  requireHostedIdentity = false,
) {
  assert.equal(typeof requireHostedIdentity, "boolean");
  if (slot === null) {
    assert.equal(
      requireHostedIdentity,
      false,
      "Hosted workflow requires a selected runtime slot",
    );
    return null;
  }
  const matches = scope.runtimeProfiles.filter((p) => p.id === slot);
  assert.equal(matches.length, 1, "Unknown selected runtime slot");
  const selected = matches[0];
  for (const key of ["platform", "architecture", "node"])
    assert.equal(
      observed[key],
      selected[key],
      "Selected runtime " + key + " differs",
    );
  if (selected.platform === "darwin") {
    assert.match(
      observed.osRelease,
      /^25\./,
      "Selected macOS 26 kernel differs",
    );
    if (slot !== "native-linux-arm64-node22" || requireHostedIdentity)
      assert.equal(
        observed.imageOS,
        "macos26",
        "Selected hosted macOS image family differs",
      );
  } else if (selected.platform === "win32") {
    assert.match(
      observed.osVersion,
      /^Windows Server 2025 (?:Datacenter|Standard)$/,
      "Selected Windows Server family differs",
    );
    assert.match(
      observed.osRelease,
      /^10\.0\.26100$/,
      "Selected Windows Server kernel differs",
    );
    if (slot !== "native-linux-arm64-node22" || requireHostedIdentity)
      assert.match(
        observed.imageOS,
        /^win25(?:-vs2026)?$/,
        "Selected hosted Windows image family differs",
      );
  } else if (selected.architecture === "x64") {
    assert.equal(
      observed.distributionId,
      "ubuntu",
      "Selected Linux distribution differs",
    );
    assert.equal(
      observed.distributionVersion,
      "24.04",
      "Selected Linux distribution version differs",
    );
    if (slot !== "native-linux-arm64-node22" || requireHostedIdentity)
      assert.equal(
        observed.imageOS,
        "ubuntu24",
        "Selected hosted Linux image family differs",
      );
  } else {
    assert.equal(slot, "native-linux-arm64-node22");
    assert.match(
      observed.containerImageId ?? "",
      /^sha256:[a-f0-9]{64}$/,
      "Pinned native container image identity required",
    );
  }
  if (slot !== "native-linux-arm64-node22" || requireHostedIdentity)
    assert.match(
      observed.imageVersion ?? "",
      /^20\d{6}\.\d+\.\d+$/,
      "Observed hosted image version required",
    );
  return selected;
}
export function requireReviewRuntimeCases(
  evidence,
  requirements,
  acceptanceSha256,
) {
  assert.equal(evidence.complete, true);
  assert.equal(evidence.required, 9);
  assert.equal(evidence.passed, 9);
  assert.deepEqual(evidence.problems, []);
  const ledger = evidence.ledger;
  assert.equal(ledger.truncated, false);
  assert.equal(ledger.terminalEventCount, 9);
  assert.equal(ledger.events.length, 9);
  assert.equal(ledger.cases.length, 9);
  assert.equal(ledger.files.length, 1);
  const file = ledger.files[0];
  assert.equal(file.stable, true);
  assert.deepEqual(file.before, { state: "present", sha256: acceptanceSha256 });
  assert.deepEqual(file.after, file.before);
  const events = new Map();
  for (const event of ledger.events) {
    assert.equal(event.fileId, file.id);
    assert.equal(event.kind, "test");
    assert.equal(event.outcome, "passed");
    assert.equal(event.required, true);
    assert.equal(event.nameTruncated, false);
    assert.ok(Number.isSafeInteger(event.sequence));
    assert.ok(event.sequence >= 1 && event.sequence <= 9);
    assert.equal(events.has(event.sequence), false);
    events.set(event.sequence, event);
  }
  for (const item of ledger.cases) {
    assert.equal(item.fileId, file.id);
    assert.equal(item.outcome, "passed");
    assert.equal(item.terminalSequences.length, 1);
    assert.equal(events.get(item.terminalSequences[0])?.name, item.name);
  }
  assert.deepEqual(
    ledger.cases.map((c) => c.name).sort(),
    requirements.map((c) => c.name).sort(),
  );
}
export function requireReviewRuntimeInstallation(receipt, expected) {
  assert.equal(receipt.offlineProductionInstall, true);
  assert.equal(receipt.lifecycleScriptsExecuted, false);
  assert.equal(receipt.harnessOutsideInstalledPackage, true);
  assert.equal(receipt.profile.complete, true);
  assert.equal(receipt.profile.required, 9);
  assert.equal(receipt.profile.passed, 9);
  assert.equal(
    receipt.profile.compiledEngine.beforeAfterByteIdentitiesMatch,
    true,
  );
  assert.equal(
    receipt.profile.compiledEngine.treeSha256,
    expected.engine.treeSha256,
  );
  assert.equal(
    receipt.profile.compiledEngine.manifestSha256,
    expected.engine.manifestSha256,
  );
  const qualified =
    expected.runtime.slot !== null ||
    expected.profileId === "confidence-provenance";
  if (expected.profileId) {
    requireReviewRuntimeCases(
      receipt.profile,
      expected.requirements,
      expected.acceptanceSha256,
    );
    if (qualified) {
      for (const key of [
        "tarballSha256",
        "harnessSha256",
        "productionDependencyLockSha256",
      ])
        assert.match(receipt[key] ?? "", /^[a-f0-9]{64}$/);
      assert.deepEqual(
        receipt.profile.selectedRuntime,
        expected.selectedRuntime,
      );
      assert.equal(
        receipt.profile.profile,
        reviewRuntimeProfile(expected.profileId).receiptProfile,
      );
      assert.equal(receipt.profile.installedEvidence, null);
      assert.equal(receipt.profile.inferenceInvoked, false);
      assert.equal(receipt.profile.fieldEvaluationExecuted, false);
      if (expected.profileId === "confidence-provenance") {
        assert.equal(receipt.profile.gateAComplete, false);
        assert.equal(receipt.profile.qualityAssessed, false);
      } else
        assert.equal(
          receipt.profile.gateAMultiCandidateWorkflowComplete,
          false,
        );
    } else {
      // The existing no-slot default uses the generic offline installation ledger.
      assert.equal(receipt.profile.profile, defaultProfileId);
    }
  }
  if (qualified) {
    assert.deepEqual(receipt.profile.runtime, expected.runtime);
    assert.equal(receipt.profile.harnessSha256, expected.harnessSha256);
    assert.equal(
      receipt.profile.requirementsSha256,
      expected.requirementsSha256,
    );
    assert.equal(receipt.profile.packageSha256, expected.packageSha256);
    assert.equal(
      receipt.profile.runtimeArtifactsSha256,
      expected.engine.treeSha256,
    );
  }
  return receipt;
}
let busy = false;
export async function verifyReviewRuntime({
  slot = null,
  requireHostedIdentity = process.env.GITHUB_ACTIONS === "true",
  profileId = defaultProfileId,
} = {}) {
  const configuration = reviewRuntimeProfile(profileId);
  assert.equal(busy, false, "Concurrent runtime controller is unavailable");
  busy = true;
  let temporary;
  const variables = [configuration.receiptVariable, configuration.slotVariable];
  const previous = Object.fromEntries(
    variables.map((k) => [k, process.env[k]]),
  );
  try {
    const scope = JSON.parse(
      await readFile(path.join(root, "docs/gate-a-profiles.v1.json"), "utf8"),
    );
    const profiles = JSON.parse(
      await readFile(
        path.join(root, "scripts/required-native-tests.json"),
        "utf8",
      ),
    );
    const requirements = selectReviewRuntimeRequirements(
      profiles,
      scope,
      profileId,
    );
    let distributionId = null,
      distributionVersion = null,
      distributionBytes = null;
    if (process.platform === "linux") {
      distributionBytes = await readFile("/etc/os-release");
      assert.ok(distributionBytes.length <= 16384);
      const fields = new Map(
        distributionBytes
          .toString("utf8")
          .split("\n")
          .map((line) => line.split(/=(.*)/s).slice(0, 2)),
      );
      const value = (k) => (fields.get(k) ?? "").replace(/^"(.*)"$/, "$1");
      distributionId = value("ID");
      distributionVersion = value("VERSION_ID");
    }
    const runtime = {
      slot,
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      osVersion: os.version(),
      distributionId,
      distributionVersion,
      distributionSha256: distributionBytes ? hash(distributionBytes) : null,
      imageOS: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
      containerImageId: process.env.CHECKTRAIL_REVIEW_RUNTIME_IMAGE_ID ?? null,
      nodeExecutableSha256: hash(await readFile(process.execPath)),
      hostedImageMetadataAttested: false,
      containerImageMetadataAttested: false,
    };
    const selected = checkReviewRuntimeSelection(
      scope,
      slot,
      runtime,
      requireHostedIdentity,
    );
    const files = [
      ...new Set(requirements.map((x) => x.file)),
      ...configuration.fixtures,
      "scripts/verify-import-context-package.mjs",
      "scripts/verify-review-runtime-package.mjs",
      "package-lock.json",
      "scripts/install-acceptance-package.mjs",
      "scripts/prepare-javascript-tools.mjs",
      "scripts/native-acceptance-diagnostics.mjs",
      "docs/gate-a-profiles.v1.json",
      "scripts/review-runtime-evidence.mjs",
      "scripts/verify-review-runtime.mjs",
      "scripts/compiled-engine-evidence.mjs",
      "scripts/required-test-evidence.mjs",
    ];
    const inputs = await Promise.all(
      files.map(async (f) => [f, hash(await readFile(path.join(root, f)))]),
    );
    const engineRoot = path.join(root, "dist/src");
    const before = await captureCompiledEngine(engineRoot);
    const enginePackageRoot = path.dirname(
      path.dirname(await realpath(engineRoot)),
    );
    const packageSha256 = hash(
      await readFile(path.join(enginePackageRoot, "package.json")),
    );
    const requirementsSha256 = hash(JSON.stringify(requirements));
    const harnessSha256 = hash(
      JSON.stringify({ inputs, packageSha256, requirementsSha256 }),
    );
    const source = process.env[configuration.installedVariable] !== "1";
    if (source) {
      temporary = await mkdtemp(
        path.join(os.tmpdir(), "checktrail-review-runtime-"),
      );
      process.env[configuration.receiptVariable] = path.join(
        temporary,
        "installed.json",
      );
      if (slot === null && profileId === defaultProfileId)
        delete process.env[configuration.slotVariable];
      else process.env[configuration.slotVariable] = slot ?? "--local";
    }
    const startedAt = new Date().toISOString();
    const evidence = await runRequiredTests(
      requirements.map((x) => ({ ...x, file: path.join(root, x.file) })),
      {
        timeoutMs: process.platform === "win32" ? 600000 : 300000,
        isolatedCaseWorkers: 1,
        onCaseProgress: (event) =>
          process.stderr.write(
            JSON.stringify({ profile: "review-runtime", ...event }) + "\n",
          ),
      },
    );
    const acceptanceSha256 = inputs.find(
      ([file]) => file === configuration.acceptanceFile,
    )[1];
    requireReviewRuntimeCases(evidence, requirements, acceptanceSha256);
    const compiledEngine = requireUnchangedCompiledEngine(
      before,
      await captureCompiledEngine(engineRoot),
    );
    assert.deepEqual(
      await Promise.all(
        files.map(async (f) => [f, hash(await readFile(path.join(root, f)))]),
      ),
      inputs,
    );
    assert.equal(
      hash(await readFile(process.execPath)),
      runtime.nodeExecutableSha256,
    );
    assert.equal(
      hash(await readFile(path.join(enginePackageRoot, "package.json"))),
      packageSha256,
    );
    assert.deepEqual(
      selectReviewRuntimeRequirements(
        JSON.parse(
          await readFile(
            path.join(root, "scripts/required-native-tests.json"),
            "utf8",
          ),
        ),
        scope,
        profileId,
      ),
      requirements,
    );
    if (distributionBytes)
      assert.equal(
        hash(await readFile("/etc/os-release")),
        runtime.distributionSha256,
      );
    let installedEvidence = null;
    if (source) {
      const bytes = await readFile(process.env[configuration.receiptVariable]);
      assert.ok(bytes.length <= 4 * 1048576);
      installedEvidence = JSON.parse(bytes.toString("utf8"));
      requireReviewRuntimeInstallation(installedEvidence, {
        runtime,
        engine: before,
        harnessSha256,
        requirementsSha256,
        packageSha256,
        profileId,
        selectedRuntime: selected,
        requirements,
        acceptanceSha256,
      });
    }
    return {
      schemaVersion: 1,
      profile: configuration.receiptProfile,
      ...evidence,
      startedAt,
      finishedAt: new Date().toISOString(),
      runtime,
      selectedRuntime: selected,
      runtimeArtifactsSha256: before.treeSha256,
      harnessSha256,
      inputSources: inputs,
      requirementsSha256,
      packageSha256,
      compiledEngine,
      installedEvidence,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
      ...(profileId === defaultProfileId
        ? { gateAMultiCandidateWorkflowComplete: false }
        : { gateAComplete: false, qualityAssessed: false }),
    };
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (temporary)
      await rm(temporary, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 30 : 0,
        retryDelay: 100,
      });
    busy = false;
  }
}
