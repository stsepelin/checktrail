import path from "node:path";
import { z } from "zod";
import type { Check, CheckResult, ProcessResult } from "./types.js";
const schema = z.object({
  version: z.literal(1),
  exitStatus: z.number().int().nonnegative(),
  programs: z.number().int().nonnegative(),
  configs: z.array(z.string()),
  files: z.array(z.string()),
  diagnostics: z.array(
    z.object({
      code: z.number().int(),
      message: z.string(),
      file: z.string().optional(),
      line: z.number().int().positive().optional(),
    }),
  ),
});
export function typescriptBuildEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "TypeScript solution evidence is incomplete or omits inventoried source.",
  };
  if (!root || processes.length !== 1 || !check.scope.length) return incomplete;
  const process = processes[0]!;
  if (![0, 1].includes(process.exitCode ?? -1))
    return {
      status: "error",
      reason:
        "TypeScript solution configuration or its supported integration could not run.",
    };
  try {
    const report = schema.parse(JSON.parse(process.stdout));
    const inside = (file: string) => {
      const relative = path.relative(root, file);
      return (
        path.isAbsolute(file) &&
        relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative)
      );
    };
    if (
      [...report.files, ...report.configs].some((file) => !inside(file)) ||
      new Set(report.files).size !== report.files.length ||
      new Set(report.configs).size !== report.configs.length
    )
      return incomplete;
    if (
      report.diagnostics.some(
        (diagnostic) => diagnostic.file && !inside(diagnostic.file),
      )
    )
      return incomplete;
    const findings = report.diagnostics.map((diagnostic) => ({
      ruleId: "TS" + diagnostic.code,
      level: "error" as const,
      message: diagnostic.message,
      ...(diagnostic.file
        ? {
            file: path
              .relative(root, diagnostic.file)
              .split(path.sep)
              .join("/"),
          }
        : {}),
      ...(diagnostic.line ? { line: diagnostic.line } : {}),
    }));
    if (findings.length || report.exitStatus !== 0 || process.exitCode !== 0)
      return {
        status: "failed",
        reason:
          "TypeScript solution reported compiler or configuration diagnostics.",
        findings,
        findingsComplete:
          report.programs > 0 &&
          report.configs.length > 0 &&
          !process.stderr.trim() &&
          check.scope.every((file) =>
            report.files.includes(path.resolve(root, check.project, file)),
          ) &&
          process.exitCode === 1 &&
          report.diagnostics.length > 0 &&
          report.diagnostics.every(
            (diagnostic) => diagnostic.file && diagnostic.code >= 2000,
          ),
      };
    if (
      !report.programs ||
      !report.configs.length ||
      process.stderr.trim() ||
      check.scope.some(
        (file) =>
          !report.files.includes(path.resolve(root, check.project, file)),
      )
    )
      return incomplete;
    return {
      status: "passed",
      reason:
        "TypeScript checked the inventoried solution source using fresh in-memory build outputs.",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
