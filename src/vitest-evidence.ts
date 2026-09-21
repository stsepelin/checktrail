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
  numTotalTests: count,
  numPassedTests: count,
  numFailedTests: count,
  numPendingTests: count,
  numTodoTests: count,
  numTotalTestSuites: count,
  numPassedTestSuites: count,
  numFailedTestSuites: count,
  numPendingTestSuites: count,
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["passed", "failed"]),
      assertionResults: z.array(
        z.object({
          status: z.enum([
            "passed",
            "failed",
            "skipped",
            "pending",
            "todo",
            "disabled",
          ]),
          fullName: z.string(),
        }),
      ),
    }),
  ),
});

export function vitestEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "tests"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Vitest evidence is incomplete, inconsistent, or does not account for every planned test file.",
  };
  if (!root || processes.length !== 1 || !check.scope.length) return incomplete;
  const process = processes[0]!;
  if (process.exitCode !== 0 && process.exitCode !== 1)
    return {
      status: "error",
      reason:
        "Vitest could not start or complete normally; inspect the runtime and configuration.",
    };
  let report: z.infer<typeof schema>;
  try {
    report = schema.parse(JSON.parse(process.stdout));
  } catch {
    return incomplete;
  }
  const expected = new Set(
    check.scope.map((file) => path.resolve(root, check.project, file)),
  );
  const seen = new Set<string>();
  const tests: TestEvidence = { total: 0, passed: 0, failed: 0, skipped: 0 };
  let pending = 0;
  let todo = 0;
  let failedFiles = false;
  for (const file of report.testResults) {
    if (!expected.has(file.name) || seen.has(file.name)) return incomplete;
    seen.add(file.name);
    failedFiles ||= file.status === "failed";
    for (const assertion of file.assertionResults) {
      if (assertion.status === "pending") return incomplete;
      tests.total++;
      if (assertion.status === "passed") tests.passed++;
      else if (assertion.status === "failed") tests.failed++;
      else {
        tests.skipped++;
        if (assertion.status === "todo") todo++;
        else pending++;
      }
    }
  }
  if (
    seen.size !== expected.size ||
    tests.total !== report.numTotalTests ||
    tests.passed !== report.numPassedTests ||
    tests.failed !== report.numFailedTests ||
    pending !== report.numPendingTests ||
    todo !== report.numTodoTests ||
    report.numTotalTestSuites !==
      report.numPassedTestSuites +
        report.numFailedTestSuites +
        report.numPendingTestSuites ||
    report.numPendingTestSuites > 0
  )
    return incomplete;
  if (
    tests.failed ||
    failedFiles ||
    report.numFailedTestSuites ||
    !report.success ||
    process.exitCode !== 0
  )
    return {
      status: "failed",
      reason: "Vitest reported a test, suite, or execution failure.",
      tests,
    };
  if (!tests.passed)
    return {
      ...incomplete,
      reason: "No passing, non-skipped Vitest assertions were observed.",
      tests,
    };
  return {
    status: "passed",
    reason:
      "Vitest accounted for every planned file and reported passing non-skipped assertions.",
    tests,
  };
}
