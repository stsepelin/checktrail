import path from "node:path";
import { z } from "zod";
import type { Check, CheckResult, ProcessResult } from "./types.js";

const schema = z.object({
  format: z.literal("repo-verifier-mypy-1"),
  version: z.literal("2.3.1"),
  files: z.array(z.string()),
  suppressedFiles: z.array(z.string()),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().min(0).max(2),
});

export function mypyEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Mypy evidence is incomplete, suppresses module errors, or does not account for every planned source.",
  };
  if (!root || processes.length !== 1 || !check.scope.length) return incomplete;
  const process = processes[0]!;
  let value: unknown;
  try {
    value = JSON.parse(process.stdout);
  } catch {
    return incomplete;
  }
  const unavailable = z
    .object({
      format: z.literal("repo-verifier-mypy-1"),
      unavailable: z.string().min(1),
    })
    .safeParse(value);
  if (process.exitCode === 3 && unavailable.success)
    return { status: "unavailable", reason: unavailable.data.unavailable };
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data.exitCode !== process.exitCode)
    return incomplete;
  const report = parsed.data;
  if (report.exitCode === 2)
    return {
      status: "error",
      reason: "Mypy reported a configuration or execution error.",
    };
  if (report.exitCode === 1)
    return {
      status: "failed",
      reason: "Mypy reported type-checking diagnostics.",
    };
  const expected = new Set(
    check.scope.map((file) => path.resolve(root, check.project, file)),
  );
  const summary = /^Success: no issues found in (\d+) source files?\s*$/.exec(
    report.stdout,
  );
  if (
    report.stderr.trim() ||
    !summary ||
    Number(summary[1]) !== expected.size ||
    report.files.length !== expected.size ||
    new Set(report.files).size !== expected.size ||
    report.files.some((file) => !expected.has(file)) ||
    report.suppressedFiles.length
  )
    return incomplete;
  return {
    status: "passed",
    reason:
      "Mypy checked every explicit source and reported no diagnostics or broad module-error suppression.",
  };
}
