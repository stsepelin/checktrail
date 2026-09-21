import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { createRequire } from "node:module";
import type { FormatsPlugin } from "ajv-formats";
import { exportSarif } from "../src/sarif.js";
import { validate } from "../src/engine.js";
import { projectReport } from "../src/output.js";
import { reportSchema } from "../src/schemas.js";
import type { Report } from "../src/types.js";
import { fixture } from "./helpers.js";
import { copyESLint, eslintConfig, eslintPolicy } from "./eslint-helpers.js";

const schemaBytes = await readFile(
  new URL(
    "../../test/fixtures/external/sarif-2.1.0.schema.json",
    import.meta.url,
  ),
);
assert.equal(
  createHash("sha256").update(schemaBytes).digest("hex"),
  "ad6db49878699b091f3eeb765b6e29e92a34bad4da88664d000c923b549c3a25",
);
// OASIS cos02 language patterns contain an unescaped ]; keep the published schema unchanged.
const ajv = new Ajv({ strict: false, allErrors: true, unicodeRegExp: false });
const formats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;
formats(ajv);
const validSarif = ajv.compile(JSON.parse(schemaBytes.toString("utf8")));
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function base(): Report {
  return {
    schemaVersion: 1,
    engineVersion: "0.1.0-dev.0",
    runId: "7fc12bf3-0c01-459f-9172-11cd2f4f518a",
    startedAt: "2026-09-18T00:00:00.000Z",
    durationMs: 1,
    sourceFingerprint: "synthetic",
    finalSourceFingerprint: "synthetic",
    policyFingerprint: "synthetic",
    excluded: [],
    sourceChanged: false,
    sourceError: false,
    outcome: "failed",
    checks: [
      {
        id: "synthetic.analysis",
        adapter: "synthetic",
        project: ".",
        scope: ["src/a #é.ts"],
        status: "failed",
        reason: "Synthetic analysis diagnostics",
        processes: [],
        findingsComplete: true,
        findings: [
          {
            ruleId: "rule/no-value",
            level: "warning",
            message: "Unexpected {value}",
            file: "src/a #é.ts",
            line: 2,
          },
        ],
      },
    ],
  };
}

test("SARIF conforms to the official schema and encodes paths, rule IDs and message braces", () => {
  const report = base();
  for (const complete of [false, undefined]) {
    const partial = base();
    if (complete === undefined) delete partial.checks[0]!.findingsComplete;
    else partial.checks[0]!.findingsComplete = complete;
    assert.equal(
      exportSarif(partial).runs[0]!.invocations[0]!.executionSuccessful,
      false,
    );
  }
  const sarif = exportSarif(report);
  assert.equal(validSarif(sarif), true, JSON.stringify(validSarif.errors));
  const run = sarif.runs[0]!;
  assert.equal(run.invocations[0]!.executionSuccessful, true);
  assert.equal(run.properties.outcome, "failed");
  assert.equal(
    run.results[0]!.locations![0]!.physicalLocation.artifactLocation.uri,
    "src/a%20%23%C3%A9.ts",
  );
  assert.equal(run.results[0]!.ruleId, "synthetic.analysis/rule%2Fno-value");
  assert.equal(run.results[0]!.level, "warning");
  assert.equal(run.results[0]!.message.text, "Unexpected {{value}}");
  assert.equal(
    run.results[0]!.locations![0]!.physicalLocation.region?.startLine,
    2,
  );
  assert.ok(!JSON.stringify(sarif).includes('"processes"'));
  assert.ok(
    !JSON.stringify(projectReport(report, false)).includes("Unexpected"),
  );
  for (const file of [
    "/private/secret.ts",
    "../outside.ts",
    "a/../../outside.ts",
    "C:\\secret.ts",
    "a\\b.ts",
    "a//b.ts",
    "./a.ts",
  ]) {
    report.checks[0]!.findings![0]!.file = file;
    assert.throws(() => exportSarif(report), /repository-relative/);
  }
});

test("SARIF preserves incompleteness and test failures without fabricating source results", () => {
  for (const status of [
    "unavailable",
    "error",
    "skipped",
    "inconclusive",
    "failed",
  ] as const) {
    const report = base();
    delete report.checks[0]!.findings;
    report.checks[0]!.status = status;
    report.outcome = status === "failed" ? "failed" : "incomplete";
    const sarif = exportSarif(report);
    assert.equal(validSarif(sarif), true, JSON.stringify(validSarif.errors));
    const run = sarif.runs[0]!;
    assert.deepEqual(run.results, []);
    assert.equal(run.invocations[0]!.executionSuccessful, false);
    assert.equal(
      run.invocations[0]!.toolExecutionNotifications[0]!.level,
      "error",
    );
    assert.equal(run.properties.status, status);
  }
  for (const sourceFlag of ["sourceChanged", "sourceError"] as const) {
    const report = base();
    report[sourceFlag] = true;
    const sarif = exportSarif(report);
    assert.equal(sarif.runs[0]!.results.length, 1);
    assert.equal(sarif.runs[0]!.invocations[0]!.executionSuccessful, false);
  }
  const empty = { ...base(), checks: [], outcome: "incomplete" as const };
  assert.equal(
    exportSarif(empty).runs[0]!.invocations[0]!.executionSuccessful,
    false,
  );
  assert.throws(
    () => exportSarif({ ...empty, outcome: "passed" }),
    /contradicts/,
  );
  assert.throws(() => exportSarif(projectReport(base(), false)));
});

test("native ESLint diagnostics reach library and CLI SARIF without commands or logs", async (t) => {
  const root = await fixture(t, {
    "package.json": '{"type":"module"}',
    "checktrail.json": eslintPolicy(),
    "eslint.config.js": eslintConfig,
    "source #with space.js": "debugger;\n",
  });
  await copyESLint(root);
  const report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "failed");
  reportSchema.parse(report);
  assert.deepEqual(report.checks[0]!.findings, [
    {
      ruleId: "no-debugger",
      level: "error",
      message: "Unexpected 'debugger' statement.",
      file: "source #with space.js",
      line: 1,
    },
  ]);
  const sarif = exportSarif(report);
  assert.equal(validSarif(sarif), true, JSON.stringify(validSarif.errors));
  await writeFile(path.join(root, "report.json"), JSON.stringify(report));
  const result = spawnSync(
    process.execPath,
    [cli, "export-sarif", "--root", root, "--input", "report.json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), sarif);
  assert.ok(!result.stdout.includes(root));
  assert.ok(!result.stdout.includes('"command"'));
  const escape = spawnSync(
    process.execPath,
    [cli, "export-sarif", "--root", root, "--input", "../report.json"],
    { encoding: "utf8" },
  );
  assert.equal(escape.status, 2);
  await writeFile(
    path.join(root, "source #with space.js"),
    "export const value = 42;\n",
  );
  const fixed = await validate(root, { trusted: true });
  assert.equal(fixed.outcome, "passed");
  assert.deepEqual(exportSarif(fixed).runs[0]!.results, []);
  assert.equal(
    exportSarif(fixed).runs[0]!.invocations[0]!.executionSuccessful,
    true,
  );
});
