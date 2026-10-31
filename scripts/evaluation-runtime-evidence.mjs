import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { attemptOutputCodeIdentity } from "./attempt-output-evidence.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import { ensureWindowsTaskAccess } from "../dist/src/windows-task-access.js";
const repository = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const profileId = "independent-evaluation-protocol";
export const evaluationRuntimeHarnessFiles = Object.freeze([
  "package.json",
  "package-lock.json",
  "docs/gate-a-profiles.v1.json",
  "scripts/evaluation-runtime-evidence.mjs",
  "scripts/verify-evaluation-runtime.mjs",
  "scripts/verify-evaluation-protocol-package.mjs",
  "scripts/evaluation-judgments.mjs",
  "scripts/evaluation-matching.mjs",
  "scripts/required-native-tests.json",
  "scripts/required-test-evidence.mjs",
  "scripts/compiled-engine-evidence.mjs",
  "scripts/attempt-output-evidence.mjs",
  "scripts/install-acceptance-package.mjs",
  "dist/test/gate-independent-evaluation-protocol.test.js",
  "dist/test/review-evaluation-matching-fixture.js",
  "dist/test/review-evaluation-judging-fixture.js",
  "dist/test/review-evaluation-artifacts-fixture.js",
  "dist/test/review-evaluation-captures-fixture.js",
  "dist/test/review-evaluation-metering-fixture.js",
  "dist/test/review-evaluation-protocol-fixture.js",
  "dist/test/windows-private-fixture.js",
  "dist/test/helpers.js",
  "dist/test/tool-fixture.js",
]);
export function selectEvaluationRuntimeRequirements(profiles, scope) {
  const selected = scope.extensionProfiles.filter((p) => p.id === profileId);
  assert.equal(selected.length, 1);
  const p = selected[0];
  assert.equal(p.runtime, "engine-matrix");
  assert.equal(
    p.acceptanceFile,
    "dist/test/gate-independent-evaluation-protocol.test.js",
  );
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
    "Frozen independent evaluation callbacks changed",
  );
  return requirements;
}
/** Match observed metadata; neither environment variables nor this comparison attest a host. */
export function checkEvaluationRuntimeSelection(
  scope,
  slot,
  observed,
  hosted = false,
) {
  assert.equal(typeof hosted, "boolean");
  if (slot === null) {
    assert.equal(hosted, false, "Hosted runtime requires a selected slot");
    return null;
  }
  const choices = scope.runtimeProfiles.filter((p) => p.id === slot);
  assert.equal(choices.length, 1, "Unknown selected runtime slot");
  const selected = choices[0];
  for (const key of ["node", "platform", "architecture"])
    assert.equal(
      observed[key],
      selected[key],
      "Selected runtime " + key + " differs",
    );
  if (selected.platform === "win32") {
    assert.match(
      observed.osVersion,
      /^Windows Server 2025 (?:Datacenter|Standard)$/,
    );
    assert.equal(observed.osRelease, "10.0.26100");
    assert.match(observed.imageOS ?? "", /^win25(?:-vs2026)?$/);
    assert.match(observed.systemPowerShellSha256 ?? "", /^[a-f0-9]{64}$/);
  } else if (selected.platform === "darwin") {
    assert.match(observed.osRelease, /^25\./);
    assert.equal(observed.imageOS, "macos26");
  } else if (selected.architecture === "x64") {
    assert.equal(observed.distributionId, "ubuntu");
    assert.equal(observed.distributionVersion, "24.04");
    assert.equal(observed.imageOS, "ubuntu24");
  } else {
    assert.equal(slot, "native-linux-arm64-node22");
    assert.equal(
      observed.containerReference,
      "docker.io/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
    );
    assert.match(observed.containerImageId ?? "", /^sha256:[a-f0-9]{64}$/);
  }
  if (slot !== "native-linux-arm64-node22" || hosted)
    assert.match(observed.imageVersion ?? "", /^20\d{6}\.\d+\.\d+$/);
  return selected;
}
const compactEngine = (full) => ({
  schemaVersion: full.schemaVersion,
  fileCount: full.fileCount,
  bytes: full.bytes,
  treeSha256: full.treeSha256,
  manifestSha256: full.manifestSha256,
  beforeAfterByteIdentitiesMatch: full.beforeAfterByteIdentitiesMatch,
  dependencyBytesCaptured: false,
  actualModuleLoadsTraced: false,
  producerSourceBuildVerified: false,
});
export function requireEvaluationTerminalCases(
  p,
  requirements,
  acceptanceSha256,
) {
  assert.match(acceptanceSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(p.complete, true, JSON.stringify(p.problems));
  assert.deepEqual(p.problems, []);
  assert.equal(p.required, 9);
  assert.equal(p.passed, 9);
  assert.equal(p.ledger.truncated, false);
  assert.equal(p.ledger.cases.length, 9);
  assert.equal(p.ledger.schemaVersion, 1);
  assert.equal(p.ledger.files.length, 1);
  const file = p.ledger.files[0];
  assert.equal(typeof file.id, "string");
  assert.ok(file.id.length > 0);
  assert.equal(file.stable, true);
  assert.deepEqual(file.before, { state: "present", sha256: acceptanceSha256 });
  assert.deepEqual(file.after, file.before);
  assert.equal(p.ledger.terminalEventCount, 9);
  assert.equal(p.ledger.events.length, 9);
  const events = new Map();
  for (const event of p.ledger.events) {
    assert.equal(event.fileId, file.id);
    assert.equal(event.kind, "test");
    assert.equal(event.outcome, "passed");
    assert.equal(event.nameTruncated, false);
    assert.equal(event.required, true);
    assert.equal(Number.isSafeInteger(event.sequence), true);
    assert.ok(event.sequence >= 1 && event.sequence <= 9);
    assert.equal(events.has(event.name), false);
    assert.equal(Number.isFinite(event.durationMs), true);
    assert.ok(event.durationMs >= 0);
    events.set(event.name, event);
  }
  assert.equal(new Set([...events.values()].map((e) => e.sequence)).size, 9);
  for (const item of p.ledger.cases) {
    assert.equal(item.fileId, file.id);
    assert.ok(events.has(item.name));
    assert.deepEqual(item.terminalSequences, [events.get(item.name).sequence]);
  }

  assert.deepEqual(
    p.ledger.cases.map((c) => [c.name, c.outcome]).sort(),
    requirements.map((c) => [c.name, "passed"]).sort(),
  );
}
export function requireEvaluationRuntimeInstallation(receipt, expected) {
  assert.equal(receipt?.schemaVersion, 1);
  assert.equal(receipt?.profile, profileId);
  assert.equal(receipt.offlineProductionInstall, true);
  assert.equal(receipt.lifecycleScriptsExecuted, false);
  assert.equal(receipt.harnessOutsideInstalledPackage, true);
  assert.match(receipt.tarballSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(receipt.productionDependencyLockSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(receipt.harnessSha256, expected.harnessSha256);
  assert.equal(receipt.compiledCodeSha256, expected.compiledCodeSha256);
  for (const key of [
    "node",
    "platform",
    "architecture",
    "nodeExecutableSha256",
  ])
    assert.equal(receipt[key], expected.runtime[key]);
  assert.equal(
    receipt.externalSdkClientDependencies?.["@modelcontextprotocol/client"],
    expected.clientVersion,
  );
  const evidence = receipt.runtimeEvidence;
  assert.ok(evidence);
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.profile, "independent-evaluation-runtime-v1");
  assert.deepEqual(evidence.selectedRuntime, expected.selectedRuntime);
  assert.equal(evidence.installed, true);
  assert.equal(evidence.installedEvidence, null);
  for (const key of [
    "runtime",
    "harnessSha256",
    "requirementsSha256",
    "packageSha256",
    "acceptanceSha256",
  ])
    assert.deepEqual(
      evidence[key],
      expected[key],
      "Installed " + key + " changed",
    );
  assert.deepEqual(
    evidence.compiledEngine,
    expected.compiledEngine,
    "Installed compiled engine changed",
  );
  for (const p of [receipt.profileEvidence, evidence.profileEvidence])
    requireEvaluationTerminalCases(
      p,
      expected.requirements,
      expected.acceptanceSha256,
    );
  assert.equal(evidence.inferenceInvoked, false);
  assert.equal(evidence.fieldEvaluationExecuted, false);
  assert.equal(evidence.gateAComplete, false);
}
let busy = false;
export async function verifyEvaluationRuntime({
  root = repository,
  slot = null,
  hosted = process.env.GITHUB_ACTIONS === "true",
  installed = false,
} = {}) {
  assert.equal(busy, false, "Runtime verification already active");
  busy = true;
  const keys = [
    "CHECKTRAIL_EVAL_RUNTIME_ACTIVE",
    "CHECKTRAIL_EVAL_RUNTIME_SLOT",
    "CHECKTRAIL_EVAL_RUNTIME_RECEIPT",
  ];
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  let temporary;
  try {
    const scope = JSON.parse(
      await readFile(path.join(root, "docs/gate-a-profiles.v1.json"), "utf8"),
    );
    const requirements = selectEvaluationRuntimeRequirements(
      JSON.parse(
        await readFile(
          path.join(root, "scripts/required-native-tests.json"),
          "utf8",
        ),
      ),
      scope,
    );
    assert.equal(
      installed,
      process.env.CHECKTRAIL_EVALUATION_PROTOCOL_INSTALLED === "1",
    );
    let distributionBytes = null,
      distributionId = null,
      distributionVersion = null;
    if (process.platform === "linux") {
      distributionBytes = await readFile("/etc/os-release");
      const text = distributionBytes.toString("utf8"),
        value = (name) => {
          const m = text.match(
            new RegExp("^" + name + '=(?:"([^"\\n]*)"|([^\\n]*))$', "m"),
          );
          return m ? (m[1] ?? m[2]) : null;
        };
      distributionId = value("ID");
      distributionVersion = value("VERSION_ID");
    }
    let systemPowerShellSha256 = null;
    if (process.platform === "win32") {
      const selected = path.win32.join(
        process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      );
      const canonical = await realpath(selected);
      assert.equal(canonical.toLowerCase(), selected.toLowerCase());
      systemPowerShellSha256 = hash(await readFile(canonical));
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
      containerReference:
        process.env.CHECKTRAIL_EVAL_RUNTIME_IMAGE_REFERENCE ?? null,
      containerImageId: process.env.CHECKTRAIL_EVAL_RUNTIME_IMAGE_ID ?? null,
      nodeExecutableSha256: hash(await readFile(process.execPath)),
      systemPowerShellSha256,
      hostedImageMetadataAttested: false,
      containerImageMetadataAttested: false,
    };
    const selectedRuntime = checkEvaluationRuntimeSelection(
      scope,
      slot,
      runtime,
      hosted,
    );
    const inputs = await Promise.all(
      evaluationRuntimeHarnessFiles.map(async (f) => [
        f,
        hash(await readFile(path.join(root, f))),
      ]),
    );
    const acceptanceSha256 = inputs.find(
      ([file]) => file === requirements[0].file,
    )?.[1];
    const harnessSha256 = hash(JSON.stringify(inputs)),
      requirementsSha256 = hash(JSON.stringify(requirements)),
      engineRoot = path.join(root, "dist/src"),
      before = await captureCompiledEngine(engineRoot);
    const compiledCodeSha256 = await attemptOutputCodeIdentity(root);
    const clientVersion = JSON.parse(
      await readFile(path.join(root, "package-lock.json"), "utf8"),
    ).packages["node_modules/@modelcontextprotocol/client"].version;
    const packageFile = path.join(
        path.dirname(path.dirname(await realpath(engineRoot))),
        "package.json",
      ),
      packageSha256 = hash(await readFile(packageFile));
    if (!installed) {
      temporary = await mkdtemp(
        path.join(os.tmpdir(), "checktrail-evaluation-runtime-"),
      );
      if (process.platform === "win32")
        ensureWindowsTaskAccess(temporary, "directory", true);
      process.env.CHECKTRAIL_EVAL_RUNTIME_ACTIVE = "1";
      process.env.CHECKTRAIL_EVAL_RUNTIME_SLOT = slot ?? "";
      process.env.CHECKTRAIL_EVAL_RUNTIME_RECEIPT = path.join(
        temporary,
        "installed.json",
      );
    }
    const startedAt = new Date().toISOString();
    const profileEvidence = await runRequiredTests(
      requirements.map((c) => ({ ...c, file: path.join(root, c.file) })),
      { timeoutMs: 600000 },
    );
    requireEvaluationTerminalCases(
      profileEvidence,
      requirements,
      acceptanceSha256,
    );
    const compiledEngine = compactEngine(
      requireUnchangedCompiledEngine(
        before,
        await captureCompiledEngine(engineRoot),
      ),
    );
    assert.deepEqual(
      await Promise.all(
        evaluationRuntimeHarnessFiles.map(async (f) => [
          f,
          hash(await readFile(path.join(root, f))),
        ]),
      ),
      inputs,
    );
    assert.equal(
      hash(await readFile(process.execPath)),
      runtime.nodeExecutableSha256,
    );
    assert.equal(hash(await readFile(packageFile)), packageSha256);
    if (distributionBytes)
      assert.equal(
        hash(await readFile("/etc/os-release")),
        runtime.distributionSha256,
      );
    if (systemPowerShellSha256) {
      const selected = path.win32.join(
        process.env.SystemRoot ?? process.env.SYSTEMROOT,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      );
      assert.equal(hash(await readFile(selected)), systemPowerShellSha256);
    }
    let installedEvidence = null;
    if (!installed) {
      const raw = await readFile(process.env.CHECKTRAIL_EVAL_RUNTIME_RECEIPT);
      assert.ok(raw.length <= 4 * 1048576);
      installedEvidence = JSON.parse(raw.toString("utf8"));
      requireEvaluationRuntimeInstallation(installedEvidence, {
        runtime,
        harnessSha256,
        acceptanceSha256,
        requirementsSha256,
        packageSha256,
        compiledEngine,
        requirements,
        compiledCodeSha256,
        clientVersion,
        selectedRuntime,
      });
    }
    return {
      schemaVersion: 1,
      profile: "independent-evaluation-runtime-v1",
      startedAt,
      finishedAt: new Date().toISOString(),
      runtime,
      selectedRuntime,
      installed,
      compiledEngine,
      harnessSha256,
      acceptanceSha256,
      requirementsSha256,
      packageSha256,
      inputSources: inputs,
      profileEvidence,
      installedEvidence,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
      gateAComplete: false,
    };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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
