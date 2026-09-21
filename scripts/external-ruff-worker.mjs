import assert from "node:assert/strict";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { validate } from "../dist/src/engine.js";
import { normalizeRuffDiagnostics } from "./external-ruff-evidence.mjs";
assert.equal(
  process.argv.length,
  3,
  "The worker receives only a root, never expected diagnostics",
);
const root = process.argv[2];
const start = performance.now();
const report = await validate(root, { trusted: true });
assert.equal(report.sourceChanged, false);
assert.equal(report.sourceError, false);
assert.equal(report.checks.length, 1);
const check = report.checks[0];
assert.equal(check.id, "python.ruff");
assert.equal(check.scope.length, 1);
let diagnostics = [];
if (check.findingsComplete) {
  assert.equal(check.processes.length, 3);
  diagnostics = normalizeRuffDiagnostics(
    JSON.parse(check.processes.at(-1).stdout),
    root,
    check.scope[0],
  );
  assert.deepEqual(
    check.findings.map((item) => ({
      code: item.ruleId,
      file: item.file,
      line: item.line,
    })),
    diagnostics.map(({ code, file, line }) => ({ code, file, line })),
  );
}
assert.ok(
  check.tools.length > 0 &&
    check.tools.every((tool) => tool.status === "identified"),
);
process.stdout.write(
  JSON.stringify({
    outcome: report.outcome,
    status: check.status,
    complete: check.findingsComplete === true,
    sourceFingerprint: report.sourceFingerprint,
    diagnostics,
    tools: check.tools.map(({ name, version }) => ({ name, version })),
    engineMs: performance.now() - start,
  }),
);
