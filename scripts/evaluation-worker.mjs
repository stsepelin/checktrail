import assert from "node:assert/strict";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { validate } from "../dist/src/index.js";

const [root, checkId] = process.argv.slice(2);
assert.ok(
  root &&
    [
      "javascript.node-test",
      "javascript.typescript",
      "infrastructure.actionlint",
    ].includes(checkId),
);
const start = performance.now();
const report = await validate(root, { trusted: true });
assert.equal(report.sourceChanged, false);
assert.equal(report.sourceError, false);
assert.equal(report.checks.length, 1);
const check = report.checks[0];
assert.equal(check.id, checkId);
assert.ok(
  check.tools.length &&
    check.tools.every((tool) => tool.status === "identified"),
);
const signals = new Set(check.findings?.map((finding) => finding.ruleId) ?? []);
if (checkId === "javascript.typescript") {
  for (const result of check.processes)
    for (const code of result.stdout.match(/\bTS\d+\b/g) ?? [])
      signals.add(code);
}
if (checkId === "javascript.node-test") {
  for (const result of check.processes)
    for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === "test:fail") {
        const error = event.data?.details?.error;
        if (error?.code) signals.add(error.code);
        if (error?.cause?.code) signals.add(error.cause.code);
      }
    }
}
process.stdout.write(
  JSON.stringify({
    outcome: report.outcome,
    status: check.status,
    signals: [...signals].sort(),
    ...(check.tests ? { tests: check.tests } : {}),
    sourceFingerprint: report.sourceFingerprint,
    tools: check.tools.map(({ name, version }) => ({ name, version })),
    engineMs: performance.now() - start,
  }),
);
