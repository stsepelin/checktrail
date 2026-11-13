import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fixture } from "./helpers.js";
const api = await import(
  new URL("../../scripts/ci-full-suite-shards.mjs", import.meta.url).href
);
const root = fileURLToPath(new URL("../../", import.meta.url));
const files = [
  "a.test.js",
  "b.test.js",
  "c.test.js",
  "gate-go-extensions.test.js",
  "gate-javascript-extensions.test.js",
  "gate-tasks-matrix.test.js",
];
const inventory = files.map((file) => ({
  file,
  bytes: 4096,
  sha256: "a".repeat(64),
}));
test("full-suite shards retain a closed disjoint inventory and spread the three heaviest native files", () => {
  const partition = api.partitionFullSuiteFiles(inventory);
  assert.deepEqual(
    partition.shards.map((row: { id: string }) => row.id),
    ["0", "1", "2"],
  );
  assert.deepEqual(
    partition.shards.flatMap((row: { files: string[] }) => row.files).sort(),
    files,
  );
  for (const row of partition.shards)
    assert.equal(
      row.files.filter((file: string) => file.startsWith("gate-")).length,
      1,
    );
  for (const mutate of [
    (p: typeof partition) => p.shards.pop(),
    (p: typeof partition) => p.shards[0].files.pop(),
    (p: typeof partition) => p.shards[0].files.push(p.shards[1].files[0]),
    (p: typeof partition) => {
      p.shards[0].id = "foreign";
    },
    (p: typeof partition) => {
      p.inventorySha256 = "f".repeat(64);
    },
  ]) {
    const bad = structuredClone(partition);
    mutate(bad);
    assert.throws(() => api.requireFullSuitePartition(bad, inventory));
  }
  assert.throws(() => api.partitionFullSuiteFiles(inventory.slice(0, 2)));
});
test("full-suite profile selection validates unassigned requirements before any execution", () => {
  const profiles = {
    one: [
      { file: "dist/test/a.test.js", name: "A" },
      { file: "dist/test/b.test.js", name: "B" },
    ],
    two: [{ file: "dist/test/c.test.js", name: "C" }],
  };
  const selected = api.selectFullSuiteRequirements(
    profiles,
    ["one", "two"],
    inventory,
    ["a.test.js"],
  );
  assert.equal(selected.allRequired, 3);
  assert.equal(selected.assignedRequired, 1);
  assert.deepEqual(selected.profiles.one, [
    { file: "dist/test/a.test.js", name: "A" },
  ]);
  for (const bad of [
    { ...profiles, two: [{ file: "dist/test/missing.test.js", name: "C" }] },
    { ...profiles, two: [{ file: "../../escape.test.js", name: "C" }] },
    {
      ...profiles,
      two: [
        { file: "dist/test/c.test.js", name: "C" },
        { file: "dist/test/c.test.js", name: "C" },
      ],
    },
    { ...profiles, two: [] },
  ])
    assert.throws(() =>
      api.selectFullSuiteRequirements(bad, ["one", "two"], inventory, [
        "a.test.js",
      ]),
    );
  assert.throws(() =>
    api.selectFullSuiteRequirements(profiles, ["one", "one"], inventory, [
      "a.test.js",
    ]),
  );
  assert.throws(() =>
    api.selectFullSuiteRequirements(profiles, ["unknown"], inventory, [
      "a.test.js",
    ]),
  );
  assert.throws(
    () =>
      api.selectFullSuiteRequirements(
        { "mutation-vitest": profiles.one },
        ["mutation-vitest"],
        inventory,
        ["a.test.js"],
      ),
    /run separately/,
  );
});
async function project(t: Parameters<typeof fixture>[0], failing = false) {
  const data: Record<string, string> = {
    "package.json": '{"type":"module"}',
    "dist/src/index.js": "export const synthetic = true;\n",
  };
  for (const [index, file] of files.entries()) {
    data["test/" + file.replace(/\.js$/u, ".ts")] =
      "// Synthetic source inventory.\n";
    data["dist/test/" + file] =
      `import {test} from 'node:test';import assert from 'node:assert/strict';import{appendFileSync}from'node:fs';test('required-${index}',()=>{appendFileSync('bodies.jsonl',JSON.stringify({name:'required-${index}',pid:process.pid})+String.fromCharCode(10));assert.equal(${failing && index === 0},false);});test('unlisted-${index}',()=>appendFileSync('bodies.jsonl',JSON.stringify({name:'unlisted-${index}',pid:process.pid})+String.fromCharCode(10)));`;
  }
  data["scripts/required-native-tests.json"] = JSON.stringify({
    all: files.map((file, index) => ({
      file: "dist/test/" + file,
      name: "required-" + index,
    })),
  });
  data["scripts/ci-full-suite-profiles.json"] = JSON.stringify({
    schemaVersion: 1,
    profiles: ["all"],
    remainingCommands: [],
  });
  const repository = await fixture(t, data);
  for (const file of [
    "ci-full-suite-shards.mjs",
    "verify-ci-full-suite-shard.mjs",
    "required-test-evidence.mjs",
    "compiled-engine-evidence.mjs",
  ])
    await cp(
      path.join(root, "scripts", file),
      path.join(repository, "scripts", file),
    );
  return repository;
}
function invoke(repository: string, flag: string, ...profiles: string[]) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(
    process.execPath,
    ["scripts/verify-ci-full-suite-shard.mjs", flag, ...profiles],
    {
      cwd: repository,
      env,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 2 * 1048576,
    },
  );
}
test("all three real shard entrypoints execute every original and unlisted body exactly once without claiming the whole suite", async (t) => {
  const repository = await project(t);
  const reports = [];
  for (const id of ["0", "1", "2"]) {
    const result = invoke(repository, "--shard" + id, "all");
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const report = JSON.parse(result.stdout);
    reports.push(report);
    const selected = api.selectFullSuiteRequirements(
      JSON.parse(
        await readFile(
          path.join(repository, "scripts/required-native-tests.json"),
          "utf8",
        ),
      ),
      ["all"],
      (await api.captureFullSuiteInventory(repository)).inventory,
      report.assignedFiles,
    );
    const originalInventory = (await api.captureFullSuiteInventory(repository))
      .inventory;
    assert.ok(report.elapsedMilliseconds > 0);
    const wrong = structuredClone(report);
    wrong.ledger.files[0].before.sha256 = "f".repeat(64);
    wrong.ledger.files[0].after.sha256 = "f".repeat(64);
    assert.equal(wrong.ledger.files[0].stable, true);
    assert.throws(
      () =>
        api.requireFullSuiteFileEvidence(
          wrong,
          originalInventory,
          report.assignedFiles,
          selected,
        ),
      /differs from the inventoried test source/,
    );
    assert.equal(report.timingHints.length, report.assignedFiles.length);
    assert.equal(report.complete, false);
    assert.equal(report.wholeSuiteComplete, false);
    assert.equal(report.fragmentComplete, true);
    assert.equal(report.compiledEngine.beforeAfterByteIdentitiesMatch, true);
    assert.equal(report.compiledTests.beforeAfterByteIdentitiesMatch, true);
    assert.ok(report.assignedRequired > 0);
    assert.equal(report.assignedRequired, report.required);
  }
  assert.equal(new Set(reports.map((r) => r.partitionSha256)).size, 1);
  assert.deepEqual(reports.flatMap((r) => r.assignedFiles).sort(), files);
  const reached = (
    await readFile(path.join(repository, "bodies.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    reached.map((r) => r.name).sort(),
    files.flatMap((_, i) => ["required-" + i, "unlisted-" + i]).sort(),
  );
  assert.equal(
    new Set(reached.map((r) => r.pid)).size,
    files.length,
    "Each physical file needs its own process",
  );
  assert.equal(
    reports.reduce((n, r) => n + r.required, 0),
    files.length,
  );
});
test("shard failure and stale compiled inventory cannot pass or start unrelated bodies", async (t) => {
  const repository = await project(t, true);
  const { inventory } = await api.captureFullSuiteInventory(repository);
  const partition = api.partitionFullSuiteFiles(inventory),
    owner = partition.shards.find((row: { files: string[] }) =>
      row.files.includes("a.test.js"),
    );
  const failed = invoke(repository, "--shard" + owner.id, "all");
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).fragmentComplete, false);
  const failureReport = JSON.parse(failed.stdout);
  assert.ok(
    failureReport.ledger.events.some(
      (row: { name: string; outcome: string; required: boolean }) =>
        row.name === "required-0" && row.outcome === "failed" && row.required,
    ),
  );
  assert.ok(
    failureReport.ledger.events.some(
      (row: { name: string; outcome: string }) =>
        row.name === "unlisted-0" && row.outcome === "passed",
    ),
  );
  await rm(path.join(repository, "bodies.jsonl"));
  await writeFile(
    path.join(repository, "dist/test/stale.test.js"),
    "throw Error('Stale code must never execute');\n",
  );
  const stale = invoke(repository, "--shard0", "all");
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /missing source tests or contains stale tests/);
  await assert.rejects(readFile(path.join(repository, "bodies.jsonl")), {
    code: "ENOENT",
  });
  await rm(path.join(repository, "dist/test/stale.test.js"));
  const omitted = invoke(repository, "--shard0", "different");
  assert.notEqual(omitted.status, 0);
  assert.match(omitted.stderr, /cannot omit required profiles/);
  await assert.rejects(readFile(path.join(repository, "bodies.jsonl")), {
    code: "ENOENT",
  });
  for (const flag of ["--shard3", "--shard0-extra", ""]) {
    const refused = invoke(repository, flag, "all");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Use --shard/);
  }
});

test("full-suite shard refuses a caller working directory outside its selected repository before test bodies run", async (t) => {
  const repository = await project(t);
  await assert.rejects(
    api.runFullSuiteShard(repository, "0", ["all"]),
    /selected repository working directory/,
  );
  await assert.rejects(readFile(path.join(repository, "bodies.jsonl")), {
    code: "ENOENT",
  });
});
