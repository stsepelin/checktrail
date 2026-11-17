import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";
const { requireBaselineSourceSubset, captureBaselineSourceExecution } =
  await import(
    new URL("../../scripts/preserved-baseline-evidence.mjs", import.meta.url)
      .href
  );
const { captureCompiledEngine } = await import(
  new URL("../../scripts/compiled-engine-evidence.mjs", import.meta.url).href
);
const runner = fileURLToPath(
  new URL("../../scripts/required-test-evidence.mjs", import.meta.url),
);
const first = "first original synthetic source callback";
const second = "broader original synthetic source callback";
const sourceProfiles = {
  first: [{ file: "dist/test/original.test.js", name: first }],
  overlap: [{ file: "dist/test/original.test.js", name: first }],
  broader: [{ file: "dist/test/original.test.js", name: second }],
};
const selection = ["first", "overlap", "broader"];
const baselineProfiles = { frozen: sourceProfiles.first };
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

test("source reuse retains and validates every broader original obligation before selecting the frozen subset", async (t) => {
  const root = await fixture(t, {
    "source-driver.mjs":
      "const{runRequiredProfiles}=await import(process.argv[2]);process.stdout.write(JSON.stringify(await runRequiredProfiles(JSON.parse(process.argv[3]),JSON.parse(process.argv[4]))));",
    "package.json": '{"type":"module"}',
    "dist/test/other.test.js":
      "import{test}from'node:test';test('unassigned original synthetic callback',()=>{});",
    "dist/src/index.js": "export const original = 42;\n",
    "dist/test/original.test.js":
      "import{test}from'node:test';import assert from'node:assert/strict';" +
      "test(" +
      JSON.stringify(first) +
      ",()=>assert.equal(40+2,42));" +
      "test(" +
      JSON.stringify(second) +
      ",()=>assert.notEqual(40+2,43));",
  });
  const absolute = Object.fromEntries(
    selection.map((name) => [
      name,
      sourceProfiles[name as keyof typeof sourceProfiles].map((row) => ({
        ...row,
        file: path.join(root, row.file),
      })),
    ]),
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    [
      path.join(root, "source-driver.mjs"),
      runner,
      JSON.stringify(absolute),
      JSON.stringify(selection),
    ],
    { encoding: "utf8", timeout: 10000, env },
  );
  assert.equal(child.status, 0, child.stderr);
  const original = JSON.parse(child.stdout);
  assert.equal(original.complete, true, JSON.stringify(original.problems));
  assert.equal(original.required, 2);
  assert.equal(original.passed, 2);
  const expected = {
    profiles: sourceProfiles,
    selection,
    fileBindings: [
      {
        id: "file-1",
        file: "dist/test/original.test.js",
        sha256: hash(
          await readFile(path.join(root, "dist/test/original.test.js")),
        ),
      },
    ],
    baselineProfiles,
    baselineSelection: ["frozen"],
    sourceContract: { kind: "required-profiles", maxTerminalEvents: 4096 },
  };
  const admitted = requireBaselineSourceSubset({
    report: original,
    ...expected,
  });
  assert.equal(admitted.required, 1);
  assert.equal(admitted.originalRequired, 2);
  assert.equal(admitted.originalPassed, 2);
  assert.equal(admitted.originalSourceCommandComplete, true);
  assert.equal(admitted.wholeSuiteQualification, false);
  assert.deepEqual(admitted.cases, [original.ledger.cases[0]]);
  const mutations: Array<{
    mutate: (value: typeof original) => void;
    reason: RegExp;
  }> = [
    {
      mutate: (v) => {
        v.profiles[2].profile = "foreign";
      },
      reason: /Original source selection changed/,
    },
    {
      mutate: (v) => {
        v.required = 1;
      },
      reason: /Original required source count changed/,
    },
    {
      mutate: (v) => {
        v.passed = 1;
      },
      reason: /Original source passed count is inconsistent/,
    },
    {
      mutate: (v) => {
        v.ledger.events[1].required = false;
      },
      reason: /Foreign actual required source event/,
    },
    {
      mutate: (v) => {
        v.ledger.events[1].outcome = "skipped";
      },
      reason: /Original required source event did not pass/,
    },
    {
      mutate: (v) => {
        v.ledger.events[1].sequence = 1;
      },
      reason: /Original source terminal sequence changed/,
    },
    {
      mutate: (v) => {
        v.ledger.cases[1].name = "foreign";
      },
      reason: /Foreign or duplicate required source case/,
    },
    {
      mutate: (v) => {
        v.ledger.cases[1].terminalSequences = [1];
      },
      reason: /Original source case terminal reference changed/,
    },
    {
      mutate: (v) => {
        v.ledger.files[0].after.sha256 = "0".repeat(64);
      },
      reason: /Original source file bytes changed/,
    },
    {
      mutate: (v) => {
        v.ledger.truncated = true;
      },
      reason: /Original source ledger was truncated/,
    },
  ];
  for (const { mutate, reason } of mutations) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(
      () => requireBaselineSourceSubset({ report: changed, ...expected }),
      reason,
    );
  }
  assert.equal(original.ledger.events[1].outcome, "passed");

  // PR205 deliberately publishes complete:false for each successful fragment.
  // Use real terminal/file evidence, preserving that separate contract rather
  // than rewriting the original source report to a whole-suite success.
  const compiled = await captureCompiledEngine(path.join(root, "dist/test"));
  const fragmentContract = {
    ...expected.sourceContract,
    kind: "full-suite-fragment",
    fragment: {
      shard: "1",
      profileManifestSha256: hash("synthetic profile manifest"),
      unassignedFiles: ["other.test.js"],
      partitionSha256: hash("synthetic partition"),
      inventorySha256: hash("synthetic source inventory"),
      requestedProfiles: selection,
      totalRequired: 2,
      assignedRequired: 2,
      assignedFiles: ["original.test.js"],
      compiledTestsTreeSha256: compiled.treeSha256,
    },
  };
  const sourceFragment = {
    ...structuredClone(original),
    complete: false,
    fragmentComplete: true,
    wholeSuiteComplete: false,
    shard: fragmentContract.fragment.shard,
    profileManifestSha256: fragmentContract.fragment.profileManifestSha256,
    unassignedFiles: fragmentContract.fragment.unassignedFiles,
    partitionSha256: fragmentContract.fragment.partitionSha256,
    inventorySha256: fragmentContract.fragment.inventorySha256,
    requestedProfiles: fragmentContract.fragment.requestedProfiles,
    totalRequired: fragmentContract.fragment.totalRequired,
    assignedRequired: fragmentContract.fragment.assignedRequired,
    assignedFiles: fragmentContract.fragment.assignedFiles,
    compiledTests: {
      treeSha256: compiled.treeSha256,
      beforeAfterByteIdentitiesMatch: true,
    },
  };
  const fragment = requireBaselineSourceSubset({
    ...expected,
    report: sourceFragment,
    sourceContract: fragmentContract,
  });
  assert.equal(fragment.originalSourceCommandComplete, false);
  assert.equal(fragment.originalSourceFragmentComplete, true);
  assert.equal(fragment.wholeSuiteQualification, false);
  assert.equal(fragment.required, 1);
  assert.throws(
    () =>
      requireBaselineSourceSubset({
        ...expected,
        report: sourceFragment,
      }),
    /Original source command is incomplete/,
  );
  let originalInvocations = 0;
  const captured = await captureBaselineSourceExecution({
    root,
    profiles: sourceProfiles,
    selection,
    baselineProfiles,
    baselineSelection: ["frozen"],
    sourceContract: expected.sourceContract,
    binding: {
      platform: process.platform,
      nodeMajor: Number(process.versions.node.split(".")[0]),
      tools: {},
    },
    execute: async () => {
      originalInvocations++;
      const observed = spawnSync(
        process.execPath,
        [
          path.join(root, "source-driver.mjs"),
          runner,
          JSON.stringify(absolute),
          JSON.stringify(selection),
        ],
        { encoding: "utf8", timeout: 10000, env },
      );
      assert.equal(observed.status, 0, observed.stderr);
      return JSON.parse(observed.stdout);
    },
  });
  assert.equal(
    originalInvocations,
    1,
    "Wrapper must not repeat original source callbacks",
  );
  assert.equal(captured.originalExecutionInvocations, 1);
  assert.equal(captured.originalReport.required, 2);
  assert.equal(captured.originalReport.ledger.cases.length, 2);
  assert.equal(captured.subset.required, 1);
  assert.equal(captured.beforeAfterRuntimeIdentitiesMatch, true);
  assert.equal(captured.compiledEngine.beforeAfterByteIdentitiesMatch, true);
  assert.equal(captured.wholeSuiteQualification, false);

  const fragmentMutations: Array<{
    mutate: (value: typeof sourceFragment) => void;
    reason: RegExp;
  }> = [
    {
      mutate: (v) => {
        v.profileManifestSha256 = hash("foreign manifest");
      },
      reason: /Stale source profile manifest/,
    },
    {
      mutate: (v) => {
        v.unassignedFiles = [];
      },
      reason: /Original unassigned source file partition changed/,
    },

    {
      mutate: (v) => {
        v.complete = true;
      },
      reason: /Source fragment was relabeled complete/,
    },
    {
      mutate: (v) => {
        v.fragmentComplete = false;
      },
      reason: /Original source fragment is incomplete/,
    },
    {
      mutate: (v) => {
        v.shard = "2";
      },
      reason: /Foreign source shard/,
    },
    {
      mutate: (v) => {
        v.partitionSha256 = hash("foreign partition");
      },
      reason: /Stale source partition/,
    },
    {
      mutate: (v) => {
        v.inventorySha256 = hash("foreign inventory");
      },
      reason: /Stale source inventory/,
    },
    {
      mutate: (v) => {
        v.assignedFiles = [];
      },
      reason: /Source file partition changed/,
    },
    {
      mutate: (v) => {
        v.compiledTests.beforeAfterByteIdentitiesMatch = false;
      },
      reason: /false/,
    },
  ];
  for (const { mutate, reason } of fragmentMutations) {
    const changed = structuredClone(sourceFragment);
    mutate(changed);
    assert.throws(
      () =>
        requireBaselineSourceSubset({
          ...expected,
          report: changed,
          sourceContract: fragmentContract,
        }),
      reason,
    );
  }
  assert.throws(
    () =>
      requireBaselineSourceSubset({
        ...expected,
        report: original,
        sourceContract: { ...expected.sourceContract, maxTerminalEvents: 8192 },
      }),
    /terminal bound differs/,
  );
});
