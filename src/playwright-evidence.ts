import path from "node:path";
import { z } from "zod";
import type {
  Check,
  CheckResult,
  ProcessResult,
  TestEvidence,
} from "./types.js";

const status = z.enum([
  "passed",
  "failed",
  "timedOut",
  "skipped",
  "interrupted",
]);
const schema = z.object({
  version: z.literal(1),
  status,
  errors: z.array(z.string()),
  projects: z.array(z.string()),
  tests: z.array(
    z.object({
      id: z.string().min(1),
      file: z.string(),
      project: z.string(),
      expectedStatus: status,
      outcome: z.enum(["expected", "unexpected", "flaky", "skipped"]),
      results: z.array(
        z.object({
          status,
          retry: z.number().int().nonnegative(),
          errors: z.array(z.string()),
        }),
      ),
    }),
  ),
});

export function playwrightEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "tests"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Playwright evidence is incomplete, inconsistent, skipped or omits planned test files.",
  };
  if (!root || processes.length !== 1 || !check.scope.length) return incomplete;
  const process = processes[0]!;
  if (process.exitCode !== 0 && process.exitCode !== 1)
    return {
      status: "error",
      reason:
        "Playwright configuration or its supported native integration could not run.",
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
  const files = new Set<string>();
  const ids = new Set<string>();
  const projects = new Set(report.projects);
  const seenProjects = new Set<string>();
  if (projects.size !== report.projects.length) return incomplete;
  const tests: TestEvidence = { total: 0, passed: 0, failed: 0, skipped: 0 };
  let missingBrowserTests = 0;
  for (const test of report.tests) {
    if (
      !expected.has(test.file) ||
      ids.has(test.id) ||
      !projects.has(test.project)
    )
      return incomplete;
    ids.add(test.id);
    files.add(test.file);
    seenProjects.add(test.project);
    tests.total++;
    if (!test.results.length) return incomplete;
    let missingBrowser = false;
    for (const [index, attempt] of test.results.entries()) {
      if (attempt.retry !== index || attempt.status === "interrupted")
        return incomplete;
      if (attempt.status === "passed" && attempt.errors.length)
        return incomplete;
      missingBrowser ||= attempt.errors.some((error) =>
        /browserType\.launch: Executable doesn't exist at/.test(error),
      );
    }
    if (missingBrowser) missingBrowserTests++;
    const last = test.results.at(-1)!;
    if (test.outcome === "skipped") {
      if (last.status !== "skipped") return incomplete;
      tests.skipped++;
    } else if (test.outcome === "expected") {
      if (last.status !== test.expectedStatus) return incomplete;
      if (test.expectedStatus === "passed") {
        if (test.results.some((attempt) => attempt.status !== "passed"))
          return incomplete;
        tests.passed++;
      } else tests.skipped++;
    } else tests.failed++;
  }
  if (
    missingBrowserTests &&
    missingBrowserTests === tests.failed &&
    !report.errors.length
  )
    return {
      status: "unavailable",
      reason:
        "Playwright reported a missing browser executable; browsers must be prepared separately.",
      tests,
    };
  if (report.status === "interrupted" || report.status === "skipped")
    return incomplete;
  if (
    tests.failed ||
    report.errors.length ||
    report.status !== "passed" ||
    process.exitCode !== 0
  )
    return {
      status: "failed",
      reason:
        "Playwright reported failed/flaky tests or a native runner error.",
      tests,
    };
  if (
    files.size !== expected.size ||
    seenProjects.size !== projects.size ||
    !tests.passed ||
    tests.skipped
  )
    return { ...incomplete, tests };
  return {
    status: "passed",
    reason:
      "Playwright completed passing non-skipped tests for every planned test file.",
    tests,
  };
}
