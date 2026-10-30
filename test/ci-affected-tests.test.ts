import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";

test("affected shared CI runs whole selected files, refuses skipped required controls and rejects invalid selections before any callback", async (t) => {
  const first =
    "CI declared native inputs match every workflow controller profile matrix and imported fixture";
  const second =
    "finite inventory audit preserves every original named native case without declaring implementation or quality acceptance";
  const boundaryControls = [
    "CI source boundaries bind exact subprocess callers and all recorded native consumers without executing source",
    "CI source boundary guards reject new imports duplicate callers encoded aliases dynamic resolution and missing profile consumers",
  ];
  const boundaryFixture = (skip: boolean) =>
    `import{test}from'node:test';${boundaryControls.map((name) => `test(${JSON.stringify(name)},{skip:${skip}},()=>{});`).join("")}`;
  const root = await fixture(t, {
    "scripts/placeholder": "original",
    "dist/test/ci-source-boundaries.test.js": boundaryFixture(false),
    "dist/test/ci-impact.test.js": `import{test}from'node:test';test(${JSON.stringify(first)},()=>{});`,
    "dist/test/gate-inventory.test.js": `import{test}from'node:test';test(${JSON.stringify(second)},()=>{});`,
    "dist/test/original-selected.test.js":
      "import{test}from'node:test';import{appendFileSync}from'node:fs';test('original selected first',()=>appendFileSync(process.env.ORIGINAL_CI_MARKER,'first\\n'));test('original selected second',()=>appendFileSync(process.env.ORIGINAL_CI_MARKER,'second\\n'));",
  });
  for (const file of [
    "verify-ci-affected-tests.mjs",
    "required-test-evidence.mjs",
  ])
    await cp(
      new URL("../../scripts/" + file, import.meta.url),
      path.join(root, "scripts", file),
    );
  await cp(
    new URL("../../scripts/required-native-tests.json", import.meta.url),
    path.join(root, "scripts/required-native-tests.json"),
  );
  const artifactRows: { file: string; name: string }[] = JSON.parse(
    await readFile(
      path.join(root, "scripts/required-native-tests.json"),
      "utf8",
    ),
  )["selected-artifact-evidence"];
  const artifactFile = artifactRows[0]!.file;
  const artifactFixture = (mode = "complete", target = artifactRows[0]!.name) =>
    `import{test}from'node:test';${artifactRows
      .filter((row) => mode !== "missing" || row.name !== target)
      .map(
        (row) =>
          `test(${JSON.stringify(row.name)},{skip:${mode === "skipped" && row.name === target}},()=>{});`,
      )
      .join("")}`;
  await writeFile(path.join(root, artifactFile), artifactFixture());
  const marker = path.join(root, "original-marker.jsonl");
  const files = [
    "dist/test/ci-impact.test.js",
    "dist/test/gate-inventory.test.js",
    "dist/test/original-selected.test.js",
    "dist/test/ci-source-boundaries.test.js",
    artifactFile,
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, ORIGINAL_CI_MARKER: marker };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const execute = (plan: object) =>
    spawnSync(
      process.execPath,
      [path.join(root, "scripts/verify-ci-affected-tests.mjs")],
      {
        cwd: root,
        env: { ...env, CHECKTRAIL_CI_PLAN: JSON.stringify(plan) },
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1048576,
      },
    );
  const passed = execute({ mode: "affected", sharedTestFiles: files });
  assert.equal(passed.error, undefined);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.equal(await readFile(marker, "utf8"), "first\nsecond\n");
  const report = JSON.parse(passed.stdout);
  assert.equal(report.evidence.complete, true);
  assert.equal(report.evidence.required, 4 + artifactRows.length);
  assert.equal(report.evidence.passed, 6 + artifactRows.length);
  assert.equal(report.fullRevisionVerification, false);
  assert.equal(report.nativeProfileQualificationClaimed, false);
  assert.equal(report.gateAComplete, false);
  for (const plan of [
    { mode: "full", sharedTestFiles: files },
    { mode: "affected", sharedTestFiles: [] },
    { mode: "affected", sharedTestFiles: [...files, files[0]] },
    { mode: "affected", sharedTestFiles: [...files, "../outside.test.js"] },
    { mode: "affected", sharedTestFiles: files.slice(1) },
    { mode: "affected", sharedTestFiles: files.slice(0, -1) },
    {
      mode: "affected",
      sharedTestFiles: [...files, "dist/test/original-missing.test.js"],
    },
  ]) {
    const refused = execute(plan);
    assert.equal(refused.error, undefined);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.equal(
      await readFile(marker, "utf8"),
      "first\nsecond\n",
      "Invalid selection must stop before callbacks",
    );
  }
  await writeFile(
    path.join(root, files[1]!),
    `import{test}from'node:test';test(${JSON.stringify(second)},{skip:true},()=>{});`,
  );
  const skipped = execute({ mode: "affected", sharedTestFiles: files });
  assert.equal(skipped.error, undefined);
  assert.equal(skipped.status, 1, skipped.stdout + skipped.stderr);
  const incomplete = JSON.parse(skipped.stdout);
  assert.equal(incomplete.evidence.complete, false);
  assert.equal(incomplete.evidence.passed, 5 + artifactRows.length);
  assert.ok(
    incomplete.evidence.problems.some(
      (row: { name: string }) => row.name === second,
    ),
  );
  await writeFile(
    path.join(root, files[1]!),
    `import{test}from'node:test';test(${JSON.stringify(second)},()=>{});`,
  );
  await writeFile(path.join(root, files[3]!), boundaryFixture(true));
  const boundarySkipped = execute({ mode: "affected", sharedTestFiles: files });
  assert.equal(boundarySkipped.error, undefined);
  assert.equal(
    boundarySkipped.status,
    1,
    boundarySkipped.stdout + boundarySkipped.stderr,
  );
  const boundaryIncomplete = JSON.parse(boundarySkipped.stdout);
  assert.equal(boundaryIncomplete.evidence.complete, false);
  assert.equal(boundaryIncomplete.evidence.passed, 4 + artifactRows.length);
  assert.deepEqual(
    boundaryIncomplete.evidence.problems
      .map((row: { name: string; reason: string }) =>
        JSON.stringify([row.name, row.reason]),
      )
      .sort(),
    boundaryControls
      .flatMap((name) =>
        ["skipped-or-todo", "required-test-not-passed"].map((reason) =>
          JSON.stringify([name, reason]),
        ),
      )
      .sort(),
  );
  await writeFile(path.join(root, files[3]!), boundaryFixture(false));
  for (const row of artifactRows) {
    for (const mode of ["skipped", "missing"]) {
      await writeFile(
        path.join(root, artifactFile),
        artifactFixture(mode, row.name),
      );
      const result = execute({ mode: "affected", sharedTestFiles: files });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, mode + ": " + row.name);
      const evidence = JSON.parse(result.stdout).evidence;
      assert.equal(evidence.complete, false);
      assert.equal(evidence.passed, 5 + artifactRows.length);
      assert.ok(
        evidence.problems.some(
          (problem: { name: string; reason: string }) =>
            problem.name === row.name &&
            problem.reason === "required-test-not-passed",
        ),
      );
    }
  }
  await writeFile(path.join(root, artifactFile), artifactFixture());
  assert.equal(execute({ mode: "affected", sharedTestFiles: files }).status, 0);
});
