// Development-only live observer. It never promotes complete SDK/Gate A closure.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  captureCProducerCallerIdentity,
  boundedCProducerBytes,
  observedCProducerTerminal,
  readCProducerCopyManifest,
  verifyCProducerReports,
  cProducerCompletion,
  cProducerSourceFiles,
} from "./qualify-c-producer.mjs";
import {
  glibcSeccompSourceFiles,
  loadGlibcSeccomp,
  validateGlibcSyscallPreflight,
} from "./producer-qualification/glibc-seccomp.mjs";
import {
  identifyFile,
  validateInputs,
  physicalPath,
} from "./qualify-binutils-producer.mjs";
import { reconcileRetentionLog } from "./producer-qualification/binutils-retention-observer.mjs";
import {
  loadCProducerProfile,
  cProducerCatalogSha256,
  sha256,
} from "./producer-qualification/c-producer-profile.mjs";
import { admitGccJobEnvelope } from "./producer-qualification/gcc-job-envelope.mjs";
import { registryImageIdentity } from "./producer-qualification/binutils-image-identity.mjs";
import {
  requireCObservationProfile,
  validateCStartupProfile,
  validateGccCarrierReceipt,
} from "./producer-qualification/c-carrier-observation.mjs";

const exec = promisify(execFile);
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const cObservationSources = [
  "scripts/qualify-c-producer.mjs",
  "scripts/qualify-binutils-producer.mjs",
  "scripts/producer-qualification/c-producer-profile.mjs",
  "scripts/producer-qualification/c-producer-profiles.v1.json",
  "scripts/producer-qualification/c-producer-build.sh",
  "scripts/producer-qualification/c-producer-test-reports.py",
  "scripts/producer-qualification/binutils-retention-observer.mjs",
  "scripts/producer-qualification/binutils-retention-observer.py",
  "scripts/producer-qualification/binutils-image-identity.mjs",
  "scripts/producer-qualification/binutils-image-identity.v1.json",
  "scripts/verify-c-producer-observation.mjs",
  "scripts/producer-qualification/c-producer-export-evidence.py",
  "scripts/producer-qualification/c-producer-replay-evidence.py",
  ".github/workflows/upstream-glibc.yml",
  "scripts/verify-binutils-retention-observer.mjs",
  "scripts/acquire-binutils-inputs.mjs",
  "scripts/acquire-c-producer-inputs.mjs",
  "scripts/producer-qualification/binutils.v1.json",
  "scripts/producer-qualification/binutils-acquisition-plan.mjs",
  "scripts/producer-qualification/binutils-prepare-inputs.py",
  "scripts/producer-qualification/binutils-apt-index-preparation.v1.json",
  "scripts/producer-qualification/binutils-input-reacquisition.v1.json",
  ...glibcSeccompSourceFiles.map(
    (file) => "scripts/producer-qualification/" + file,
  ),
  "scripts/producer-qualification/gcc-job-envelope.mjs",
  "scripts/producer-qualification/gcc-github-job-clock.mjs",
  "scripts/producer-qualification/emsdk-metadata-values.mjs",
  "scripts/producer-qualification/c-carrier-observation.mjs",
  "scripts/observe-c-producer-carrier.mjs",
  ".github/workflows/upstream-gcc.yml",
];
const metadataGit = async (args) =>
  (
    await exec(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd: repository,
        timeout: 5000,
        maxBuffer: 2 * 1024 ** 2,
        encoding: "buffer",
      },
    )
  ).stdout;
async function json(file, maximum = 16 * 1024 ** 2) {
  return JSON.parse(await boundedCProducerBytes(file, maximum));
}

export function validateCObservationHeader(
  receipt,
  profile,
  startup,
  controllerExit,
) {
  const name = requireCObservationProfile(profile.sourcePackage);
  validateCStartupProfile(startup, name, profile, cProducerCatalogSha256);
  assert.equal(receipt.catalogSha256, cProducerCatalogSha256);
  assert.equal(controllerExit, 2, "Unexpected original controller exit");
  assert.equal(
    receipt.state,
    "original-command-completed-qualification-incomplete",
  );
  assert.equal(receipt.profile, profile.profile);
  assert.equal(receipt.sourceVersion, profile.sourceVersion);
  assert.deepEqual(receipt.limits, profile.limits);
  assert.equal(receipt.buildExecuted, true);
  assert.equal(receipt.originalExecutionInvoked, true);
  assert.ok(
    observedCProducerTerminal(receipt.executionObserver) &&
      receipt.executionObserver.exitCode === 0,
    "Incomplete original foreground terminal",
  );
  assert.deepEqual(receipt.originalBuild, {
    schemaVersion: 1,
    command: profile.command,
    invoked: true,
    exitCode: 0,
    wrapperExitCode: 0,
  });
  assert.equal(startup.schemaVersion, 1);
  assert.equal(startup.state, "operator-source-and-caller-frame");
  for (const key of [
    "sourceOrCompilerExecuted",
    "hardwareHostAttestationPerformed",
    "gateAComplete",
  ])
    assert.equal(startup[key], false);
  assert.deepEqual(receipt.host.capturedCaller, startup.caller);
  assert.ok(
    startup.caller.uid > 0,
    "Hosted observation requires actual nonroot caller proof",
  );
  assert.deepEqual(
    [
      receipt.host.platform,
      receipt.host.architecture,
      receipt.host.kernelMachine,
    ],
    ["linux", "x64", "x86_64"],
  );
  assert.deepEqual(startup.host, {
    platform: "linux",
    architecture: "x64",
    kernelMachine: "x86_64",
  });
  const preflight = receipt.custodyPreflight;
  assert.equal(preflight.state, "selected-nonroot-caller-export-verified");
  assert.deepEqual(preflight.capturedCaller, startup.caller);
  assert.equal(preflight.nativeLinuxCrossUidAcceptanceVerified, true);
  assert.equal(preflight.sourceOrCompilerInvoked, false);
  assert.ok(
    observedCProducerTerminal(preflight.observer) &&
      preflight.observer.exitCode === 0,
  );
  assert.ok(["absent", "removed"].includes(preflight.cleanup.state));
  assert.ok(["absent", "removed"].includes(receipt.cleanup.state));
  assert.ok(
    ["absent", "removed"].includes(receipt.retentionObserverCleanup.state),
  );
  assert.equal(receipt.retentionObserver.state, "completed");
  assert.deepEqual(receipt.retentionObserver.terminal, {
    exitCode: 0,
    signal: null,
  });
  assert.equal(receipt.retentionObserver.readOnly, true);
  assert.equal(receipt.retentionObserver.network, "none");
  assert.equal(receipt.retentionObserver.capability, "DAC_READ_SEARCH");
  assert.equal(receipt.retentionObserver.nativeFilesystemQuotaEnforced, false);
  for (const key of [
    "fullCompilerSdkBootstrapClosureVerified",
    "completeOriginalNoticeClosureVerified",
    "historicalPublisherConsumptionVerified",
    "gateAComplete",
    "originalBuildChecksDisabled",
    "originalDefaultTargetsDisabled",
    "inputAuthenticationAndFreshnessDisabled",
  ])
    assert.equal(receipt[key], false);
  assert.equal(receipt.nativeFilesystemQuotaEnforced, false);
  assert.ok(
    Array.isArray(receipt.outputs) &&
      receipt.outputs.length <= 1024 &&
      receipt.outputs.some(
        (row) =>
          /^[A-Za-z0-9][A-Za-z0-9.+_~-]*\.(deb|udeb)$/u.test(row.file) &&
          Number.isSafeInteger(row.bytes) &&
          row.bytes > 0,
      ),
    "Nonempty physical package output is required",
  );
  return {
    originalCommandExitCode: 0,
    originalTestOutcomesPreserved: true,
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    historicalPublisherConsumptionVerified: false,
    gateAComplete: false,
  };
}

export async function captureCObservationStartup(name, output) {
  requireCObservationProfile(name);
  const { profile, catalogSha256 } = await loadCProducerProfile(name);
  assert.deepEqual(
    [process.platform, process.arch, os.machine()],
    ["linux", "x64", "x86_64"],
  );
  const caller = captureCProducerCallerIdentity();
  assert.ok(
    caller.uid > 0,
    "Hosted native custody requires a nonroot operator",
  );
  const gitHead = (await metadataGit(["rev-parse", "HEAD"]))
    .toString("utf8")
    .trim();
  assert.match(gitHead, /^[a-f0-9]{40}$/u);
  const sourcePins = [];
  for (const file of cObservationSources) {
    const raw = await boundedCProducerBytes(
      path.join(repository, file),
      2 * 1024 ** 2,
    );
    const committed = await metadataGit([
      "cat-file",
      "blob",
      gitHead + ":" + file,
    ]);
    assert.deepEqual(
      raw,
      committed,
      "Observation harness differs from exact Git source: " + file,
    );
    sourcePins.push({ file, bytes: raw.length, sha256: sha256(raw) });
  }
  const value = {
    schemaVersion: 1,
    state: "operator-source-and-caller-frame",
    gitHead,
    selectedProfile: {
      name,
      profile: profile.profile,
      sourceVersion: profile.sourceVersion,
      catalogSha256,
    },
    caller,
    host: {
      platform: process.platform,
      architecture: process.arch,
      kernelMachine: os.machine(),
    },
    sourcePins,
    sourceOrCompilerExecuted: false,
    hardwareHostAttestationPerformed: false,
    gateAComplete: false,
  };
  await physicalPath(path.dirname(path.resolve(output)), true);
  await writeFile(output, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return {
    state: value.state,
    gitHead,
    sourceFiles: sourcePins.length,
    gateAComplete: false,
  };
}

export async function verifyCObservationStartup(name, startupFile) {
  requireCObservationProfile(name);
  assert.deepEqual(
    [process.platform, process.arch, os.machine()],
    ["linux", "x64", "x86_64"],
  );
  const { profile, catalogSha256 } = await loadCProducerProfile(name);
  const startupRaw = await boundedCProducerBytes(
    startupFile,
    1024 ** 2,
    captureCProducerCallerIdentity(),
  );
  const startup = JSON.parse(startupRaw);
  validateCStartupProfile(startup, name, profile, catalogSha256);
  assert.deepEqual(startup.caller, captureCProducerCallerIdentity());
  assert.deepEqual(
    startup.sourcePins.map((row) => row.file),
    cObservationSources,
  );
  await validateInputs(repository, startup.sourcePins);
  assert.equal(
    (await metadataGit(["rev-parse", "HEAD"])).toString("utf8").trim(),
    startup.gitHead,
    "Source revision changed during original execution",
  );
  return { startupRaw, startup };
}

export async function verifyCLiveObservation(
  name,
  result,
  startupFile,
  controllerExit,
  carrierDirectory = null,
) {
  requireCObservationProfile(name);
  const { catalog, profile, catalogSha256 } = await loadCProducerProfile(name);
  const { startupRaw, startup } = await verifyCObservationStartup(
    name,
    startupFile,
  );
  const receiptFile = path.join(result, "receipt.json");
  const receiptRaw = await boundedCProducerBytes(receiptFile, 16 * 1024 ** 2);
  const receipt = JSON.parse(receiptRaw);
  const summary = validateCObservationHeader(
    receipt,
    profile,
    startup,
    controllerExit,
  );
  assert.equal(receipt.catalogSha256, catalogSha256);
  assert.equal(receipt.retentionObserver.independentImage, catalog.image);
  assert.deepEqual(
    receipt.sourcePins.map((row) => row.file),
    cProducerSourceFiles(profile),
  );
  assert.deepEqual(
    receipt.harnessPins.map((row) => row.file),
    ["qualify-c-producer.mjs", "qualify-binutils-producer.mjs"],
  );
  const selectedImage = registryImageIdentity(
    await json(
      path.join(
        repository,
        "scripts/producer-qualification/binutils-image-identity.v1.json",
      ),
      1024 ** 2,
    ),
    catalog.image,
  );
  assert.ok(
    [selectedImage.configDigest, selectedImage.manifestDigest].includes(
      receipt.image.id,
    ),
  );
  assert.deepEqual(receipt.image, {
    id: receipt.image.id,
    os: "linux",
    architecture: "amd64",
    manifestDigest: selectedImage.manifestDigest,
    configDigest: selectedImage.configDigest,
    rootfsDiffIds: selectedImage.rootfsDiffIds,
  });
  for (const row of receipt.sourcePins)
    assert.deepEqual(
      await identifyFile(
        path.join(repository, "scripts/producer-qualification", row.file),
        2 * 1024 ** 2,
      ),
      { bytes: row.bytes, sha256: row.sha256 },
    );
  for (const row of receipt.harnessPins)
    assert.deepEqual(
      await identifyFile(
        path.join(repository, "scripts", row.file),
        2 * 1024 ** 2,
      ),
      { bytes: row.bytes, sha256: row.sha256 },
    );
  await validateInputs(path.join(result, "bundle"), profile.files);
  await validateInputs(
    path.join(result, "controls"),
    receipt.sourcePins.filter((row) =>
      [
        "c-producer-build.sh",
        "c-producer-test-reports.py",
        "binutils-retention-observer.py",
        "glibc-seccomp-probe.py",
      ].includes(row.file),
    ),
  );
  let carrierObservation = null;
  if (name === "glibc") {
    const syscall = validateGlibcSyscallPreflight(
      receipt,
      await loadGlibcSeccomp(),
      observedCProducerTerminal,
    );
    await validateInputs(
      path.join(result, "controls"),
      receipt.generatedControlPins,
    );
    for (const mode of ["baseline", "derived"]) {
      const raw = await boundedCProducerBytes(
        path.join(result, "seccomp-" + mode + ".log"),
        65536,
      );
      assert.deepEqual(
        { bytes: raw.length, sha256: sha256(raw) },
        syscall.modes[mode].log,
      );
      assert.deepEqual(JSON.parse(raw), syscall.modes[mode].record);
    }
    assert.equal(carrierDirectory, null);
  } else {
    assert.equal(receipt.syscallRuntime, null);
    assert.ok(
      !Object.hasOwn(receipt, "syscallPreflight") &&
        !Object.hasOwn(receipt, "generatedControlPins"),
      "GCC must retain its original carrier policy",
    );
    assert.ok(typeof carrierDirectory === "string");
    const carrierRaw = await boundedCProducerBytes(
      path.join(carrierDirectory, "receipt.json"),
      1024 ** 2,
    );
    const carrier = JSON.parse(carrierRaw);
    let jobResponse = null,
      jobCapturePin = null;
    if (Object.hasOwn(carrier, "githubJobEnvelope")) {
      jobResponse = await boundedCProducerBytes(
        path.join(carrierDirectory, "github-job-response.json"),
        128 * 1024,
      );
      const captureRaw = await boundedCProducerBytes(
        path.join(carrierDirectory, "github-job-capture.json"),
        256 * 1024,
      );
      const captured = JSON.parse(captureRaw);
      assert.deepEqual(captured.response, {
        bytes: jobResponse.length,
        sha256: sha256(jobResponse),
      });
      assert.equal(captured.requestAuthenticationHeadersRetained, false);
      const { response, ...metadata } = captured;
      assert.deepEqual(
        admitGccJobEnvelope({ ...metadata, responseBytes: jobResponse }),
        carrier.githubJobEnvelope,
      );
      jobCapturePin = {
        response,
        capture: { bytes: captureRaw.length, sha256: sha256(captureRaw) },
      };
    }
    validateGccCarrierReceipt(carrier, profile, catalogSha256, jobResponse);
    assert.deepEqual(carrier.startupInput, {
      bytes: startupRaw.length,
      sha256: sha256(startupRaw),
    });
    assert.deepEqual(
      await identifyFile(
        path.join(carrierDirectory, "controller.log"),
        8 * 1024 ** 2,
      ),
      carrier.log,
    );
    const ownerRaw = await boundedCProducerBytes(
      path.join(carrierDirectory, "owner-frame.json"),
      16 * 1024 ** 2,
    );
    assert.deepEqual(
      { bytes: ownerRaw.length, sha256: sha256(ownerRaw) },
      carrier.ownerFrame,
    );
    const owner = JSON.parse(ownerRaw);
    assert.equal(owner.attempt, receipt.attempt);
    assert.equal(owner.attempt, carrier.ownerAttempt);
    assert.equal(owner.profile, receipt.profile);
    assert.equal(owner.sourceVersion, receipt.sourceVersion);
    assert.equal(owner.catalogSha256, receipt.catalogSha256);
    assert.deepEqual(owner.limits, receipt.limits);
    assert.deepEqual(owner.sourcePins, receipt.sourcePins);
    assert.deepEqual(owner.harnessPins, receipt.harnessPins);
    assert.deepEqual(owner.host.capturedCaller, startup.caller);
    assert.equal(carrier.cleanup.producer.id, receipt.cleanup.id);
    assert.equal(
      carrier.cleanup.retention.id,
      receipt.retentionObserverCleanup.id,
    );
    carrierObservation = {
      receipt: { bytes: carrierRaw.length, sha256: sha256(carrierRaw) },
      ownerFrame: carrier.ownerFrame,
      controllerLog: carrier.log,
      ...(jobCapturePin ? { githubJobClock: jobCapturePin } : {}),
    };
  }
  assert.deepEqual(
    await identifyFile(
      path.join(result, "build.log"),
      profile.limits.logByteLimit,
    ),
    receipt.log,
  );
  assert.equal(receipt.executionObserver.retainedBytes, receipt.log.bytes);
  const observer = await boundedCProducerBytes(
    path.join(result, "retention-observer.jsonl"),
    16 * 1024 ** 2,
  );
  assert.deepEqual(
    { bytes: observer.length, sha256: sha256(observer) },
    receipt.retentionObserver.log,
  );
  reconcileRetentionLog(observer, receipt.retentionObserver);
  assert.deepEqual(
    receipt.finalRetention,
    receipt.retentionObserver.lastSample,
  );
  const allowance =
    profile.files.reduce((sum, row) => sum + row.bytes, 0) +
    receipt.sourcePins
      .filter((row) =>
        [
          "c-producer-build.sh",
          "c-producer-test-reports.py",
          "binutils-retention-observer.py",
          "glibc-seccomp-probe.py",
        ].includes(row.file),
      )
      .reduce((sum, row) => sum + row.bytes, 0) +
    (receipt.generatedControlPins ?? []).reduce(
      (sum, row) => sum + row.bytes,
      0,
    );
  assert.ok(
    receipt.finalRetention.bytes <= profile.limits.workByteLimit + allowance,
  );
  const command = await json(
    path.join(result, "work/original-command.json"),
    4096,
  );
  assert.deepEqual(command, receipt.originalBuild);
  const reports = await readCProducerCopyManifest(
    path.join(result, "work/test-reports.json"),
    startup.caller,
  );
  assert.deepEqual(
    await verifyCProducerReports(
      reports,
      path.join(result, "work/original-test-reports"),
      profile,
      startup.caller,
    ),
    receipt.testEvidence,
  );
  assert.equal(reports.exportCustody.producerEffectiveUid, 0);
  const preflightRoot = path.join(result, "custody-preflight");
  const preflight = await readCProducerCopyManifest(
    path.join(preflightRoot, "test-reports.json"),
    startup.caller,
  );
  assert.equal(preflight.exportCustody.producerEffectiveUid, 0);
  await verifyCProducerReports(
    preflight,
    path.join(preflightRoot, "original-test-reports"),
    (await loadCProducerProfile("glibc")).profile,
    startup.caller,
  );
  assert.deepEqual(
    await identifyFile(path.join(preflightRoot, "test-reports.json"), 65536),
    receipt.custodyPreflight.manifest,
  );
  assert.deepEqual(
    await identifyFile(path.join(result, "custody-preflight.log"), 65536),
    receipt.custodyPreflight.log,
  );
  assert.deepEqual(
    await identifyFile(
      path.join(result, "work/installed-build-package-identities.txt"),
      1024 ** 2,
    ),
    receipt.installedPackageIdentities,
  );
  const outputs = await readdir(path.join(result, "work/output"));
  assert.deepEqual(
    outputs.sort(),
    receipt.outputs.map((row) => row.file).sort(),
  );
  for (const row of receipt.outputs) {
    assert.match(
      row.file,
      /^[A-Za-z0-9][A-Za-z0-9.+_~-]*\.(deb|udeb|changes|buildinfo)$/u,
    );
    assert.deepEqual(
      await identifyFile(
        path.join(result, "work/output", row.file),
        profile.limits.workByteLimit,
      ),
      { bytes: row.bytes, sha256: row.sha256 },
    );
  }
  assert.deepEqual(
    await identifyFile(
      path.join(result, "work/native-build-worktree.tar"),
      profile.limits.workByteLimit,
    ),
    receipt.nativeBuildWorktree,
  );
  assert.deepEqual(
    cProducerCompletion(
      command,
      receipt.executionObserver,
      receipt.outputs,
      receipt.testEvidence,
    ),
    receipt.buildCompletion,
  );
  const value = {
    schemaVersion: 1,
    state: "original-" + name + "-command-observed-qualification-incomplete",
    selectedProfile: startup.selectedProfile,
    carrier: carrierObservation,
    ...summary,
    originalTestEvidenceState: receipt.buildCompletion.testEvidenceState,
    controllerExit,
    startup: { bytes: startupRaw.length, sha256: sha256(startupRaw) },
    originalReceipt: { bytes: receiptRaw.length, sha256: sha256(receiptRaw) },
    physicallyRecheckedPackageOutputs: receipt.outputs,
    physicallyRecheckedNativeArchive: receipt.nativeBuildWorktree,
    packagePayloadAndNativeArchiveTransported: false,
    completeConfigurationInventoryAssessed: false,
  };
  await writeFile(
    path.join(result, "build-observation.json"),
    JSON.stringify(value, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return {
    state: value.state,
    packages: receipt.outputs.length,
    reports: receipt.testEvidence.reports.length,
    gateAComplete: false,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    assert.equal(args[0], "--profile");
    const name = requireCObservationProfile(args[1]);
    if (args.length === 4 && args[2] === "--capture-startup")
      process.stdout.write(
        JSON.stringify(
          await captureCObservationStartup(name, path.resolve(args[3])),
        ) + "\n",
      );
    else {
      assert.ok(
        args.length === (name === "gcc-12" ? 10 : 8) &&
          args[2] === "--result" &&
          args[4] === "--startup" &&
          args[6] === "--controller-exit" &&
          /^[0-9]{1,3}$/u.test(args[7]) &&
          (name !== "gcc-12" || args[8] === "--carrier"),
        "Usage: --profile gcc-12|glibc --capture-startup NEW_FILE | --profile gcc-12|glibc --result RESULT --startup FILE --controller-exit STATUS [--carrier GCC_CARRIER]",
      );
      process.stdout.write(
        JSON.stringify(
          await verifyCLiveObservation(
            name,
            path.resolve(args[3]),
            path.resolve(args[5]),
            Number(args[7]),
            name === "gcc-12" ? path.resolve(args[9]) : null,
          ),
        ) + "\n",
      );
    }
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 2;
  }
}
