import path from "node:path";
import { z } from "zod";
import { goScopeComplete } from "./go-scope.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";
const schema = z.object({
  Issues: z.array(
    z.object({
      FromLinter: z.string().min(1),
      Text: z.string().min(1),
      Pos: z.object({
        Filename: z.string(),
        Line: z.number().int().positive(),
        Column: z.number().int().nonnegative(),
      }),
    }),
  ),
  Report: z.object({
    Linters: z
      .array(z.object({ Name: z.string(), Enabled: z.boolean().optional() }))
      .optional(),
    Warnings: z.array(z.unknown()).optional(),
    Error: z.string().optional(),
  }),
});
export function golangciEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "golangci-lint evidence, active linters or native Go scope could not be established.",
  };
  if (!root || processes.length !== 2) return incomplete;
  const process = processes[1]!;
  if (![0, 1].includes(process.exitCode ?? -1))
    return {
      status: "error",
      reason:
        "golangci-lint configuration or its supported execution profile could not run.",
    };
  try {
    const report = schema.parse(JSON.parse(process.stdout));
    const expected = new Set(
      check.scope.map((file) => path.resolve(root, check.project, file)),
    );
    const active =
      report.Report.Linters?.filter((linter) => linter.Enabled).map(
        (linter) => linter.Name,
      ) ?? [];
    if (
      !active.some((name) => name !== "typecheck") ||
      new Set(active).size !== active.length ||
      active.some(
        (name) =>
          ![
            "errcheck",
            "govet",
            "ineffassign",
            "staticcheck",
            "unused",
            "typecheck",
          ].includes(name),
      )
    )
      return incomplete;
    if (
      report.Issues.some(
        (issue) =>
          !path.isAbsolute(issue.Pos.Filename) ||
          !expected.has(path.resolve(issue.Pos.Filename)),
      )
    )
      return incomplete;
    const findings = report.Issues.map((issue) => ({
      ruleId: issue.FromLinter,
      level: "error" as const,
      message: issue.Text,
      file: path.relative(root, issue.Pos.Filename).split(path.sep).join("/"),
      line: issue.Pos.Line,
    }));
    if (findings.length)
      return {
        status: "failed",
        reason: "golangci-lint reported native diagnostics.",
        findings,
        findingsComplete:
          process.exitCode === 1 &&
          !process.stderr.trim() &&
          !report.Report.Error &&
          !report.Report.Warnings?.length &&
          report.Issues.every(
            (issue) =>
              issue.FromLinter !== "typecheck" &&
              active.includes(issue.FromLinter),
          ) &&
          goScopeComplete(check, processes[0], root),
      };
    if (process.exitCode !== 0 || report.Report.Error)
      return {
        status: "error",
        reason: "golangci-lint reported an analysis or loading error.",
      };
    if (
      report.Report.Warnings?.length ||
      process.stderr.trim() ||
      !goScopeComplete(check, processes[0], root)
    )
      return incomplete;
    return {
      status: "passed",
      reason:
        "Configured golangci-lint checks completed for the inventoried Go scope.",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
