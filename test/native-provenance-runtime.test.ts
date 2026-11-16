// Original synthetic receipt and physical-layout controls, never native qualification.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  lstat,
  readdir,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixture } from "./helpers.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const api = await import(
  pathToFileURL(
    path.join(root, "scripts/native-provenance-runtime-evidence.mjs"),
  ).href
);
const runtimeApi = await import(
  pathToFileURL(path.join(root, "scripts/review-runtime-evidence.mjs")).href
);
const inventory = JSON.parse(
  await readFile(path.join(root, "docs/gate-a-profiles.v1.json"), "utf8"),
);
const definitions = JSON.parse(
  await readFile(path.join(root, "scripts/required-native-tests.json"), "utf8"),
);
const requirements = api.selectProvenanceRuntimeRequirements(
  definitions,
  inventory,
) as Array<{ file: string; name: string }>;
const sha = "a".repeat(64),
  other = "b".repeat(64);
function syntheticRuntime(slot: {
  id: string;
  platform: string;
  architecture: string;
  node: string;
}) {
  return {
    slot: slot.id,
    node: slot.node,
    platform: slot.platform,
    architecture: slot.architecture,
    osRelease:
      slot.platform === "darwin"
        ? "25.0.0"
        : slot.platform === "win32"
          ? "10.0.26100"
          : "6.12.0",
    osVersion:
      slot.platform === "win32"
        ? "Windows Server 2025 Datacenter"
        : "synthetic",
    distributionId: "ubuntu",
    distributionVersion: "24.04",
    distributionSha256: sha,
    imageOS:
      slot.platform === "darwin"
        ? "macos26"
        : slot.platform === "win32"
          ? "win25"
          : "ubuntu24",
    imageVersion: "20261112.1.0",
    containerImageId: "sha256:" + sha,
    nodeExecutableSha256: sha,
    hostedImageMetadataAttested: false,
    containerImageMetadataAttested: false,
    selectedRuntime: slot,
  };
}
function sourceEvidence(installed = false) {
  const files = [
    {
      id: "file-1",
      before: { state: "present", sha256: sha },
      after: { state: "present", sha256: sha },
      stable: true,
    },
  ];
  const events = requirements.map((row, index) => ({
    sequence: index + 1,
    fileId: "file-1",
    name: row.name,
    nameTruncated: false,
    kind: "test",
    outcome: "passed",
    required: true,
  }));
  return {
    schemaVersion: 1,
    profile: "native-provenance-runtime-v1",
    passed: 9,
    required: 9,
    complete: true,
    problems: [] as string[],
    ledger: {
      truncated: false,
      terminalEventCount: 9,
      files,
      events,
      cases: requirements.map((row, index) => ({
        fileId: "file-1",
        name: row.name,
        outcome: "passed",
        terminalSequences: [index + 1],
      })),
    },
    installed,
    installedEvidence: null as unknown,
    runtime: syntheticRuntime(inventory.runtimeProfiles[0]),
    sourceBinding: {
      gitHead: "c".repeat(40),
      worktreeClean: true,
      statusSha256: sha,
      compiledFromSourceVerified: false,
    },
    sourceBuild: {
      schemaVersion: 1,
      state: "current-source-typescript-build-reconciled",
      command: [
        "node",
        "node_modules/typescript/bin/tsc",
        "--project",
        "tsconfig.json",
        "--outDir",
        "<fresh-temporary-output>",
      ],
      sourceBinding: {
        gitHead: "c".repeat(40),
        worktreeClean: true,
        statusSha256: sha,
        compiledFromSourceVerified: false,
      },
      inputs: {
        schemaVersion: 1,
        runtime: {
          node: inventory.runtimeProfiles[0].node,
          platform: inventory.runtimeProfiles[0].platform,
          architecture: inventory.runtimeProfiles[0].architecture,
          nodeExecutableSha256: sha,
        },
        configuration: [
          "tsconfig.json",
          "package.json",
          "package-lock.json",
        ].map((file) => ({ file, bytes: 42, sha256: sha })),
        source: {
          schemaVersion: 1,
          fileCount: 1,
          bytes: 42,
          treeSha256: sha,
          manifestSha256: sha,
        },
        tests: {
          schemaVersion: 1,
          fileCount: 1,
          bytes: 42,
          treeSha256: sha,
          manifestSha256: sha,
        },
        compiler: ["package.json", "bin/tsc", "lib/tsc.js", "lib/_tsc.js"].map(
          (file) => ({ file, bytes: 42, sha256: sha }),
        ),
        compilerDependencyClosureVerified: false,
      },
      sourceInputSha256: api.provenanceRuntimeHash(
        JSON.stringify({
          schemaVersion: 1,
          runtime: {
            node: inventory.runtimeProfiles[0].node,
            platform: inventory.runtimeProfiles[0].platform,
            architecture: inventory.runtimeProfiles[0].architecture,
            nodeExecutableSha256: sha,
          },
          configuration: [
            "tsconfig.json",
            "package.json",
            "package-lock.json",
          ].map((file) => ({ file, bytes: 42, sha256: sha })),
          source: {
            schemaVersion: 1,
            fileCount: 1,
            bytes: 42,
            treeSha256: sha,
            manifestSha256: sha,
          },
          tests: {
            schemaVersion: 1,
            fileCount: 1,
            bytes: 42,
            treeSha256: sha,
            manifestSha256: sha,
          },
          compiler: [
            "package.json",
            "bin/tsc",
            "lib/tsc.js",
            "lib/_tsc.js",
          ].map((file) => ({ file, bytes: 42, sha256: sha })),
          compilerDependencyClosureVerified: false,
        }),
      ),
      compilerExitCode: 0,
      compilerSignal: null,
      currentArtifactsMatchFreshBuild: true,
      engine: {
        schemaVersion: 1,
        fileCount: 1,
        bytes: 42,
        treeSha256: sha,
        manifestSha256: sha,
      },
      tests: {
        schemaVersion: 1,
        fileCount: 1,
        bytes: 42,
        treeSha256: api.provenanceRuntimeHash(
          JSON.stringify([
            [requirements[0]!.file.slice("dist/test/".length), sha],
          ]),
        ),
        manifestSha256: api.provenanceRuntimeHash(
          JSON.stringify([
            {
              file: requirements[0]!.file.slice("dist/test/".length),
              bytes: 42,
              sha256: sha,
            },
          ]),
        ),
      },
      compiledTests: [{ file: requirements[0]!.file, bytes: 42, sha256: sha }],
      compilerDependencyClosureVerified: false,
      upstreamProducerClosureVerified: false,
    },
    inputSources: [{ file: requirements[0]!.file, bytes: 42, sha256: sha }],
    harnessSha256: sha,
    requirementsSha256: sha,
    compiledEngine: {
      schemaVersion: 1,
      fileCount: 1,
      bytes: 42,
      treeSha256: sha,
      manifestSha256: sha,
      afterTreeSha256: sha,
      afterManifestSha256: sha,
      beforeAfterByteIdentitiesMatch: true,
    },
    executionBinding: {
      engineLocation: installed ? "fresh-installed-package" : "current-source",
      helperLocation: installed ? "fresh-installed-package" : "current-source",
      harnessOutsideInstalledPackage: installed,
    },
    harnessInputsUnchanged: true,
    selectedSlotQualified: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
    upstreamProducerClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    gateAComplete: false,
  };
}
function installedReceipt() {
  const source = sourceEvidence();
  return {
    schemaVersion: 1,
    profile: "native-provenance-installed-v1",
    offlineProductionInstall: true,
    lifecycleScriptsExecuted: false,
    harnessOutsideInstalledPackage: true,
    tarballSha256: sha,
    productionDependencyLockSha256: other,
    harnessSha256: source.harnessSha256,
    evidence: sourceEvidence(true),
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
    gateAComplete: false,
  };
}

test("provenance qualification selects all nine exact planned callbacks and rejects changed inventories", () => {
  assert.equal(requirements.length, 9);
  assert.equal(api.provenanceRuntimeArgument(["--development"]), null);
  for (const args of [[], ["--development", "extra"], ["--unknown"]])
    assert.throws(() => api.provenanceRuntimeArgument(args));
  for (const change of [
    (j: typeof inventory) =>
      j.extensionProfiles
        .find((p: { id: string }) => p.id === "native-license-provenance")
        .acceptanceCases.pop(),
    (j: typeof inventory) =>
      (j.extensionProfiles.find(
        (p: { id: string }) => p.id === "native-license-provenance",
      ).runtime = "foreign"),
  ]) {
    const copy = structuredClone(inventory);
    change(copy);
    assert.throws(() =>
      api.selectProvenanceRuntimeRequirements(definitions, copy),
    );
  }
  const wrong = structuredClone(definitions);
  wrong["native-license-provenance"][0].name = "foreign";
  assert.throws(() =>
    api.selectProvenanceRuntimeRequirements(wrong, inventory),
  );
});

test("provenance phase diagnostics preserve outcomes and redact errors with bounded timing and accounting", async () => {
  const lines: string[] = [];
  let time = 100;
  const progress = api.createProvenanceRuntimeProgress({
    cohort: "source",
    clock: () => time++,
    write: (line: string) => lines.push(line),
  });
  const report = {
    complete: false,
    required: 9,
    passed: 6,
    problems: [{ message: "PRIVATE_ERROR /private/project TOKEN" }],
    ledger: {
      events: [
        { outcome: "failed" },
        { outcome: "skipped" },
        { outcome: "todo" },
      ],
    },
  };
  assert.equal(await progress.run("source-cases", () => report), report);
  const failure = new Error("PRIVATE_ERROR /private/project TOKEN");
  await assert.rejects(
    progress.run("source-build", () => {
      throw failure;
    }),
    (error: unknown) => error === failure,
  );
  const missing = await progress.run("fresh-cases", () => undefined);
  assert.equal(missing, undefined);
  const packets = lines.map((line) => JSON.parse(line));
  assert.deepEqual(packets[0], {
    profile: "native-provenance-progress-v1",
    cohort: "source",
    phase: "source-cases",
    status: "started",
    elapsedMs: 1,
  });
  assert.deepEqual(packets[1], {
    profile: "native-provenance-progress-v1",
    cohort: "source",
    phase: "source-cases",
    status: "completed",
    elapsedMs: 2,
    acceptanceComplete: false,
    passed: 6,
    required: 9,
    skipped: 1,
    todo: 1,
  });
  assert.equal(packets[3].status, "failed");
  assert.deepEqual(
    { ...packets[5], elapsedMs: 0 },
    {
      profile: "native-provenance-progress-v1",
      cohort: "source",
      phase: "fresh-cases",
      status: "completed",
      elapsedMs: 0,
      acceptanceComplete: false,
      passed: null,
      required: null,
      skipped: null,
      todo: null,
    },
  );
  assert.doesNotMatch(
    lines.join(""),
    /PRIVATE_ERROR|private\/project|TOKEN|message|durationMs/u,
  );
  for (let i = 0; i < 200; i++) await progress.run("capture", () => undefined);
  assert.equal(lines.length, 128);
  assert.ok(lines.every((line) => Buffer.byteLength(line) <= 512));
  const brokenPipe = api.createProvenanceRuntimeProgress({
    cohort: "fresh",
    write: () => {
      throw new Error("diagnostic pipe failed");
    },
  });
  assert.equal(await brokenPipe.run("capture", () => report), report);
  await assert.rejects(
    brokenPipe.run("capture", () => {
      throw failure;
    }),
    (error: unknown) => error === failure,
  );
  await assert.rejects(
    progress.run("/private/project", () => report),
    /Unknown provenance diagnostic phase/u,
  );
});

test(
  "provenance phase diagnostics reach stderr before a blocking child and leave stdout empty",
  { timeout: 15000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { createProvenanceRuntimeProgress } from ${JSON.stringify(pathToFileURL(path.join(root, "scripts/native-provenance-runtime-evidence.mjs")).href)};
    const progress = createProvenanceRuntimeProgress({ cohort: "source" });
    await progress.run("source-build", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000));
  `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    const exited = once(child, "exit");
    const reader = createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });
    try {
      const [line] = await once(reader, "line", {
        signal: AbortSignal.timeout(10000),
      });
      const packet = JSON.parse(line);
      assert.equal(packet.phase, "source-build");
      assert.equal(packet.status, "started");
      assert.equal(child.exitCode, null);
      assert.equal(stdout, "");
    } finally {
      reader.close();
      child.kill();
      await exited;
    }
  },
);

test("synthetic selected-slot controls require every exact patch, architecture and image family", () => {
  assert.equal(inventory.runtimeProfiles.length, 8);
  for (const slot of inventory.runtimeProfiles) {
    const runtime = syntheticRuntime(slot);
    assert.deepEqual(
      runtimeApi.checkReviewRuntimeSelection(inventory, slot.id, runtime, true),
      slot,
    );
    for (const mutate of [
      (r: typeof runtime) => (r.node = "0.0.0"),
      (r: typeof runtime) => (r.architecture = "foreign"),
      (r: typeof runtime) => (r.platform = "foreign"),
      (r: typeof runtime) => (r.imageVersion = ""),
      (r: typeof runtime) =>
        slot.id === "native-linux-arm64-node22"
          ? (r.containerImageId = "")
          : (r.imageOS = "foreign"),
    ]) {
      const changed = structuredClone(runtime);
      mutate(changed);
      assert.throws(() =>
        runtimeApi.checkReviewRuntimeSelection(
          inventory,
          slot.id,
          changed,
          true,
        ),
      );
    }
  }
  assert.throws(() =>
    runtimeApi.checkReviewRuntimeSelection(
      inventory,
      "foreign",
      syntheticRuntime(inventory.runtimeProfiles[0]),
    ),
  );
});

test("actual mismatched host refuses selected provenance slot before any cohort", async () => {
  const slot = inventory.runtimeProfiles.find(
    (p: { platform: string }) => p.platform !== process.platform,
  );
  await assert.rejects(
    api.captureProvenanceRuntime(inventory, slot.id),
    /Selected runtime platform differs/u,
  );
  const development = await api.captureProvenanceRuntime(inventory, null);
  assert.equal(development.slot, null);
  assert.equal(development.selectedRuntime, null);
  assert.equal(development.node, process.versions.node);
});

test("provenance case ledger refuses missing, skipped, foreign, duplicate and stale evidence", () => {
  const positive = sourceEvidence();
  api.requireProvenanceRuntimeCases(positive, requirements, sha);
  for (const mutate of [
    (r: typeof positive) => r.ledger.cases.pop(),
    (r: typeof positive) => (r.ledger.cases[0]!.outcome = "skipped"),
    (r: typeof positive) => (r.ledger.cases[0]!.name = "foreign"),
    (r: typeof positive) => (r.ledger.cases[1]!.terminalSequences = [1]),
    (r: typeof positive) => (r.ledger.events[0]!.required = false),
    (r: typeof positive) => (r.ledger.files[0]!.after.sha256 = other),
    (r: typeof positive) => (r.ledger.truncated = true),
    (r: typeof positive) => (r.complete = false),
  ]) {
    const changed = structuredClone(positive);
    mutate(changed);
    assert.throws(() =>
      api.requireProvenanceRuntimeCases(changed, requirements, sha),
    );
  }
});

test("finite source and fresh nine-case envelopes reject partial, stale, foreign and recursive receipts", () => {
  const source = sourceEvidence(),
    positive = installedReceipt();
  api.requireProvenanceRuntimeInstallation(positive, source, requirements);
  for (const mutate of [
    (r: typeof positive) => (r.tarballSha256 = ""),
    (r: typeof positive) => (r.productionDependencyLockSha256 = ""),
    (r: typeof positive) => (r.harnessSha256 = other),
    (r: typeof positive) => (r.evidence.passed = 3),
    (r: typeof positive) => (r.evidence.required = 3),
    (r: typeof positive) => (r.evidence.installedEvidence = {}),
    (r: typeof positive) => (r.evidence.sourceBinding.gitHead = "d".repeat(40)),
    (r: typeof positive) => (r.evidence.runtime.node = "0.0.0"),
    (r: typeof positive) => (r.evidence.runtime.imageVersion = "20260101.1.0"),
    (r: typeof positive) => (r.evidence.compiledEngine.treeSha256 = other),
    (r: typeof positive) => (r.evidence.compiledEngine.afterTreeSha256 = other),
    (r: typeof positive) =>
      (r.evidence.executionBinding.engineLocation = "current-source"),
    (r: typeof positive) =>
      (r.evidence.executionBinding.helperLocation = "current-source"),
    (r: typeof positive) => (r.evidence.harnessInputsUnchanged = false),
    (r: typeof positive) => (r.gateAComplete = true),
  ]) {
    const changed = structuredClone(positive);
    mutate(changed);
    assert.throws(() =>
      api.requireProvenanceRuntimeInstallation(changed, source, requirements),
    );
  }
  const dirty = structuredClone(source);
  dirty.sourceBinding.worktreeClean = false;
  dirty.sourceBuild.sourceBinding.worktreeClean = false;
  const expected = { ...dirty, requirements };
  assert.throws(
    () => api.requireProvenanceRuntimeEvidence(dirty, expected),
    /clean source/u,
  );
});

test("installed layout physically binds engine and helpers and rejects source fallback", async (t) => {
  const temporary = await realpath(await fixture(t, {})),
    pkg = path.join(temporary, "consumer/node_modules/synthetic-package"),
    engine = path.join(pkg, "dist/src"),
    harness = path.join(temporary, "harness"),
    sourceEngine = path.join(temporary, "source/dist/src");
  await mkdir(engine, { recursive: true });
  await mkdir(path.join(harness, "dist"), { recursive: true });
  await mkdir(sourceEngine, { recursive: true });
  await writeFile(
    path.join(engine, "engine.js"),
    "export const synthetic = true;\n",
  );
  const inputSources = [];
  for (const file of api.provenanceInstalledPrograms as string[]) {
    const bytes = Buffer.from(
      "// Original synthetic installed helper " + file + "\n",
    );
    await mkdir(path.dirname(path.join(pkg, file)), { recursive: true });
    await writeFile(path.join(pkg, file), bytes);
    inputSources.push({
      file,
      bytes: bytes.length,
      sha256: api.provenanceRuntimeHash(bytes),
    });
  }
  await symlink(
    engine,
    path.join(harness, "dist/src"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const context = {
    schemaVersion: 1,
    mode: "installed",
    installedPackageRoot: pkg,
    installedEngineRoot: engine,
    sourceEngineRoot: sourceEngine,
    inputSources,
  };
  const previous = process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED_PACKAGE;
  try {
    process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED_PACKAGE = pkg;
    await api.requireProvenanceInstalledLayout(harness, context);
    await assert.rejects(
      api.requireProvenanceInstalledLayout(harness, {
        ...context,
        sourceEngineRoot: engine,
      }),
      /checkout engine/u,
    );
    await assert.rejects(
      api.requireProvenanceInstalledLayout(pkg, context),
      /outside installed package/u,
    );
    process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED_PACKAGE =
      path.dirname(pkg);
    await assert.rejects(
      api.requireProvenanceInstalledLayout(harness, context),
      /helper root differs/u,
    );
    process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED_PACKAGE = pkg;
    await writeFile(
      path.join(pkg, api.provenanceInstalledPrograms[0]),
      "Changed synthetic helper",
    );
    await assert.rejects(
      api.requireProvenanceInstalledLayout(harness, context),
    );
    await rm(path.join(harness, "dist/src"));
    await symlink(
      sourceEngine,
      path.join(harness, "dist/src"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      api.requireProvenanceInstalledLayout(harness, context),
    );
  } finally {
    if (previous === undefined)
      delete process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED_PACKAGE;
    else process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED_PACKAGE = previous;
  }
});

test("bounded provenance metadata refuses empty, oversized and linked inputs", async (t) => {
  const dir = await realpath(await fixture(t, {})),
    file = path.join(dir, "context.json");
  await writeFile(file, "{}", { mode: 0o600 });
  assert.equal(
    (await api.readProvenanceInput(file, 16, true)).toString(),
    "{}",
  );
  await assert.rejects(api.readProvenanceInput(file, 1));
  await writeFile(file, "");
  await assert.rejects(api.readProvenanceInput(file, 16));
  const target = path.join(dir, "target.json");
  await writeFile(target, "{}");
  await rm(file);
  await symlink(target, file);
  await assert.rejects(api.readProvenanceInput(file, 16));
});

test("runtime admission alone cannot qualify failed or incomplete case accounting", () => {
  const source = sourceEvidence();
  assert.equal(
    api.provenanceRuntimeQualified(source.runtime, source, source.sourceBuild),
    true,
  );
  assert.equal(
    api.provenanceRuntimeQualified(
      { ...source.runtime, slot: null },
      source,
      source.sourceBuild,
    ),
    false,
  );
  for (const change of [
    (r: typeof source) => (r.complete = false),
    (r: typeof source) => (r.passed = 8),
    (r: typeof source) => (r.required = 3),
    (r: typeof source) => (r.problems = ["unavailable"]),
  ]) {
    const partial = structuredClone(source);
    change(partial);
    assert.equal(
      api.provenanceRuntimeQualified(
        source.runtime,
        partial,
        source.sourceBuild,
      ),
      false,
    );
  }
});

test(
  "observed first-party rebuild rejects stale engine and callbacks and accepts actual rebuilt outputs",
  { timeout: 120000 },
  async (t) => {
    const dir = await realpath(await fixture(t, {})),
      build = await import(
        pathToFileURL(
          path.join(root, "scripts/native-provenance-source-build.mjs"),
        ).href
      ),
      exec = promisify(execFile);
    const pkg = JSON.parse(
        await readFile(path.join(root, "package.json"), "utf8"),
      ),
      version = pkg.dependencies.typescript;
    await mkdir(path.join(dir, "src"));
    await mkdir(path.join(dir, "test"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "synthetic-current-source",
        version: "1.0.0",
        type: "module",
        scripts: { build: "tsc" },
        devDependencies: { typescript: version },
      }),
    );
    await writeFile(
      path.join(dir, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/typescript": { version } },
      }),
    );
    await writeFile(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          rootDir: ".",
          outDir: "dist",
          declaration: true,
          types: [],
        },
        include: ["src/**/*.ts", "test/**/*.ts"],
      }),
    );
    await symlink(
      path.join(root, "node_modules"),
      path.join(dir, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      path.join(dir, "src/probe.ts"),
      'export const marker = "original synthetic behavior";\n',
    );
    await writeFile(
      path.join(dir, "test/probe.ts"),
      'import { marker } from "../src/probe.js"; export const observed: string = marker;\n',
    );
    const compile = () =>
      exec(
        process.execPath,
        [
          path.join(dir, "node_modules/typescript/bin/tsc"),
          "--project",
          path.join(dir, "tsconfig.json"),
        ],
        { cwd: dir, timeout: 30000, env: { ...process.env, NODE_OPTIONS: "" } },
      );
    await compile();
    const binding = sourceEvidence().sourceBinding,
      first = await build.observeProvenanceSourceBuild(dir, binding);
    const expected = {
      sourceBinding: binding,
      compiledEngine: first.engine,
      inputSources: first.compiledTests,
      runtime: first.inputs.runtime,
    };
    build.requireProvenanceSourceBuild(first, expected);
    for (const change of [
      (w: typeof first) =>
        (w.sourceBinding = { ...binding, gitHead: "d".repeat(40) }),
      (w: typeof first) => w.compiledTests.pop(),
      (w: typeof first) => (w.compilerExitCode = 1),
      (w: typeof first) => (w.inputs.compiler = []),
      (w: typeof first) => (w.sourceInputSha256 = "0".repeat(64)),
    ]) {
      const altered = structuredClone(first);
      change(altered);
      assert.throws(() =>
        build.requireProvenanceSourceBuild(altered, expected),
      );
    }
    await writeFile(
      path.join(dir, "src/probe.ts"),
      'export const marker = "changed synthetic behavior";\n',
    );
    await assert.rejects(
      build.observeProvenanceSourceBuild(dir, binding),
      /artifacts are stale relative/u,
    );
    await compile();
    const repaired = await build.observeProvenanceSourceBuild(dir, binding);
    assert.notEqual(repaired.engine.treeSha256, first.engine.treeSha256);
    assert.notEqual(
      repaired.inputs.source.treeSha256,
      first.inputs.source.treeSha256,
    );
    // The explicit string type keeps the compiled callback unchanged when only
    // the engine's literal changes above. This next control is test-only stale.
    await writeFile(
      path.join(dir, "test/probe.ts"),
      'export const observed = "changed synthetic callback";\n',
    );
    await assert.rejects(
      build.observeProvenanceSourceBuild(dir, binding),
      /artifacts are stale relative/u,
    );
    await compile();
    await build.observeProvenanceSourceBuild(dir, binding);
    await writeFile(
      path.join(dir, "dist/src/orphan.js"),
      "// Original synthetic orphaned artifact\n",
    );
    await assert.rejects(
      build.observeProvenanceSourceBuild(dir, binding),
      /artifacts are stale relative/u,
    );

    assert.equal(
      api.provenanceRuntimeQualified(
        sourceEvidence().runtime,
        sourceEvidence(),
        undefined,
      ),
      false,
      "No build witness can qualify no selected source",
    );
  },
);

function sourcePublication() {
  const packet = { ...sourceEvidence(), installedEvidence: installedReceipt() };
  const expected = { ...sourceEvidence(), requirements, installed: false };
  return { packet, expected };
}

test("raw provenance publisher preserves exact UTF-8 source plus fresh bytes against pinned inner context", async (t) => {
  const directory = await realpath(await fixture(t, {})),
    target = path.join(directory, "runtime.json"),
    { packet, expected } = sourcePublication();
  // Explicit synthetic Linux metadata is compared to supplied inner pins. The
  // publisher must not replace it with this test process's host runtime.
  const raw = Buffer.from(
    JSON.stringify(
      { ...packet, syntheticNote: "Original synthetic λ metadata" },
      null,
      1,
    ) + "\r\n",
  );
  const result = await api.publishProvenanceRuntimeReceipt(
    raw,
    target,
    expected,
  );
  assert.deepEqual(await readFile(target), raw);
  assert.equal(result.sha256, api.provenanceRuntimeHash(raw));
  assert.equal(result.bytes, raw.length);
  assert.equal(result.complete, true);
  assert.equal(result.selectedSlotQualified, true);
  const observed = await lstat(target);
  assert.ok(observed.isFile() && !observed.isSymbolicLink());
  assert.equal(observed.nlink, 1);
  if (process.platform !== "win32") assert.equal(observed.mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ["runtime.json"]);
});

test("raw provenance publisher rejects stale foreign partial and malformed packets before creating output", async (t) => {
  const directory = await realpath(await fixture(t, {})),
    { packet, expected } = sourcePublication();
  const mutations = [
    (p: typeof packet) => (p.runtime.node = "0.0.0"),
    (p: typeof packet) => (p.runtime.imageVersion = "foreign-image"),
    (p: typeof packet) => (p.sourceBinding.gitHead = "d".repeat(40)),
    (p: typeof packet) => (p.harnessSha256 = other),
    (p: typeof packet) => (p.compiledEngine.treeSha256 = other),
    (p: typeof packet) => (p.sourceBuild.state = "stale-source-build"),
    (p: typeof packet) => (p.installedEvidence.evidence.passed = 3),
    (p: typeof packet) => (p.installedEvidence.evidence.harnessSha256 = other),
    (p: typeof packet) =>
      (p.installedEvidence.evidence.sourceBuild.inputs.compiler = []),
  ];
  for (const [index, mutate] of mutations.entries()) {
    const altered = structuredClone(packet);
    mutate(altered);
    const target = path.join(directory, "refused-" + index + ".json");
    await assert.rejects(
      api.publishProvenanceRuntimeReceipt(
        Buffer.from(JSON.stringify(altered)),
        target,
        expected,
      ),
    );
    await assert.rejects(lstat(target), { code: "ENOENT" });
  }
  for (const raw of [
    Buffer.alloc(0),
    Buffer.from("{"),
    Buffer.from([0xff]),
    Buffer.alloc(4 * 1048576 + 1),
  ]) {
    await assert.rejects(
      api.publishProvenanceRuntimeReceipt(
        raw,
        path.join(directory, "malformed.json"),
        expected,
      ),
    );
  }
  assert.deepEqual(await readdir(directory), []);
});

test("raw provenance publisher retains incomplete accounting without promoting it or reusing an installed receipt", async (t) => {
  const directory = await realpath(await fixture(t, {})),
    target = path.join(directory, "incomplete.json"),
    { expected } = sourcePublication();
  const packet = {
    ...sourceEvidence(),
    complete: false,
    passed: 8,
    problems: ["original synthetic callback failure"],
    selectedSlotQualified: false,
  };
  packet.ledger.cases[0]!.outcome = "failed";
  packet.ledger.events[0]!.outcome = "failed";
  const raw = Buffer.from(JSON.stringify(packet) + "\n"),
    written = await api.publishProvenanceRuntimeReceipt(raw, target, expected);
  assert.deepEqual(await readFile(target), raw);
  assert.equal(written.complete, false);
  assert.equal(written.selectedSlotQualified, false);
  for (const changed of [
    { ...packet, selectedSlotQualified: true },
    { ...packet, installedEvidence: installedReceipt() },
    { ...packet, complete: true },
  ])
    await assert.rejects(
      api.publishProvenanceRuntimeReceipt(
        Buffer.from(JSON.stringify(changed)),
        path.join(directory, "must-not-exist.json"),
        expected,
      ),
    );
  await assert.rejects(lstat(path.join(directory, "must-not-exist.json")), {
    code: "ENOENT",
  });
});

test("raw provenance publication refuses overwrite aliases links and noncanonical destinations and leaves no stage files", async (t) => {
  const directory = await realpath(await fixture(t, {})),
    { packet, expected } = sourcePublication(),
    raw = Buffer.from(JSON.stringify(packet) + "\n"),
    occupied = path.join(directory, "existing.json");
  const original = Buffer.from(
    "Original synthetic preexisting receipt bytes\n",
  );
  await writeFile(occupied, original, { mode: 0o600 });
  await assert.rejects(
    api.publishProvenanceRuntimeReceipt(raw, occupied, expected),
    /already exists/u,
  );
  assert.deepEqual(await readFile(occupied), original);
  const linked = path.join(directory, "linked.json");
  await symlink(occupied, linked);
  await assert.rejects(
    api.publishProvenanceRuntimeReceipt(raw, linked, expected),
  );
  assert.deepEqual(await readFile(occupied), original);
  const alias = path.join(directory, "alias");
  await symlink(
    directory,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const target of [
    "relative.json",
    directory + path.sep + "." + path.sep + "new.json",
    path.join(alias, "new.json"),
    path.join(directory, "missing/new.json"),
    path.join(occupied, "new.json"),
  ])
    await assert.rejects(
      api.publishProvenanceRuntimeReceipt(raw, target, expected),
    );
  assert.deepEqual((await readdir(directory)).sort(), [
    "alias",
    "existing.json",
    "linked.json",
  ]);
});
