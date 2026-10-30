import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const moduleUrl = new URL(
  "../../scripts/attempt-runtime-evidence.mjs",
  import.meta.url,
);
const runtimeModule = await import(moduleUrl.href);
const {
  selectAttemptRuntimeRequirements,
  checkAttemptRuntimeSelection,
  requireAttemptRuntimeInstallation,
  attemptRuntimeHarnessFiles,
} = runtimeModule;
const { selectAttemptFoundation, requireAttemptFoundationEvidence } =
  await import(
    new URL("../../scripts/attempt-foundation-evidence.mjs", import.meta.url)
      .href
  );
const scope = JSON.parse(
    await readFile(
      new URL("../../docs/gate-a-profiles.v1.json", import.meta.url),
      "utf8",
    ),
  ),
  profiles = JSON.parse(
    await readFile(
      new URL("../../scripts/required-native-tests.json", import.meta.url),
      "utf8",
    ),
  );
function requirements() {
  return scope.extensionProfiles
    .find((p: { id: string }) => p.id === "attempt-archives")
    .acceptanceCases.map((c: { name: string }) => ({
      file: "dist/test/gate-attempt-archives.test.js",
      name: c.name,
    }));
}
function observed(p: {
  id: string;
  node: string;
  platform: string;
  architecture: string;
}) {
  return {
    slot: p.id,
    node: p.node,
    platform: p.platform,
    architecture: p.architecture,
    osVersion:
      p.platform === "win32" ? "Windows Server 2025 Datacenter" : "original",
    osRelease:
      p.platform === "win32"
        ? "10.0.26100"
        : p.platform === "darwin"
          ? "25.1.0"
          : "original",
    distributionId: "ubuntu",
    distributionVersion: "24.04",
    imageOS:
      p.platform === "win32"
        ? "win25"
        : p.platform === "darwin"
          ? "macos26"
          : "ubuntu24",
    imageVersion: "20261023.1.0",
    systemPowerShellSha256: "a".repeat(64),
    containerReference: "sha256:" + "b".repeat(64),
    baseNodeReference:
      "docker.io/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
    baseSystemReference:
      "docker.io/library/golang@sha256:ae5a2316d12f3e78fd99177dad452e6ad4f240af2d71d57b480c3477f250fec6",
    containerDefinitionSha256: "c".repeat(64),
    gitVersion: "git version 2.56.0",
    goVersion: "go1.27.1",
    goPlatform: p.platform === "win32" ? "windows" : p.platform,
    goArchitecture: p.architecture === "x64" ? "amd64" : p.architecture,
    goExecutableSha256: "8".repeat(64),
    gitExecutableSha256: "d".repeat(64),
    containerImageId: "sha256:" + "b".repeat(64),
  };
}
test("attempt runtime requirements preserve every frozen case and immutable unique source and installed harness inputs", () => {
  assert.deepEqual(
    selectAttemptRuntimeRequirements(profiles, scope),
    requirements(),
  );
  assert.equal(requirements().length, 9);
  assert.equal(Object.isFrozen(attemptRuntimeHarnessFiles), true);
  assert.equal(
    new Set(attemptRuntimeHarnessFiles).size,
    attemptRuntimeHarnessFiles.length,
  );
  for (const mode of [
    "coherent-renamed-case",
    "coherent-extra-case",
    "coherent-other-file",
  ]) {
    const changedScope = structuredClone(scope),
      changedProfiles = structuredClone(profiles),
      p = changedScope.extensionProfiles.find(
        (p: { id: string }) => p.id === "attempt-archives",
      );
    if (mode === "coherent-renamed-case") {
      p.acceptanceCases[0].name += " changed";
      changedProfiles["attempt-archives"][0].name = p.acceptanceCases[0].name;
    }
    if (mode === "coherent-extra-case") {
      p.acceptanceCases.push({
        id: "extra",
        name: "attempt-archives extra acceptance",
      });
      changedProfiles["attempt-archives"].push({
        file: p.acceptanceFile,
        name: "attempt-archives extra acceptance",
      });
    }
    if (mode === "coherent-other-file") {
      p.acceptanceFile = "dist/test/other.js";
      for (const item of changedProfiles["attempt-archives"])
        item.file = p.acceptanceFile;
    }
    assert.throws(() =>
      selectAttemptRuntimeRequirements(changedProfiles, changedScope),
    );
  }
  for (const alter of [
    (j: typeof scope) =>
      j.extensionProfiles.splice(
        j.extensionProfiles.findIndex(
          (p: { id: string }) => p.id === "attempt-archives",
        ),
        1,
      ),
    (j: typeof scope) => {
      j.extensionProfiles.find(
        (p: { id: string }) => p.id === "attempt-archives",
      ).runtime = "other";
    },
    (j: typeof scope) => {
      j.extensionProfiles.find(
        (p: { id: string }) => p.id === "attempt-archives",
      ).acceptanceCases[0].name += " renamed";
    },
    (j: typeof scope) => {
      j.extensionProfiles
        .find((p: { id: string }) => p.id === "attempt-archives")
        .acceptanceCases.pop();
    },
  ]) {
    const changed = structuredClone(scope);
    alter(changed);
    assert.throws(() => selectAttemptRuntimeRequirements(profiles, changed));
  }
  for (const alter of [
    (p: typeof profiles) => p["attempt-archives"].pop(),
    (p: typeof profiles) =>
      p["attempt-archives"].push(p["attempt-archives"][0]),
    (p: typeof profiles) => {
      p["attempt-archives"][0].file = "dist/test/other.js";
    },
  ]) {
    const changed = structuredClone(profiles);
    alter(changed);
    assert.throws(() => selectAttemptRuntimeRequirements(changed, scope));
  }
});
test("attempt runtime selection rejects wrong Node platform architecture host image and native image boundaries even outside hosted CI", () => {
  for (const p of scope.runtimeProfiles) {
    const valid = observed(p);
    assert.deepEqual(checkAttemptRuntimeSelection(scope, p.id, valid), p);
    for (const field of ["node", "platform", "architecture", "imageOS"]) {
      const changed = { ...valid, [field]: "original-wrong" };
      if (p.id !== "native-linux-arm64-node22" || field !== "imageOS")
        assert.throws(() => checkAttemptRuntimeSelection(scope, p.id, changed));
    }
    for (const bad of [
      { gitExecutableSha256: null },
      { gitVersion: "original malformed version" },
      { goVersion: "go1.27.2" },
      { goExecutableSha256: null },
      { goPlatform: "foreign" },
      { goArchitecture: "foreign" },
    ])
      assert.throws(() =>
        checkAttemptRuntimeSelection(scope, p.id, { ...valid, ...bad }),
      );
    if (p.platform === "darwin")
      assert.throws(() =>
        checkAttemptRuntimeSelection(scope, p.id, {
          ...valid,
          osRelease: "24.6.0",
        }),
      );
    if (p.platform === "win32") {
      for (const change of [
        { osVersion: "Windows 11 Pro" },
        { osRelease: "10.0.20348" },
        { systemPowerShellSha256: null },
        { imageOS: "win2022" },
      ])
        assert.throws(() =>
          checkAttemptRuntimeSelection(scope, p.id, { ...valid, ...change }),
        );
      assert.deepEqual(
        checkAttemptRuntimeSelection(scope, p.id, {
          ...valid,
          imageOS: "win25-vs2026",
        }),
        p,
      );
    }
    if (p.platform === "linux" && p.architecture === "x64")
      for (const change of [
        { distributionId: "alpine" },
        { distributionVersion: "22.04" },
      ])
        assert.throws(() =>
          checkAttemptRuntimeSelection(scope, p.id, { ...valid, ...change }),
        );
    if (p.id === "native-linux-arm64-node22") {
      for (const change of [
        { containerReference: "node:latest" },
        { containerImageId: null },
        { baseNodeReference: "node:latest" },
        { baseSystemReference: "golang:latest" },
        { containerDefinitionSha256: null },
      ])
        assert.throws(() =>
          checkAttemptRuntimeSelection(scope, p.id, { ...valid, ...change }),
        );
      assert.deepEqual(
        checkAttemptRuntimeSelection(scope, p.id, {
          ...valid,
          imageVersion: null,
        }),
        p,
      );
      assert.throws(() =>
        checkAttemptRuntimeSelection(
          scope,
          p.id,
          { ...valid, imageVersion: null },
          true,
        ),
      );
    } else
      assert.throws(() =>
        checkAttemptRuntimeSelection(scope, p.id, {
          ...valid,
          imageVersion: null,
        }),
      );
  }
  assert.equal(checkAttemptRuntimeSelection(scope, null, {}), null);
  assert.throws(() => checkAttemptRuntimeSelection(scope, null, {}, true));
  assert.throws(() =>
    checkAttemptRuntimeSelection(scope, "original-unknown-slot", {}),
  );
});
function foundationObservation(platform = "linux") {
  const selection = selectAttemptFoundation(profiles, platform),
    requirements: { file: string; name: string }[] = selection.requirements,
    files = [...new Set(requirements.map((c) => c.file))],
    digests = Object.fromEntries(
      files.map((file, i) => [file, String(i + 1).repeat(64)]),
    ),
    fileId = (file: string) => "file-" + (files.indexOf(file) + 1),
    evidence = {
      complete: true,
      problems: [],
      required: requirements.length,
      passed: requirements.length,
      ledger: {
        schemaVersion: 1,
        truncated: false,
        terminalEventCount: requirements.length,
        files: files.map((file) => ({
          id: fileId(file),
          stable: true,
          before: { state: "present", sha256: digests[file] },
          after: { state: "present", sha256: digests[file] },
        })),
        events: requirements.map((c, i) => ({
          sequence: i + 1,
          fileId: fileId(c.file),
          name: c.name,
          kind: "test",
          outcome: "passed",
          required: true,
          nameTruncated: false,
          durationMs: 0,
        })),
        cases: requirements.map((c, i) => ({
          fileId: fileId(c.file),
          name: c.name,
          outcome: "passed",
          terminalSequences: [i + 1],
        })),
      },
    };
  return { selection, digests, evidence };
}
function installation() {
  const foundation = foundationObservation();
  const expected = {
    runtime: observed(scope.runtimeProfiles[0]),
    selectedRuntime: structuredClone(scope.runtimeProfiles[0]),
    harnessSha256: "a".repeat(64),
    requirementsSha256: "b".repeat(64),
    packageSha256: "c".repeat(64),
    acceptanceSha256: "1".repeat(64),
    compiledEngine: {
      schemaVersion: 1,
      fileCount: 2,
      bytes: 50,
      dependencyBytesCaptured: false,
      actualModuleLoadsTraced: false,
      producerSourceBuildVerified: false,
      treeSha256: "d".repeat(64),
      manifestSha256: "e".repeat(64),
      beforeAfterByteIdentitiesMatch: true,
    },
    clientVersion: "2.3.1",
    requirements: requirements(),
    foundationRequirements: foundation.selection.requirements,
    foundationExclusions: foundation.selection.exclusions,
    foundationDigests: foundation.digests,
    foundationRequirementsSha256: "9".repeat(64),
  };
  const receipt = {
    schemaVersion: 1,
    profile: "attempt-archives-whole-installed-v1",
    offlineProductionInstall: true,
    lifecycleScriptsExecuted: false,
    harnessOutsideInstalledPackage: true,
    tarballSha256: "f".repeat(64),
    productionDependencyLockSha256: "0".repeat(64),
    runtime: structuredClone(expected.runtime),
    selectedRuntime: structuredClone(expected.selectedRuntime),
    harnessSha256: expected.harnessSha256,
    requirementsSha256: expected.requirementsSha256,
    packageSha256: expected.packageSha256,
    compiledEngine: structuredClone(expected.compiledEngine),
    externalSdkDependencies: { "@modelcontextprotocol/client": "2.3.1" },
    profileEvidence: {
      complete: true,
      required: 9,
      passed: 9,
      ledger: {
        schemaVersion: 1,
        terminalEventCount: 9,
        files: [
          {
            id: "file-1",
            stable: true,
            before: { state: "present", sha256: expected.acceptanceSha256 },
            after: { state: "present", sha256: expected.acceptanceSha256 },
          },
        ],
        events: requirements().map((c: { name: string }, i: number) => ({
          sequence: i + 1,
          fileId: "file-1",
          name: c.name,
          nameTruncated: false,
          kind: "test",
          outcome: "passed",
          durationMs: 1,
          required: true,
        })),
        truncated: false,
        cases: requirements().map((c: { name: string }, i: number) => ({
          fileId: "file-1",
          terminalSequences: [i + 1],
          name: c.name,
          outcome: "passed",
        })),
      },
    },
    foundationEvidence: foundation.evidence,
    foundationExclusions: foundation.selection.exclusions,
    foundationRequirementsSha256: expected.foundationRequirementsSha256,
    gateAAttemptArchivesComplete: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
  return { expected, receipt };
}
test("attempt runtime installation binds current runtime engine package harness SDK and exact non-skipped terminal cases without qualifying evaluation", () => {
  const { expected, receipt } = installation();
  assert.doesNotThrow(() =>
    requireAttemptRuntimeInstallation(receipt, expected),
  );
  const edits: ((r: Record<string, unknown>) => void)[] = [
    (r) => {
      r.schemaVersion = 2;
    },
    (r) => {
      r.profile = "original-other";
    },
    (r) => {
      r.offlineProductionInstall = false;
    },
    (r) => {
      r.lifecycleScriptsExecuted = true;
    },
    (r) => {
      r.harnessOutsideInstalledPackage = false;
    },
    (r) => {
      r.tarballSha256 = "bad";
    },
    (r) => {
      r.productionDependencyLockSha256 = "bad";
    },
  ];
  for (const field of [
    "runtime",
    "selectedRuntime",
    "harnessSha256",
    "requirementsSha256",
    "packageSha256",
    "compiledEngine",
  ])
    edits.push((r) => {
      r[field] = "different";
    });
  for (const field of [
    "gateAAttemptArchivesComplete",
    "gateAComplete",
    "inferenceInvoked",
    "fieldEvaluationExecuted",
  ])
    edits.push((r) => {
      r[field] = true;
    });
  for (const edit of edits) {
    const changed = structuredClone(receipt);
    edit(changed);
    assert.throws(() => requireAttemptRuntimeInstallation(changed, expected));
  }
  for (const edit of [
    (r: typeof receipt) => {
      r.runtime.node = "0.0.0";
    },
    (r: typeof receipt) => {
      r.runtime.imageVersion = "20261024.1.0";
    },
    (r: typeof receipt) => {
      r.selectedRuntime = structuredClone(scope.runtimeProfiles[1]);
    },
    (r: typeof receipt) => {
      r.harnessSha256 = "2".repeat(64);
    },
    (r: typeof receipt) => {
      r.requirementsSha256 = "2".repeat(64);
    },
    (r: typeof receipt) => {
      r.packageSha256 = "2".repeat(64);
    },
    (r: typeof receipt) => {
      r.compiledEngine.treeSha256 = "2".repeat(64);
    },
    (r: typeof receipt) => {
      r.compiledEngine.manifestSha256 = "2".repeat(64);
    },
    (r: typeof receipt) => {
      r.compiledEngine.beforeAfterByteIdentitiesMatch = false;
    },
    (r: typeof receipt) => {
      r.compiledEngine.fileCount++;
    },
    (r: typeof receipt) => {
      r.compiledEngine.bytes++;
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.files[0]!.stable = false;
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.files[0]!.before.sha256 = "2".repeat(64);
      r.profileEvidence.ledger.files[0]!.after.sha256 = "2".repeat(64);
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.events.pop();
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.events[0]!.outcome = "skipped";
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.events[0]!.sequence =
        r.profileEvidence.ledger.events[1]!.sequence;
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.events[0]!.nameTruncated = true;
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.cases[0].fileId = "other-file";
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.cases[0].terminalSequences = [2];
    },
    (r: typeof receipt) => {
      r.externalSdkDependencies["@modelcontextprotocol/client"] = "0";
    },
    (r: typeof receipt) => {
      r.profileEvidence.complete = false;
    },
    (r: typeof receipt) => {
      r.profileEvidence.required = 8;
    },
    (r: typeof receipt) => {
      r.profileEvidence.passed = 8;
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.truncated = true;
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.cases.pop();
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.cases[0].outcome = "skipped";
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.cases[0].name += " renamed";
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.cases[0] = structuredClone(
        r.profileEvidence.ledger.cases[1],
      );
    },
  ]) {
    const changed = structuredClone(receipt);
    edit(changed);
    assert.throws(() => requireAttemptRuntimeInstallation(changed, expected));
  }
  const zeroDuration = structuredClone(receipt);
  zeroDuration.profileEvidence.ledger.events[0]!.durationMs = 0;
  assert.doesNotThrow(() =>
    requireAttemptRuntimeInstallation(zeroDuration, expected),
  );
  for (const edit of [
    (r: typeof receipt) => {
      r.profileEvidence.ledger.files[0]!.id = "";
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.files.push(
        structuredClone(r.profileEvidence.ledger.files[0]!),
      );
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.files[0]!.after.sha256 = "2".repeat(64);
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.terminalEventCount = 8;
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.events[0]!.fileId = "other-file";
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.events[0]!.kind = "suite";
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.events[0]!.required = false;
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.events[0]!.name =
        r.profileEvidence.ledger.events[1]!.name;
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.events[0]!.sequence = 0;
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.events[0]!.sequence = 10;
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.events[0]!.sequence = 1.5;
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.events[0]!.durationMs = NaN;
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.events[0]!.durationMs = Infinity;
    },
    (r: typeof receipt) => {
      r.profileEvidence.ledger.events[0]!.durationMs = -1;
    },
  ]) {
    const changed = structuredClone(receipt);
    edit(changed);
    assert.throws(() => requireAttemptRuntimeInstallation(changed, expected));
  }
});
test("attempt runtime CLI rejects missing unknown and extra hosted slots before emitting qualifying evidence", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: "true" };
  delete env.NODE_TEST_CONTEXT;
  for (const args of [
    [],
    ["original-unknown-slot"],
    ["ci-linux-node22", "extra"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../scripts/verify-attempt-runtime.mjs", import.meta.url),
        ),
        ...args,
      ],
      { env, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      args.length === 0
        ? /Hosted runtime requires a selected slot/
        : args.length === 1
          ? /Unknown selected runtime slot/
          : /process.argv.length/,
    );
  }
});

test("attempt foundation selects every original journal and physical callback while recording the sole POSIX exclusion on Windows", async () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const { selection, digests, evidence } = foundationObservation(platform);
    assert.equal(selection.requirements.length, platform === "win32" ? 44 : 45);
    assert.equal(selection.exclusions.length, platform === "win32" ? 1 : 0);
    if (platform === "win32")
      assert.match(selection.exclusions[0].reason, /POSIX/);
    assert.doesNotThrow(() =>
      requireAttemptFoundationEvidence(
        evidence,
        selection.requirements,
        digests,
      ),
    );
  }
  for (const profile of [
    "attempt-journal-foundation",
    "attempt-output-foundation",
  ]) {
    for (const mode of ["omit", "duplicate", "rename", "foreign-file"]) {
      const changed = structuredClone(profiles),
        rows = changed[profile];
      if (mode === "omit") rows.pop();
      if (mode === "duplicate") rows[0] = structuredClone(rows[1]);
      if (mode === "rename") rows[0].name += " changed";
      if (mode === "foreign-file") rows[0].file = "dist/test/foreign.test.js";
      assert.throws(() => selectAttemptFoundation(changed, "linux"));
    }
  }
  assert.throws(() => selectAttemptFoundation(profiles, "foreign"));
});
test("attempt foundation refuses forged totals and missing duplicate extra skipped truncated unstable or foreign terminal evidence", () => {
  const { selection, digests, evidence } = foundationObservation();
  const edits: ((e: typeof evidence) => void)[] = [
    (e) => {
      e.complete = false;
    },
    (e) => {
      e.required--;
    },
    (e) => {
      e.passed--;
    },
    (e) => {
      e.ledger.events.pop();
    },
    (e) => {
      e.ledger.events.push(structuredClone(e.ledger.events[0]!));
    },
    (e) => {
      e.ledger.cases.pop();
    },
    (e) => {
      e.ledger.cases[0] = structuredClone(e.ledger.cases[1]!);
    },
    (e) => {
      e.ledger.events[0]!.outcome = "skipped";
    },
    (e) => {
      e.ledger.cases[0]!.outcome = "skipped";
    },
    (e) => {
      e.ledger.events[0]!.nameTruncated = true;
    },
    (e) => {
      e.ledger.truncated = true;
    },
    (e) => {
      e.ledger.events[0]!.sequence = 2;
    },
    (e) => {
      e.ledger.events[0]!.required = false;
    },
    (e) => {
      e.ledger.events[0]!.kind = "suite";
    },
    (e) => {
      e.ledger.events[0]!.durationMs = NaN;
    },
    (e) => {
      e.ledger.events[0]!.durationMs = -1;
    },
    (e) => {
      e.ledger.events[0]!.fileId = "foreign";
    },
    (e) => {
      e.ledger.cases[0]!.fileId = "foreign";
    },
    (e) => {
      e.ledger.cases[0]!.terminalSequences = [2];
    },
    (e) => {
      e.ledger.files[0]!.stable = false;
    },
    (e) => {
      e.ledger.files[0]!.before.sha256 = "f".repeat(64);
      e.ledger.files[0]!.after.sha256 = "f".repeat(64);
    },
    (e) => {
      e.ledger.files[0]!.after.sha256 = "f".repeat(64);
    },
    (e) => {
      e.ledger.files[0]!.id = "";
    },
    (e) => {
      e.ledger.files[0] = structuredClone(e.ledger.files[1]!);
    },
    (e) => {
      e.ledger.files.pop();
    },
    (e) => {
      e.ledger.terminalEventCount--;
    },
    (e) => {
      e.ledger.events[0]!.name = e.ledger.events[1]!.name;
    },
  ];
  for (const edit of edits) {
    const changed = structuredClone(evidence);
    edit(changed);
    assert.throws(() =>
      requireAttemptFoundationEvidence(
        changed,
        selection.requirements,
        digests,
      ),
    );
  }
  const changed = structuredClone(digests);
  changed[selection.requirements[0].file] = "e".repeat(64);
  assert.throws(() =>
    requireAttemptFoundationEvidence(evidence, selection.requirements, changed),
  );
});
test("attempt installation requires the platform-specific foundation and cannot borrow a passing whole-profile count", () => {
  const { expected, receipt } = installation();
  for (const mode of [
    "missing",
    "foreign-selection",
    "foreign-exclusion",
    "foreign-digest",
    "missing-case",
    "skipped-case",
  ]) {
    const changed = structuredClone(receipt);
    if (mode === "missing")
      Reflect.deleteProperty(changed, "foundationEvidence");
    if (mode === "foreign-selection")
      changed.foundationRequirementsSha256 = "f".repeat(64);
    if (mode === "foreign-exclusion")
      changed.foundationExclusions = [
        { file: "foreign", name: "foreign", reason: "foreign" },
      ];
    if (mode === "foreign-digest")
      changed.foundationEvidence.ledger.files[0]!.before.sha256 = "f".repeat(
        64,
      );
    if (mode === "missing-case") changed.foundationEvidence.ledger.cases.pop();
    if (mode === "skipped-case")
      changed.foundationEvidence.ledger.events[0]!.outcome = "skipped";
    assert.throws(() => requireAttemptRuntimeInstallation(changed, expected));
  }
});
