import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const {
  callbackIdentities,
  captureBaselineRuntime,
  requireBaselineToolVersions,
  captureBaselineSourceExecution,
  assertInstalledEngineBinding,
  prepareBaselineHarness,
  selectBaselineCohort,
} = await import(
  new URL("../../scripts/preserved-baseline-evidence.mjs", import.meta.url).href
);
const { captureCompiledEngine } = await import(
  new URL("../../scripts/compiled-engine-evidence.mjs", import.meta.url).href
);
const { installAcceptancePackage, runAcceptanceNpm } = await import(
  new URL("../../scripts/install-acceptance-package.mjs", import.meta.url).href
);
const { runFreshBaselineAtInstallation } = await import(
  new URL(
    "../../scripts/preserved-baseline-fresh-coordinator.mjs",
    import.meta.url,
  ).href
);
const runtime = {
  platform: process.platform,
  nodeMajor: Number(process.versions.node.split(".")[0]),
  tools: {},
};
const caseName =
  "original synthetic callback observes physical module and a valid near miss";
const callback =
  [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { fileURLToPath } from 'node:url';",
    "import { value, location } from '../src/index.js';",
    "test(" + JSON.stringify(caseName) + ", () => {",
    "assert.equal(value, 42);",
    "assert.equal(value === 41, false);",
    "assert.equal(fileURLToPath(location), process.env.CHECKTRAIL_BASELINE_UNIT_PHYSICAL);",
    "});",
  ].join("\n") + "\n";
const profiles = {
  alpha: [{ file: "dist/test/original.test.js", name: caseName }],
  overlapping: [{ file: "dist/test/original.test.js", name: caseName }],
};

test("preserved baseline registry retains frozen original callbacks, finite applicability and fails unavailable adapters", async () => {
  const host = await selectBaselineCohort(repository, "host-core");
  assert.deepEqual(host.selection, [
    "core",
    "javascript",
    "python",
    "frameworks",
    "go",
    "go-matrix",
    "php-tools",
    "rust",
    "native-acceptance-ledger",
    "native-process-observer",
  ]);
  const review = await selectBaselineCohort(repository, "packaged-review");
  assert.equal(review.selection.length, 15);
  assert.equal(review.cohort.nodeVersion, "22.23.2");
  assert.equal(review.cohort.gitVersion, "2.47.3");
  assert.equal(
    review.cohort.sourceCommand,
    "node scripts/verify-review-container.mjs",
  );
  await assert.rejects(
    selectBaselineCohort(repository, "review"),
    /Unknown preserved baseline cohort/,
  );
  await assert.rejects(
    selectBaselineCohort(repository, "ruby"),
    /adapter is not implemented/,
  );
  const frozen = JSON.parse(
    await readFile(
      path.join(repository, "docs/gate-a-native-baseline.v1.json"),
      "utf8",
    ),
  );
  for (const selection of [host, review]) {
    for (const name of selection.selection)
      assert.deepEqual(selection.profiles[name], frozen[name]);
  }
});

test("baseline runtime observes physical executable bytes and refuses missing tools and wrong selectors", async () => {
  const observed = await captureBaselineRuntime(runtime);
  const executable = await readFile(await realpath(process.execPath));
  assert.equal(
    observed.node.sha256,
    createHash("sha256").update(executable).digest("hex"),
  );
  assert.equal(observed.node.version, process.version);
  assert.equal(observed.arch, process.arch);
  await assert.rejects(
    captureBaselineRuntime({
      ...runtime,
      tools: { "checktrail-nonexistent-baseline-tool": ["--version"] },
    }),
    /tool is unavailable/,
  );
  await assert.rejects(
    captureBaselineRuntime({ ...runtime, nodeMajor: runtime.nodeMajor + 1 }),
    /Node selector is inapplicable/,
  );
  await assert.rejects(
    captureBaselineRuntime({
      ...runtime,
      platform: process.platform === "linux" ? "darwin" : "linux",
    }),
    /platform is inapplicable/,
  );
});

test("baseline version binding accepts observed CLI outputs and rejects neighboring patch and minor tokens", async () => {
  const { cohort } = await selectBaselineCohort(repository, "host-core");
  const tools = {
    go: { version: "go version go1.27.1 linux/amd64" },
    python3: { version: "Python 3.13.12" },
    php: { version: "PHP 8.5.4 (cli) (built: synthetic)" },
    rustc: { version: "rustc 1.98.1 (synthetic)" },
    staticcheck: { version: "staticcheck 2026.2.1 (0.8.1)" },
    "golangci-lint": { version: "2.13.2" },
  };
  assert.doesNotThrow(() => requireBaselineToolVersions(cohort, tools));
  for (const [tool, version] of [
    ["go", "go version go1.27.10 linux/amd64"],
    ["go", "go version go1.27.1-custom linux/amd64"],
    ["staticcheck", "staticcheck 2026.2.1 (0.8.10)"],
    ["golangci-lint", "2.13.20"],
    ["python3", "Python 3.130.1"],
    ["php", "PHP 8.50.1 (cli)"],
    ["rustc", "rustc 1.98.10 (synthetic)"],
  ]) {
    assert.throws(
      () =>
        requireBaselineToolVersions(cohort, {
          ...tools,
          [tool!]: { version },
        }),
      /tool (version differs|differs from existing selector)/,
    );
  }
});

test("real offline fresh install retains exact original callback union and physical engine with broken skip stale and fallback refusals", async (t) => {
  const manifest = {
    name: "@stsepelin/checktrail",
    version: "0.0.0",
    type: "module",
    dependencies: {},
    files: ["dist/src"],
  };
  const root = await fixture(t, {
    "package.json": JSON.stringify(manifest),
    "package-lock.json": JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      packages: {
        "": {
          name: manifest.name,
          version: manifest.version,
          dependencies: {},
        },
      },
    }),
    "dist/src/index.js":
      "export const value = 42;\nexport const location = import.meta.url;\n",
    "dist/test/original.test.js": callback,
  });
  await mkdir(path.join(root, "node_modules"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "package.json", "package-lock.json"], {
    cwd: root,
  });
  const output = await fixture(t, {});
  const packed = JSON.parse(
    runAcceptanceNpm(
      [
        "pack",
        "--offline",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        output,
      ],
      { cwd: root, encoding: "utf8", timeout: 30000 },
    ),
  );
  const consumer = path.join(output, "consumer");
  const install = await installAcceptancePackage(
    root,
    path.join(output, packed[0].filename),
    consumer,
  );
  assert.equal(install.offlineProductionInstall, true);
  assert.equal(install.lifecycleScriptsExecuted, false);
  const installedPackage = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail",
  );
  const harness = path.join(output, "harness");
  await prepareBaselineHarness({ repository: root, harness, installedPackage });
  assert.equal(
    await readFile(path.join(harness, "dist/test/original.test.js"), "utf8"),
    callback,
  );
  assert.equal(
    await realpath(path.join(harness, "dist/src")),
    await realpath(path.join(installedPackage, "dist/src")),
  );
  const callbacks = await callbackIdentities(root, profiles, [
    "alpha",
    "overlapping",
  ]);
  assert.equal(callbacks.uniqueCallbacks, 1);
  assert.equal(callbacks.memberships, 2);
  const engine = await captureCompiledEngine(path.join(root, "dist/src"));
  const worker = path.join(repository, "scripts/preserved-baseline-worker.mjs");
  const expectedSourceScope = {
    profiles,
    selection: ["alpha", "overlapping"],
    additionalFiles: [],
    baselineProfiles: profiles,
    baselineSelection: ["alpha", "overlapping"],
    binding: runtime,
    sourceContract: { kind: "required-profiles", maxTerminalEvents: 4096 },
  };
  let counter = 0;
  const run = async (
    fresh: boolean,
    expectedCallbacks = callbacks,
    expectedEngine = engine,
    sourceCapture?: object,
    phaseProfiles = profiles,
  ) => {
    const currentRoot = fresh ? harness : root;
    const input = path.join(output, "input-" + ++counter + ".json");
    await writeFile(
      input,
      JSON.stringify({
        root: currentRoot,
        profiles: phaseProfiles,
        selection: ["alpha", "overlapping"],
        expectedCallbacks,
        expectedEngine,
        binding: runtime,
        timeoutMs: 10000,
        ...(sourceCapture
          ? {
              mode: "fresh-from-original-source",
              sourceCapture,
              expectedSourceScope,
              sourceRoot: root,
            }
          : {}),
        ...(fresh
          ? { installedPackage, sourceEngine: path.join(root, "dist/src") }
          : {}),
      }),
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [worker, input], {
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...env,
        CHECKTRAIL_BASELINE_UNIT_PHYSICAL: await realpath(
          path.join(fresh ? installedPackage : root, "dist/src/index.js"),
        ),
      },
    });
  };
  const source = await run(false),
    fresh = await run(true);
  assert.equal(source.status, 0, source.stderr);
  assert.equal(fresh.status, 0, fresh.stderr);
  for (const result of [JSON.parse(source.stdout), JSON.parse(fresh.stdout)]) {
    assert.equal(result.complete, true);
    assert.equal(result.required, 1, "Shared original callback executes once");
    assert.deepEqual(result.profiles, [
      { profile: "alpha", required: 1 },
      { profile: "overlapping", required: 1 },
    ]);
    assert.equal(result.ledger.cases[0].outcome, "passed");
    assert.equal(result.beforeAfterRuntimeIdentitiesMatch, true);
  }
  assert.equal(
    JSON.parse(fresh.stdout).physicalBinding.physicallyInstalled,
    true,
  );
  assert.deepEqual(
    JSON.parse(source.stdout).runtime,
    JSON.parse(fresh.stdout).runtime,
  );

  let sourceInvocations = 0;
  const sourceCapture = await captureBaselineSourceExecution({
    root,
    ...expectedSourceScope,
    execute: async () => {
      sourceInvocations++;
      const observed = await run(false);
      assert.equal(observed.status, 0, observed.stderr);
      return JSON.parse(observed.stdout);
    },
  });
  const reused = await run(true, callbacks, engine, sourceCapture);
  assert.equal(reused.status, 0, reused.stderr);
  const reusedReport = JSON.parse(reused.stdout);
  assert.equal(
    sourceInvocations,
    1,
    "Fresh reuse must not run source callbacks",
  );
  assert.equal(reusedReport.sourceCallbacksReexecuted, false);
  assert.equal(reusedReport.sourceAndFreshSubsetComplete, true);
  assert.equal(reusedReport.fresh.physicalBinding.physicallyInstalled, true);
  assert.equal(reusedReport.wholeSuiteQualification, false);
  for (const name of [
    "preserved-baseline-worker.mjs",
    "preserved-baseline-evidence.mjs",
    "compiled-engine-evidence.mjs",
    "required-test-evidence.mjs",
  ]) {
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(
      path.join(root, "scripts", name),
      await readFile(path.join(repository, "scripts", name)),
    );
    execFileSync("git", ["add", "scripts/" + name], { cwd: root });
  }
  const coordinatedHarness = path.join(output, "coordinated-harness");
  let freshLaunches = 0;
  const coordinated = await runFreshBaselineAtInstallation({
    repository: root,
    sourceCapture,
    expectedSourceScope,
    installedPackage,
    harness: coordinatedHarness,
    launchWorker: async ({
      harness: workerRoot,
      inputFile,
      worker: workerFile,
    }: {
      harness: string;
      inputFile: string;
      worker: string;
    }) => {
      freshLaunches++;
      const input = JSON.parse(await readFile(inputFile, "utf8"));
      assert.equal(input.mode, "fresh-from-original-source");
      assert.equal(input.sourceCapture.originalExecutionInvocations, 1);
      assert.deepEqual(input.expectedSourceScope, expectedSourceScope);
      assert.equal(input.installedPackage, installedPackage);
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, [workerFile, inputFile], {
        cwd: workerRoot,
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...env,
          CHECKTRAIL_BASELINE_UNIT_PHYSICAL: await realpath(
            path.join(installedPackage, "dist/src/index.js"),
          ),
        },
      });
      assert.equal(child.status, 0, child.stderr);
      return child.stdout;
    },
  });
  assert.equal(freshLaunches, 1);
  assert.equal(
    sourceInvocations,
    1,
    "Fresh coordinator must not replay original source",
  );
  assert.equal(coordinated.fresh.physicalBinding.physicallyInstalled, true);
  await assert.rejects(lstat(coordinatedHarness), { code: "ENOENT" });
  await assert.rejects(lstat(coordinatedHarness + ".input.json"), {
    code: "ENOENT",
  });
  assert.ok(
    (await lstat(installedPackage)).isDirectory(),
    "Controller's shared fresh installation remains for original CLI/MCP checks",
  );
  const refusedHarness = path.join(output, "refused-coordinated-harness");
  await assert.rejects(
    runFreshBaselineAtInstallation({
      repository: root,
      sourceCapture,
      expectedSourceScope,
      installedPackage,
      harness: refusedHarness,
      launchWorker: () =>
        JSON.stringify({ ...coordinated, sourceCallbacksReexecuted: true }),
    }),
    /true.*false/s,
  );
  await assert.rejects(lstat(refusedHarness), { code: "ENOENT" });
  await assert.rejects(lstat(refusedHarness + ".input.json"), {
    code: "ENOENT",
  });
  const occupiedHarness = path.join(output, "occupied-harness");
  await mkdir(occupiedHarness);
  await writeFile(
    path.join(occupiedHarness, "sentinel"),
    "keep existing harness",
  );
  await assert.rejects(
    runFreshBaselineAtInstallation({
      repository: root,
      sourceCapture,
      expectedSourceScope,
      installedPackage,
      harness: occupiedHarness,
      launchWorker: () =>
        assert.fail("Existing target must refuse before launching"),
    }),
    /target already exists/,
  );
  assert.equal(
    await readFile(path.join(occupiedHarness, "sentinel"), "utf8"),
    "keep existing harness",
  );
  const occupiedInputHarness = path.join(output, "occupied-input-harness");
  await writeFile(occupiedInputHarness + ".input.json", "keep existing input");
  await assert.rejects(
    runFreshBaselineAtInstallation({
      repository: root,
      sourceCapture,
      expectedSourceScope,
      installedPackage,
      harness: occupiedInputHarness,
      launchWorker: () =>
        assert.fail("Existing input must refuse before launching"),
    }),
    /target already exists/,
  );
  assert.equal(
    await readFile(occupiedInputHarness + ".input.json", "utf8"),
    "keep existing input",
  );
  await assert.rejects(lstat(occupiedInputHarness), { code: "ENOENT" });
  const changedCapture = structuredClone(sourceCapture);
  changedCapture.originalReport.ledger.events[0].outcome = "skipped";
  const rejectedSource = await run(true, callbacks, engine, changedCapture);
  assert.notEqual(rejectedSource.status, 0);
  assert.match(
    rejectedSource.stderr,
    /Original required source event did not pass/,
  );

  // Wrong expected output must fail in the original callback, not in a
  // signature precondition. The changed body is supplied as the expected copy.
  const broken = callback.replace(
    "assert.equal(value, 42)",
    "assert.equal(value, 43, 'CHECKTRAIL_BASELINE_PRIVATE_SENTINEL /private/synthetic/token.mjs')",
  );
  await writeFile(path.join(harness, "dist/test/original.test.js"), broken);
  const brokenIdentities = await callbackIdentities(harness, profiles, [
    "alpha",
    "overlapping",
  ]);
  const failed = await run(true, brokenIdentities);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Preserved baseline cohort incomplete/);
  const failedDiagnostic = JSON.parse(
    failed.stderr
      .split("\n")
      .find((line: string) =>
        line.startsWith(
          '{"schemaVersion":1,"profile":"preserved-baseline-incomplete-v1"',
        ),
      )!,
  );
  assert.equal(failedDiagnostic.phase, "fresh-installed");
  assert.equal(failedDiagnostic.complete, false);
  assert.equal(failedDiagnostic.required, 1);
  assert.equal(failedDiagnostic.installedBindingVerifiedBeforeExecution, true);
  assert.equal(failedDiagnostic.afterExecutionEngineAndRuntimeAssessed, false);
  assert.equal(failedDiagnostic.caseOutcomes[0].name, caseName);
  assert.equal(failedDiagnostic.caseOutcomes[0].outcome, "failed");
  assert.ok(
    failedDiagnostic.problems.some(
      (problem: { name: string; reason: string }) =>
        problem.name === caseName && problem.reason === "failed",
    ),
  );
  assert.ok(!failed.stderr.includes("CHECKTRAIL_BASELINE_PRIVATE_SENTINEL"));
  assert.ok(!failed.stderr.includes("/private/synthetic/token.mjs"));

  // Crossing the observed 64 KiB pipe boundary must still emit one complete
  // diagnostic JSON record before the original refusal terminates the worker.
  const largeRun = async (padding: number) => {
    const names = Array.from(
      { length: 200 },
      (_, i) =>
        "original bounded callback " +
        i +
        " " +
        "x".repeat(70 + Math.min(400, Math.max(0, padding - i * 400))),
    );
    const largeBody =
      broken +
      names
        .map((name) => "\ntest(" + JSON.stringify(name) + ", () => {});\n")
        .join("");
    await writeFile(
      path.join(harness, "dist/test/original.test.js"),
      largeBody,
    );
    const largeProfiles = {
      alpha: [caseName, ...names].map((name) => ({
        file: "dist/test/original.test.js",
        name,
      })),
      overlapping: profiles.overlapping,
    };
    const identities = await callbackIdentities(harness, largeProfiles, [
      "alpha",
      "overlapping",
    ]);
    const observed = await run(
      true,
      identities,
      engine,
      undefined,
      largeProfiles,
    );
    assert.notEqual(observed.status, 0);
    const line = observed.stderr
      .split("\n")
      .find((value: string) =>
        value.startsWith(
          '{"schemaVersion":1,"profile":"preserved-baseline-incomplete-v1"',
        ),
      )!;
    const diagnostic = JSON.parse(line);
    assert.equal(diagnostic.caseOutcomes.length, 201);
    assert.equal(
      diagnostic.caseOutcomes.filter(
        (row: { outcome: string }) => row.outcome === "passed",
      ).length,
      200,
    );
    assert.equal(diagnostic.failedTerminals[0].name, caseName);
    assert.ok(
      !observed.stderr.includes("CHECKTRAIL_BASELINE_PRIVATE_SENTINEL"),
    );
    return Buffer.byteLength(line) + 1;
  };
  const initialBytes = await largeRun(0);
  assert.ok(initialBytes < 65536);
  for (const boundary of [65536, 65537])
    assert.equal(await largeRun(boundary - initialBytes), boundary);

  const skipped = callback.replace("test(", "test.skip(");
  await writeFile(path.join(harness, "dist/test/original.test.js"), skipped);
  const skipIdentities = await callbackIdentities(harness, profiles, [
    "alpha",
    "overlapping",
  ]);
  const skip = await run(true, skipIdentities);
  assert.notEqual(skip.status, 0);
  assert.match(skip.stderr, /Preserved baseline cohort incomplete/);
  const skippedDiagnostic = JSON.parse(
    skip.stderr
      .split("\n")
      .find((line: string) =>
        line.startsWith(
          '{"schemaVersion":1,"profile":"preserved-baseline-incomplete-v1"',
        ),
      )!,
  );
  assert.equal(skippedDiagnostic.complete, false);
  assert.equal(skippedDiagnostic.caseOutcomes[0].outcome, "skipped");

  // The frozen expected source bytes reject an altered callback before it runs.
  const staleCallback = await run(true);
  assert.notEqual(staleCallback.status, 0);
  assert.match(staleCallback.stderr, /Baseline callback bytes changed/);
  await writeFile(path.join(harness, "dist/test/original.test.js"), callback);
  await writeFile(
    path.join(installedPackage, "dist/src/index.js"),
    "export const value = 41;\nexport const location = import.meta.url;\n",
  );
  const staleEngine = await run(true);
  assert.notEqual(staleEngine.status, 0);
  assert.match(staleEngine.stderr, /Baseline engine bytes differ/);
  await writeFile(
    path.join(installedPackage, "dist/src/index.js"),
    await readFile(path.join(root, "dist/src/index.js")),
  );
  assert.equal(
    (await run(true)).status,
    0,
    "Exact restoration remains admissible",
  );

  const changesEngine = (
    "import { writeFile } from 'node:fs/promises';\n" + callback
  )
    .replace(", () => {", ", async () => {")
    .replace(
      "\n});",
      "\nawait writeFile(fileURLToPath(location), 'export const value = 43;\\nexport const location = import.meta.url;\\n');\n});",
    );
  await writeFile(
    path.join(harness, "dist/test/original.test.js"),
    changesEngine,
  );
  const changesEngineIdentities = await callbackIdentities(harness, profiles, [
    "alpha",
    "overlapping",
  ]);
  const changedDuringExecution = await run(true, changesEngineIdentities);
  assert.notEqual(changedDuringExecution.status, 0);
  assert.match(
    changedDuringExecution.stderr,
    /Compiled engine bytes changed during required test execution/,
  );
  await writeFile(
    path.join(installedPackage, "dist/src/index.js"),
    await readFile(path.join(root, "dist/src/index.js")),
  );
  await writeFile(path.join(harness, "dist/test/original.test.js"), callback);

  await rm(path.join(harness, "dist/src"));
  await symlink(
    path.join(root, "dist/src"),
    path.join(harness, "dist/src"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    assertInstalledEngineBinding({
      harness,
      installedPackage,
      sourceEngine: path.join(root, "dist/src"),
    }),
    /does not resolve to physically installed engine/,
  );
  const fallback = await run(true);
  assert.notEqual(fallback.status, 0);
  assert.match(
    fallback.stderr,
    /does not resolve to physically installed engine/,
  );
});

test("baseline callback admission rejects empty duplicate unknown and linked callback inputs before execution", async (t) => {
  const root = await fixture(t, { "dist/test/original.test.js": callback });
  await assert.rejects(
    callbackIdentities(root, profiles, []),
    /Empty baseline profile selection/,
  );
  await assert.rejects(
    callbackIdentities(root, profiles, ["alpha", "alpha"]),
    /Duplicate baseline profile/,
  );
  await assert.rejects(
    callbackIdentities(root, profiles, ["missing"]),
    /Unknown baseline profile/,
  );
  await assert.rejects(
    callbackIdentities(root, { empty: [] }, ["empty"]),
    /Empty baseline callback selection/,
  );
  const other = await fixture(t, { "linked.js": callback });
  await rm(path.join(root, "dist/test/original.test.js"));
  await symlink(
    path.join(other, "linked.js"),
    path.join(root, "dist/test/original.test.js"),
  );
  await assert.rejects(
    callbackIdentities(root, profiles, ["alpha"]),
    /falls back through a link/,
  );
});
