import path from "node:path";
import { z } from "zod";
import { actionlintInvocationSchema, workflowPath } from "./actionlint.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";

const schema = actionlintInvocationSchema.extend({
  version: z.literal("1.7.12"),
  preflight: z.strictObject({
    findings: z
      .array(
        z.strictObject({
          ruleId: z.string().regex(/^yaml\/[A-Z_]+$/),
          level: z.literal("error"),
          message: z.string(),
          file: z.string(),
          line: z.number().int().positive(),
        }),
      )
      .max(2000),
    unavailable: z.string().min(1).optional(),
  }),
  results: z
    .array(
      z.strictObject({
        file: z.string(),
        exitCode: z.number().int(),
        stdout: z.string(),
        stderr: z.string(),
      }),
    )
    .max(128),
});
const diagnosticsSchema = z
  .array(
    z.strictObject({
      message: z.string(),
      filepath: z.string(),
      line: z.number().int().positive(),
      column: z.number().int().positive(),
      kind: z.string().regex(/^[a-z][a-z0-9-]+$/),
      snippet: z.string(),
      end_column: z.number().int().nonnegative(),
    }),
  )
  .max(2000);

export function actionlintEvidence(
  check: Check,
  processes: ProcessResult[],
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Workflow evidence is malformed or missing native per-file completion accounting",
    findingsComplete: false,
  };
  if (processes.length !== 1) return incomplete;
  const process = processes[0]!;
  if (process.stderr.trim()) return incomplete;
  if (process.exitCode === 3) {
    try {
      z.strictObject({ unavailable: z.literal("actionlint-toolchain") }).parse(
        JSON.parse(process.stdout),
      );
      return {
        status: "unavailable",
        reason: "The verified actionlint release is unavailable",
      };
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0)
    return {
      status: "error",
      reason: "Workflow evidence collection did not complete",
      findingsComplete: false,
    };
  try {
    const data = schema.parse(JSON.parse(process.stdout));
    const planned = actionlintInvocationSchema.parse(
      JSON.parse(check.commands[0]!.args[2]!),
    );
    if (
      JSON.stringify(data.scope) !== JSON.stringify(check.scope) ||
      JSON.stringify(data.scope) !== JSON.stringify(planned.scope) ||
      data.fingerprint !== planned.fingerprint ||
      JSON.stringify(data.config) !== JSON.stringify(planned.config)
    )
      return incomplete;
    if (
      data.preflight.findings.some(
        (item) =>
          !workflowPath(item.file) ||
          path.posix.isAbsolute(item.file) ||
          path.posix.normalize(item.file) !== item.file ||
          item.file.startsWith("../"),
      )
    )
      return incomplete;
    const findings: Finding[] = data.preflight.findings.map((item) => ({
      ...item,
      file: path.posix.join(check.project, item.file),
    }));
    if (data.preflight.findings.length) {
      if (data.results.length) return incomplete;
      return {
        status: "failed",
        reason:
          "Workflow or local action YAML is invalid; native analysis did not run",
        findings,
        findingsComplete: false,
      };
    }
    if (data.preflight.unavailable) {
      if (data.results.length) return incomplete;
      return {
        status: "unavailable",
        reason: data.preflight.unavailable,
        findingsComplete: false,
      };
    }
    if (
      data.results.length !== check.scope.length ||
      new Set(data.results.map((result) => result.file)).size !==
        check.scope.length
    )
      return incomplete;
    for (const result of data.results) {
      if (!check.scope.includes(result.file)) return incomplete;
      const diagnostics = diagnosticsSchema.parse(JSON.parse(result.stdout));
      const lines = result.stderr.trimEnd().split("\n");
      const counts: { parse?: number; total?: number } = {};
      const required = new Set([
        `verbose: Linting ${result.file}`,
        "verbose: Using project at <project>",
        'verbose: Rule "shellcheck" was disabled since shellcheck command name was empty',
        'verbose: Rule "pyflakes" was disabled since pyflakes command name was empty',
      ]);
      for (const line of lines) {
        const match =
          /^verbose: Found (?:(total) )?(\d+) (parse )?errors in \d+ ms for (.+)$/.exec(
            line,
          );
        if (match && match[4] === result.file && !!match[1] !== !!match[3]) {
          const key = match[1] ? "total" : "parse";
          if (counts[key] !== undefined) return incomplete;
          counts[key] = Number(match[2]);
        } else if (!required.delete(line)) return incomplete;
      }
      if (
        counts.parse === undefined ||
        counts.total !== diagnostics.length ||
        (required.size &&
          (counts.parse === 0 ||
            required.size !== 2 ||
            ![...required].every((line) =>
              line.startsWith("verbose: Rule "),
            ))) ||
        diagnostics.some((item) => item.filepath !== result.file) ||
        result.exitCode !== (diagnostics.length ? 1 : 0)
      )
        return incomplete;
      if (!diagnostics.length && counts.parse !== 0) return incomplete;
      findings.push(
        ...diagnostics.map((item) => ({
          ruleId: `actionlint/${item.kind}`,
          level: "error" as const,
          message: item.message,
          file: path.posix.join(check.project, item.filepath),
          line: item.line,
        })),
      );
    }
    return findings.length
      ? {
          status: "failed",
          reason:
            "Actionlint reported workflow errors; failed analysis does not establish complete coverage",
          findings,
          findingsComplete: false,
        }
      : {
          status: "passed",
          reason:
            "Every planned workflow completed native static analysis; workflow jobs and action code were not executed",
          findings,
          findingsComplete: true,
        };
  } catch {
    return incomplete;
  }
}
