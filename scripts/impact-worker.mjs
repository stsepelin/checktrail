import assert from "node:assert/strict";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { validate } from "../dist/src/index.js";

const [root, base] = process.argv.slice(2);
assert.ok(root && (base === "full" || /^[a-f0-9]{40}$/.test(base)));
assert.equal(process.argv.length, 4);
const started = performance.now();
const cpu = process.cpuUsage();
const report = await validate(root, {
  trusted: true,
  ...(base !== "full" ? { base } : {}),
});
assert.equal(report.sourceChanged, false);
assert.equal(report.sourceError, false);
assert.equal(report.sourceFingerprint, report.finalSourceFingerprint);
const checks = report.checks.map((check) => {
  assert.equal(check.id, "javascript.node-test");
  assert.ok(
    check.tools.length &&
      check.tools.every((tool) => tool.status === "identified"),
  );
  const assertions = [];
  for (const execution of check.processes) {
    assert.ok(
      !execution.errorCode &&
        !execution.signal &&
        !execution.cancelled &&
        !execution.timedOut &&
        !execution.truncated,
    );
    for (const line of execution.stdout.trim().split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      if (
        event.type === "test:fail" &&
        [
          event.data?.details?.error?.code,
          event.data?.details?.error?.cause?.code,
        ].includes("ERR_ASSERTION")
      )
        assertions.push(event.data.name);
    }
  }
  return {
    project: check.project,
    id: check.id,
    status: check.status,
    tests: check.tests,
    assertions: assertions.sort(),
    tools: check.tools.map(({ name, version }) => ({ name, version })),
  };
});
const usage = process.cpuUsage(cpu);
process.stdout.write(
  JSON.stringify({
    outcome: report.outcome,
    checks,
    selection: report.selection
      ? {
          mode: report.selection.mode,
          projects: report.selection.selectedProjects,
          changedFiles: report.selection.changedFiles,
          reason: report.selection.reason,
          gitVersion: report.selection.git?.version,
        }
      : null,
    sourceFingerprint: report.sourceFingerprint,
    policyFingerprint: report.policyFingerprint,
    engineMs: performance.now() - started,
    engineCpuMs: (usage.user + usage.system) / 1000,
    engineMaxRssKiB: process.resourceUsage().maxRSS,
  }),
);
