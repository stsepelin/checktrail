import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { inventory } from "../src/inventory.js";
import { nativeMutationReportSchema } from "../src/mutation-native-schema.js";
import {
  runMutations,
  mutationReportSchema,
  mutationSummarySchema,
  projectMutations,
} from "../src/mutation.js";
import { mutationDependencies } from "../src/mutation-native-copy.js";
import {
  mutationFamilies,
  mutationFamilyAvailable,
  mutationFixture,
  type MutationFamily,
} from "./mutation-native-fixture.js";
import { mutationInterruption } from "./mutation-native-lifecycle-fixture.js";
const selected = process.env.CHECKTRAIL_MUTATION_FAMILY;
if (selected !== undefined)
  assert.ok(
    mutationFamilies.includes(selected as MutationFamily),
    "Unknown selected mutation family",
  );
const family = (selected ?? "vitest") as MutationFamily;
const native = {
  skip: !(selected !== undefined && (await mutationFamilyAvailable(family))),
  timeout: 600000,
};
const prefix = "mutation-runners";
const dependencies =
  family === "pytest"
    ? ".checktrail/mutation-python-tools"
    : family === "phpunit"
      ? "vendor"
      : "node_modules";
const run = (root: string, recipe: Parameters<typeof runMutations>[1]) =>
  runMutations(root, recipe, { trusted: true, timeoutMs: 120000 }).then(
    (report) => nativeMutationReportSchema.parse(report),
  );
const brief = (report: Awaited<ReturnType<typeof run>>) =>
  JSON.stringify({
    complete: report.complete,
    reason: report.reason,
    baseline: report.baseline?.outcome,
    trials: report.trials.map((t) => ({
      id: t.id,
      status: t.status,
      outcome: t.observation?.outcome,
      exit: t.observation?.exitCode,
      timedOut: t.observation?.timedOut,
    })),
  });
async function recordMutationWitnesses(
  controls: Awaited<ReturnType<typeof mutationInterruption>>[],
) {
  const base = process.env.CHECKTRAIL_MUTATION_LIFECYCLE_RECEIPT;
  if (!base) return;
  const stage =
      process.env.CHECKTRAIL_MUTATION_INSTALLED === "1"
        ? "installed"
        : "source",
    file = base + (stage === "installed" ? ".installed" : "");
  let previous: { family: string; stage: string; controls: typeof controls } = {
    family,
    stage,
    controls: [],
  };
  try {
    previous = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  assert.equal(previous.family, family);
  assert.equal(previous.stage, stage);
  assert.equal(
    new Set([...previous.controls, ...controls].map((c) => c.kind)).size,
    previous.controls.length + controls.length,
  );
  await writeFile(
    file,
    JSON.stringify({
      ...previous,
      controls: [...previous.controls, ...controls],
    }) + "\n",
  );
}
test(`${prefix} broken acceptance`, native, async (t) => {
  const { root, recipe, file, source } = await mutationFixture(t, family);
  recipe.mutations = recipe.mutations.slice(0, 2);
  const before = (await inventory(root)).fingerprint,
    dep = (await mutationDependencies(root, dependencies, () => true))
      .fingerprint;
  const report = await run(root, recipe);
  mutationReportSchema.parse(report);
  assert.equal(report.complete, true, brief(report));
  assert.deepEqual(
    report.trials.map((t) => t.status),
    ["killed", "survived"],
  );
  assert.equal(report.baseline?.tests?.total, 2);
  assert.equal(report.baseline?.tests?.passed, 2);
  assert.equal(report.trials[0]?.observation?.tests?.failed, 1);
  assert.equal(report.counts.killed, 1);
  assert.equal(report.counts.survived, 1);
  const observations = [
    report.baseline!,
    ...report.trials.map((t) => t.observation!),
  ];
  assert.equal(new Set(observations.map((o) => o.runId)).size, 3);
  assert.ok(
    observations.every(
      (o) =>
        !o.sourceChanged &&
        !o.dependenciesChanged &&
        !o.cleanupError &&
        !o.processError &&
        o.tests?.total === 2,
    ),
  );
  assert.notEqual(
    report.trials[0]!.observation!.sourceFingerprint,
    report.baseline!.sourceFingerprint,
  );
  assert.equal(report.sourceFingerprint, before);
  assert.equal(report.finalSourceFingerprint, before);
  assert.equal(report.dependencyFingerprint, dep);
  assert.equal(report.finalDependencyFingerprint, dep);
  assert.equal((await inventory(root)).fingerprint, before);
  assert.equal(await readFile(path.join(root, file), "utf8"), source);
  assert.equal(
    (await mutationDependencies(root, dependencies, () => true)).fingerprint,
    dep,
  );
});
test(`${prefix} fixed acceptance`, native, async (t) => {
  const { root, recipe } = await mutationFixture(t, family);
  recipe.mutations = [recipe.mutations[1]!];
  const report = await run(root, recipe);
  assert.equal(report.complete, true, brief(report));
  assert.equal(report.counts.survived, 1);
  assert.equal(report.counts.killed, 0);
  assert.equal(report.trials[0]?.observation?.tests?.passed, 2);
});
test(`${prefix} near-miss acceptance`, native, async (t) => {
  const { root, recipe } = await mutationFixture(t, family);
  recipe.mutations = recipe.mutations.slice(2);
  const report = await run(root, recipe);
  assert.equal(report.complete, false, brief(report));
  assert.deepEqual(
    report.trials.map((t) => t.status),
    [
      "execution-error",
      "skipped",
      "setup-error",
      "execution-error",
      "setup-error",
    ],
    brief(report),
  );
  assert.equal(report.counts.killed + report.counts.survived, 0);
  assert.equal(report.counts.executionError, 2);
  assert.equal(report.counts.setupError, 2);
  assert.equal(report.counts.skipped, 1);
  assert.equal(report.sourceFingerprint, report.finalSourceFingerprint);
  assert.equal(report.dependencyFingerprint, report.finalDependencyFingerprint);
});
test(`${prefix} prerequisite acceptance`, native, async (t) => {
  const { root, recipe } = await mutationFixture(t, family);
  recipe.mutations = recipe.mutations.slice(0, 1);
  await rm(path.join(root, dependencies), { recursive: true });
  const before = (await inventory(root)).fingerprint,
    report = await run(root, recipe);
  assert.equal(report.complete, false);
  assert.equal(report.baseline, undefined);
  assert.equal(report.counts.notRun, 1);
  assert.equal(report.counts.killed + report.counts.survived, 0);
  assert.equal(report.sourceFingerprint, before);
  assert.equal(report.finalSourceFingerprint, before);
  await assert.rejects(runMutations(root, recipe, { trusted: false }), /trust/);
  for (const invalid of [
    {
      ...recipe,
      mutations: [{ ...recipe.mutations[0], file: "../outside.js" }],
    },
    { ...recipe, mutations: [recipe.mutations[0], recipe.mutations[0]] },
  ])
    await assert.rejects(run(root, invalid));
  {
    const { root, recipe } = await mutationFixture(t, family);
    recipe.mutations = recipe.mutations.slice(0, 1);
    const file = path.join(
      root,
      family === "pytest"
        ? ".checktrail/mutation-python-tools/pytest/__init__.py"
        : family === "phpunit"
          ? "vendor/phpunit/phpunit/src/Runner/Version.php"
          : `node_modules/${family}/package.json`,
    );
    const original = await readFile(file, "utf8");
    let changed: string;
    if (family === "pytest") changed = original + '\n__version__ = "0.0.0"\n';
    else if (family === "phpunit") {
      assert.equal(original.split("VersionId('13.3.4'").length, 2);
      changed = original.replace("VersionId('13.3.4'", "VersionId('0.0.0'");
    } else
      changed = JSON.stringify({ ...JSON.parse(original), version: "0.0.0" });
    try {
      await writeFile(file, changed);
      const report = await run(root, recipe);
      assert.equal(report.complete, false);
      assert.equal(report.counts.notRun, 1);
      assert.equal(report.counts.killed + report.counts.survived, 0);
      assert.notEqual(report.baseline?.outcome, "passed");
      if (family === "vitest" || family === "jest") {
        await writeFile(
          file,
          JSON.stringify({
            ...JSON.parse(original),
            originalPadding: "a".repeat(65536),
          }),
        );
        const bounded = await run(root, recipe);
        assert.equal(bounded.complete, false);
        assert.equal(bounded.baseline, undefined);
        assert.equal(bounded.counts.notRun, 1);
      }
    } finally {
      await writeFile(file, original);
    }
  }
});
test(`${prefix} stale acceptance`, native, async (t) => {
  const witnesses = [];
  for (const kind of ["source", "dependency"] as const)
    witnesses.push(await mutationInterruption(t, family, kind));
  assert.deepEqual(
    witnesses.map((w) => w.kind),
    ["source", "dependency"],
  );
  assert.ok(witnesses.every((w) => w.nativeBodies === 2));
  await recordMutationWitnesses(witnesses);
});
test(`${prefix} empty acceptance`, native, async (t) => {
  const { root, recipe, file, source } = await mutationFixture(t, family);
  recipe.mutations = recipe.mutations.slice(0, 1);
  const selectedTest =
    family === "pytest"
      ? "test_original.py"
      : family === "phpunit"
        ? "OriginalTest.php"
        : "original.test.js";
  const originalTest = await readFile(path.join(root, selectedTest), "utf8");
  await writeFile(
    path.join(root, selectedTest),
    family === "phpunit" ? "<?php\n" : "",
  );
  const report = await run(root, recipe);
  assert.equal(report.complete, false, brief(report));
  assert.notEqual(report.baseline?.outcome, "passed");
  assert.equal(report.counts.notRun, 1);
  assert.equal(report.counts.killed + report.counts.survived, 0);
  assert.equal(await readFile(path.join(root, file), "utf8"), source);
  await writeFile(path.join(root, selectedTest), originalTest);
  const skippedSource = source.replace(
    family === "jest"
      ? "exports.mode=0"
      : family === "phpunit"
        ? "MODE=0"
        : "mode=0",
    family === "jest"
      ? "exports.mode=1"
      : family === "phpunit"
        ? "MODE=1"
        : "mode=1",
  );
  assert.notEqual(skippedSource, source);
  await writeFile(path.join(root, file), skippedSource);
  const skipped = await run(root, recipe);
  assert.equal(skipped.baseline?.outcome, "skipped", brief(skipped));
  assert.equal(skipped.baseline?.tests?.total, 2);
  assert.equal(skipped.baseline?.tests?.skipped, 2);
  assert.equal(skipped.complete, false);
  assert.equal(skipped.counts.notRun, 1);
  assert.equal(skipped.counts.killed + skipped.counts.survived, 0);
  assert.equal(await readFile(path.join(root, file), "utf8"), skippedSource);
});
test(`${prefix} privacy acceptance`, native, async (t) => {
  const { root, recipe, file } = await mutationFixture(t, family);
  recipe.mutations = recipe.mutations.slice(0, 1);
  recipe.mutations[0]!.id = "original-native-private-recipe-canary";
  await writeFile(path.join(root, "mutations.json"), JSON.stringify(recipe));
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const invoke = (extra: string[]) =>
    spawnSync(
      process.execPath,
      [
        cli,
        "mutate",
        "--root",
        root,
        "--input",
        "mutations.json",
        "--timeout-ms",
        "120000",
        ...extra,
      ],
      { encoding: "utf8", timeout: 150000, maxBuffer: 12 * 1048576 },
    );
  assert.equal(invoke([]).status, 2);
  for (const detailed of [false, true]) {
    const result = invoke([
      "--trust-project",
      ...(detailed ? ["--detailed"] : []),
    ]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr.slice(-1000));
    const report = JSON.parse(result.stdout);
    (detailed ? mutationReportSchema : mutationSummarySchema).parse(report);
    assert.equal(report.complete, true);
    assert.equal(report.counts.killed, 1);
    assert.equal(
      result.stdout.includes("original-native-private-recipe-canary"),
      detailed,
    );
    assert.equal(result.stdout.includes(file), detailed);
    assert.equal(result.stdout.includes(root), false);
    if (!detailed) assert.equal(Object.hasOwn(report, "baseline"), false);
  }
  for (const allow of [false, true])
    for (const detailed of allow ? [false, true] : [false]) {
      const client = new Client(
        { name: "original-mutation-acceptance", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          cli,
          "serve",
          "--root",
          root,
          "--timeout-ms",
          "120000",
          ...(allow ? ["--allow-execution"] : []),
          ...(detailed ? ["--detailed"] : []),
        ],
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        assert.equal(
          (
            await client.callTool({
              name: "mutation_experiment",
              arguments: { input: "mutations.json", trusted: true },
            })
          ).isError,
          true,
        );
        const result = await client.callTool(
          {
            name: "mutation_experiment",
            arguments: { input: "mutations.json", timeoutMs: 120000 },
          },
          { timeout: 150000 },
        );
        if (!allow) {
          assert.equal(result.isError, true);
          continue;
        }
        assert.notEqual(result.isError, true);
        const report = result.structuredContent;
        (detailed ? mutationReportSchema : mutationSummarySchema).parse(report);
        assert.equal((report as { complete: boolean }).complete, true);
        const encoded = JSON.stringify(result);
        assert.equal(
          encoded.includes("original-native-private-recipe-canary"),
          detailed,
        );
        assert.equal(encoded.includes(file), detailed);
        assert.equal(encoded.includes(root), false);
        assert.equal(
          (
            await client.callTool({
              name: "mutation_experiment",
              arguments: { input: "../outside.json" },
            })
          ).isError,
          true,
        );
      } finally {
        await client.close();
      }
    }
  const report = await run(root, recipe),
    summary = projectMutations(report, false);
  mutationSummarySchema.parse(summary);
  assert.equal(Object.hasOwn(summary, "trials"), false);
  assert.equal(Object.hasOwn(summary, "outcome"), false);
});
test(`${prefix} lifecycle acceptance`, native, async (t) => {
  const witnesses = [];
  for (const kind of ["cancel", "timeout", "output"] as const)
    witnesses.push(await mutationInterruption(t, family, kind));
  assert.deepEqual(
    witnesses.map((w) => w.kind),
    ["cancel", "timeout", "output"],
  );
  assert.ok(witnesses.every((w) => w.nativeBodies === 2));
  await recordMutationWitnesses(witnesses);
});
test(
  `${prefix} installed acceptance`,
  { ...native, timeout: 1200000 },
  async () => {
    if (process.env.CHECKTRAIL_MUTATION_INSTALLED === "1") {
      assert.match(
        await realpath(
          fileURLToPath(new URL("../src/mutation.js", import.meta.url)),
        ),
        /node_modules\/@stsepelin\/checktrail\/dist\/src\/mutation\.js$/,
      );
      return;
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../scripts/verify-mutation-package.mjs", import.meta.url),
        ),
      ],
      { env, encoding: "utf8", timeout: 1170000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(result.error, undefined, result.error?.message ?? "");
    assert.equal(result.status, 0, result.stderr.slice(-2000));
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.family, family);
    assert.equal(receipt.profile.required, 9);
    assert.equal(receipt.profile.passed, 9);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
    if (process.env.CHECKTRAIL_MUTATION_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_MUTATION_INSTALL_RECEIPT,
        JSON.stringify(receipt) + "\n",
      );
  },
);
