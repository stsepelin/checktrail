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
  const root = await fixture(t, {
    "scripts/placeholder": "original",
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
  const marker = path.join(root, "original-marker.jsonl");
  const files = [
    "dist/test/ci-impact.test.js",
    "dist/test/gate-inventory.test.js",
    "dist/test/original-selected.test.js",
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
  assert.equal(report.evidence.required, 2);
  assert.equal(report.evidence.passed, 4);
  assert.equal(report.fullRevisionVerification, false);
  assert.equal(report.nativeProfileQualificationClaimed, false);
  assert.equal(report.gateAComplete, false);
  for (const plan of [
    { mode: "full", sharedTestFiles: files },
    { mode: "affected", sharedTestFiles: [] },
    { mode: "affected", sharedTestFiles: [...files, files[0]] },
    { mode: "affected", sharedTestFiles: [...files, "../outside.test.js"] },
    { mode: "affected", sharedTestFiles: files.slice(1) },
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
  assert.equal(incomplete.evidence.passed, 3);
  assert.ok(
    incomplete.evidence.problems.some(
      (row: { name: string }) => row.name === second,
    ),
  );
});
