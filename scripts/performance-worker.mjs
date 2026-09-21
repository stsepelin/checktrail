import assert from "node:assert/strict";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { createPlan, validate } from "../dist/src/index.js";

const [root, mode, projectsInput, filesInput] = process.argv.slice(2);
const projects = Number(projectsInput);
const files = Number(filesInput);
assert.ok(root && ["plan", "validate"].includes(mode));
assert.ok(Number.isInteger(projects) && projects > 0 && projects <= 20);
assert.ok(Number.isInteger(files) && files > 0 && files <= 2000);
const start = performance.now();
const cpuStart = process.cpuUsage();
let fingerprint;
let checks;
let executedTests = 0;
if (mode === "plan") {
  const result = await createPlan(root);
  assert.equal(result.source.files.length, files);
  assert.equal(result.plan.projects.length, projects);
  assert.equal(result.plan.checks.length, projects);
  assert.ok(
    result.plan.checks.every(
      (check) =>
        check.id === "javascript.node-test" && !check.unavailableReason,
    ),
  );
  fingerprint = result.source.fingerprint;
  checks = result.plan.checks.length;
} else {
  const result = await validate(root, { trusted: true });
  assert.equal(result.outcome, "passed");
  assert.equal(result.sourceChanged, false);
  assert.equal(result.sourceError, false);
  assert.equal(result.checks.length, projects);
  assert.ok(
    result.checks.every(
      (check) =>
        check.id === "javascript.node-test" &&
        check.status === "passed" &&
        check.tests?.passed === 1 &&
        check.tests.failed === 0 &&
        check.tests.skipped === 0,
    ),
  );
  fingerprint = result.sourceFingerprint;
  checks = result.checks.length;
  executedTests = result.checks.reduce(
    (sum, check) => sum + check.tests.passed,
    0,
  );
}
const engineMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
process.stdout.write(
  JSON.stringify({
    fingerprint,
    checks,
    executedTests,
    engineMs,
    engineCpuMs: (cpu.user + cpu.system) / 1000,
    enginePeakRssKiB: process.resourceUsage().maxRSS,
  }),
);
