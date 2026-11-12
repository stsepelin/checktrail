import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, access, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const api = await import(
  new URL("../../scripts/dotnet-generator-shards.mjs", import.meta.url).href
);
const runner = await import(
  new URL(
    "../../scripts/verify-dotnet-generator-shard-tests.mjs",
    import.meta.url,
  ).href
);
const guards = await import(
  new URL(
    "../../scripts/verify-dotnet-generator-extensions-guards.mjs",
    import.meta.url,
  ).href
);
const loaded = await api.loadGeneratorShards(root);
const mutationSources = await api.captureGeneratorMutationSources(root);
const clone = <T>(value: T): T => structuredClone(value);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const context = {
  repository: "synthetic/repository",
  runId: "123456",
  headSha: "a".repeat(40),
  checkoutSha: "e".repeat(40),
  jobId: "987654",
  jobAttempt: 1,
};
const engine = {
  schemaVersion: 1,
  fileCount: 2,
  bytes: 16,
  treeSha256: "c".repeat(64),
  manifestSha256: "d".repeat(64),
};
function evidence(rows: { file: string; name: string }[]) {
  const files = [...new Set(rows.map((row) => row.file))];
  return {
    required: rows.length,
    passed: rows.length,
    problems: [],
    complete: true,
    compiledEngine: {
      ...engine,
      afterTreeSha256: engine.treeSha256,
      afterManifestSha256: engine.manifestSha256,
      beforeAfterByteIdentitiesMatch: true,
    },
    ledger: {
      schemaVersion: 1,
      terminalEventCount: rows.length,
      events: rows.map((row, i) => ({
        sequence: i + 1,
        fileId: "file-" + files.indexOf(row.file),
        name: row.name,
        nameTruncated: false,
        kind: "test",
        outcome: "passed",
        durationMs: 1,
        required: true,
      })),
      truncated: false,
      files: files.map((file, i) => ({
        id: "file-" + i,
        stable: true,
        before: { state: "present", sha256: digest(file) },
        after: { state: "present", sha256: digest(file) },
      })),
      cases: rows.map((row, i) => ({
        fileId: "file-" + files.indexOf(row.file),
        name: row.name,
        outcome: "passed",
        terminalSequences: [i + 1],
      })),
    },
  };
}
function inputs(id: string) {
  const shard = api.selectGeneratorShard(loaded.manifest, id);
  const files = api.generatorShardHarnessPaths(loaded).map((file: string) => ({
    file,
    bytes: Object.hasOwn(mutationSources, file)
      ? Buffer.byteLength(mutationSources[file])
      : file.length,
    sha256: Object.hasOwn(mutationSources, file)
      ? digest(mutationSources[file])
      : digest(file),
  }));
  const artifact = (file: string) =>
    files.find((row: { file: string }) => row.file === file)!.sha256;
  const role = (name: "baseline" | "source") => ({
    schemaVersion: 1,
    scope: "dotnet-generator-required-role-fragment",
    shard: id,
    role: name,
    context: clone(context),
    manifestSha256: loaded.manifestSha256,
    requirementsSha256: loaded.requirementsSha256,
    requiredCaseKeys: shard[name].map(api.generatorCaseKey),
    evidence: evidence(shard[name]),
    fragmentComplete: true,
    wholeProfileQualification: false,
  });
  return {
    loaded: clone(loaded),
    mutationSources: clone(mutationSources),
    shardId: id,
    context: clone(context),
    runtime: {
      image: {
        selectedReference: "synthetic:qualified",
        observedImageId: "sha256:" + "a".repeat(64),
      },
      node: {
        version: "v22.23.2",
        platform: "linux",
        arch: "arm64",
        sha256: "b".repeat(64),
      },
      sdk: {
        version: "10.0.401",
        runtime: "10.0.12",
        byteVerified: true,
        pinsSha256: "f".repeat(64),
      },
    },
    baseline: role("baseline"),
    source: role("source"),
    installed:
      id === loaded.manifest.installedOwner
        ? {
            offlineProductionInstall: true,
            harnessOutsideInstalledPackage: true,
            profile: evidence(
              loaded.requirements[loaded.manifest.sourceProfile],
            ),
          }
        : null,
    guards: {
      schemaVersion: 1,
      profile: "dotnet-generator-extensions",
      scope: "dotnet-generator-mutation-fragment",
      shard: id,
      context: clone(context),
      manifestSha256: loaded.manifestSha256,
      requirementsSha256: loaded.requirementsSha256,
      fragmentComplete: true,
      wholeProfileQualification: false,
      mutantAndRestoredProcessesPerControl: 2,
      sourceRestored: true,
      callbacksUnchanged: true,
      fixturesUnchanged: true,
      expectedControlIds: [...shard.controls],
      nativeCompileProofIds: shard.controls.filter((item: string) =>
        loaded.manifest.nativeCompileControlIds.includes(item),
      ),
      callbacks: [
        {
          file: "gate-dotnet-generator-extensions.test.js",
          sha256: artifact(
            "dist/test/gate-dotnet-generator-extensions.test.js",
          ),
        },
      ],
      fixtures: [
        {
          file: "dotnet-generator-extensions-fixture.js",
          sha256: artifact("dist/test/dotnet-generator-extensions-fixture.js"),
        },
      ],
      controls: shard.controls.map((item: string) => {
        const definition = api.generatorGuardDefinitions.find(
          (row: { id: string }) => row.id === item,
        );
        const binding = api.resolveGeneratorMutation(
          definition,
          mutationSources["dist/src/" + definition.file],
        ).binding;
        return {
          ...binding,
          originalPassed: true,
          mutantCompiled: true,
          mutantFailedAssertion: true,
          restoredPassed: true,
          expressionsReplaced: 1,
          ...(definition.nativeSource
            ? { mutatedNativeObserverCompiled: true }
            : {}),
        };
      }),
    },
    harness: {
      files,
      sha256: digest(JSON.stringify(files)),
      beforeAfterByteIdentitiesMatch: true,
    },
    stageDurationMs: {},
    durationMs: 1,
  };
}

test("generator shards exactly cover all original baseline source installed and native mutation roles", () => {
  assert.equal(loaded.manifest.shards.length, 3);
  assert.equal(
    loaded.manifest.shards.flatMap(
      (row: { baseline: unknown[] }) => row.baseline,
    ).length,
    37,
  );
  assert.equal(
    loaded.manifest.shards.flatMap((row: { source: unknown[] }) => row.source)
      .length,
    9,
  );
  assert.equal(loaded.requirements[loaded.manifest.sourceProfile].length, 9);
  assert.deepEqual(
    [
      ...guards.generatorGuardDefinitions.map((row: { id: string }) => row.id),
    ].sort(),
    [...api.dotnetGeneratorControlIds].sort(),
  );
  assert.equal(
    guards.generatorGuardDefinitions.filter(
      (row: { nativeSource?: boolean }) => row.nativeSource === true,
    ).length,
    3,
  );
  for (const id of api.dotnetGeneratorShardIds) {
    const result = api.createGeneratorShardFragment(inputs(id));
    assert.equal(result.fragmentComplete, true);
    assert.equal(result.wholeProfileQualification, false);
    assert.equal(result.gateAComplete, false);
    assert.equal(result.selectedRoles.installed.length, id === "0" ? 9 : 0);
    assert.equal(result.guards.nativeCompileProofIds.length, 1);
    assert.deepEqual(result.concurrency.completeThreeShardEnvelope, {
      maxNativeContainers: 6,
      aggregateCpuLimit: 12,
      aggregateMemoryBytes: 24 * 1024 ** 3,
    });
  }
});

test("generator shard manifest rejects missing overlapping new unknown and relocated callback roles", () => {
  for (const mutate of [
    (m: typeof loaded.manifest) => m.shards.pop(),
    (m: typeof loaded.manifest) =>
      m.shards[1].baseline.push(m.shards[0].baseline[0]),
    (m: typeof loaded.manifest) => m.shards[0].source.pop(),
    (m: typeof loaded.manifest) =>
      m.shards[0].source.push({
        file: "dist/test/unknown.test.js",
        name: "unknown callback",
      }),
    (m: typeof loaded.manifest) => m.shards[0].controls.push("unknown-control"),
    (m: typeof loaded.manifest) => {
      m.shards[0].controls[0] = m.shards[1].controls[0];
    },
    (m: typeof loaded.manifest) => {
      m.installedOwner = "1";
    },
    (m: typeof loaded.manifest) => {
      m.shards[0].id = "00";
    },
    (m: typeof loaded.manifest) => {
      m.nativeCompileControlIds.pop();
    },
  ]) {
    const value = clone(loaded.manifest);
    mutate(value);
    assert.throws(() =>
      api.validateGeneratorShardManifest(value, loaded.requirements),
    );
  }
  const requirements = clone(loaded.requirements);
  requirements[loaded.manifest.sourceProfile].push({
    file: "dist/test/new.test.js",
    name: "newly required callback",
  });
  assert.throws(() =>
    api.validateGeneratorShardManifest(loaded.manifest, requirements),
  );
  const reordered = clone(loaded.manifest);
  reordered.shards.reverse();
  assert.equal(
    api.validateGeneratorShardManifest(reordered, loaded.requirements),
    reordered,
  );
});

test("generator shard arguments are exact and cannot widen the selected profile", () => {
  for (const id of ["0", "1", "2"])
    assert.equal(api.parseGeneratorShardArguments(["--shard", id]), id);
  for (const args of [
    [],
    ["--shard"],
    ["--shard", "3"],
    ["--shard", "01"],
    ["--shard", "0", "--all"],
    ["--shard-extra", "0"],
    ["--shard", 0],
  ])
    assert.throws(() => api.parseGeneratorShardArguments(args));
});

test("generator job context keeps each actual job attempt without cross-run or head relabeling", () => {
  const env = {
    CHECKTRAIL_DOTNET_GENERATOR_JOB_CONTEXT: JSON.stringify(context),
    GITHUB_REPOSITORY: context.repository,
    GITHUB_RUN_ID: context.runId,
    GITHUB_SHA: context.checkoutSha,
    GITHUB_RUN_ATTEMPT: "7",
  };
  assert.equal(api.generatorJobContextFromEnvironment(env).jobAttempt, 1);
  for (const edit of [
    { GITHUB_SHA: "b".repeat(40) },
    { GITHUB_RUN_ID: "999" },
    { GITHUB_REPOSITORY: "synthetic/other" },
    { CHECKTRAIL_DOTNET_GENERATOR_JOB_CONTEXT: undefined },
  ])
    assert.throws(() =>
      api.generatorJobContextFromEnvironment({ ...env, ...edit }),
    );
  for (const edit of [
    { jobId: "" },
    { jobId: "0" },
    { jobAttempt: 0 },
    { jobAttempt: "1" },
    { headSha: "unknown" },
    { extra: true },
  ])
    assert.throws(() =>
      api.validateGeneratorJobContext({ ...context, ...edit }),
    );
});

test("fragment receipts reject omission duplicate skip stale context changed engine and missing native proof", () => {
  for (const mutate of [
    (x: ReturnType<typeof inputs>) => {
      x.baseline.context.jobId = "555";
    },
    (x: ReturnType<typeof inputs>) => {
      x.source.context.headSha = "b".repeat(40);
    },
    (x: ReturnType<typeof inputs>) => {
      x.source.context.jobAttempt++;
    },
    (x: ReturnType<typeof inputs>) => {
      x.source.shard = "1";
    },
    (x: ReturnType<typeof inputs>) => {
      x.source.manifestSha256 = "0".repeat(64);
    },
    (x: ReturnType<typeof inputs>) => {
      x.baseline.requirementsSha256 = "0".repeat(64);
    },
    (x: ReturnType<typeof inputs>) => {
      x.source.evidence.ledger.cases.pop();
    },
    (x: ReturnType<typeof inputs>) => {
      x.source.evidence.ledger.cases[1] = clone(
        x.source.evidence.ledger.cases[0]!,
      );
    },
    (x: ReturnType<typeof inputs>) => {
      x.source.evidence.ledger.cases[0]!.outcome = "skipped";
    },
    (x: ReturnType<typeof inputs>) => {
      x.source.evidence.ledger.files[0]!.stable = false;
    },
    (x: ReturnType<typeof inputs>) => {
      x.source.evidence.compiledEngine.afterTreeSha256 = "0".repeat(64);
    },
    (x: ReturnType<typeof inputs>) => {
      x.source.evidence.ledger.events[0]!.outcome = "failed";
    },
    (x: ReturnType<typeof inputs>) => {
      x.source.evidence.ledger.events[0]!.name = "unrelated passed callback";
    },
    (x: ReturnType<typeof inputs>) => {
      x.source.evidence.ledger.events = [];
    },
    (x: ReturnType<typeof inputs>) => {
      x.guards.nativeCompileProofIds = [];
    },
    (x: ReturnType<typeof inputs>) => {
      x.guards.controls.pop();
    },
    (x: ReturnType<typeof inputs>) => {
      x.guards.controls[0].restoredPassed = false;
    },
    (x: ReturnType<typeof inputs>) => {
      x.guards.sourceRestored = false;
    },
    (x: ReturnType<typeof inputs>) => {
      x.guards.controls[0].mutantSha256 = x.guards.controls[0].originalSha256;
    },
    (x: ReturnType<typeof inputs>) => {
      x.harness.beforeAfterByteIdentitiesMatch = false;
    },
    (x: ReturnType<typeof inputs>) => {
      x.harness.files.pop();
    },
    (x: ReturnType<typeof inputs>) => {
      x.runtime.node.arch = "x64";
    },
    (x: ReturnType<typeof inputs>) => {
      x.runtime.sdk.version = "10.0.400";
    },
  ]) {
    const value = inputs("0");
    mutate(value);
    assert.throws(() => api.createGeneratorShardFragment(value));
  }
  const missing = inputs("0");
  missing.installed = null;
  assert.throws(() => api.createGeneratorShardFragment(missing));
  const unexpected = inputs("1");
  unexpected.installed = inputs("0").installed;
  assert.throws(() => api.createGeneratorShardFragment(unexpected));
});

test("standalone .NET shard runner preserves serial native selection and compiled source stability", async () => {
  for (const role of ["baseline", "source"]) {
    let calls = 0;
    const result = await runner.runGeneratorShardRole(root, "1", role, {
      capture: async () => clone(engine),
      run: async (
        rows: { file: string; name: string }[],
        options: { isolatedCaseWorkers: number; timeoutMs: number },
      ) => {
        calls++;
        assert.equal(options.timeoutMs, 600000);
        assert.equal(options.isolatedCaseWorkers, 1);
        assert.ok(rows.every((row) => path.isAbsolute(row.file)));
        return evidence(rows);
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.fragmentComplete, true);
    assert.equal(result.wholeProfileQualification, false);
  }
  let captures = 0;
  await assert.rejects(
    runner.runGeneratorShardRole(root, "1", "source", {
      capture: async () => ({
        ...engine,
        treeSha256: captures++ === 0 ? engine.treeSha256 : "0".repeat(64),
      }),
      run: async (rows: { file: string; name: string }[]) => evidence(rows),
    }),
    /changed/,
  );
  assert.throws(
    () =>
      api.requireStableGeneratorShardHarness({ sha256: "a" }, { sha256: "b" }),
    /changed/,
  );
});

test("sharding leaves the complete installed child harness unchanged and the containers retain their original limits", async () => {
  const controller = await readFile(
    path.join(root, "scripts/verify-dotnet-generator-extensions-container.mjs"),
    "utf8",
  );
  assert.match(controller, /"--cpus",\s*"2"/u);
  assert.match(controller, /"--memory",\s*"4g"/u);
  assert.match(controller, /"--pids-limit",\s*"256"/u);
  const source = await readFile(
    path.join(root, "test/gate-dotnet-generator-extensions.test.ts"),
    "utf8",
  );
  assert.ok(
    source.includes(
      'CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "dotnet-generator-extensions"',
    ),
  );
  assert.ok(source.includes("receipt.profile.required, 9"));
  assert.ok(source.includes("receipt.profile.passed, 9"));
});

test("real named runner executes only its assigned tiny callback for both generator roles", async (t) => {
  for (const role of ["baseline", "source"]) {
    const directory = await fixture(t, {});
    const selected = path.join(directory, "selected.marker");
    const unselected = path.join(directory, "unselected.marker");
    const file = path.join(directory, "tiny.test.mjs");
    await writeFile(
      file,
      `import {test} from 'node:test';import {writeFileSync} from 'node:fs';test('synthetic assigned callback',()=>writeFileSync(${JSON.stringify(selected)},'selected'));test('synthetic unassigned callback',()=>{writeFileSync(${JSON.stringify(unselected)},'unselected');throw Error('An unassigned callback executed');});`,
    );
    // node:test.run cannot run recursively inside a test callback. Invoke the
    // real runner in a fresh ordinary Node process, like the production driver.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const driver = path.join(directory, "selection-driver.mjs");
    await writeFile(
      driver,
      `
      import {runRequiredTests} from ${JSON.stringify(new URL("../../scripts/required-test-evidence.mjs", import.meta.url).href)};
      import {generatorShardRunOptions} from ${JSON.stringify(new URL("../../scripts/verify-dotnet-generator-shard-tests.mjs", import.meta.url).href)};
      const start=performance.now();
      const report=await runRequiredTests(${JSON.stringify([{ file, name: "synthetic assigned callback" }])},generatorShardRunOptions(${JSON.stringify(role)}));
      process.stdout.write(JSON.stringify({report,durationMs:Math.round(performance.now()-start)}));
    `,
    );
    const child = spawnSync(process.execPath, [driver], {
      env,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 1048576,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr);
    const { report: result, durationMs } = JSON.parse(child.stdout);
    assert.equal(result.complete, true, JSON.stringify(result));
    assert.equal(result.required, 1);
    assert.equal(result.passed, 1);
    assert.equal(result.requiredCaseWorkerLimit, 1);
    assert.deepEqual(
      result.ledger.cases.map((row: { name: string }) => row.name),
      ["synthetic assigned callback"],
    );
    assert.equal(await readFile(selected, "utf8"), "selected");
    await assert.rejects(access(unselected), { code: "ENOENT" });
    t.diagnostic(
      JSON.stringify({
        scope: "tiny synthetic Node callback selection only",
        role,
        durationMs,
        sdkExecuted: false,
      }),
    );
  }
});

test("mutation IDs bind the exact prescribed callback and bytes rather than a relabeled experiment", () => {
  const value = inputs("0");
  const first = value.guards.controls[0]!;
  const target = value.guards.controls[2]!;
  assert.equal(first.callback, target.callback);
  assert.equal(first.file, target.file);
  assert.equal(first.originalSha256, target.originalSha256);
  assert.notEqual(first.mutantSha256, target.mutantSha256);
  const targetId = target.id;
  value.guards.controls[2] = { ...first, id: targetId };
  assert.throws(
    () => api.createGeneratorShardFragment(value),
    /prescribed experiment/,
  );
  const arbitrary = inputs("0");
  arbitrary.guards.controls[0]!.mutantSha256 = digest(
    "arbitrary distinct mutant",
  );
  assert.throws(
    () => api.createGeneratorShardFragment(arbitrary),
    /prescribed experiment/,
  );
  const wrongCallback = inputs("0");
  wrongCallback.guards.controls[0]!.callback =
    "dotnet-generator-extensions stale acceptance";
  assert.throws(
    () => api.createGeneratorShardFragment(wrongCallback),
    /prescribed experiment/,
  );
  const staleSource = inputs("0");
  const file = Object.keys(staleSource.mutationSources)[0]!;
  staleSource.mutationSources[file] += "\n";
  assert.throws(
    () => api.createGeneratorShardFragment(staleSource),
    /captured harness/,
  );
  for (const id of api.dotnetGeneratorShardIds)
    assert.equal(
      api.createGeneratorShardFragment(inputs(id)).fragmentComplete,
      true,
    );
});
