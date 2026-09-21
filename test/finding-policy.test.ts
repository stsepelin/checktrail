import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createFindingBaseline,
  compareFindings,
} from "../src/finding-policy.js";
import {
  findingBaselineSchema,
  findingComparisonSchema,
} from "../src/finding-policy-schema.js";
import { validate } from "../src/engine.js";
import type { Report } from "../src/types.js";
import { fixture } from "./helpers.js";
import { copyESLint, eslintConfig, eslintPolicy } from "./eslint-helpers.js";
const author = {
  owner: "synthetic-maintainer",
  reason: "Temporary synthetic compatibility exception",
};
const now = "2026-09-18T00:00:00.000Z";
function report(): Report {
  return {
    schemaVersion: 1,
    engineVersion: "0.1.0-dev.0",
    runId: "7fc12bf3-0c01-459f-9172-11cd2f4f518a",
    startedAt: now,
    durationMs: 1,
    sourceFingerprint: "source",
    finalSourceFingerprint: "source",
    policyFingerprint: "policy",
    excluded: [],
    sourceChanged: false,
    sourceError: false,
    outcome: "failed",
    checks: [
      {
        id: "synthetic.analysis",
        adapter: "synthetic",
        project: ".",
        scope: ["src/value.ts"],
        status: "failed",
        reason: "Native finding",
        processes: [],
        findingsComplete: true,
        findings: [
          {
            ruleId: "exact-rule",
            level: "error",
            message: "Exact synthetic problem",
            file: "src/value.ts",
            line: 2,
          },
        ],
      },
    ],
  };
}

test("finding baselines match exact identities, count occurrences and retain native validation failure", () => {
  const original = report();
  const before = structuredClone(original);
  const baseline = createFindingBaseline(original, author);
  findingBaselineSchema.parse(baseline);
  const comparison = compareFindings(original, baseline, { now });
  findingComparisonSchema.parse(comparison);
  assert.equal(comparison.outcome, "passed");
  assert.equal(comparison.validationOutcome, "failed");
  assert.equal(comparison.provenance, "finding-comparison");
  assert.equal(comparison.counts.matched, 1);
  assert.deepEqual(original, before);
  assert.ok(!JSON.stringify(baseline).includes("Exact synthetic problem"));
  for (const patch of [
    { ruleId: "exact-rule-extra" },
    { file: "src/value.ts-extra" },
    { line: 3 },
    { level: "warning" as const },
    { message: "Different problem" },
  ]) {
    const changed = report();
    Object.assign(changed.checks[0]!.findings![0]!, patch);
    const result = compareFindings(changed, baseline, { now });
    assert.equal(result.outcome, "failed");
    assert.equal(result.counts.new, 1);
    assert.equal(result.counts.stale, 1);
  }
  const duplicate = report();
  duplicate.checks[0]!.findings!.push({
    ...duplicate.checks[0]!.findings![0]!,
  });
  const counted = compareFindings(duplicate, baseline, { now });
  assert.equal(counted.counts.changed, 1);
  assert.equal(counted.outcome, "failed");
  const two = createFindingBaseline(duplicate, author);
  assert.equal(two.entries[0]!.occurrences, 2);
  assert.equal(compareFindings(duplicate, two, { now }).outcome, "passed");
  const fixed = report();
  fixed.outcome = "passed";
  fixed.checks[0]!.status = "passed";
  fixed.checks[0]!.findings = [];
  assert.equal(compareFindings(fixed, baseline, { now }).counts.stale, 1);
  assert.equal(
    compareFindings(fixed, createFindingBaseline(fixed, author), { now })
      .outcome,
    "passed",
  );
  assert.throws(() => createFindingBaseline(fixed, { owner: "", reason: "" }));
});

test("baseline reconciliation rejects broad, duplicate or forged identities and detects expired exceptions and expansion", () => {
  const input = report();
  const baseline = createFindingBaseline(input, author);
  for (const file of [
    "../outside.ts",
    "/outside.ts",
    "C:/outside.ts",
    "./src/value.ts",
    "src//value.ts",
    "src/../value.ts",
    "src\\value.ts",
    "src/",
    "src/./value.ts",
    "src/\n/../value.ts",
  ]) {
    const altered = structuredClone(baseline);
    altered.entries[0]!.file = file;
    assert.equal(findingBaselineSchema.safeParse(altered).success, false, file);
    assert.throws(() => compareFindings(input, altered, { now }), file);
  }
  const literal = report();
  literal.checks[0]!.findings![0]!.file = "src/literal*.ts";
  assert.equal(
    compareFindings(input, createFindingBaseline(literal, author), { now })
      .counts.new,
    1,
  );
  const duplicate = structuredClone(baseline);
  duplicate.entries.push({ ...duplicate.entries[0]! });
  assert.throws(() => compareFindings(input, duplicate));
  const forged = structuredClone(baseline);
  forged.entries[0]!.id = "0".repeat(64);
  assert.throws(() => compareFindings(input, forged));
  const expired = createFindingBaseline(input, {
    ...author,
    kind: "exception",
    expiresAt: now,
  });
  assert.equal(compareFindings(input, expired, { now }).counts.expired, 1);
  const valid = createFindingBaseline(input, {
    ...author,
    kind: "exception",
    expiresAt: "2027-01-01T00:00:00.000Z",
  });
  assert.equal(compareFindings(input, valid, { now }).outcome, "passed");
  const limits = structuredClone(baseline);
  limits.limits.maxEntries = 0;
  assert.equal(compareFindings(input, limits, { now }).limitExceeded, true);
  const exceptions = structuredClone(valid);
  exceptions.limits.maxExceptions = 0;
  assert.equal(compareFindings(input, exceptions, { now }).limitExceeded, true);
  const previous = {
    ...baseline,
    entries: [],
    limits: { maxEntries: 0, maxExceptions: 0 },
  };
  const expanded = compareFindings(input, baseline, {
    now,
    previousBaseline: previous,
  });
  assert.equal(expanded.counts.expanded, 1);
  assert.equal(expanded.limitExceeded, true);
  assert.equal(expanded.outcome, "failed");
  const modified = structuredClone(baseline);
  modified.entries[0]!.reason = "Changed review decision";
  assert.equal(
    compareFindings(input, modified, { now, previousBaseline: baseline }).counts
      .modified,
    1,
  );
});

test("missing, stale or partial execution cannot reconcile absent entries or hide native failures", () => {
  const input = report();
  const baseline = createFindingBaseline(input, author);
  const partial = report();
  partial.checks[0]!.findingsComplete = false;
  assert.throws(() => createFindingBaseline(partial, author));
  const compared = compareFindings(partial, baseline, { now });
  assert.equal(compared.outcome, "failed");
  assert.equal(compared.counts.unverified, 1);
  assert.equal(compared.unaccountedFailures, 1);
  const missing = report();
  missing.checks = [];
  missing.outcome = "incomplete";
  assert.throws(() => createFindingBaseline(missing, author));
  assert.equal(
    compareFindings(missing, baseline, { now }).counts.unverified,
    1,
  );
  const stale = report();
  stale.sourceChanged = true;
  assert.throws(() => createFindingBaseline(stale, author));
  const result = compareFindings(stale, baseline, { now });
  assert.equal(result.sourceVerified, false);
  assert.equal(result.counts.unverified, 1);
  assert.equal(result.outcome, "incomplete");
  const unknown = report();
  unknown.checks[0]!.tools = [
    {
      name: "synthetic",
      source: "version-command",
      version: null,
      status: "inconclusive",
    },
  ];
  assert.equal(
    compareFindings(unknown, baseline, { now }).outcome,
    "incomplete",
  );
  const unparsed = report();
  delete unparsed.checks[0]!.findings;
  assert.equal(
    compareFindings(unparsed, baseline, { now }).unaccountedFailures,
    1,
  );
  const contradiction = report();
  contradiction.outcome = "passed";
  assert.throws(() => compareFindings(contradiction, baseline));
  const sourceMismatch = report();
  sourceMismatch.finalSourceFingerprint = "other";
  assert.throws(() => compareFindings(sourceMismatch, baseline));
  const repeated = report();
  repeated.checks.push(structuredClone(repeated.checks[0]!));
  assert.throws(() => compareFindings(repeated, baseline));
});

test(
  "native ESLint baseline reconciliation detects a fixed sibling and CLI keeps policy success distinct from validation failure",
  { timeout: 30_000 },
  async (t) => {
    const root = await fixture(t, {
      "package.json": '{"type":"module"}',
      "repo-verifier.json": eslintPolicy(),
      "eslint.config.mjs": eslintConfig,
      "value.js": "debugger;\ndebugger;\n",
    });
    await copyESLint(root);
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed");
    assert.equal(broken.checks[0]!.findingsComplete, true);
    const baseline = createFindingBaseline(broken, author);
    assert.equal(baseline.entries.length, 2);
    await writeFile(path.join(root, "report.json"), JSON.stringify(broken));
    await writeFile(path.join(root, "baseline.json"), JSON.stringify(baseline));
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const run = (args: string[]) =>
      spawnSync(process.execPath, [cli, ...args, "--root", root], {
        encoding: "utf8",
      });
    const matched = run([
      "compare-findings",
      "--input",
      "report.json",
      "--baseline",
      "baseline.json",
    ]);
    assert.equal(matched.status, 0, matched.stderr);
    const summary = JSON.parse(matched.stdout);
    assert.equal(summary.validationOutcome, "failed");
    assert.equal(summary.outcome, "passed");
    assert.ok(!matched.stdout.includes("value.js"));
    assert.equal(summary.entries, undefined);
    const created = run([
      "create-baseline",
      "--input",
      "report.json",
      "--owner",
      author.owner,
      "--reason",
      author.reason,
      "--detailed",
    ]);
    assert.equal(created.status, 0, created.stderr);
    assert.deepEqual(JSON.parse(created.stdout), baseline);
    await writeFile(
      path.join(root, "value.js"),
      "// fixed first issue\ndebugger;\n",
    );
    const partial = await validate(root, { trusted: true });
    assert.equal(partial.outcome, "failed");
    assert.equal(partial.checks[0]!.findingsComplete, true);
    const reconciled = compareFindings(partial, baseline, { now });
    assert.equal(reconciled.counts.matched, 1);
    assert.equal(reconciled.counts.stale, 1);
    assert.equal(reconciled.outcome, "failed");
    assert.equal(
      reconciled.counts.matched +
        reconciled.counts.stale +
        reconciled.counts.expired +
        reconciled.counts.changed +
        reconciled.counts.unverified,
      baseline.entries.length,
    );
  },
);
