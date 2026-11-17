import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
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
    distributionVersion: "26.04",
    distributionSha256: hex("d"),
    imageOS:
      p.platform === "win32"
        ? "win25-vs2026"
        : p.platform === "darwin"
          ? "macos26"
          : "ubuntu26",
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
    problems: [],
    ledger: {
      schemaVersion: 1,
      truncated: false,
      terminalEventCount: 9,
      files: [
        {
          id: "file-1",
          before: { state: "present", sha256: hex("9") },
          after: { state: "present", sha256: hex("9") },
          stable: true,
        },
      ],
      events: requirements.map((r: { name: string }, index: number) => ({
        sequence: index + 1,
        fileId: "file-1",
        kind: "test",
        name: r.name,
        outcome: "passed",
        nameTruncated: false,
        durationMs: 1,
        required: true,
      })),
      cases: requirements.map((r: { name: string }, index: number) => ({
        fileId: "file-1",
        name: r.name,
        outcome: "passed",
        terminalSequences: [index + 1],
      })),
    },
  };
  const expected = {
    runtime,
    compiledEngine,
    requirements,
    acceptanceSha256: hex("9"),
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
      acceptanceSha256: expected.acceptanceSha256,
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
    ["acceptance-file", (r) => (r.runtimeEvidence.acceptanceSha256 = hex("0"))],
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

test("CI independent evaluation runs each core runtime once keeps consumer-only lanes separate and requires completion", async () => {
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const native = await readFile(
    new URL("../../scripts/verify-tasks-runtime-arm64.mjs", import.meta.url),
    "utf8",
  );
  type MatrixRow = { slot: string; core: boolean; consumer: boolean };
  type Step = { run?: string; if?: string };
  const command =
    "node scripts/verify-evaluation-runtime.mjs ${{ matrix.slot }}";
  const batch =
    "node scripts/verify-required-native-tests.mjs windows-private-access-batch";
  const enabled = (condition: string | undefined, row: MatrixRow) => {
    if (condition === undefined) return true;
    if (condition === "matrix.core") return row.core;
    if (condition === "matrix.consumer") return row.consumer;
    if (condition === "matrix.slot == 'windows-node22'")
      return row.slot === "windows-node22";
    if (condition === "matrix.core && matrix.slot == 'windows-node22'")
      return row.core && row.slot === "windows-node22";
    throw Error("Unknown evaluation matrix condition: " + condition);
  };
  const validate = (candidate: typeof workflow, controller = native) => {
    const job = candidate.jobs["tasks-runtime"];
    const rows: MatrixRow[] = job.strategy.matrix.include;
    const steps: Step[] = job.steps;
    const whole = steps.filter((step) =>
      step.run?.includes("verify-evaluation-runtime.mjs"),
    );
    const acl = steps.filter((step) =>
      step.run?.includes("windows-private-access-batch"),
    );
    assert.equal(whole.length, 1);
    assert.equal(acl.length, 1);
    assert.equal(
      whole[0]!.run,
      command,
      "Whole cohort cannot suppress a failed result",
    );
    assert.equal(
      acl[0]!.run,
      batch,
      "Private access control cannot suppress a failed result",
    );
    const reached = rows.filter((row) => enabled(whole[0]!.if, row));
    assert.deepEqual(
      reached.map((row) => row.slot).sort(),
      scope.runtimeProfiles
        .filter((row: { id: string }) => row.id !== "native-linux-arm64-node22")
        .map((row: { id: string }) => row.id)
        .sort(),
    );
    const consumerOnly = rows.filter((row) => row.consumer && !row.core);
    assert.ok(
      consumerOnly.length > 0,
      "The independent consumer lane must stay represented",
    );
    assert.ok(
      consumerOnly.every((row) => !enabled(whole[0]!.if, row)),
      "Consumer-only lanes do not duplicate the evaluation cohort",
    );
    assert.deepEqual(
      rows.filter((row) => enabled(acl[0]!.if, row)).map((row) => row.slot),
      ["windows-node22"],
    );
    for (const id of ["tasks-runtime", "tasks-runtime-arm64"])
      assert.ok(
        candidate.jobs["ci-complete"].needs.includes(id),
        "Missing required completion dependency: " + id,
      );
    assert.equal(
      controller.split(
        "node scripts/verify-evaluation-runtime.mjs native-linux-arm64-node22",
      ).length - 1,
      1,
    );
    assert.ok(
      controller.includes(
        "assert.equal(evaluationRuntime.profileEvidence.complete, true)",
      ),
    );
    assert.ok(
      controller.includes(
        "evaluationRuntime.installedEvidence.runtimeEvidence.profileEvidence",
      ),
    );
  };
  validate(workflow);
  for (const mode of [
    "missing",
    "duplicate-consumer",
    "duplicate-acl",
    "bypass",
    "completion-host",
    "completion-arm",
    "arm-source",
  ]) {
    const changed = structuredClone(workflow);
    const steps: Step[] = changed.jobs["tasks-runtime"].steps;
    const whole = steps.find((step) => step.run === command)!;
    const acl = steps.find((step) => step.run === batch)!;
    if (mode === "missing") steps.splice(steps.indexOf(whole), 1);
    if (mode === "duplicate-consumer") delete whole.if;
    if (mode === "duplicate-acl") acl.if = "matrix.slot == 'windows-node22'";
    if (mode === "bypass") whole.run += " || true";
    if (mode.startsWith("completion"))
      changed.jobs["ci-complete"].needs = changed.jobs[
        "ci-complete"
      ].needs.filter(
        (id: string) =>
          id !==
          (mode === "completion-host"
            ? "tasks-runtime"
            : "tasks-runtime-arm64"),
      );
    const controller =
      mode === "arm-source"
        ? native.replace(
            "node scripts/verify-evaluation-runtime.mjs native-linux-arm64-node22",
            "node scripts/original-omitted-controller.mjs native-linux-arm64-node22",
          )
        : native;
    assert.throws(() => validate(changed, controller), mode);
  }
  validate(workflow);
});

test("evaluation terminal evidence rejects foreign changed or forged file event and case bindings", () => {
  const { expected, receipt } = installation();
  const baseline = receipt.profileEvidence;
  const requireEvidence = (p: typeof baseline) =>
    harness.requireEvaluationTerminalCases(
      p,
      expected.requirements,
      expected.acceptanceSha256,
    );
  requireEvidence(baseline);
  const changes: [string, (p: typeof baseline) => void][] = [
    ["problems", (p) => p.problems.push("Original unknown problem" as never)],
    ["schema", (p) => (p.ledger.schemaVersion = 2)],
    ["no-file", (p) => p.ledger.files.splice(0)],
    [
      "extra-file",
      (p) => p.ledger.files.push(structuredClone(p.ledger.files[0]!)),
    ],
    ["foreign-hash", (p) => (p.ledger.files[0]!.before.sha256 = hex("0"))],
    ["changed-hash", (p) => (p.ledger.files[0]!.after.sha256 = hex("0"))],
    [
      "coherent-foreign-hash",
      (p) => {
        p.ledger.files[0]!.before.sha256 = hex("0");
        p.ledger.files[0]!.after.sha256 = hex("0");
      },
    ],
    ["unavailable", (p) => (p.ledger.files[0]!.before.state = "unavailable")],
    ["unstable", (p) => (p.ledger.files[0]!.stable = false)],
    ["foreign-file", (p) => (p.ledger.events[0]!.fileId = "other")],
    ["event-count", (p) => (p.ledger.terminalEventCount = 8)],
    ["missing-event", (p) => p.ledger.events.pop()],
    [
      "extra-event",
      (p) => p.ledger.events.push(structuredClone(p.ledger.events[0]!)),
    ],
    ["event-outcome", (p) => (p.ledger.events[0]!.outcome = "skipped")],
    ["event-kind", (p) => (p.ledger.events[0]!.kind = "suite")],
    ["event-required", (p) => (p.ledger.events[0]!.required = false)],
    ["event-name", (p) => (p.ledger.events[0]!.name += " foreign")],
    ["name-truncated", (p) => (p.ledger.events[0]!.nameTruncated = true)],
    ["event-sequence", (p) => (p.ledger.events[0]!.sequence = 2)],
    ["duration", (p) => (p.ledger.events[0]!.durationMs = -1)],
    ["case-file", (p) => (p.ledger.cases[0]!.fileId = "other")],
    ["case-sequence", (p) => (p.ledger.cases[0]!.terminalSequences = [2])],
  ];
  for (const [name, change] of changes) {
    const changed = structuredClone(baseline);
    change(changed);
    assert.throws(() => requireEvidence(changed), name);
    for (const inner of [false, true]) {
      const altered = structuredClone(receipt);
      if (inner) altered.runtimeEvidence.profileEvidence = changed;
      else altered.profileEvidence = changed;
      assert.throws(
        () => harness.requireEvaluationRuntimeInstallation(altered, expected),
        name,
      );
    }
  }
  requireEvidence(baseline);
});

const arm64 = await import(
  new URL("../../scripts/verify-tasks-runtime-arm64.mjs", import.meta.url).href
);
const provenanceApi = await import(
  new URL(
    "../../scripts/native-provenance-runtime-evidence.mjs",
    import.meta.url,
  ).href
);
const provenanceBuild = await import(
  new URL("../../scripts/native-provenance-source-build.mjs", import.meta.url)
    .href
);
function arm64Startup() {
  const digest = (value: unknown) =>
    provenanceApi.provenanceRuntimeHash(JSON.stringify(value));
  const selectedRuntime = scope.runtimeProfiles.find(
    (row: { id: string }) => row.id === "native-linux-arm64-node22",
  );
  const runtime = {
    slot: selectedRuntime.id,
    node: selectedRuntime.node,
    platform: selectedRuntime.platform,
    architecture: selectedRuntime.architecture,
    nodeExecutableSha256: hex("a"),
    containerImageId: "sha256:" + hex("f"),
    selectedRuntime,
  };
  const sourceBinding = { head: "a".repeat(40), worktreeClean: true };
  const tree = {
    schemaVersion: 1,
    fileCount: 1,
    bytes: 42,
    treeSha256: hex("a"),
    manifestSha256: hex("b"),
  };
  const inputSources = [
    { file: "dist/test/synthetic.test.js", bytes: 42, sha256: hex("c") },
  ];
  const requirements = provenanceApi.selectProvenanceRuntimeRequirements(
    profiles,
    scope,
  );
  const inputs = {
    schemaVersion: 1,
    runtime: {
      node: runtime.node,
      platform: runtime.platform,
      architecture: runtime.architecture,
      nodeExecutableSha256: runtime.nodeExecutableSha256,
    },
    configuration: ["tsconfig.json", "package.json", "package-lock.json"].map(
      (file) => ({ file, bytes: 42, sha256: hex("a") }),
    ),
    compiler: ["package.json", "bin/tsc", "lib/tsc.js", "lib/_tsc.js"].map(
      (file) => ({ file, bytes: 42, sha256: hex("b") }),
    ),
    source: { ...tree },
    tests: { ...tree },
    compilerDependencyClosureVerified: false,
  };
  const sourceBuild = {
    schemaVersion: 1,
    state: "current-source-typescript-build-reconciled",
    command: [...provenanceBuild.provenanceBuildCommand],
    sourceBinding,
    inputs,
    sourceInputSha256: digest(inputs),
    compilerExitCode: 0,
    compilerSignal: null,
    currentArtifactsMatchFreshBuild: true,
    engine: { ...tree },
    tests: {
      ...tree,
      treeSha256: digest([["synthetic.test.js", hex("c")]]),
      manifestSha256: digest([
        { file: "synthetic.test.js", bytes: 42, sha256: hex("c") },
      ]),
    },
    compiledTests: inputSources,
    compilerDependencyClosureVerified: false,
    upstreamProducerClosureVerified: false,
  };
  const bindings = {
    sourceBinding,
    inputSources,
    harnessSha256: digest(inputSources),
    requirements,
    requirementsSha256: digest(requirements),
    compiledEngine: { ...tree },
    selectedRuntime,
  };
  const expected = { ...bindings, runtime, sourceBuild, installed: false };
  return {
    packet: { profile: "native-provenance-arm64-startup-v1", expected },
    bindings: structuredClone(bindings),
    imageId: runtime.containerImageId,
  };
}

test("ARM provenance shell leaves all original bare-Node commands separate from Git-dependent startup", () => {
  const legacy = arm64.arm64TasksRuntimeCommand();
  const body = arm64.arm64ProvenanceRuntimeCommand();
  for (const input of [legacy, body]) {
    const shell = spawnSync("sh", ["-n"], {
      input,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(shell.status, 0, shell.stderr);
  }
  const marker = "node --input-type=module <<'CHECKTRAIL_PROVENANCE_STARTUP'\n";
  assert.equal(body.split(marker).length, 2);
  const program = body
    .split(marker)[1]!
    .split("\nCHECKTRAIL_PROVENANCE_STARTUP\n")[0]!;
  const syntax = spawnSync(
    process.execPath,
    ["--input-type=module", "--check"],
    {
      input: program,
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(syntax.status, 0, syntax.stderr);
  const original = [
    "node scripts/verify-tasks-runtime.mjs native-linux-arm64-node22",
    "node scripts/verify-review-runtime.mjs native-linux-arm64-node22",
    "node scripts/verify-review-runtime.mjs native-linux-arm64-node22 confidence-provenance",
    "node scripts/verify-required-native-tests.mjs lifecycle-runtime-bindings",
    "node scripts/verify-lifecycle-platforms.mjs native-linux-arm64-node22",
    "node scripts/verify-evaluation-runtime.mjs native-linux-arm64-node22",
  ];
  assert.equal(
    legacy,
    [
      "set -eu",
      "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache",
      ...original,
    ].join("\n"),
  );
  for (const command of original) {
    assert.equal(
      legacy.split("\n").filter((line: string) => line === command).length,
      1,
      command,
    );
    assert.equal(
      body.split("\n").filter((line: string) => line === command).length,
      0,
      command,
    );
  }
  const provenanceCommand =
    "node scripts/verify-native-provenance-runtime.mjs native-linux-arm64-node22";
  assert.equal(
    body.split("\n").filter((line: string) => line === provenanceCommand)
      .length,
    1,
  );
  assert.ok(!legacy.includes(provenanceCommand));
  assert.ok(!legacy.includes("CHECKTRAIL_PROVENANCE_STARTUP"));
  assert.ok(!legacy.includes("git"));
  assert.ok(body.includes("/prepared-cache /tmp/npm-cache >/dev/null"));
  assert.ok(
    program.includes(
      "observeProvenanceSourceBuild('/workspace',sourceBinding)",
    ),
  );
  assert.ok(
    body.includes('exec /usr/bin/git -c safe.directory=/workspace "$@"'),
  );
  assert.ok(!body.includes("safe.directory=*"));
  assert.ok(!body.includes("CHECKTRAIL_NATIVE_PROVENANCE_RUNTIME_RECEIPT"));
});

test("ARM provenance image binds the actual derived image, definition and both pinned ARM64 bases", async () => {
  const definition = await arm64.captureArm64ProvenanceImageDefinition(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const { consumerRuntimeBaseImages } = await import(
    new URL("../../scripts/consumer-runtime-selection.mjs", import.meta.url)
      .href
  );
  const bases = {
    node: {
      reference: consumerRuntimeBaseImages.node,
      image: { Id: "sha256:" + hex("b"), Os: "linux", Architecture: "arm64" },
    },
    system: {
      reference: consumerRuntimeBaseImages.system,
      image: { Id: "sha256:" + hex("c"), Os: "linux", Architecture: "arm64" },
    },
  };
  const image = {
    Id: "sha256:" + hex("d"),
    Os: "linux",
    Architecture: "arm64",
  };
  const bound = arm64.bindArm64ProvenanceImage(definition, bases, image);
  assert.deepEqual(bound.definition, definition);
  assert.equal(bound.imageId, image.Id);
  assert.deepEqual(bound.baseImages, {
    node: {
      reference: consumerRuntimeBaseImages.node,
      imageId: bases.node.image.Id,
    },
    system: {
      reference: consumerRuntimeBaseImages.system,
      imageId: bases.system.image.Id,
    },
  });
  for (const mutate of [
    (v: typeof bases) => {
      v.node.reference = consumerRuntimeBaseImages.system;
    },
    (v: typeof bases) => {
      v.system.image.Architecture = "amd64";
    },
    (v: typeof bases) => {
      v.node.image.Os = "darwin";
    },
    (v: typeof bases) => {
      v.system.image.Id = "unobserved";
    },
  ]) {
    const changed = structuredClone(bases);
    mutate(changed);
    assert.throws(() =>
      arm64.bindArm64ProvenanceImage(definition, changed, image),
    );
  }
  assert.throws(() =>
    arm64.bindArm64ProvenanceImage({ ...definition, sha256: "" }, bases, image),
  );
  assert.throws(() =>
    arm64.bindArm64ProvenanceImage(definition, bases, bases.node.image),
  );
  assert.throws(() =>
    arm64.bindArm64ProvenanceImage(definition, bases, {
      ...image,
      Architecture: "amd64",
    }),
  );
});

test("ARM split containers retain identical isolation budgets and distinct actual image IDs", () => {
  const common = {
    task: "synthetic-arm64",
    preparedCache: "/synthetic-public-cache",
  };
  const legacy = arm64.arm64RuntimeRunArguments({
    ...common,
    name: "legacy",
    imageId: "sha256:" + hex("b"),
    imageReference: arm64.arm64RuntimeReference,
    command: arm64.arm64TasksRuntimeCommand(),
  });
  const derived = arm64.arm64RuntimeRunArguments({
    ...common,
    name: "provenance",
    imageId: "sha256:" + hex("d"),
    imageReference: "sha256:" + hex("d"),
    command: arm64.arm64ProvenanceRuntimeCommand(),
  });
  for (const args of [legacy, derived]) {
    for (const [option, value] of [
      ["--network", "none"],
      ["--user", "65532:65532"],
      ["--cpus", "2"],
      ["--memory", "3g"],
      ["--pids-limit", "256"],
      ["--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=2048m,mode=1777"],
    ]) {
      assert.equal(args.filter((x: string) => x === option).length, 1);
      assert.equal(args[args.indexOf(option) + 1], value);
    }
    assert.ok(args.includes("--read-only"));
    assert.ok(
      args.some((x: string) => x.endsWith(",target=/workspace,readonly")),
    );
    assert.ok(
      args.includes(
        "type=bind,src=/synthetic-public-cache,target=/prepared-cache,readonly",
      ),
    );
  }
  assert.deepEqual(legacy.slice(-4), [
    "sha256:" + hex("b"),
    "sh",
    "-c",
    arm64.arm64TasksRuntimeCommand(),
  ]);
  assert.deepEqual(derived.slice(-4), [
    "sha256:" + hex("d"),
    "sh",
    "-c",
    arm64.arm64ProvenanceRuntimeCommand(),
  ]);
  assert.ok(
    legacy.includes("CHECKTRAIL_REVIEW_RUNTIME_IMAGE_ID=sha256:" + hex("b")),
  );
  assert.ok(
    derived.includes("CHECKTRAIL_REVIEW_RUNTIME_IMAGE_ID=sha256:" + hex("d")),
  );
  assert.ok(
    legacy.includes(
      "CHECKTRAIL_EVAL_RUNTIME_IMAGE_REFERENCE=" + arm64.arm64RuntimeReference,
    ),
  );
  assert.ok(
    derived.includes(
      "CHECKTRAIL_EVAL_RUNTIME_IMAGE_REFERENCE=sha256:" + hex("d"),
    ),
  );
});

test("ARM startup admits synthetic inner build bindings and refuses host runtime or changed source build inputs", () => {
  const { packet, bindings, imageId } = arm64Startup();
  assert.equal(
    arm64.requireArm64ProvenanceStartup(packet, bindings, imageId),
    packet.expected,
  );
  const changes: [string, (value: typeof packet) => void][] = [
    [
      "outer host Node",
      (v) => {
        v.expected.runtime.node = "22.23.3";
      },
    ],
    [
      "neighboring slot",
      (v) => {
        v.expected.runtime.slot = "ci-linux-node22";
      },
    ],
    [
      "foreign arch",
      (v) => {
        v.expected.runtime.architecture = "x64";
      },
    ],
    [
      "foreign OS",
      (v) => {
        v.expected.runtime.platform = "darwin";
      },
    ],
    [
      "foreign image",
      (v) => {
        v.expected.runtime.containerImageId = "sha256:" + hex("e");
      },
    ],
    [
      "dirty source",
      (v) => {
        v.expected.sourceBinding.worktreeClean = false;
      },
    ],
    [
      "foreign source",
      (v) => {
        v.expected.sourceBinding.head = "b".repeat(40);
      },
    ],
    [
      "changed harness",
      (v) => {
        v.expected.inputSources[0]!.sha256 = hex("e");
      },
    ],
    [
      "changed ledger",
      (v) => {
        v.expected.requirementsSha256 = hex("e");
      },
    ],
    [
      "foreign compiled tree",
      (v) => {
        v.expected.compiledEngine.treeSha256 = hex("e");
      },
    ],
    [
      "stale build",
      (v) => {
        v.expected.sourceBuild.currentArtifactsMatchFreshBuild = false;
      },
    ],
    [
      "failed compiler",
      (v) => {
        v.expected.sourceBuild.compilerExitCode = 1;
      },
    ],
    [
      "other compiler runtime",
      (v) => {
        v.expected.sourceBuild.inputs.runtime.node = "22.23.3";
      },
    ],
    [
      "changed compiler bytes",
      (v) => {
        v.expected.sourceBuild.inputs.compiler[0]!.sha256 = hex("e");
      },
    ],
    [
      "wrong fresh test emit",
      (v) => {
        v.expected.sourceBuild.tests.treeSha256 = hex("e");
      },
    ],
  ];
  for (const [name, change] of changes) {
    const changed = structuredClone(packet);
    change(changed);
    assert.throws(
      () => arm64.requireArm64ProvenanceStartup(changed, bindings, imageId),
      name,
    );
  }
  assert.throws(() =>
    arm64.requireArm64ProvenanceCompletion(
      { complete: true, selectedSlotQualified: true },
      packet.expected,
    ),
  );
});

test("ARM raw packet framing preserves receipt bytes and rejects blank malformed or extra output", () => {
  const raw = ' { "complete": false } \n';
  assert.deepEqual(arm64.splitArm64RuntimePackets(raw), [
    { raw, packet: { complete: false } },
  ]);
  assert.deepEqual(arm64.splitArm64RuntimePackets(""), []);
  for (const changed of ["\n", "{}\n\n", "broken\n", "{}\n".repeat(10)])
    assert.throws(() => arm64.splitArm64RuntimePackets(changed));
});

test("ARM host publication forwards exact child bytes and keeps the original child failure on capture errors", async () => {
  const { packet, bindings, imageId } = arm64Startup();
  const raw = ' { "complete": false, "synthetic": "incomplete" } \n';
  const output = "{}\n".repeat(7) + JSON.stringify(packet) + "\n" + raw;
  const destination = "/synthetic/host-receipt.json";
  const calls: unknown[][] = [];
  const publish = async (...args: unknown[]) => {
    calls.push(args);
    return {
      bytes: Buffer.byteLength(raw),
      sha256: hex("a"),
      complete: false,
      selectedSlotQualified: false,
    };
  };
  const result = await arm64.captureArm64ProvenanceOutput(
    output,
    bindings,
    imageId,
    destination,
    undefined,
    publish,
  );
  assert.equal(result.receipt.complete, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [Buffer.from(raw), destination, packet.expected]);
  assert.equal(
    await arm64.publishArm64ProvenanceReceipt(
      raw,
      undefined,
      packet.expected,
      publish,
    ),
    null,
  );
  assert.equal(calls.length, 1);
  const childFailure = new Error("synthetic original container failure");
  await assert.rejects(
    arm64.captureArm64ProvenanceOutput(
      output,
      bindings,
      imageId,
      destination,
      childFailure,
      publish,
    ),
    (error: unknown) => error === childFailure,
  );
  assert.equal(calls.length, 2);
  for (const malformed of [
    "broken\n",
    output.replace(packet.profile, "foreign-startup"),
  ]) {
    const failed = new Error("synthetic child error") as Error & {
      provenanceCaptureFailure?: Error;
    };
    await assert.rejects(
      arm64.captureArm64ProvenanceOutput(
        malformed,
        bindings,
        imageId,
        destination,
        failed,
        publish,
      ),
      (error: unknown) => error === failed,
    );
    assert.ok(failed.provenanceCaptureFailure instanceof Error);
  }
  const denied = new Error("synthetic publication refusal");
  const failed = new Error("synthetic child error") as Error & {
    provenanceCaptureFailure?: Error;
  };
  const refuse = async () => {
    throw denied;
  };
  await assert.rejects(
    arm64.captureArm64ProvenanceOutput(
      output,
      bindings,
      imageId,
      destination,
      failed,
      refuse,
    ),
    (error: unknown) => error === failed,
  );
  assert.equal(failed.provenanceCaptureFailure, denied);
  await assert.rejects(
    arm64.captureArm64ProvenanceOutput(
      output,
      bindings,
      imageId,
      destination,
      undefined,
      refuse,
    ),
    (error: unknown) => error === denied,
  );
});

test("ARM positive packet waits for natural completion and qualification before the publisher is called", async () => {
  const { packet, bindings, imageId } = arm64Startup();
  const raw = ' { "complete": true, "synthetic": "positive" } \n';
  const output = "{}\n".repeat(7) + JSON.stringify(packet) + "\n" + raw;
  const destination = "/synthetic/host-positive-receipt.json";
  const calls: unknown[][] = [];
  const events: string[] = [];
  const publish = async (...args: unknown[]) => {
    events.push("published");
    calls.push(args);
    return { complete: true, selectedSlotQualified: true };
  };
  const failed = new Error("synthetic failure after positive output");
  await assert.rejects(
    arm64.captureArm64ProvenanceOutput(
      output,
      bindings,
      imageId,
      destination,
      failed,
      publish,
    ),
    (error: unknown) => error === failed,
  );
  assert.deepEqual(
    calls,
    [],
    "A failed container cannot publish its positive packet",
  );
  const captured = await arm64.captureArm64ProvenanceOutput(
    output,
    bindings,
    imageId,
    destination,
    undefined,
    publish,
  );
  assert.equal(captured.receipt, null);
  assert.deepEqual(
    calls,
    [],
    "Capturing a positive packet does not qualify it",
  );
  const changedBindings = structuredClone(bindings);
  changedBindings.harnessSha256 = hex("e");
  await assert.rejects(
    arm64.publishQualifiedArm64ProvenanceReceipt(
      raw,
      destination,
      packet.expected,
      async () => {
        assert.deepEqual(changedBindings, bindings, "Outer freshness mismatch");
      },
      publish,
    ),
    /Outer freshness mismatch/,
  );
  assert.deepEqual(
    calls,
    [],
    "Changed outer bindings cannot publish a positive receipt",
  );
  const result = await arm64.publishQualifiedArm64ProvenanceReceipt(
    raw,
    destination,
    packet.expected,
    async () => {
      events.push("qualification-started");
      await Promise.resolve();
      assert.deepEqual(structuredClone(bindings), bindings);
      events.push("qualification-completed");
    },
    publish,
  );
  assert.equal(result.complete, true);
  assert.deepEqual(events, [
    "qualification-started",
    "qualification-completed",
    "published",
  ]);
  assert.deepEqual(calls, [[Buffer.from(raw), destination, packet.expected]]);
});

test("ARM main publishes positive provenance after prior profile checks and runs completion and outer freshness inside qualification", async () => {
  const controller = await readFile(
    new URL("../../scripts/verify-tasks-runtime-arm64.mjs", import.meta.url),
    "utf8",
  );
  const publishAt = controller.indexOf(
    "nativeProvenanceReceipt = await publishQualifiedArm64ProvenanceReceipt(",
  );
  const baselineAt = controller.indexOf(
    "lifecycleInstalled.evidence.compiledEngine.treeSha256,",
  );
  assert.ok(baselineAt > 0 && publishAt > baselineAt);
  const afterPublicationCall = controller.slice(publishAt);
  const callbackStart = afterPublicationCall.indexOf("async () => {");
  const callbackEnd = afterPublicationCall.indexOf("\n      },\n    );");
  assert.ok(callbackStart > 0 && callbackEnd > callbackStart);
  const qualification = afterPublicationCall.slice(callbackStart, callbackEnd);
  assert.ok(qualification.includes("requireArm64ProvenanceCompletion("));
  assert.ok(
    qualification.includes("await captureArm64ProvenanceBindings(root)"),
  );
  assert.ok(
    qualification.includes(
      "Outer source/harness/compiled bytes changed during ARM qualification",
    ),
  );
});
