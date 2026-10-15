import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runMutations } from "../src/mutation.js";
import { nativeMutationReportSchema } from "../src/mutation-native-schema.js";
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
  assert.ok(mutationFamilies.includes(selected as MutationFamily));
const family = (selected ?? "vitest") as MutationFamily;
const native = {
  skip: selected === undefined || !(await mutationFamilyAvailable(family)),
  timeout: 300000,
};
const directory =
  family === "pytest"
    ? ".checktrail/mutation-python-tools"
    : family === "phpunit"
      ? "vendor"
      : "node_modules";
const run = (root: string, recipe: Parameters<typeof runMutations>[1]) =>
  runMutations(root, recipe, { trusted: true, timeoutMs: 120000 }).then(
    (report) => nativeMutationReportSchema.parse(report),
  );
function witness(kind: string, report: Awaited<ReturnType<typeof run>>) {
  console.log(
    "checktrail-mutation-guard-witness: " +
      JSON.stringify({
        kind,
        family,
        baselineTests: report.baseline?.tests,
        baselineOutcome: report.baseline?.outcome,
        trialTests: report.trials[0]?.observation?.tests,
        trialOutcome: report.trials[0]?.observation?.outcome,
      }),
  );
}
for (const kind of ["source", "dependency"] as const)
  test(
    `native mutation copied ${kind} changes cannot pass`,
    native,
    async (t) => {
      const { root, recipe, file, source } = await mutationFixture(t, family);
      recipe.mutations = [recipe.mutations[1]!];
      const relative =
        kind === "source" ? file : directory + "/original-native-observed.txt";
      if (kind === "dependency")
        await writeFile(path.join(root, relative), "original dependency\n");
      let changed: string;
      if (family === "vitest" || family === "jest") {
        const prefix =
          family === "vitest"
            ? "import{appendFileSync}from'node:fs';\n"
            : "const{appendFileSync}=require('node:fs');\n";
        changed =
          prefix +
          source.replace(
            "{return",
            `{appendFileSync(${JSON.stringify(relative)},'\\n');return`,
          );
      } else if (family === "pytest")
        changed =
          "from pathlib import Path\n" +
          source.replace(
            "    return",
            `    with Path(${JSON.stringify(relative)}).open('a') as stream:\n        stream.write('\\n')\n    return`,
          );
      else
        changed = source.replace(
          "{return",
          `{file_put_contents(__DIR__.${JSON.stringify("/" + relative)},"\\n",FILE_APPEND);return`,
        );
      assert.notEqual(changed, source);
      await writeFile(path.join(root, file), changed);
      const dep = (await mutationDependencies(root, directory, () => true))
        .fingerprint;
      const report = await run(root, recipe);
      witness(kind, report);
      assert.equal(report.baseline?.tests?.total, 2);
      assert.equal(report.baseline?.tests?.passed, 2);
      assert.equal(
        report.baseline?.[
          kind === "source" ? "sourceChanged" : "dependenciesChanged"
        ],
        true,
      );
      assert.equal(report.baseline?.outcome, "inconclusive");
      assert.equal(report.complete, false);
      assert.equal(report.counts.notRun, 1);
      assert.equal(report.counts.killed + report.counts.survived, 0);
      assert.equal(await readFile(path.join(root, file), "utf8"), changed);
      assert.equal(
        (await mutationDependencies(root, directory, () => true)).fingerprint,
        dep,
      );
    },
  );
test(
  "native mutation changed test identity cannot kill",
  { ...native, skip: native.skip || !["vitest", "jest"].includes(family) },
  async (t) => {
    const { root, recipe, file, source } = await mutationFixture(t, family);
    recipe.mutations = [recipe.mutations[0]!];
    const testFile = path.join(root, "original.test.js"),
      original = await readFile(testFile, "utf8");
    assert.equal(original.split("'original binary'").length, 2);
    await writeFile(
      testFile,
      original.replace("'original binary'", "'original binary '+combine(4,7)"),
    );
    const report = await run(root, recipe);
    witness("cohort", report);
    assert.equal(report.baseline?.tests?.passed, 2);
    assert.equal(report.trials[0]?.observation?.tests?.total, 2);
    assert.equal(report.trials[0]?.observation?.tests?.failed, 1);
    assert.equal(report.trials[0]?.observation?.outcome, "assertion-failure");
    assert.notDeepEqual(
      report.trials[0]?.observation?.cases.map((c) => c.id).sort(),
      report.baseline?.cases.map((c) => c.id).sort(),
    );
    assert.equal(report.trials[0]?.status, "inconclusive");
    assert.equal(report.counts.killed + report.counts.survived, 0);
    assert.equal(report.complete, false);
    assert.equal(await readFile(path.join(root, file), "utf8"), source);
  },
);
test(
  "native PHPUnit teardown cannot kill",
  { ...native, skip: native.skip || family !== "phpunit" },
  async (t) => {
    const { root, recipe } = await mutationFixture(t, family);
    recipe.mutations = [
      recipe.mutations.find((m) => m.id === "teardown-assertion")!,
    ];
    const report = await run(root, recipe);
    witness("teardown", report);
    assert.equal(report.baseline?.tests?.passed, 2);
    assert.equal(report.trials[0]?.observation?.tests?.total, 2);
    assert.equal(report.trials[0]?.observation?.tests?.failed, 2);
    assert.equal(report.trials[0]?.status, "execution-error");
    assert.equal(report.counts.killed, 0);
    assert.equal(report.complete, false);
  },
);
test(
  "native pytest output reaches the physical output bound",
  { ...native, skip: native.skip || family !== "pytest" },
  async (t) => {
    const observed = await mutationInterruption(t, family, "output");
    assert.equal(observed.nativeBodies, 2);
  },
);
