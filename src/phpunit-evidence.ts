import path from "node:path";
import { importJUnit } from "./junit.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";

export function phpunitEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "tests"> {
  const pest = check.id === "php.pest";
  const name = pest ? "Pest" : "PHPUnit";
  const incomplete = {
    status: "inconclusive" as const,
    reason: `${name} evidence is incomplete, omits a planned test file, or has no passing assertions.`,
  };
  if (!root || !check.scope.length || processes.length !== 1) return incomplete;
  const process = processes[0]!;
  const result = importJUnit(pest ? process.stderr : process.stdout);
  if (!result.tests || !result.cases)
    return process.exitCode === 0
      ? incomplete
      : {
          status: "error",
          reason: `${name} could not produce valid JUnit evidence; inspect runtime and configuration.`,
        };
  const tests = result.tests;
  if (tests.failed)
    return {
      status: "failed",
      reason: `${name} reported test or fixture failures.`,
      tests,
    };
  if (!tests.passed) return { ...incomplete, tests };
  if (process.exitCode !== 0)
    return {
      status: "failed",
      reason: `${name} reported a runtime, warning or risky-test failure.`,
      tests,
    };
  const expected = new Set(
    check.scope.map((file) => path.resolve(root, check.project, file)),
  );
  const files = new Set<string>();
  for (const item of result.cases) {
    if (!item.file || (item.status === "passed" && !item.assertions))
      return { ...incomplete, tests };
    const file = path.resolve(
      root,
      check.project,
      pest ? item.file.split("::")[0]! : item.file,
    );
    if (!expected.has(file)) return { ...incomplete, tests };
    files.add(file);
  }
  if (files.size !== expected.size) return { ...incomplete, tests };
  return {
    status: "passed",
    reason: `${name} produced fresh JUnit evidence for every planned file with passing assertions.`,
    tests,
  };
}
