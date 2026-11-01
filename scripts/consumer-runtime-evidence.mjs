import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, realpath, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { runRequiredTests } from "./required-test-evidence.mjs";
import { projectConsumerTerminalDiagnostic } from "./consumer-runtime-diagnostics.mjs";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import { ensureWindowsTaskAccess } from "../dist/src/windows-task-access.js";
import {
  consumerFoundationHarnessFiles,
  selectConsumerFoundation,
  runConsumerFoundation,
  requireConsumerFoundationEvidence,
} from "./consumer-foundation-evidence.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  profileId = "consumer-impact";
import { checkConsumerRuntimeSelection } from "./consumer-runtime-selection.mjs";
export {
  consumerRuntimeBaseImages,
  checkConsumerRuntimeSelection,
} from "./consumer-runtime-selection.mjs";
export const consumerRuntimeHarnessFiles = Object.freeze([
  ...consumerFoundationHarnessFiles,
  "package.json",
  "package-lock.json",
  "docs/gate-a-profiles.v1.json",
  "scripts/consumer-runtime-evidence.mjs",
  "scripts/consumer-runtime-diagnostics.mjs",
  "scripts/consumer-runtime-selection.mjs",
  "scripts/consumer-witness-collection.mjs",
  "scripts/consumer-native-capture-registry.mjs",
  "scripts/consumer-witness-controller.mjs",
  "scripts/consumer-witness-evidence.mjs",
  "scripts/consumer-witness-project-controller.mjs",
  "scripts/consumer-runtime-tools.Dockerfile",
  "scripts/verify-consumer-runtime-arm64.mjs",
  "scripts/pull-pinned-image.mjs",
  "scripts/prepare-acceptance-cache-subset.mjs",
  "scripts/verify-consumer-runtime.mjs",
  "scripts/verify-consumer-impact-whole-package.mjs",
  "scripts/required-native-tests.json",
  "scripts/required-test-evidence.mjs",
  "scripts/compiled-engine-evidence.mjs",
  "scripts/install-acceptance-package.mjs",
  "dist/test/gate-consumer-impact.test.js",
  "dist/test/consumer-impact-fixture.js",
  "dist/test/consumer-witness-fixture.js",
  "docs/gate-a-consumer-witnesses.v1.json",
  "scripts/consumer-witness-attempts.mjs",
  "scripts/consumer-witness-jvm.mjs",
  "scripts/consumer-witness-managed.mjs",
  "scripts/consumer-witness-data.mjs",
  "scripts/consumer-witness-swift.mjs",
  "scripts/consumer-witness-project.mjs",
  "dist/test/git-fixture.js",
  "dist/test/tasks-wire-fixture.js",
  "dist/test/helpers.js",
  "dist/test/tool-fixture.js",
]);
export function selectConsumerRuntimeRequirements(profiles, scope) {
  const selected = scope.extensionProfiles.filter((p) => p.id === profileId);
  assert.equal(selected.length, 1);
  const p = selected[0];
  assert.equal(p.runtime, "engine-matrix");
  assert.equal(p.acceptanceFile, "dist/test/gate-consumer-impact.test.js");
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
    "Frozen consumer impact callbacks changed",
  );
  return requirements;
}
export const compactConsumerEngine = ({
  schemaVersion,
  fileCount,
  bytes,
  treeSha256,
  manifestSha256,
  beforeAfterByteIdentitiesMatch,
}) => ({
  schemaVersion,
  fileCount,
  bytes,
  treeSha256,
  manifestSha256,
  beforeAfterByteIdentitiesMatch,
  dependencyBytesCaptured: false,
  actualModuleLoadsTraced: false,
  producerSourceBuildVerified: false,
});
async function observeGit() {
  let executable;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    try {
      const candidate = await realpath(
          path.join(
            directory,
            process.platform === "win32" ? "git.exe" : "git",
          ),
        ),
        info = await stat(candidate);
      assert.ok(
        info.isFile() && info.size > 0 && info.size <= 64 * 1048576,
        "Git executable observation unavailable",
      );
      executable = candidate;
      break;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  assert.ok(executable, "Native Git prerequisite unavailable");
  const version = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 4096,
  }).trim();
  assert.match(version, /^git version [^\r\n]{1,128}$/);
  return {
    gitVersion: version,
    gitExecutableSha256: hash(await readFile(executable)),
  };
}
export async function observeConsumerRuntime(slot = null) {
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
      ),
      canonical = await realpath(selected);
    assert.equal(canonical.toLowerCase(), selected.toLowerCase());
    systemPowerShellSha256 = hash(await readFile(canonical));
  }
  return {
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
      process.env.CHECKTRAIL_CONSUMER_RUNTIME_IMAGE_REFERENCE ?? null,
    containerImageId: process.env.CHECKTRAIL_CONSUMER_RUNTIME_IMAGE_ID ?? null,
    baseNodeReference:
      process.env.CHECKTRAIL_CONSUMER_BASE_NODE_REFERENCE ?? null,
    baseSystemReference:
      process.env.CHECKTRAIL_CONSUMER_BASE_SYSTEM_REFERENCE ?? null,
    containerDefinitionSha256: hash(
      await readFile(
        new URL("./consumer-runtime-tools.Dockerfile", import.meta.url),
      ),
    ),
    ...(await observeGit()),
    nodeExecutableSha256: hash(await readFile(process.execPath)),
    systemPowerShellSha256,
    hostedImageMetadataAttested: false,
    containerImageMetadataAttested: false,
  };
}
export function requireConsumerTerminalCases(
  p,
  requirements,
  acceptanceSha256,
) {
  assert.match(acceptanceSha256 ?? "", /^[a-f0-9]{64}$/);
  try {
    assert.equal(p.complete, true, JSON.stringify(p.problems));
  } catch (error) {
    try {
      error.consumerTerminalDiagnostic = projectConsumerTerminalDiagnostic(
        p,
        requirements,
        acceptanceSha256,
      );
    } catch {
      /* Preserve the original profile refusal. */
    }
    throw error;
  }
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
export function requireConsumerRuntimeInstallation(receipt, expected) {
  assert.equal(receipt?.schemaVersion, 1);
  assert.equal(receipt.profile, "consumer-impact-whole-installed-v1");
  assert.equal(receipt.offlineProductionInstall, true);
  assert.equal(receipt.lifecycleScriptsExecuted, false);
  assert.equal(receipt.harnessOutsideInstalledPackage, true);
  for (const field of ["tarballSha256", "productionDependencyLockSha256"])
    assert.match(receipt[field] ?? "", /^[a-f0-9]{64}$/);
  for (const field of [
    "runtime",
    "selectedRuntime",
    "harnessSha256",
    "requirementsSha256",
    "foundationRequirementsSha256",
    "packageSha256",
    "compiledEngine",
  ])
    assert.deepEqual(
      receipt[field],
      expected[field],
      "Installed " + field + " differs",
    );
  assert.equal(
    receipt.externalSdkDependencies?.["@modelcontextprotocol/client"],
    expected.clientVersion,
  );
  requireConsumerTerminalCases(
    receipt.profileEvidence,
    expected.requirements,
    expected.acceptanceSha256,
  );
  requireConsumerFoundationEvidence(
    receipt.foundationEvidence,
    expected.foundationSelection,
    expected.foundationDigests,
  );
  for (const key of [
    "gateAConsumerImpactComplete",
    "gateAComplete",
    "inferenceInvoked",
    "fieldEvaluationExecuted",
  ])
    assert.equal(receipt[key], false);
}
let busy = false;
export async function verifyConsumerRuntime({
  root = repository,
  slot = null,
  hosted = process.env.GITHUB_ACTIONS === "true",
} = {}) {
  assert.equal(busy, false, "Runtime verification already active");
  assert.notEqual(process.env.CHECKTRAIL_CONSUMER_WHOLE_INSTALLED, "1");
  busy = true;
  const keys = [
      "CHECKTRAIL_CONSUMER_RUNTIME_ACTIVE",
      "CHECKTRAIL_CONSUMER_RUNTIME_SLOT",
      "CHECKTRAIL_CONSUMER_RUNTIME_RECEIPT",
    ],
    previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  let temporary;
  try {
    const scope = JSON.parse(
        await readFile(path.join(root, "docs/gate-a-profiles.v1.json"), "utf8"),
      ),
      profiles = JSON.parse(
        await readFile(
          path.join(root, "scripts/required-native-tests.json"),
          "utf8",
        ),
      );
    const requirements = selectConsumerRuntimeRequirements(profiles, scope),
      runtime = await observeConsumerRuntime(slot),
      selectedRuntime = checkConsumerRuntimeSelection(
        scope,
        slot,
        runtime,
        hosted,
      );
    const inputs = await Promise.all(
        consumerRuntimeHarnessFiles.map(async (f) => [
          f,
          hash(await readFile(path.join(root, f))),
        ]),
      ),
      harnessSha256 = hash(JSON.stringify(inputs)),
      requirementsSha256 = hash(JSON.stringify(requirements)),
      engineRoot = path.join(root, "dist/src"),
      before = await captureCompiledEngine(engineRoot);
    const packageFile = path.join(
        path.dirname(path.dirname(await realpath(engineRoot))),
        "package.json",
      ),
      packageSha256 = hash(await readFile(packageFile)),
      clientVersion = JSON.parse(
        await readFile(path.join(root, "package-lock.json"), "utf8"),
      ).packages["node_modules/@modelcontextprotocol/client"].version;
    temporary = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "checktrail-consumer-runtime-")),
    );
    if (process.platform === "win32")
      ensureWindowsTaskAccess(temporary, "directory", true);
    process.env.CHECKTRAIL_CONSUMER_RUNTIME_ACTIVE = "1";
    process.env.CHECKTRAIL_CONSUMER_RUNTIME_SLOT = slot ?? "";
    process.env.CHECKTRAIL_CONSUMER_RUNTIME_RECEIPT = path.join(
      temporary,
      "installed.json",
    );
    const startedAt = new Date().toISOString();
    const profileEvidence = await runRequiredTests(
      requirements.map((c) => ({ ...c, file: path.join(root, c.file) })),
      { timeoutMs: 600000, isolatedCaseWorkers: 1 },
    );
    const foundationSelection = selectConsumerFoundation(profiles),
      foundationDigests = Object.fromEntries(inputs),
      foundationRequirementsSha256 = hash(JSON.stringify(foundationSelection)),
      foundationEvidence = await runConsumerFoundation(
        root,
        foundationSelection,
        foundationDigests,
        "consumer-foundation-source",
      );
    const acceptanceSha256 = inputs.find(
      ([file]) => file === "dist/test/gate-consumer-impact.test.js",
    )[1];
    requireConsumerTerminalCases(
      profileEvidence,
      requirements,
      acceptanceSha256,
    );
    const compiledEngine = compactConsumerEngine(
      requireUnchangedCompiledEngine(
        before,
        await captureCompiledEngine(engineRoot),
      ),
    );
    assert.deepEqual(
      await Promise.all(
        consumerRuntimeHarnessFiles.map(async (f) => [
          f,
          hash(await readFile(path.join(root, f))),
        ]),
      ),
      inputs,
    );
    assert.deepEqual(await observeConsumerRuntime(slot), runtime);
    assert.equal(hash(await readFile(packageFile)), packageSha256);
    const receiptFile = process.env.CHECKTRAIL_CONSUMER_RUNTIME_RECEIPT,
      receiptStat = await stat(receiptFile);
    assert.ok(
      receiptStat.isFile() &&
        receiptStat.size > 0 &&
        receiptStat.size <= 8 * 1048576,
    );
    const installedEvidence = JSON.parse(await readFile(receiptFile, "utf8"));
    requireConsumerRuntimeInstallation(installedEvidence, {
      runtime,
      selectedRuntime,
      harnessSha256,
      requirementsSha256,
      packageSha256,
      compiledEngine,
      requirements,
      clientVersion,
      acceptanceSha256,
      foundationSelection,
      foundationDigests,
      foundationRequirementsSha256,
    });
    return {
      schemaVersion: 1,
      profile: "consumer-impact-runtime-v1",
      startedAt,
      completedAt: new Date().toISOString(),
      selectedRuntime,
      runtime,
      harnessSha256,
      requirementsSha256,
      packageSha256,
      compiledEngine,
      profileEvidence,
      foundationEvidence,
      foundationRequirementsSha256,
      installedEvidence,
      gateAConsumerImpactComplete: false,
      gateAComplete: false,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
    };
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    busy = false;
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
