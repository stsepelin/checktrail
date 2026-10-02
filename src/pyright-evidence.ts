import path from "node:path";
import { z } from "zod";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";

const integer = z.number().int().nonnegative();
const position = z.object({ line: integer, character: integer });
const native = z.object({
  exitCode: integer.max(4),
  stdout: z.string(),
  stderr: z.string(),
});
const envelope = z.object({
  format: z.literal("checktrail-pyright-1"),
  version: z.literal("1.1.414"),
  configFiles: z.array(z.string()).min(1).max(16),
  policyProblems: z.array(z.string()),
  sources: z.array(z.string()),
  selection: native,
  diagnostics: native,
});
const reportSchema = z.object({
  version: z.literal("1.1.414"),
  time: z.string(),
  generalDiagnostics: z.array(
    z.object({
      file: z.string(),
      severity: z.enum(["error", "warning", "information"]),
      message: z.string().min(1),
      range: z.object({ start: position, end: position }).optional(),
      rule: z.string().min(1).optional(),
    }),
  ),
  summary: z.object({
    filesAnalyzed: integer,
    errorCount: integer,
    warningCount: integer,
    informationCount: integer,
    timeInSec: z.number().finite().nonnegative(),
  }),
});

export function pyrightEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Pyright native source selection, configuration or diagnostic counts did not reconcile, or a suppression remains unverified.",
  };
  if (!root || !check.scope.length || processes.length !== 1) return incomplete;
  const process = processes[0]!;
  let value: unknown;
  try {
    value = JSON.parse(process.stdout);
  } catch {
    return incomplete;
  }
  const unavailable = z
    .object({
      format: z.literal("checktrail-pyright-1"),
      unavailable: z.string().min(1),
    })
    .safeParse(value);
  if (unavailable.success && process.exitCode === 3)
    return { status: "unavailable", reason: unavailable.data.unavailable };
  const error = z
    .object({
      format: z.literal("checktrail-pyright-1"),
      error: z.string().min(1),
    })
    .safeParse(value);
  if (error.success && process.exitCode === 2)
    return { status: "error", reason: error.data.error };
  const parsed = envelope.safeParse(value);
  if (!parsed.success || process.stderr.trim()) return incomplete;
  const data = parsed.data;
  if (data.selection.exitCode > 1 || data.diagnostics.exitCode > 1)
    return process.exitCode === 2
      ? {
          status: "error",
          reason: "Pyright reported a native configuration or execution error.",
        }
      : incomplete;
  if (process.exitCode !== data.diagnostics.exitCode) return incomplete;
  let report: z.infer<typeof reportSchema>;
  try {
    report = reportSchema.parse(JSON.parse(data.diagnostics.stdout));
  } catch {
    return incomplete;
  }
  const expected = new Set(
    check.scope.map((file) => path.resolve(root, check.project, file)),
  );
  const exact = (files: string[]) =>
    files.length === expected.size &&
    new Set(files).size === expected.size &&
    files.every((file) => expected.has(file));
  const tool = check.commands[0]?.args[1];
  const libraryRoot = tool
    ? path.join(path.dirname(tool), "dist/typeshed-fallback/stdlib")
    : undefined;
  const environmentLibraries: string[] = [];
  for (const section of data.selection.stdout
    .split(/^ {2}Search paths:\r?$/m)
    .slice(1)) {
    for (const line of section.split(/\r?\n/).slice(1)) {
      if (!line.startsWith("    ")) break;
      const directory = line.trim();
      if (
        path.isAbsolute(directory) &&
        path.basename(directory) === "site-packages" &&
        path.resolve(directory) === directory
      )
        environmentLibraries.push(directory);
    }
  }
  const knownLibraries = [
    ...(libraryRoot ? [libraryRoot] : []),
    ...environmentLibraries,
  ];
  const selected = [
    ...data.selection.stdout.matchAll(
      /^([^\r\n]+)\r?\n Imports +\d+ files?\r?$/gm,
    ),
  ]
    .map((match) => path.resolve(root, check.project, match[1]!))
    .filter(
      (file) =>
        expected.has(file) ||
        !knownLibraries.some((directory) =>
          file.startsWith(`${directory}${path.sep}`),
        ),
    );
  const counts = { error: 0, warning: 0, information: 0 };
  for (const diagnostic of report.generalDiagnostics) {
    if (!expected.has(diagnostic.file)) return incomplete;
    if (
      diagnostic.range &&
      (diagnostic.range.end.line < diagnostic.range.start.line ||
        (diagnostic.range.end.line === diagnostic.range.start.line &&
          diagnostic.range.end.character < diagnostic.range.start.character))
    )
      return incomplete;
    counts[diagnostic.severity]++;
  }
  if (
    counts.error !== report.summary.errorCount ||
    counts.warning !== report.summary.warningCount ||
    counts.information !== report.summary.informationCount ||
    data.diagnostics.exitCode !== (counts.error + counts.warning > 0 ? 1 : 0)
  )
    return incomplete;
  const complete =
    exact(data.sources) &&
    exact(selected) &&
    report.summary.filesAnalyzed === expected.size &&
    data.selection.stdout
      .split(/\r?\n/)
      .filter(
        (line) =>
          line ===
          `Found ${expected.size} source ${expected.size === 1 ? "file" : "files"}`,
      ).length === 1 &&
    !data.policyProblems.length &&
    !data.selection.stderr.trim() &&
    !data.diagnostics.stderr.trim() &&
    data.selection.exitCode === data.diagnostics.exitCode;
  const findings: Finding[] = report.generalDiagnostics.map((diagnostic) => ({
    ruleId: diagnostic.rule ?? `pyright.${diagnostic.severity}`,
    level: diagnostic.severity === "information" ? "note" : diagnostic.severity,
    message: diagnostic.message,
    file: path.relative(root, diagnostic.file).split(path.sep).join("/"),
    ...(diagnostic.range ? { line: diagnostic.range.start.line + 1 } : {}),
  }));
  if (counts.error + counts.warning)
    return {
      status: "failed",
      reason: "Pyright reported type or syntax diagnostics.",
      findings,
      findingsComplete: complete,
    };
  return complete
    ? {
        status: "passed",
        reason:
          "Pyright accounted for every planned source and reported no errors, warnings or explicit diagnostic suppression.",
        findings,
        findingsComplete: true,
      }
    : incomplete;
}
