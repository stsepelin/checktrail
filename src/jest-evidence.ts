import path from "node:path";
import { z } from "zod";
import type {
  Check,
  CheckResult,
  ProcessResult,
  TestEvidence,
} from "./types.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({
  success: z.boolean(),
  wasInterrupted: z.boolean(),
  numTotalTests: count,
  numPassedTests: count,
  numFailedTests: count,
  numPendingTests: count,
  numTodoTests: count,
  numTotalTestSuites: count,
  numPassedTestSuites: count,
  numFailedTestSuites: count,
  numPendingTestSuites: count,
  numRuntimeErrorTestSuites: count,
  runExecError: z.unknown().optional(),
  testResults: z.array(
    z.object({
      testFilePath: z.string(),
      numPassingTests: count,
      numFailingTests: count,
      numPendingTests: count,
      numTodoTests: count,
      testExecError: z.unknown().optional(),
      testResults: z.array(
        z.object({
          status: z.enum(["passed", "failed", "pending", "todo", "disabled"]),
          fullName: z.string(),
          wouldRun: z.unknown().optional(),
        }),
      ),
    }),
  ),
});

export function jestEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "tests"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Jest evidence is incomplete, inconsistent, or omits planned files or runnable tests.",
  };
  if (!root || processes.length !== 1 || !check.scope.length) return incomplete;
  const process = processes[0]!;
  if (process.exitCode !== 0 && process.exitCode !== 1)
    return {
      status: "error",
      reason:
        "Jest could not start or complete normally; inspect the runtime and configuration.",
    };
  let report: z.infer<typeof schema>;
  try {
    report = schema.parse(JSON.parse(process.stdout));
  } catch {
    return incomplete;
  }
  if (report.wasInterrupted) return incomplete;
  const expected = new Set(
    check.scope.map((file) => path.resolve(root, check.project, file)),
  );
  const seen = new Set<string>();
  const tests: TestEvidence = { total: 0, passed: 0, failed: 0, skipped: 0 };
  let pending = 0;
  let todo = 0;
  let runtimeFailure = Boolean(report.runExecError);
  for (const file of report.testResults) {
    if (!expected.has(file.testFilePath) || seen.has(file.testFilePath))
      return incomplete;
    seen.add(file.testFilePath);
    runtimeFailure ||= Boolean(file.testExecError);
    const counts = { passed: 0, failed: 0, pending: 0, todo: 0 };
    for (const assertion of file.testResults) {
      if (assertion.wouldRun !== undefined) return incomplete;
      if (assertion.status === "disabled") counts.pending++;
      else counts[assertion.status]++;
    }
    if (
      counts.passed !== file.numPassingTests ||
      counts.failed !== file.numFailingTests ||
      counts.pending !== file.numPendingTests ||
      counts.todo !== file.numTodoTests
    )
      return incomplete;
    tests.passed += counts.passed;
    tests.failed += counts.failed;
    pending += counts.pending;
    todo += counts.todo;
  }
  tests.skipped = pending + todo;
  tests.total = tests.passed + tests.failed + tests.skipped;
  if (
    seen.size !== expected.size ||
    tests.total !== report.numTotalTests ||
    tests.passed !== report.numPassedTests ||
    tests.failed !== report.numFailedTests ||
    pending !== report.numPendingTests ||
    todo !== report.numTodoTests ||
    report.numTotalTestSuites !== seen.size ||
    report.numTotalTestSuites !==
      report.numPassedTestSuites +
        report.numFailedTestSuites +
        report.numPendingTestSuites
  )
    return incomplete;
  if (
    tests.failed ||
    runtimeFailure ||
    report.numFailedTestSuites ||
    report.numRuntimeErrorTestSuites ||
    !report.success ||
    process.exitCode !== 0
  )
    return {
      status: "failed",
      reason: "Jest reported a test, suite, or execution failure.",
      tests,
    };
  // Jest uses pending for both deliberate skips and tests omitted by .only.
  if (!tests.passed || pending || report.numPendingTestSuites)
    return { ...incomplete, tests };
  return {
    status: "passed",
    reason:
      "Jest accounted for every planned file with passing assertions and no pending tests.",
    tests,
  };
}
