import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { importJUnit } from "../src/junit.js";
import { fixture } from "./helpers.js";

const valid =
  '<testsuite name="synthetic" tests="1" failures="0" errors="0" skipped="0"><testcase name="adds &amp; compares" file="Example.php" assertions="1"/></testsuite>';

test("JUnit imports reconcile nested suite totals without claiming execution freshness", () => {
  const result = importJUnit(`<testsuites tests="1">${valid}</testsuites>`);
  assert.equal(result.outcome, "passed");
  assert.equal(result.provenance, "imported-report");
  assert.equal(result.cases?.[0]!.name, "adds & compares");
  assert.deepEqual(result.tests, {
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
  });
  for (const [tag, outcome] of [
    ["failure", "failed"],
    ["error", "failed"],
    ["skipped", "incomplete"],
  ] as const) {
    const xml = `<testsuite tests="1"><testcase name="case"><${tag}/></testcase></testsuite>`;
    assert.equal(importJUnit(xml).outcome, outcome);
  }
});

test("JUnit rejects malformed, contradictory, empty, duplicate and entity-bearing reports", () => {
  for (const xml of [
    "",
    "<testsuite>",
    '<testsuite tests="0"/>',
    valid.replace('tests="1"', 'tests="2"'),
    valid.replace('tests="1"', 'tests="-1"'),
    valid.replace('tests="1"', 'tests="9007199254740993"'),
    valid.replace('tests="1"', ""),
    valid + valid,
    '<testsuite tests="2"><testcase name="duplicate"/><testcase name="duplicate"/></testsuite>',
    '<testsuite tests="1"><testcase name="case"><failure/><skipped/></testcase></testsuite>',
    '<testsuite tests="1"><testcase name="case"><flakyFailure/></testcase></testsuite>',
    '<!DOCTYPE testsuite [<!ENTITY leak SYSTEM "file:///private.txt">]>' +
      valid,
    '<!DOCTYPE testsuite [<!ENTITY a "aaaa">]>' +
      valid.replace("adds &amp; compares", "&a;"),
    '<testsuite tests="1">'.repeat(40) +
      '<testcase name="deep"/>' +
      "</testsuite>".repeat(40),
    " ".repeat(8 * 1024 * 1024 + 1) + valid,
  ])
    assert.equal(importJUnit(xml).outcome, "incomplete", xml.slice(0, 160));
});

test("JUnit CLI import keeps file/case details out of default output", async (t) => {
  const root = await fixture(t, { "results.xml": valid });
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const run = spawnSync(
    process.execPath,
    [cli, "import-junit", "--root", root, "--input", "results.xml"],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const value = JSON.parse(run.stdout);
  assert.equal(value.provenance, "imported-report");
  assert.equal(value.outcome, "passed");
  assert.ok(!run.stdout.includes("Example.php"));
  const escape = spawnSync(
    process.execPath,
    [
      cli,
      "import-junit",
      "--root",
      root,
      "--input",
      path.resolve(root, "results.xml"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(escape.status, 2);
});
