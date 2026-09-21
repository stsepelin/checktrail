import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { inventory } from "../src/inventory.js";
import {
  runMutations,
  projectMutations,
  mutationReportSchema,
  mutationSummarySchema,
} from "../src/mutation.js";
import type { MutationRecipe } from "../src/mutation.js";
import { fixture } from "./helpers.js";

async function example(t: TestContext) {
  const files: Record<string, string> = {};
  for (const name of [
    "package.json",
    "quantity.js",
    "quantity.test.js",
    "mutations.json",
  ])
    files[name] = await readFile(
      new URL(`../../examples/mutations/${name}`, import.meta.url),
      "utf8",
    );
  return {
    root: await fixture(t, files),
    recipe: JSON.parse(files["mutations.json"]!) as MutationRecipe,
  };
}

test("native mutation experiments kill assertion failures, retain survivors and preserve original files", async (t) => {
  const { root, recipe } = await example(t);
  const before = await inventory(root);
  const report = await runMutations(root, recipe, { trusted: true });
  mutationReportSchema.parse(report);
  assert.equal(report.complete, true, JSON.stringify(report));
  assert.deepEqual(
    report.trials.map((trial) => trial.status),
    ["killed", "survived"],
  );
  assert.deepEqual(report.counts, {
    total: 2,
    killed: 1,
    survived: 1,
    invalid: 0,
    inconclusive: 0,
    notRun: 0,
  });
  assert.equal(report.baseline?.tests?.passed, 1);
  assert.equal(report.trials[0]?.observation?.tests?.failed, 1);
  assert.equal(report.sourceFingerprint, before.fingerprint);
  assert.equal((await inventory(root)).fingerprint, before.fingerprint);
  assert.equal(report.finalSourceFingerprint, before.fingerprint);
  assert.notEqual(
    report.trials[0]?.observation?.sourceFingerprint,
    report.baseline?.sourceFingerprint,
  );
  const summary = projectMutations(report, false);
  mutationSummarySchema.parse(summary);
  assert.ok(!JSON.stringify(summary).includes("quantity.js"));
  assert.ok(!Object.hasOwn(summary, "outcome"));
  assert.deepEqual(projectMutations(report, true), report);
});

test("syntax/import/runtime errors and changing test identity are never assertion kills", async (t) => {
  const { root, recipe } = await example(t);
  recipe.mutations = [
    {
      id: "syntax",
      file: "quantity.js",
      expected: "left + right",
      replacement: "left +",
    },
    {
      id: "runtime",
      file: "quantity.js",
      expected: "left + right",
      replacement: "missingFunction()",
    },
    {
      id: "import",
      file: "quantity.js",
      expected: "export const",
      replacement: "import 'missing-package'; export const",
    },
    {
      id: "assertion",
      file: "quantity.js",
      expected: "left + right",
      replacement: "left - right",
    },
  ];
  const report = await runMutations(root, recipe, { trusted: true });
  assert.deepEqual(
    report.trials.map((trial) => trial.status),
    ["inconclusive", "inconclusive", "inconclusive", "killed"],
  );
  assert.equal(report.complete, false);
  await writeFile(
    path.join(root, "quantity.test.js"),
    "import {test} from 'node:test';import {combine} from './quantity.js';test(String(combine(4,7)),()=>{});",
  );
  recipe.mutations = [recipe.mutations[3]!];
  const renamed = await runMutations(root, recipe, { trusted: true });
  assert.equal(renamed.trials[0]?.status, "inconclusive");
});

test("invalid edits do not execute and every requested mutation has a terminal record", async (t) => {
  const { root, recipe } = await example(t);
  await writeFile(
    path.join(root, "quantity.test.js"),
    "throw new Error('Invalid recipes must not run this test');",
  );
  recipe.mutations = [
    {
      id: "missing",
      file: "absent.js",
      expected: "left",
      replacement: "right",
    },
    {
      id: "test-file",
      file: "quantity.test.js",
      expected: "throw",
      replacement: "return",
    },
    { id: "same", file: "quantity.js", expected: "left", replacement: "left" },
    {
      id: "multiple",
      file: "quantity.js",
      expected: "left",
      replacement: "right",
    },
    {
      id: "no-match",
      file: "quantity.js",
      expected: "absent",
      replacement: "right",
    },
  ];
  const report = await runMutations(root, recipe, { trusted: true });
  assert.equal(report.baseline, undefined);
  assert.equal(report.counts.invalid, recipe.mutations.length);
  assert.equal(report.trials.length, recipe.mutations.length);
  assert.equal(report.complete, false);
  for (const invalid of [
    {
      ...recipe,
      mutations: [{ ...recipe.mutations[0], file: "../outside.js" }],
    },
    { ...recipe, mutations: [{ ...recipe.mutations[0], file: "/outside.js" }] },
    { ...recipe, mutations: [{ ...recipe.mutations[0], file: "a\\b.js" }] },
    { ...recipe, mutations: [recipe.mutations[0], recipe.mutations[0]] },
    { ...recipe, mutations: Array(9).fill(recipe.mutations[0]) },
    {
      ...recipe,
      mutations: [{ ...recipe.mutations[0], expected: "x".repeat(4097) }],
    },
  ])
    await assert.rejects(runMutations(root, invalid, { trusted: true }));
  await assert.rejects(runMutations(root, recipe, { trusted: false }), /trust/);
});

test("baseline failures, skipped tests, nested tests and source-changing tests stop experiments", async (t) => {
  const { root, recipe } = await example(t);
  for (const body of [
    "import {test} from 'node:test';import assert from 'node:assert/strict';test('fails',()=>assert.equal(1,2));",
    "import {test} from 'node:test';test.skip('skip',()=>{});",
    "import {test} from 'node:test';test('outer',async t=>{await t.test('inner',()=>{});});",
    "import {test} from 'node:test';import {writeFileSync} from 'node:fs';test('writes',()=>writeFileSync('quantity.js','changed'));",
  ]) {
    await writeFile(path.join(root, "quantity.test.js"), body);
    const before = (await inventory(root)).fingerprint;
    const report = await runMutations(root, recipe, { trusted: true });
    assert.equal(report.complete, false);
    assert.equal(report.counts.notRun, recipe.mutations.length);
    assert.equal((await inventory(root)).fingerprint, before);
  }
});

test("mutation cancellation removes the temporary copy and never reports unrun trials as survivors", async (t) => {
  const { root, recipe } = await example(t);
  const probe = path.join(root, ".repo-verifier/started");
  await mkdir(path.dirname(probe));
  await writeFile(
    path.join(root, "quantity.test.js"),
    `import {test} from 'node:test';import {writeFileSync} from 'node:fs';test('slow',async()=>{writeFileSync(${JSON.stringify(probe)},process.cwd());await new Promise(resolve=>setTimeout(resolve,60000));});`,
  );
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = runMutations(root, recipe, {
    trusted: true,
    signal: controller.signal,
  });
  let copy: string | undefined;
  for (let i = 0; i < 100; i++) {
    try {
      copy = await readFile(probe, "utf8");
      break;
    } catch {
      await delay(20);
    }
  }
  controller.abort();
  const report = await pending;
  assert.ok(copy, "Native test did not start");
  await assert.rejects(access(copy));
  await assert.rejects(access(path.dirname(copy)));
  assert.equal(report.complete, false);
  assert.equal(report.counts.killed + report.counts.survived, 0);
  assert.equal(report.counts.notRun, recipe.mutations.length);
});

test("mutation profile rejects extra projects, dependencies and unrelated required checks", async (t) => {
  const { root, recipe } = await example(t);
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ ...manifest, dependencies: { fictional: "1.0.0" } }),
  );
  await assert.rejects(
    runMutations(root, recipe, { trusted: true }),
    /dependency-free/,
  );
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(root, "repo-verifier.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: ".",
          checks: ["javascript.node-test", "javascript.typescript"],
        },
      ],
    }),
  );
  await assert.rejects(
    runMutations(root, recipe, { trusted: true }),
    /one root/,
  );
  await rm(path.join(root, "repo-verifier.json"));
  await mkdir(path.join(root, "nested"));
  await writeFile(
    path.join(root, "nested/package.json"),
    JSON.stringify(manifest),
  );
  await assert.rejects(
    runMutations(root, recipe, { trusted: true }),
    /one root/,
  );
});

test("mutation CLI requires trust and reports survivors as advisory observations rather than a failed validation", async (t) => {
  const { root } = await example(t);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const invoke = (args: string[]) =>
    spawnSync(
      process.execPath,
      [cli, "mutate", "--root", root, "--input", "mutations.json", ...args],
      { encoding: "utf8", timeout: 10000 },
    );
  assert.equal(invoke([]).status, 2);
  const result = invoke(["--trust-project"]);
  assert.equal(result.status, 0, result.stderr);
  const report = mutationSummarySchema.parse(JSON.parse(result.stdout));
  assert.equal(report.counts.killed, 1);
  assert.equal(report.counts.survived, 1);
  assert.equal(report.channel, "advisory");
  assert.ok(!result.stdout.includes("quantity.js"));
});

test("original-source changes invalidate otherwise classified experiments", async (t) => {
  const { root, recipe } = await example(t);
  const original = path.join(root, "quantity.js");
  await writeFile(
    path.join(root, "quantity.test.js"),
    `import {test} from 'node:test';import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';import {combine} from './quantity.js';test('sum',()=>{writeFileSync(${JSON.stringify(original)},'externally changed');assert.equal(combine(4,7),11);});`,
  );
  const report = await runMutations(root, recipe, { trusted: true });
  assert.equal(report.complete, false);
  assert.notEqual(report.finalSourceFingerprint, report.sourceFingerprint);
  assert.match(report.reason, /Original source changed/);
  assert.equal(report.counts.killed, 1);
  assert.equal(report.counts.survived, 1);
});

test("a hanging mutant exhausts the shared budget without being classified as killed", async (t) => {
  const { root, recipe } = await example(t);
  recipe.mutations[0]!.replacement = "(()=>{while(true){}})()";
  const report = await runMutations(root, recipe, {
    trusted: true,
    timeoutMs: 2000,
  });
  assert.equal(report.complete, false);
  assert.equal(report.trials[0]?.status, "inconclusive");
  assert.equal(report.trials[1]?.status, "not-run");
  assert.equal(report.counts.killed, 0);
});
