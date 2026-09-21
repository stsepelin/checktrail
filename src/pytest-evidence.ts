import path from "node:path";
import { z } from "zod";
import type {
  Check,
  CheckResult,
  ProcessResult,
  TestEvidence,
} from "./types.js";

const schema = z.object({
  format: z.literal("checktrail-pytest-1"),
  version: z.string().min(1),
  exitCode: z.number().int().min(0).max(5),
  finished: z.boolean(),
  items: z.array(z.object({ id: z.string(), file: z.string() })),
  reports: z.array(
    z.object({
      id: z.string(),
      phase: z.enum(["setup", "call", "teardown"]),
      outcome: z.enum(["passed", "failed", "skipped"]),
      xfail: z.boolean(),
    }),
  ),
  deselected: z.array(z.string()),
  collectionErrors: z.array(z.string()),
});

export function pytestEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "tests"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Pytest evidence is incomplete or does not account for every planned file and collected test.",
  };
  if (!root || processes.length !== 1 || !check.scope.length) return incomplete;
  const process = processes[0]!;
  let value: unknown;
  try {
    value = JSON.parse(process.stdout);
  } catch {
    return incomplete;
  }
  if (
    process.exitCode === 3 &&
    z
      .object({
        format: z.literal("checktrail-pytest-1"),
        unavailable: z.literal("pytest"),
      })
      .safeParse(value).success
  )
    return {
      status: "unavailable",
      reason: "Pytest is not installed in the selected python3 runtime.",
    };
  const parsed = schema.safeParse(value);
  if (!parsed.success) return incomplete;
  const report = parsed.data;
  if (report.exitCode !== process.exitCode || !report.finished)
    return incomplete;
  if (report.collectionErrors.length)
    return {
      status: "failed",
      reason: "Pytest reported collection or import failures.",
    };
  if (report.exitCode === 2) return incomplete;
  if (report.exitCode === 3 || report.exitCode === 4)
    return {
      status: "error",
      reason: "Pytest reported an internal or configuration error.",
    };
  const expected = new Set(
    check.scope.map((file) => path.resolve(root, check.project, file)),
  );
  const files = new Set<string>();
  const items = new Map<string, z.infer<typeof schema>["reports"]>();
  for (const item of report.items) {
    if (!expected.has(item.file) || items.has(item.id)) return incomplete;
    files.add(item.file);
    items.set(item.id, []);
  }
  for (const event of report.reports) {
    const events = items.get(event.id);
    if (!events || events.some((prior) => prior.phase === event.phase))
      return incomplete;
    events.push(event);
  }
  const tests: TestEvidence = {
    total: items.size,
    passed: 0,
    failed: 0,
    skipped: 0,
  };
  for (const events of items.values()) {
    const setup = events[0];
    const teardown = events.at(-1);
    if (setup?.phase !== "setup" || teardown?.phase !== "teardown")
      return incomplete;
    const call = events.find((event) => event.phase === "call");
    if (
      (setup.outcome === "passed" && !call) ||
      (setup.outcome !== "passed" && call)
    )
      return incomplete;
    if (
      events.some(
        (event) =>
          event.outcome === "failed" ||
          (event.outcome === "passed" && event.xfail),
      )
    )
      tests.failed++;
    else if (events.some((event) => event.outcome === "skipped"))
      tests.skipped++;
    else tests.passed++;
  }
  if (tests.failed || report.exitCode === 1)
    return {
      status: "failed",
      reason:
        "Pytest reported assertion, fixture, teardown or unexpected-pass failures.",
      tests,
    };
  if (
    files.size !== expected.size ||
    report.deselected.length ||
    !tests.passed ||
    report.exitCode !== 0
  )
    return { ...incomplete, tests };
  return {
    status: "passed",
    reason:
      "Pytest accounted for every planned file and collected test with complete lifecycle evidence.",
    tests,
  };
}
