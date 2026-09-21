import path from "node:path";
import { z } from "zod";
import type { Check, CheckResult, ProcessResult } from "./types.js";

const envelope = z
  .object({
    version: z.literal("1.32.1"),
    files: z.array(z.string()),
    fixers: z.array(z.string().min(1)),
    blocked: z.string().nullable(),
    report: z.string().optional(),
    exitCode: z.number().int().optional(),
  })
  .strict();
const nativeReport = z
  .object({
    tool: z.literal("pint"),
    result: z.enum(["passed", "fail", "fixed"]),
    files: z
      .array(
        z
          .object({
            path: z.string(),
            fixers: z.array(z.string().min(1)).nonempty(),
          })
          .strict(),
      )
      .optional(),
    errors: z
      .array(z.object({ path: z.string(), message: z.string() }).strict())
      .optional(),
  })
  .strict();

export function pintEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Pint evidence is incomplete, unsupported, missing planned files or has no active rules.",
  };
  if (!root || !check.scope.length || processes.length !== 1) return incomplete;
  const process = processes[0]!;
  try {
    const result = envelope.parse(JSON.parse(process.stdout));
    if (result.blocked !== null) return incomplete;
    if (!result.report || result.exitCode !== process.exitCode)
      return incomplete;
    const report = nativeReport.parse(JSON.parse(result.report));
    if (report.result === "fixed") return incomplete;
    if ((report.files?.length ?? 0) + (report.errors?.length ?? 0) > 0)
      return {
        status: "failed",
        reason: "Pint reported style or syntax errors.",
      };
    if (report.result !== "passed" || process.exitCode !== 0)
      return {
        status: "error",
        reason: "Pint could not complete native validation.",
      };
    if (process.stderr.trim()) return incomplete;
    const expected = new Set(
      check.scope.map((file) => path.resolve(root, check.project, file)),
    );
    const actual = new Set(
      result.files.map((file) => path.resolve(root, check.project, file)),
    );
    if (
      !result.fixers.length ||
      actual.size !== result.files.length ||
      actual.size !== expected.size ||
      [...actual].some((file) => !expected.has(file))
    )
      return incomplete;
    return {
      status: "passed",
      reason:
        "Pint checked every planned file with active rules and no style or syntax errors.",
    };
  } catch {
    return process.exitCode === 0
      ? incomplete
      : {
          status: "error",
          reason:
            "Pint returned invalid evidence; inspect configuration and runtime prerequisites.",
        };
  }
}
