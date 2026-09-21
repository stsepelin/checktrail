import path from "node:path";
import { z } from "zod";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";

const diagnostic = z.object({
  code: z.string().min(1).nullable(),
  filename: z.string(),
  message: z.string(),
  location: z.object({
    row: z.number().int().positive(),
    column: z.number().int().positive(),
  }),
});

function hasEnabledRules(settings: string, expectedFile: string): boolean {
  try {
    const resolved = /^Resolved settings for: (".*")$/m.exec(settings)?.[1];
    if (!resolved || JSON.parse(resolved) !== expectedFile) return false;
  } catch {
    return false;
  }
  const enabled = /^linter\.rules\.enabled = \[([^]*?)\]/m.exec(settings)?.[1];
  const ignoreSections = settings.split(/^linter\.per_file_ignores = /m);
  const ignores =
    ignoreSections.length === 2
      ? ignoreSections[1]!.split(/^linter\./m)[0]
      : undefined;
  if (enabled === undefined || ignores === undefined) return false;
  const lines = enabled
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    !lines.length ||
    lines.some((line) => !/^[\w-]+ \([A-Z]+\d+\),?$/.test(line))
  )
    return false;
  const ignored = new Set(
    [...ignores.matchAll(/\(([A-Z]+\d+)\)/g)].map((match) => match[1]),
  );
  return lines.some((line) => !ignored.has(/\(([A-Z]+\d+)\)/.exec(line)?.[1]));
}

export function ruffEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Ruff did not provide complete file selection and enabled-rule evidence.",
  };
  if (
    !root ||
    !check.scope.length ||
    processes.length !== check.scope.length + 2
  )
    return incomplete;
  if (
    processes.some(
      (process) => process.exitCode !== 0 && process.exitCode !== 1,
    )
  )
    return {
      status: "error",
      reason: "Ruff reported a configuration or execution error.",
    };
  const expected = new Set(
    check.scope.map((file) => path.resolve(root, check.project, file)),
  );
  const files = processes[0]!.stdout.split(/\r?\n/).filter(Boolean);
  const complete =
    processes.every((process) => !process.stderr.trim()) &&
    processes.slice(0, -1).every((process) => process.exitCode === 0) &&
    files.length === expected.size &&
    new Set(files).size === files.length &&
    files.every((file) => expected.has(file)) &&
    processes
      .slice(1, -1)
      .every((process, index) =>
        hasEnabledRules(
          process.stdout,
          path.resolve(root, check.project, check.scope[index]!),
        ),
      );
  const execution = processes.at(-1)!;
  let diagnostics: z.infer<typeof diagnostic>[];
  try {
    diagnostics = z.array(diagnostic).parse(JSON.parse(execution.stdout));
  } catch {
    return incomplete;
  }
  if (diagnostics.some((item) => !expected.has(item.filename)))
    return incomplete;
  const findings: Finding[] = diagnostics.map((item) => ({
    ruleId: item.code ?? "syntax-error",
    level: "error",
    message: item.message,
    file: path.relative(root, item.filename).split(path.sep).join("/"),
    line: item.location.row,
  }));
  if (diagnostics.length || execution.exitCode !== 0)
    return {
      status: "failed",
      reason: "Ruff reported lint or syntax diagnostics.",
      findings,
      findingsComplete:
        complete &&
        execution.exitCode === 1 &&
        diagnostics.length > 0 &&
        diagnostics.every(
          (item) =>
            item.code !== null &&
            /^[A-Z]+\d+$/.test(item.code) &&
            item.code !== "E999",
        ),
    };
  return complete
    ? {
        status: "passed",
        findings,
        findingsComplete: true,
        reason:
          "Ruff selected every planned file, had enabled rules and reported no diagnostics.",
      }
    : incomplete;
}
