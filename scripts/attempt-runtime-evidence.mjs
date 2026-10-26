import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, realpath, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { runRequiredTests } from "./required-test-evidence.mjs";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import { ensureWindowsTaskAccess } from "../dist/src/windows-task-access.js";
import {
  selectAttemptFoundation,
  requireAttemptFoundationEvidence,
  runAttemptFoundation,
} from "./attempt-foundation-evidence.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const attemptRuntimeBaseImages = Object.freeze({
  node: "docker.io/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
  system:
    "docker.io/library/golang@sha256:ae5a2316d12f3e78fd99177dad452e6ad4f240af2d71d57b480c3477f250fec6",
});
import {
  attemptWholeHarnessFiles,
  selectAttemptWholeRequirements as selectAttemptRuntimeRequirements,
  requireAttemptTerminalCases,
} from "./attempt-whole-evidence.mjs";
export { selectAttemptRuntimeRequirements, requireAttemptTerminalCases };
export const attemptRuntimeHarnessFiles = attemptWholeHarnessFiles;
/** Match observed metadata; neither environment variables nor this comparison attest a host. */
export function checkAttemptRuntimeSelection(
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
    assert.equal(observed.containerReference, observed.containerImageId);
    assert.equal(observed.baseNodeReference, attemptRuntimeBaseImages.node);
    assert.equal(observed.baseSystemReference, attemptRuntimeBaseImages.system);
    assert.match(observed.containerDefinitionSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.match(observed.containerImageId ?? "", /^sha256:[a-f0-9]{64}$/);
  }
  if (slot !== "native-linux-arm64-node22" || hosted)
    assert.match(observed.imageVersion ?? "", /^20\d{6}\.\d+\.\d+$/);
  assert.match(observed.gitExecutableSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(observed.gitVersion ?? "", /^git version [^\r\n]{1,128}$/);
  assert.equal(observed.goVersion, "go1.27.1");
  assert.match(observed.goExecutableSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    observed.goPlatform,
    selected.platform === "win32" ? "windows" : selected.platform,
  );
  assert.equal(
    observed.goArchitecture,
    selected.architecture === "x64" ? "amd64" : selected.architecture,
  );
  return selected;
}

export const compactAttemptEngine = ({
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
async function observeGo() {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    let executable;
    try {
      executable = await realpath(
        path.join(directory, process.platform === "win32" ? "go.exe" : "go"),
      );
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) continue;
      throw error;
    }
    const info = await stat(executable);
    assert.ok(
      info.isFile() && info.size > 0 && info.size <= 128 * 1048576,
      "Go executable observation unavailable",
    );
    const version = execFileSync(executable, ["version"], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 4096,
      windowsHide: true,
      env: { ...process.env, GOTOOLCHAIN: "local" },
    }).trim();
    const match =
      /^go version (go1\.27\.1) (darwin|linux|windows)\/(amd64|arm64)$/.exec(
        version,
      );
    assert.ok(match, "Pinned Go 1.27.1 prerequisite unavailable");
    assert.equal(
      match[2],
      process.platform === "win32" ? "windows" : process.platform,
    );
    assert.equal(match[3], process.arch === "x64" ? "amd64" : process.arch);
    return {
      goVersion: match[1],
      goPlatform: match[2],
      goArchitecture: match[3],
      goExecutableSha256: hash(await readFile(executable)),
    };
  }
  throw Error("Pinned Go prerequisite unavailable");
}
export async function observeAttemptRuntime(slot = null) {
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
      process.env.CHECKTRAIL_ATTEMPT_RUNTIME_IMAGE_REFERENCE ?? null,
    containerImageId: process.env.CHECKTRAIL_ATTEMPT_RUNTIME_IMAGE_ID ?? null,
    baseNodeReference:
      process.env.CHECKTRAIL_ATTEMPT_BASE_NODE_REFERENCE ?? null,
    baseSystemReference:
      process.env.CHECKTRAIL_ATTEMPT_BASE_SYSTEM_REFERENCE ?? null,
    containerDefinitionSha256: hash(
      await readFile(
        new URL("./attempt-runtime-tools.Dockerfile", import.meta.url),
      ),
    ),
    ...(await observeGit()),
    ...(await observeGo()),
    nodeExecutableSha256: hash(await readFile(process.execPath)),
    systemPowerShellSha256,
    hostedImageMetadataAttested: false,
    containerImageMetadataAttested: false,
  };
}
export function requireAttemptRuntimeInstallation(receipt, expected) {
  assert.equal(receipt?.schemaVersion, 1);
  assert.equal(receipt.profile, "attempt-archives-whole-installed-v1");
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
    "foundationExclusions",
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
  requireAttemptTerminalCases(
    receipt.profileEvidence,
    expected.requirements,
    expected.acceptanceSha256,
  );
  requireAttemptFoundationEvidence(
    receipt.foundationEvidence,
    expected.foundationRequirements,
    expected.foundationDigests,
  );
  for (const key of [
    "gateAAttemptArchivesComplete",
    "gateAComplete",
    "inferenceInvoked",
    "fieldEvaluationExecuted",
  ])
    assert.equal(receipt[key], false);
}
let busy = false;
export async function verifyAttemptRuntime({
  root = repository,
  slot = null,
  hosted = process.env.GITHUB_ACTIONS === "true",
} = {}) {
  assert.equal(busy, false, "Runtime verification already active");
  assert.notEqual(process.env.CHECKTRAIL_ATTEMPT_WHOLE_INSTALLED, "1");
  busy = true;
  const keys = [
      "CHECKTRAIL_ATTEMPT_RUNTIME_ACTIVE",
      "CHECKTRAIL_ATTEMPT_RUNTIME_SLOT",
      "CHECKTRAIL_ATTEMPT_RUNTIME_RECEIPT",
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
    // Reject invalid selection before observing or invoking native prerequisites.
    if (slot === null)
      assert.equal(hosted, false, "Hosted runtime requires a selected slot");
    else
      assert.equal(
        scope.runtimeProfiles.filter((p) => p.id === slot).length,
        1,
        "Unknown selected runtime slot",
      );
    const requirements = selectAttemptRuntimeRequirements(profiles, scope),
      runtime = await observeAttemptRuntime(slot),
      selectedRuntime = checkAttemptRuntimeSelection(
        scope,
        slot,
        runtime,
        hosted,
      );
    const inputs = await Promise.all(
        attemptRuntimeHarnessFiles.map(async (f) => [
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
      await mkdtemp(path.join(os.tmpdir(), "checktrail-attempt-runtime-")),
    );
    if (process.platform === "win32")
      ensureWindowsTaskAccess(temporary, "directory", true);
    process.env.CHECKTRAIL_ATTEMPT_RUNTIME_ACTIVE = "1";
    process.env.CHECKTRAIL_ATTEMPT_RUNTIME_SLOT = slot ?? "";
    process.env.CHECKTRAIL_ATTEMPT_RUNTIME_RECEIPT = path.join(
      temporary,
      "installed.json",
    );
    const startedAt = new Date().toISOString();
    const profileEvidence = await runRequiredTests(
      requirements.map((c) => ({ ...c, file: path.join(root, c.file) })),
      {
        timeoutMs: process.platform === "win32" ? 600000 : 300000,
        isolatedCaseWorkers: 1,
        onCaseProgress: (event) =>
          process.stderr.write(
            JSON.stringify({ profile: "attempt-archives-source", ...event }) +
              "\n",
          ),
      },
    );
    const foundationSelection = selectAttemptFoundation(
        profiles,
        runtime.platform,
      ),
      foundationDigests = Object.fromEntries(inputs),
      foundationRequirementsSha256 = hash(JSON.stringify(foundationSelection)),
      foundationEvidence = await runAttemptFoundation(
        root,
        foundationSelection,
        foundationDigests,
        "attempt-foundation-source",
      );
    const acceptanceSha256 = inputs.find(
      ([file]) => file === "dist/test/gate-attempt-archives.test.js",
    )[1];
    requireAttemptTerminalCases(
      profileEvidence,
      requirements,
      acceptanceSha256,
    );
    const compiledEngine = compactAttemptEngine(
      requireUnchangedCompiledEngine(
        before,
        await captureCompiledEngine(engineRoot),
      ),
    );
    assert.deepEqual(
      await Promise.all(
        attemptRuntimeHarnessFiles.map(async (f) => [
          f,
          hash(await readFile(path.join(root, f))),
        ]),
      ),
      inputs,
    );
    assert.deepEqual(await observeAttemptRuntime(slot), runtime);
    assert.equal(hash(await readFile(packageFile)), packageSha256);
    const receiptFile = process.env.CHECKTRAIL_ATTEMPT_RUNTIME_RECEIPT,
      receiptStat = await stat(receiptFile);
    assert.ok(
      receiptStat.isFile() &&
        receiptStat.size > 0 &&
        receiptStat.size <= 8 * 1048576,
    );
    const installedEvidence = JSON.parse(await readFile(receiptFile, "utf8"));
    requireAttemptRuntimeInstallation(installedEvidence, {
      runtime,
      selectedRuntime,
      harnessSha256,
      requirementsSha256,
      packageSha256,
      compiledEngine,
      requirements,
      clientVersion,
      acceptanceSha256,
      foundationRequirementsSha256,
      foundationExclusions: foundationSelection.exclusions,
      foundationRequirements: foundationSelection.requirements,
      foundationDigests,
    });
    return {
      schemaVersion: 1,
      profile: "attempt-archives-runtime-v1",
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
      foundationExclusions: foundationSelection.exclusions,
      installedEvidence,
      gateAAttemptArchivesComplete: false,
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
