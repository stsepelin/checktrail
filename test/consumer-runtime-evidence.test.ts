import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const moduleUrl = new URL(
  "../../scripts/consumer-runtime-evidence.mjs",
  import.meta.url,
);
const runtimeModule = await import(moduleUrl.href);
const {
  selectConsumerRuntimeRequirements,
  checkConsumerRuntimeSelection,
  requireConsumerRuntimeInstallation,
  consumerRuntimeHarnessFiles,
} = runtimeModule;
const { selectConsumerFoundation, requireConsumerFoundationEvidence } =
  await import(
    new URL("../../scripts/consumer-foundation-evidence.mjs", import.meta.url)
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
    .find((p: { id: string }) => p.id === "consumer-impact")
    .acceptanceCases.map((c: { name: string }) => ({
      file: "dist/test/gate-consumer-impact.test.js",
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
    gitExecutableSha256: "d".repeat(64),
    containerImageId: "sha256:" + "b".repeat(64),
  };
}
test("consumer runtime requirements preserve every frozen case and immutable unique source and installed harness inputs", () => {
  assert.deepEqual(
    selectConsumerRuntimeRequirements(profiles, scope),
    requirements(),
  );
  assert.equal(requirements().length, 9);
  assert.equal(Object.isFrozen(consumerRuntimeHarnessFiles), true);
  assert.equal(
    new Set(consumerRuntimeHarnessFiles).size,
    consumerRuntimeHarnessFiles.length,
  );
  for (const mode of [
    "coherent-renamed-case",
    "coherent-extra-case",
    "coherent-other-file",
  ]) {
    const changedScope = structuredClone(scope),
      changedProfiles = structuredClone(profiles),
      p = changedScope.extensionProfiles.find(
        (p: { id: string }) => p.id === "consumer-impact",
      );
    if (mode === "coherent-renamed-case") {
      p.acceptanceCases[0].name += " changed";
      changedProfiles["consumer-impact"][0].name = p.acceptanceCases[0].name;
    }
    if (mode === "coherent-extra-case") {
      p.acceptanceCases.push({
        id: "extra",
        name: "consumer-impact extra acceptance",
      });
      changedProfiles["consumer-impact"].push({
        file: p.acceptanceFile,
        name: "consumer-impact extra acceptance",
      });
    }
    if (mode === "coherent-other-file") {
      p.acceptanceFile = "dist/test/other.js";
      for (const item of changedProfiles["consumer-impact"])
        item.file = p.acceptanceFile;
    }
    assert.throws(() =>
      selectConsumerRuntimeRequirements(changedProfiles, changedScope),
    );
  }
  for (const alter of [
    (j: typeof scope) =>
      j.extensionProfiles.splice(
        j.extensionProfiles.findIndex(
          (p: { id: string }) => p.id === "consumer-impact",
        ),
        1,
      ),
    (j: typeof scope) => {
      j.extensionProfiles.find(
        (p: { id: string }) => p.id === "consumer-impact",
      ).runtime = "other";
    },
    (j: typeof scope) => {
      j.extensionProfiles.find(
        (p: { id: string }) => p.id === "consumer-impact",
      ).acceptanceCases[0].name += " renamed";
    },
    (j: typeof scope) => {
      j.extensionProfiles
        .find((p: { id: string }) => p.id === "consumer-impact")
        .acceptanceCases.pop();
    },
  ]) {
    const changed = structuredClone(scope);
    alter(changed);
    assert.throws(() => selectConsumerRuntimeRequirements(profiles, changed));
  }
  for (const alter of [
    (p: typeof profiles) => p["consumer-impact"].pop(),
    (p: typeof profiles) => p["consumer-impact"].push(p["consumer-impact"][0]),
    (p: typeof profiles) => {
      p["consumer-impact"][0].file = "dist/test/other.js";
    },
  ]) {
    const changed = structuredClone(profiles);
    alter(changed);
    assert.throws(() => selectConsumerRuntimeRequirements(changed, scope));
  }
});
test("consumer runtime selection rejects wrong Node platform architecture host image and native image boundaries even outside hosted CI", () => {
  for (const p of scope.runtimeProfiles) {
    const valid = observed(p);
    assert.deepEqual(checkConsumerRuntimeSelection(scope, p.id, valid), p);
    for (const field of ["node", "platform", "architecture", "imageOS"]) {
      const changed = { ...valid, [field]: "original-wrong" };
      if (p.id !== "native-linux-arm64-node22" || field !== "imageOS")
        assert.throws(() =>
          checkConsumerRuntimeSelection(scope, p.id, changed),
        );
    }
    for (const bad of [
      { gitExecutableSha256: null },
      { gitVersion: "original malformed version" },
    ])
      assert.throws(() =>
        checkConsumerRuntimeSelection(scope, p.id, { ...valid, ...bad }),
      );
    if (p.platform === "darwin")
      assert.throws(() =>
        checkConsumerRuntimeSelection(scope, p.id, {
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
          checkConsumerRuntimeSelection(scope, p.id, { ...valid, ...change }),
        );
      assert.deepEqual(
        checkConsumerRuntimeSelection(scope, p.id, {
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
          checkConsumerRuntimeSelection(scope, p.id, { ...valid, ...change }),
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
          checkConsumerRuntimeSelection(scope, p.id, { ...valid, ...change }),
        );
      assert.deepEqual(
        checkConsumerRuntimeSelection(scope, p.id, {
          ...valid,
          imageVersion: null,
        }),
        p,
      );
      assert.throws(() =>
        checkConsumerRuntimeSelection(
          scope,
          p.id,
          { ...valid, imageVersion: null },
          true,
        ),
      );
    } else
      assert.throws(() =>
        checkConsumerRuntimeSelection(scope, p.id, {
          ...valid,
          imageVersion: null,
        }),
      );
  }
  assert.equal(checkConsumerRuntimeSelection(scope, null, {}), null);
  assert.throws(() => checkConsumerRuntimeSelection(scope, null, {}, true));
  assert.throws(() =>
    checkConsumerRuntimeSelection(scope, "original-unknown-slot", {}),
  );
});
function foundationObservation() {
  const selection = selectConsumerFoundation(profiles),
    requirements: { file: string; name: string }[] = selection.requirements,
    events: { file: string; name: string }[] = selection.events,
    files = [...new Set(requirements.map((c) => c.file))],
    digests = Object.fromEntries(
      files.map((file, i) => [file, String(i + 1).repeat(64)]),
    ),
    fileId = (file: string) => "file-" + (files.indexOf(file) + 1),
    key = (c: { file: string; name: string }) =>
      JSON.stringify([c.file, c.name]),
    required = new Set(requirements.map(key)),
    evidence = {
      complete: true,
      problems: [],
      required: requirements.length,
      passed: events.length,
      ledger: {
        schemaVersion: 1,
        truncated: false,
        terminalEventCount: events.length,
        files: files.map((file) => ({
          id: fileId(file),
          stable: true,
          before: { state: "present", sha256: digests[file] },
          after: { state: "present", sha256: digests[file] },
        })),
        events: events.map((c, i) => ({
          sequence: i + 1,
          fileId: fileId(c.file),
          name: c.name,
          kind: "test",
          outcome: "passed",
          required: required.has(key(c)),
          nameTruncated: false,
          durationMs: 0,
        })),
        cases: requirements.map((c) => ({
          fileId: fileId(c.file),
          name: c.name,
          outcome: "passed",
          terminalSequences: [events.findIndex((e) => key(e) === key(c)) + 1],
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
    foundationSelection: foundation.selection,
    foundationDigests: foundation.digests,
    foundationRequirementsSha256: "9".repeat(64),
  };
  const receipt = {
    schemaVersion: 1,
    profile: "consumer-impact-whole-installed-v1",
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
    foundationRequirementsSha256: expected.foundationRequirementsSha256,
    gateAConsumerImpactComplete: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
  return { expected, receipt };
}
test("consumer runtime installation binds current runtime engine package harness SDK and exact non-skipped terminal cases without qualifying evaluation", () => {
  const { expected, receipt } = installation();
  assert.doesNotThrow(() =>
    requireConsumerRuntimeInstallation(receipt, expected),
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
    "gateAConsumerImpactComplete",
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
    assert.throws(() => requireConsumerRuntimeInstallation(changed, expected));
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
    assert.throws(() => requireConsumerRuntimeInstallation(changed, expected));
  }
});
test("consumer runtime CLI rejects missing unknown and extra hosted slots before emitting qualifying evidence", () => {
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
          new URL("../../scripts/verify-consumer-runtime.mjs", import.meta.url),
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

test("consumer foundation binds every original top-level and nested control while refusing renamed removed or duplicate source requirements", () => {
  const { selection, digests, evidence } = foundationObservation();
  assert.equal(selection.requirements.length, 18);
  assert.equal(selection.events.length, 45);
  assert.equal(evidence.ledger.events.filter((e) => !e.required).length, 27);
  assert.doesNotThrow(() =>
    requireConsumerFoundationEvidence(evidence, selection, digests),
  );
  for (const mode of ["omit", "duplicate", "rename", "foreign-file"]) {
    const changed = structuredClone(profiles),
      rows = changed["consumer-impact-foundation"];
    if (mode === "omit") rows.pop();
    if (mode === "duplicate") rows[0] = structuredClone(rows[1]);
    if (mode === "rename") rows[0].name += " changed";
    if (mode === "foreign-file") rows[0].file = "dist/test/foreign.test.js";
    assert.throws(() => selectConsumerFoundation(changed));
  }
});
test("consumer foundation rejects missing skipped or extra nested events forged totals foreign files and broken terminal bindings", () => {
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
      e.ledger.truncated = true;
    },
    (e) => {
      e.ledger.terminalEventCount--;
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
      e.ledger.events.at(-1)!.outcome = "skipped";
    },
    (e) => {
      e.ledger.events.at(-1)!.name = "foreign nested control";
    },
    (e) => {
      e.ledger.events.at(-1)!.required = true;
    },
    (e) => {
      e.ledger.events[0]!.required = false;
    },
    (e) => {
      e.ledger.events[0]!.nameTruncated = true;
    },
    (e) => {
      e.ledger.events[0]!.sequence = 2;
    },
    (e) => {
      e.ledger.events[0]!.durationMs = NaN;
    },
    (e) => {
      e.ledger.events[0]!.durationMs = Infinity;
    },
    (e) => {
      e.ledger.events[0]!.durationMs = -1;
    },
    (e) => {
      e.ledger.events[0]!.kind = "suite";
    },
    (e) => {
      e.ledger.events.at(-1)!.fileId = "foreign";
    },
    (e) => {
      e.ledger.files[0]!.stable = false;
    },
    (e) => {
      e.ledger.files[0]!.id = e.ledger.files[1]!.id;
    },
    (e) => {
      e.ledger.files[0]!.before.sha256 = "f".repeat(64);
      e.ledger.files[0]!.after.sha256 = "f".repeat(64);
    },
    (e) => {
      e.ledger.files[0]!.after.sha256 = "f".repeat(64);
    },
    (e) => {
      e.ledger.cases[0]!.terminalSequences = [2];
    },
    (e) => {
      e.ledger.cases[0]!.fileId = "foreign";
    },
    (e) => {
      e.ledger.cases[0] = structuredClone(e.ledger.cases[1]!);
    },
  ];
  for (const edit of edits) {
    const changed = structuredClone(evidence);
    edit(changed);
    assert.throws(() =>
      requireConsumerFoundationEvidence(changed, selection, digests),
    );
  }
  const changed = structuredClone(evidence);
  changed.ledger.events = changed.ledger.events.filter((e) => e.required);
  changed.passed = 45;
  changed.ledger.terminalEventCount = 45;
  assert.throws(
    () => requireConsumerFoundationEvidence(changed, selection, digests),
    "Advertising the original total cannot replace omitted nested controls",
  );
});
test("consumer installation requires the matching foundation even when all whole-feature callbacks pass", () => {
  const { expected, receipt } = installation();
  for (const mode of [
    "missing",
    "wrong-selection",
    "missing-nested",
    "skipped-nested",
    "changed-file",
  ]) {
    const changed = structuredClone(receipt);
    if (mode === "missing")
      Reflect.deleteProperty(changed, "foundationEvidence");
    if (mode === "wrong-selection")
      changed.foundationRequirementsSha256 = "f".repeat(64);
    if (mode === "missing-nested")
      changed.foundationEvidence.ledger.events.pop();
    if (mode === "skipped-nested")
      changed.foundationEvidence.ledger.events.at(-1)!.outcome = "skipped";
    if (mode === "changed-file")
      changed.foundationEvidence.ledger.files[0]!.stable = false;
    assert.throws(() => requireConsumerRuntimeInstallation(changed, expected));
  }
});
