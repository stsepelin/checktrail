import path from "node:path";
import { z } from "zod";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({
  totals: z.object({ errors: count, file_errors: count }),
  files: z.record(
    z.string(),
    z.object({
      errors: count,
      messages: z.array(
        z.object({
          message: z.string(),
          line: z.number().int().positive().nullable(),
          ignorable: z.boolean(),
          identifier: z.string().min(1).optional(),
        }),
      ),
    }),
  ),
  errors: z.array(z.string()),
});

export function phpstanEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "PHPStan output does not account for every planned file or consistent diagnostic totals.",
  };
  if (!root || processes.length !== 1 || !check.scope.length) return incomplete;
  const process = processes[0]!;
  const lines = process.stdout.split(/\r?\n/).filter(Boolean);
  let report: z.infer<typeof schema>;
  try {
    report = schema.parse(JSON.parse(lines.pop() ?? ""));
  } catch {
    return process.exitCode === 0
      ? incomplete
      : {
          status: "error",
          reason:
            "PHPStan could not produce native analysis evidence; inspect configuration and runtime errors.",
        };
  }
  if (process.exitCode !== 0 && process.exitCode !== 1)
    return { status: "error", reason: "PHPStan did not exit normally." };
  const expected = new Set(
    check.scope.map((file) => path.resolve(root, check.project, file)),
  );
  let errors = 0;
  const findings: Finding[] = [];
  for (const [file, result] of Object.entries(report.files)) {
    if (!expected.has(file) || result.errors !== result.messages.length)
      return incomplete;
    errors += result.errors;
    findings.push(
      ...result.messages.map((message): Finding => ({
        ruleId: message.identifier ?? "diagnostic",
        level: "error",
        message: message.message,
        file: path.relative(root, file).split(path.sep).join("/"),
        ...(message.line ? { line: message.line } : {}),
      })),
    );
  }
  if (
    errors !== report.totals.file_errors ||
    report.errors.length !== report.totals.errors
  )
    return incomplete;
  const complete =
    lines.length === expected.size &&
    new Set(lines).size === expected.size &&
    lines.every((file) => expected.has(file)) &&
    !process.stderr.trim();
  if (errors || report.errors.length || process.exitCode === 1)
    return {
      status: "failed",
      reason: "PHPStan reported analysis diagnostics.",
      findings,
      findingsComplete:
        complete &&
        errors > 0 &&
        !report.errors.length &&
        process.exitCode === 1 &&
        Object.values(report.files).every((file) =>
          file.messages.every((message) => message.ignorable),
        ),
    };
  if (!complete) return incomplete;
  return {
    status: "passed",
    findings,
    findingsComplete: true,
    reason: "PHPStan analysed every planned file and reported no diagnostics.",
  };
}
