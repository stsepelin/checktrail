import path from "node:path";
import { z } from "zod";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const evidenceSchema = z.object({
  schemaVersion: z.literal(1),
  toolVersion: z.string().regex(/^\d+\.\d+\.\d+/),
  files: z.array(
    z.object({
      path: z.string(),
      configured: z.boolean(),
      activeRules: count,
      results: z.array(
        z.object({
          filePath: z.string(),
          errorCount: count,
          warningCount: count,
          fatalErrorCount: count,
          messages: z.array(
            z.object({
              ruleId: z.string().min(1).nullable(),
              severity: z.union([z.literal(1), z.literal(2)]),
              fatal: z.boolean().optional(),
              message: z.string(),
              line: z.number().int().positive().optional(),
            }),
          ),
        }),
      ),
    }),
  ),
});

export function eslintEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  if (processes.some((p) => p.exitCode !== 0 && p.exitCode !== 1))
    return {
      status: "error",
      reason:
        "ESLint could not complete; inspect its configuration, plugins and runtime locally.",
    };
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "ESLint evidence is incomplete, inconsistent, or does not cover every planned file with enabled rules.",
  };
  if (
    !root ||
    processes.length !== 1 ||
    processes[0]!.stderr.trim() ||
    !check.scope.length
  )
    return incomplete;
  try {
    const evidence = evidenceSchema.parse(JSON.parse(processes[0]!.stdout));
    const expected = new Set(check.scope);
    const seen = new Set<string>();
    let violations = 0;
    const findings: Finding[] = [];
    for (const file of evidence.files) {
      if (
        !expected.has(file.path) ||
        seen.has(file.path) ||
        !file.configured ||
        file.activeRules === 0 ||
        file.results.length !== 1
      )
        return incomplete;
      seen.add(file.path);
      const result = file.results[0]!;
      if (result.filePath !== path.resolve(root, check.project, file.path))
        return incomplete;
      if (
        result.errorCount !==
          result.messages.filter((m) => m.severity === 2).length ||
        result.warningCount !==
          result.messages.filter((m) => m.severity === 1).length ||
        result.fatalErrorCount !==
          result.messages.filter((m) => m.fatal).length ||
        result.messages.some(
          (m) =>
            (m.fatal && m.severity !== 2) ||
            (m.severity === 1 && m.ruleId === null),
        )
      )
        return incomplete;
      violations += result.errorCount + result.warningCount;
      findings.push(
        ...result.messages.map((message): Finding => ({
          ruleId: message.ruleId ?? "parse-error",
          level: message.severity === 2 ? "error" : "warning",
          message: message.message,
          file: path.posix.join(check.project, file.path),
          ...(message.line ? { line: message.line } : {}),
        })),
      );
    }
    if (seen.size !== expected.size) return incomplete;
    if (violations)
      return {
        status: "failed",
        reason: "ESLint reported errors or warnings in the planned files.",
        findings,
        findingsComplete:
          processes[0]!.exitCode === 1 &&
          findings.every((finding) => finding.ruleId !== "parse-error"),
      };
    if (processes[0]!.exitCode !== 0) return incomplete;
    return {
      status: "passed",
      findings,
      findingsComplete: true,
      reason:
        "ESLint checked every planned file with enabled rules and reported no errors or warnings.",
    };
  } catch {
    return incomplete;
  }
}
