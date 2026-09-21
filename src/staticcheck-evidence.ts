import path from "node:path";
import { z } from "zod";
import { goScopeComplete } from "./go-scope.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";

const diagnostic = z.object({
  code: z.string().min(1),
  severity: z.enum(["error", "warning", "ignored"]),
  message: z.string().min(1),
  location: z.object({
    file: z.string(),
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
  }),
});

export function staticcheckEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Staticcheck evidence is malformed, unaccounted source was excluded, or the native run was incomplete.",
  };
  if (!root || processes.length !== 2) return incomplete;
  const process = processes[1]!;
  if (![0, 1].includes(process.exitCode ?? -1))
    return { status: "error", reason: "Staticcheck could not run normally." };
  try {
    const rows = process.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => diagnostic.parse(JSON.parse(line)));
    const expected = new Set(
      check.scope.map((file) => path.resolve(root, check.project, file)),
    );
    const findings: Finding[] = [];
    let compileError = false;
    for (const row of rows) {
      if (row.code === "compile") {
        compileError = true;
        continue;
      }
      const file = path.resolve(root, check.project, row.location.file);
      if (!expected.has(file) || row.location.line < 1) return incomplete;
      findings.push({
        ruleId: row.code,
        level: row.severity === "ignored" ? "note" : row.severity,
        message: row.message,
        file: path.relative(root, file).split(path.sep).join("/"),
        line: row.location.line,
      });
    }
    if (findings.length || compileError)
      return {
        status: "failed",
        reason:
          "Staticcheck reported diagnostics, including explicitly surfaced native suppressions.",
        findings,
        findingsComplete:
          !compileError &&
          process.exitCode === 1 &&
          !process.stderr.trim() &&
          goScopeComplete(check, processes[0], root),
      };
    if (process.exitCode !== 0 || process.stderr.trim())
      return {
        status: "error",
        reason:
          "Staticcheck reported a loading, configuration or runtime error.",
      };
    if (!goScopeComplete(check, processes[0], root)) return incomplete;
    return {
      status: "passed",
      reason:
        "Staticcheck completed all-rule analysis of the inventoried native Go scope.",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
