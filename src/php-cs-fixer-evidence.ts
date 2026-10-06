import path from "node:path";
import { z } from "zod";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";

const evidence = z.strictObject({
  version: z.literal("3.95.27"),
  files: z.array(z.string().min(1)),
  fixers: z.array(z.string().min(1)),
  events: z.array(
    z.strictObject({
      file: z.string().min(1),
      status: z.number().int().min(1).max(7),
    }),
  ),
  changes: z.array(
    z.strictObject({
      file: z.string().min(1),
      fixers: z.array(z.string().min(1)).nonempty(),
      diff: z.string().min(1),
    }),
  ),
  errors: z.array(
    z.strictObject({
      file: z.string().min(1),
      type: z.number().int().min(1).max(3),
      message: z.string().min(1),
    }),
  ),
  blocked: z.string().nullable(),
  dryRun: z.literal(true),
  usingCache: z.literal(false),
  exitCode: z.number().int(),
});
export function phpCsFixerEvidence(
  check: Check,
  processes: ProcessResult[],
  root?: string,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "PHP-CS-Fixer native rules, files, processing events or result totals do not reconcile.",
  };
  if (!root || !check.scope.length || processes.length !== 1) return incomplete;
  const process = processes[0]!;
  try {
    const value = evidence.parse(JSON.parse(process.stdout));
    if (value.blocked !== null)
      return {
        status: "error",
        reason:
          "PHP-CS-Fixer could not complete its pinned configuration/runtime profile.",
      };
    if (
      value.exitCode !== process.exitCode ||
      process.stderr.trim() ||
      !value.fixers.length
    )
      return incomplete;
    const address = (file: string) => path.resolve(root, check.project, file);
    const expected = new Set(check.scope.map(address));
    const files = value.files.map(address);
    const events = value.events.map((event) => ({
      ...event,
      file: address(event.file),
    }));
    if (
      files.length !== expected.size ||
      new Set(files).size !== files.length ||
      files.some((file) => !expected.has(file)) ||
      events.length !== files.length ||
      new Set(events.map((event) => event.file)).size !== events.length ||
      events.some((event) => !expected.has(event.file))
    )
      return incomplete;
    if (events.some((event) => event.status === 2 || event.status === 7))
      return incomplete;
    const changes = new Map(
      value.changes.map((change) => [address(change.file), change]),
    );
    const errors = new Map(
      value.errors.map((error) => [address(error.file), error]),
    );
    if (
      changes.size !== value.changes.length ||
      errors.size !== value.errors.length
    )
      return incomplete;
    for (const [file, change] of changes)
      if (
        !expected.has(file) ||
        change.fixers.some((rule) => !value.fixers.includes(rule))
      )
        return incomplete;
    for (const file of errors.keys())
      if (!expected.has(file)) return incomplete;
    if (
      events.some((event) =>
        event.status === 3
          ? changes.has(event.file) || errors.has(event.file)
          : event.status === 4
            ? !changes.has(event.file) || errors.has(event.file)
            : event.status === 1
              ? errors.get(event.file)?.type !== 1 || changes.has(event.file)
              : event.status === 5
                ? errors.get(event.file)?.type !== 2
                : event.status === 6
                  ? errors.get(event.file)?.type !== 3
                  : true,
      )
    )
      return incomplete;
    const exit =
      (changes.size ? 8 : 0) |
      (value.errors.some((error) => error.type === 1) ? 4 : 0) |
      (value.errors.some((error) => error.type !== 1) ? 64 : 0);
    if (exit !== value.exitCode) return incomplete;
    if (value.errors.some((error) => error.type !== 1))
      return {
        status: "error",
        reason:
          "PHP-CS-Fixer reported a fixer exception or invalid transformed syntax.",
      };
    const findings: Finding[] = [];
    for (const [file, change] of changes) {
      for (const rule of change.fixers)
        findings.push({
          ruleId: rule,
          level: "error",
          file: path.relative(root, file).split(path.sep).join("/"),
          message: "Native dry-run formatting change required.",
        });
    }
    for (const [file, error] of errors)
      findings.push({
        ruleId: "syntax",
        level: "error",
        file: path.relative(root, file).split(path.sep).join("/"),
        message: error.message,
      });
    return {
      status: findings.length ? "failed" : "passed",
      reason: findings.length
        ? "PHP-CS-Fixer reported native style or input syntax errors."
        : "PHP-CS-Fixer processed every declared file with active rules and no changes.",
      findings,
      findingsComplete: true,
    };
  } catch {
    return process.exitCode === 0
      ? incomplete
      : {
          status: "error",
          reason:
            "PHP-CS-Fixer returned invalid or unsupported native evidence.",
        };
  }
}
