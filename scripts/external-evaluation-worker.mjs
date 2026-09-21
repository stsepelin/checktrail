import assert from "node:assert/strict";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { validate } from "../dist/src/engine.js";
import { normalizeExternalDiagnostics } from "./external-evaluation-evidence.mjs";
assert.equal(
  process.argv.length,
  3,
  "Worker accepts a root only, never labels",
);
const root = process.argv[2];
const start = performance.now();
const report = await validate(root, { trusted: true });
assert.equal(report.sourceChanged, false);
assert.equal(report.sourceError, false);
assert.equal(report.checks.length, 1);
const check = report.checks[0];
assert.equal(check.id, "javascript.eslint");
assert.deepEqual(check.scope, ["case.js", "eslint.config.cjs"]);
assert.ok(
  check.tools.length &&
    check.tools.every((tool) => tool.status === "identified"),
);
let diagnostics = [];
if (["passed", "failed"].includes(check.status)) {
  assert.equal(check.processes.length, 1);
  const evidence = JSON.parse(check.processes[0].stdout);
  assert.equal(evidence.toolVersion, "10.10.0");
  assert.ok(
    evidence.files.every((file) => file.configured && file.activeRules > 0),
  );
  diagnostics = normalizeExternalDiagnostics(
    evidence.files.flatMap((file) => file.results),
    root,
  );
}
process.stdout.write(
  JSON.stringify({
    outcome: report.outcome,
    status: check.status,
    sourceFingerprint: report.sourceFingerprint,
    diagnostics,
    tools: check.tools.map(({ name, version }) => ({ name, version })),
    engineMs: performance.now() - start,
  }),
);
