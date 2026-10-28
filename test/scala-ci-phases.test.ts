import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

test("Scala CI requires source guards and installed acceptance as independent matrix phases", async () => {
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const job = workflow.jobs.scala;
  assert.deepEqual(job.strategy?.matrix?.phase ?? [], [
    "source",
    "guards",
    "installed",
  ]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.ok(workflow.jobs["ci-complete"].needs.includes("scala"));
  assert.equal(
    job.if,
    "${{ always() && !cancelled() && (needs.ci-plan.result != 'success' || fromJSON(needs.ci-plan.outputs.plan).selected['scala']) }}",
  );
  const native = job.steps.find((step: { run?: string }) =>
    step.run?.includes("scripts/verify-scala-container.mjs"),
  );
  assert.equal(
    native.run,
    'node scripts/verify-scala-container.mjs "${{ matrix.phase }}"',
  );
});

const phasesModule = () =>
  import(new URL("../../scripts/scala-ci-phases.mjs", import.meta.url).href);
const syntheticReceipts = () => ({
  source: { complete: true, required: 2, passed: 2 },
  guards: {
    sourceRestored: true,
    callbacksUnchanged: true,
    guards: [{ originalPassed: true, mutantKilled: true }],
  },
  installed: {
    offlineProductionInstall: true,
    lifecycleScriptsExecuted: false,
    harnessOutsideInstalledPackage: true,
    profile: { complete: true, required: 2, passed: 2 },
  },
});

test("Scala phase routing preserves complete legacy order and selects each independent cohort exactly once", async () => {
  const { selectScalaCiPhases, runScalaCiPhases } = await phasesModule();
  for (const args of [[], ["all"], ["source"], ["guards"], ["installed"]]) {
    const selected = selectScalaCiPhases(args),
      expected =
        args.length === 0 || args[0] === "all"
          ? ["source", "guards", "installed"]
          : args;
    assert.deepEqual(selected, expected);
    const reached: string[] = [],
      values = syntheticReceipts();
    const handlers = Object.fromEntries(
      Object.entries(values).map(([name, receipt]) => [
        name,
        () => {
          reached.push(name);
          return receipt;
        },
      ]),
    );
    const completion = runScalaCiPhases(selected, handlers, 2),
      receipts = completion.receipts;
    assert.deepEqual(completion.selectedPhases, expected);
    assert.equal(completion.selectedPhasesComplete, true);
    assert.deepEqual(reached, expected);
    assert.deepEqual(Object.keys(receipts), expected);
    assert.equal(completion.allPhasesComplete, expected.length === 3);
    for (const name of expected)
      assert.equal(receipts[name], values[name as keyof typeof values]);
  }
});

test("Scala phase admission rejects unknown duplicate empty reordered or missing selections before any callback", async () => {
  const { selectScalaCiPhases, runScalaCiPhases } = await phasesModule();
  for (const args of [
    ["Source"],
    ["source-control"],
    ["source", "installed"],
    ["all", "all"],
    [""],
  ])
    assert.throws(() => selectScalaCiPhases(args), /Unknown Scala CI phase/);
  for (const selected of [
    [],
    ["source", "source"],
    ["guards", "source"],
    ["unknown"],
  ]) {
    const reached: string[] = [];
    assert.throws(() =>
      runScalaCiPhases(
        selected,
        {
          source: () => reached.push("source"),
          guards: () => reached.push("guards"),
        },
        2,
      ),
    );
    assert.deepEqual(reached, []);
  }
  const reached: string[] = [];
  assert.throws(() =>
    runScalaCiPhases(
      ["source", "guards", "installed"],
      {
        source: () => reached.push("source"),
        guards: () => reached.push("guards"),
      },
      2,
    ),
  );
  assert.deepEqual(reached, []);
});

test("Scala phase receipts refuse empty partial failed unrestored and unavailable native controls", async () => {
  const { runScalaCiPhases } = await phasesModule(),
    good = syntheticReceipts();
  const bad: Array<[string, unknown]> = [
    ["source", {}],
    ["source", { ...good.source, complete: false }],
    ["source", { ...good.source, required: 0, passed: 0 }],
    ["source", { ...good.source, passed: 1 }],
    ["source", { ...good.source, required: 1, passed: 1 }],
    ["guards", { ...good.guards, sourceRestored: false }],
    ["guards", { ...good.guards, callbacksUnchanged: false }],
    ["guards", { ...good.guards, guards: [] }],
    [
      "guards",
      {
        ...good.guards,
        guards: [{ originalPassed: false, mutantKilled: true }],
      },
    ],
    [
      "guards",
      {
        ...good.guards,
        guards: [{ originalPassed: true, mutantKilled: false }],
      },
    ],
    ["installed", { ...good.installed, offlineProductionInstall: false }],
    ["installed", { ...good.installed, lifecycleScriptsExecuted: true }],
    ["installed", { ...good.installed, harnessOutsideInstalledPackage: false }],
    [
      "installed",
      { ...good.installed, profile: { ...good.source, complete: false } },
    ],
    [
      "installed",
      { ...good.installed, profile: { ...good.source, passed: 1 } },
    ],
  ];
  for (const [phase, receipt] of bad)
    assert.throws(
      () => runScalaCiPhases([phase], { [phase]: () => receipt }, 2),
      phase + JSON.stringify(receipt),
    );
  const reached: string[] = [],
    failure = Error("Original synthetic native phase failure");
  assert.throws(
    () =>
      runScalaCiPhases(
        ["source", "guards", "installed"],
        {
          source: () => {
            reached.push("source");
            return good.source;
          },
          guards: () => {
            reached.push("guards");
            throw failure;
          },
          installed: () => {
            reached.push("installed");
            return good.installed;
          },
        },
        2,
      ),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(reached, ["source", "guards"]);
});

test("Scala controller rejects invalid phase arguments before consulting Docker", () => {
  const controller = fileURLToPath(
    new URL("../../scripts/verify-scala-container.mjs", import.meta.url),
  );
  for (const args of [["source-control"], ["source", "installed"]]) {
    const result = spawnSync(process.execPath, [controller, ...args], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown Scala CI phase selection/);
    assert.doesNotMatch(
      result.stderr,
      /spawnSync docker|Cannot find module|ERR_MODULE_NOT_FOUND/,
    );
  }
});
