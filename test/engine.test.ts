import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { validate } from "../src/engine.js";
import { projectReport } from "../src/output.js";
import { fixture, nodeManifest, passingTest } from "./helpers.js";

test("runs native Node tests and records test evidence", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "sum.test.js": passingTest,
  });
  const report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "passed");
  assert.equal(report.sourceChanged, false);
  assert.equal(report.sourceError, false);
  assert.equal(report.checks[0]?.tests?.passed, 1);
  assert.equal(report.sourceFingerprint, report.finalSourceFingerprint);
});

test("rejects execution without operator trust before a project test can run", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "side-effect.test.js":
      "import fs from 'node:fs'; fs.writeFileSync('sentinel', 'ran');",
  });
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(path.join(root, "sentinel")));
});

test("reports test failures and does not expose raw logs in summary mode", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "broken.test.js":
      "import { test } from 'node:test'; test('example', () => { throw new Error('synthetic-private-message'); });",
  });
  const report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "failed");
  assert.equal(report.checks[0]?.status, "failed");
  assert.deepEqual(report.checks[0]?.tests, {
    total: 1,
    passed: 0,
    failed: 1,
    skipped: 0,
  });
  assert.ok(
    JSON.stringify(projectReport(report, true)).includes(
      "synthetic-private-message",
    ),
  );
  const summary = JSON.stringify(projectReport(report, false));
  assert.ok(!summary.includes("synthetic-private-message"));
  assert.ok(!summary.includes(root));
  assert.ok(!summary.includes("broken.test.js"));
});

test("zero-test and all-skipped JavaScript files never yield pass", async (t) => {
  for (const contents of [
    "",
    "import { test } from 'node:test'; test.skip('pending', () => {});",
  ]) {
    const root = await fixture(t, {
      "package.json": nodeManifest,
      "empty.test.js": contents,
    });
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete");
  }
});

test("source edits during a successful check invalidate the aggregate result", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "change.test.js":
      "import { test } from 'node:test'; import fs from 'node:fs'; test('writes source', () => fs.writeFileSync('changed.js', 'export const value = 1;'));",
  });
  const report = await validate(root, { trusted: true });
  assert.equal(report.checks[0]?.status, "passed");
  assert.equal(report.sourceChanged, true);
  assert.equal(report.outcome, "incomplete");
});

test("native Python unittest execution yields counts and preserves the source snapshot", async (t) => {
  if (spawnSync("python3", ["--version"]).status !== 0)
    return t.skip("python3 unavailable");
  const root = await fixture(t, {
    "pyproject.toml": '[project]\nname = "synthetic-example"',
    "repo-verifier.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["python.unittest"] }],
    }),
    "tests/test_sum.py":
      "import unittest\n\nclass SumTest(unittest.TestCase):\n    def test_sum(self):\n        self.assertEqual(2 + 3, 5)\n",
  });
  const report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "passed");
  assert.equal(report.checks[0]?.tests?.passed, 1);
  await writeFile(
    path.join(root, "tests/test_sum.py"),
    "import unittest\nclass SumTest(unittest.TestCase):\n    def test_sum(self): self.assertEqual(2 + 3, 6)\n",
  );
  const failed = await validate(root, { trusted: true });
  assert.equal(failed.outcome, "failed");
  assert.deepEqual(failed.checks[0]!.tests, {
    total: 1,
    passed: 0,
    failed: 1,
    skipped: 0,
  });
});

test(
  "native Go formatting, vet and uncached tests run as separate checks",
  { timeout: 125_000 },
  async (t) => {
    if (spawnSync("go", ["version"]).status !== 0)
      return t.skip("Go unavailable");
    const root = await fixture(t, {
      "go.mod": "module example.test/arithmetic\n\ngo 1.22\n",
      "sum.go":
        "package arithmetic\n\nfunc Sum(a, b int) int { return a + b }\n",
      "sum_test.go":
        'package arithmetic\n\nimport "testing"\n\nfunc TestSum(t *testing.T) {\n\tif Sum(2, 3) != 5 {\n\t\tt.Fatal("incorrect sum")\n\t}\n}\n',
    });
    const report = await validate(root, { trusted: true, timeoutMs: 120_000 });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.deepEqual(
      report.checks.map((check) => check.id),
      ["go.format", "go.vet", "go.test"],
    );
    assert.equal(report.checks[2]?.tests?.passed, 1);
    await writeFile(
      path.join(root, "sum.go"),
      "package arithmetic\n\nfunc Sum(a, b int) int { return a - b }\n",
    );
    const failed = await validate(root, { trusted: true, timeoutMs: 120_000 });
    assert.equal(failed.checks[2]!.status, "failed");
    assert.deepEqual(failed.checks[2]!.tests, {
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
    });
  },
);

test("native PHP syntax accepts valid code and rejects malformed code", async (t) => {
  if (spawnSync("php", ["--version"]).status !== 0)
    return t.skip("PHP unavailable");
  for (const [code, expected] of [
    ["<?php function sum(int $a, int $b): int { return $a + $b; }", "passed"],
    ["<?php function broken(", "failed"],
  ]) {
    const root = await fixture(t, {
      "composer.json": "{}",
      "example.php": code!,
    });
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, expected);
  }
});
