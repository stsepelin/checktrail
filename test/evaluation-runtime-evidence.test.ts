import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const harness = await import(
  new URL("../../scripts/evaluation-runtime-evidence.mjs", import.meta.url).href
);
const scope = JSON.parse(
  await readFile(
    new URL("../../docs/gate-a-profiles.v1.json", import.meta.url),
    "utf8",
  ),
);
const profiles = JSON.parse(
  await readFile(
    new URL("../../scripts/required-native-tests.json", import.meta.url),
    "utf8",
  ),
);
const hex = (c: string) => c.repeat(64);
function observed(slot: string) {
  const p = scope.runtimeProfiles.find((p: { id: string }) => p.id === slot);
  return {
    slot,
    node: p.node,
    platform: p.platform,
    architecture: p.architecture,
    osRelease:
      p.platform === "win32"
        ? "10.0.26100"
        : p.platform === "darwin"
          ? "25.1.0"
          : "6.14.0",
    osVersion:
      p.platform === "win32"
        ? "Windows Server 2025 Datacenter"
        : "Original observed OS",
    distributionId: "ubuntu",
    distributionVersion: "24.04",
    distributionSha256: hex("d"),
    imageOS:
      p.platform === "win32"
        ? "win25-vs2026"
        : p.platform === "darwin"
          ? "macos26"
          : "ubuntu24",
    imageVersion: "20261023.1.0",
    containerReference:
      slot === "native-linux-arm64-node22"
        ? "docker.io/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32"
        : null,
    containerImageId:
      slot === "native-linux-arm64-node22" ? "sha256:" + hex("f") : null,
    nodeExecutableSha256: hex("a"),
    systemPowerShellSha256: p.platform === "win32" ? hex("b") : null,
    hostedImageMetadataAttested: false,
    containerImageMetadataAttested: false,
  };
}
test("evaluation runtime requirements preserve all frozen whole-profile callbacks without admitting missing renamed or extra cases", () => {
  const expected = harness.selectEvaluationRuntimeRequirements(profiles, scope);
  assert.equal(expected.length, 9);
  assert.equal(new Set(expected.map((r: { name: string }) => r.name)).size, 9);
  for (const mode of [
    "missing",
    "renamed",
    "extra",
    "file",
    "runtime",
    "duplicate-profile",
  ]) {
    const p = structuredClone(profiles),
      s = structuredClone(scope),
      selected = s.extensionProfiles.find(
        (p: { id: string }) => p.id === "independent-evaluation-protocol",
      );
    if (mode === "missing") p["independent-evaluation-protocol"].pop();
    else if (mode === "renamed")
      p["independent-evaluation-protocol"][0].name += " other";
    else if (mode === "extra")
      p["independent-evaluation-protocol"].push(
        p["independent-evaluation-protocol"][0],
      );
    else if (mode === "file")
      selected.acceptanceFile = "dist/test/other.test.js";
    else if (mode === "runtime") selected.runtime = "other";
    else s.extensionProfiles.push(structuredClone(selected));
    assert.throws(
      () => harness.selectEvaluationRuntimeRequirements(p, s),
      mode,
    );
  }
  assert.equal(Object.isFrozen(harness.evaluationRuntimeHarnessFiles), true);
  assert.equal(
    new Set(harness.evaluationRuntimeHarnessFiles).size,
    harness.evaluationRuntimeHarnessFiles.length,
  );
  for (const required of [
    "docs/gate-a-profiles.v1.json",
    "package-lock.json",
    "dist/test/windows-private-fixture.js",
    "scripts/verify-evaluation-protocol-package.mjs",
    "scripts/compiled-engine-evidence.mjs",
  ])
    assert.ok(
      harness.evaluationRuntimeHarnessFiles.includes(required),
      required,
    );
});
test("evaluation runtime selection rejects every node architecture OS image and native container boundary even outside hosted CI", () => {
  for (const p of scope.runtimeProfiles) {
    const current = observed(p.id);
    assert.deepEqual(
      harness.checkEvaluationRuntimeSelection(scope, p.id, current),
      p,
    );
    for (const key of ["node", "platform", "architecture"]) {
      const changed = structuredClone(current);
      changed[key as "node" | "platform" | "architecture"] = "other";
      assert.throws(
        () => harness.checkEvaluationRuntimeSelection(scope, p.id, changed),
        key,
      );
    }
    const bad = structuredClone(current);
    if (p.platform === "win32") {
      for (const key of [
        "osVersion",
        "osRelease",
        "imageOS",
        "systemPowerShellSha256",
      ]) {
        const changed = { ...current, [key]: "other" };
        assert.throws(
          () => harness.checkEvaluationRuntimeSelection(scope, p.id, changed),
          key,
        );
      }
    } else if (p.platform === "darwin") {
      assert.throws(() =>
        harness.checkEvaluationRuntimeSelection(scope, p.id, {
          ...current,
          osRelease: "24.1.0",
        }),
      );
      assert.throws(() =>
        harness.checkEvaluationRuntimeSelection(scope, p.id, {
          ...current,
          imageOS: "macos15",
        }),
      );
    } else if (p.architecture === "x64") {
      for (const key of ["distributionId", "distributionVersion", "imageOS"])
        assert.throws(
          () =>
            harness.checkEvaluationRuntimeSelection(scope, p.id, {
              ...current,
              [key]: "other",
            }),
          key,
        );
    } else {
      assert.throws(() =>
        harness.checkEvaluationRuntimeSelection(scope, p.id, {
          ...current,
          containerReference: "other",
        }),
      );
      assert.throws(() =>
        harness.checkEvaluationRuntimeSelection(scope, p.id, {
          ...current,
          containerImageId: null,
        }),
      );
    }
    bad.imageVersion = "";
    if (p.id !== "native-linux-arm64-node22")
      assert.throws(() =>
        harness.checkEvaluationRuntimeSelection(scope, p.id, bad),
      );
    else
      assert.throws(() =>
        harness.checkEvaluationRuntimeSelection(scope, p.id, bad, true),
      );
  }
  assert.equal(harness.checkEvaluationRuntimeSelection(scope, null, {}), null);
  assert.throws(() =>
    harness.checkEvaluationRuntimeSelection(scope, null, {}, true),
  );
  assert.throws(() =>
    harness.checkEvaluationRuntimeSelection(scope, "other", {}),
  );
});
function installation() {
  const requirements = harness.selectEvaluationRuntimeRequirements(
    profiles,
    scope,
  );
  const runtime = observed("ci-linux-node22"),
    compiledEngine = {
      schemaVersion: 1,
      fileCount: 123,
      bytes: 456,
      treeSha256: hex("c"),
      manifestSha256: hex("d"),
      beforeAfterByteIdentitiesMatch: true,
      dependencyBytesCaptured: false,
      actualModuleLoadsTraced: false,
      producerSourceBuildVerified: false,
    };
  const profileEvidence = {
    complete: true,
    required: 9,
    passed: 9,
    ledger: {
      truncated: false,
      cases: requirements.map((r: { name: string }) => ({
        name: r.name,
        outcome: "passed",
      })),
    },
  };
  const expected = {
    runtime,
    compiledEngine,
    requirements,
    harnessSha256: hex("e"),
    requirementsSha256: hex("f"),
    packageSha256: hex("a"),
    compiledCodeSha256: hex("b"),
    clientVersion: "2.3.1",
    selectedRuntime: scope.runtimeProfiles.find(
      (p: { id: string }) => p.id === runtime.slot,
    ),
  };
  const receipt = {
    schemaVersion: 1,
    profile: "independent-evaluation-protocol",
    offlineProductionInstall: true,
    lifecycleScriptsExecuted: false,
    harnessOutsideInstalledPackage: true,
    tarballSha256: hex("c"),
    productionDependencyLockSha256: hex("d"),
    harnessSha256: expected.harnessSha256,
    compiledCodeSha256: expected.compiledCodeSha256,
    node: runtime.node,
    platform: runtime.platform,
    architecture: runtime.architecture,
    nodeExecutableSha256: runtime.nodeExecutableSha256,
    externalSdkClientDependencies: { "@modelcontextprotocol/client": "2.3.1" },
    profileEvidence,
    runtimeEvidence: {
      schemaVersion: 1,
      profile: "independent-evaluation-runtime-v1",
      runtime,
      compiledEngine,
      harnessSha256: expected.harnessSha256,
      requirementsSha256: expected.requirementsSha256,
      packageSha256: expected.packageSha256,
      selectedRuntime: expected.selectedRuntime,
      installed: true,
      installedEvidence: null,
      profileEvidence: structuredClone(profileEvidence),
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
      gateAComplete: false,
    },
  };
  return { expected, receipt: structuredClone(receipt) };
}
test("evaluation runtime installation binds all current bytes observations and exact non-skipped terminal cases", () => {
  const { expected, receipt } = installation();
  harness.requireEvaluationRuntimeInstallation(receipt, expected);
  const changes: [
    string,
    (r: ReturnType<typeof installation>["receipt"]) => void,
  ][] = [
    ["outer-schema", (r) => (r.schemaVersion = 2)],
    ["profile", (r) => (r.profile = "other")],
    ["offline", (r) => (r.offlineProductionInstall = false)],
    ["scripts", (r) => (r.lifecycleScriptsExecuted = true)],
    ["outside", (r) => (r.harnessOutsideInstalledPackage = false)],
    ["tarball", (r) => (r.tarballSha256 = "bad")],
    ["lock", (r) => (r.productionDependencyLockSha256 = "bad")],
    ["harness", (r) => (r.harnessSha256 = hex("0"))],
    ["code", (r) => (r.compiledCodeSha256 = hex("0"))],
    ["node", (r) => (r.node = "other")],
    ["platform", (r) => (r.platform = "other")],
    ["architecture", (r) => (r.architecture = "other")],
    ["executable", (r) => (r.nodeExecutableSha256 = hex("0"))],
    [
      "client",
      (r) =>
        (r.externalSdkClientDependencies["@modelcontextprotocol/client"] =
          "2.3.0"),
    ],
    ["schema", (r) => (r.runtimeEvidence.schemaVersion = 2)],
    ["runtime-profile", (r) => (r.runtimeEvidence.profile = "other")],
    ["selected-slot", (r) => (r.runtimeEvidence.selectedRuntime.id = "other")],
    ["source", (r) => (r.runtimeEvidence.installed = false)],
    [
      "recursive",
      (r) => Object.assign(r.runtimeEvidence, { installedEvidence: {} }),
    ],
    ["runtime", (r) => (r.runtimeEvidence.runtime.imageVersion = "other")],
    ["inner-harness", (r) => (r.runtimeEvidence.harnessSha256 = hex("0"))],
    ["requirements", (r) => (r.runtimeEvidence.requirementsSha256 = hex("0"))],
    ["package", (r) => (r.runtimeEvidence.packageSha256 = hex("0"))],
    ["engine", (r) => (r.runtimeEvidence.compiledEngine.treeSha256 = hex("0"))],
    ["engine-size", (r) => r.runtimeEvidence.compiledEngine.bytes++],
    [
      "engine-after",
      (r) =>
        (r.runtimeEvidence.compiledEngine.beforeAfterByteIdentitiesMatch = false),
    ],
    ["count", (r) => (r.profileEvidence.required = 0)],
    ["passed", (r) => (r.profileEvidence.passed = 8)],
    ["incomplete", (r) => (r.profileEvidence.complete = false)],
    ["truncated", (r) => (r.profileEvidence.ledger.truncated = true)],
    [
      "omitted",
      (r) => {
        r.profileEvidence.ledger.cases.pop();
      },
    ],
    [
      "duplicate",
      (r) => {
        r.profileEvidence.ledger.cases[1] = structuredClone(
          r.profileEvidence.ledger.cases[0]!,
        );
      },
    ],
    [
      "skipped",
      (r) => (r.profileEvidence.ledger.cases[0]!.outcome = "skipped"),
    ],
    ["inner-count", (r) => (r.runtimeEvidence.profileEvidence.required = 8)],
    [
      "inner-outcome",
      (r) =>
        (r.runtimeEvidence.profileEvidence.ledger.cases[0]!.outcome =
          "skipped"),
    ],
    ["inference", (r) => (r.runtimeEvidence.inferenceInvoked = true)],
    ["field", (r) => (r.runtimeEvidence.fieldEvaluationExecuted = true)],
    ["gate", (r) => (r.runtimeEvidence.gateAComplete = true)],
  ];
  for (const [name, change] of changes) {
    const changed = structuredClone(receipt);
    change(changed);
    assert.throws(
      () => harness.requireEvaluationRuntimeInstallation(changed, expected),
      name,
    );
  }
  harness.requireEvaluationRuntimeInstallation(receipt, expected);
});
test("evaluation runtime CLI rejects unknown or missing hosted slots before emitting a qualifying receipt", () => {
  const cli = fileURLToPath(
    new URL("../../scripts/verify-evaluation-runtime.mjs", import.meta.url),
  );
  for (const args of [[], ["unknown-slot"], ["ci-linux-node22", "extra"]]) {
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: "true" };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env,
      timeout: 10000,
      maxBuffer: 65536,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes("AssertionError"));
  }
});
