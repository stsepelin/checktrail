import path from "node:path";
import { z } from "zod";
import { javaInvocationSchema } from "./java.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";

const schema = z.strictObject({
  version: z.literal(1),
  runtime: z.literal("25.0.4+7-LTS"),
  vendor: z.literal("Eclipse Adoptium"),
  success: z.boolean(),
  finished: z.number().int().nonnegative(),
  extra: z.string(),
  sources: z
    .array(
      z.strictObject({
        file: z.string(),
        parsed: z.number().int().nonnegative(),
        declared: z.array(z.string()),
        analyzed: z.array(z.string()),
      }),
    )
    .max(20_000),
  diagnostics: z
    .array(
      z.strictObject({
        kind: z.enum([
          "ERROR",
          "WARNING",
          "MANDATORY_WARNING",
          "NOTE",
          "OTHER",
        ]),
        code: z.string().min(1),
        message: z.string(),
        file: z.string().nullable(),
        line: z.number().int(),
      }),
    )
    .max(2000),
});
export function javaEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Java evidence is malformed or lacks native source/analysis accounting",
    findingsComplete: false,
  };
  if (!root || processes.length !== 1) return incomplete;
  const process = processes[0]!;
  if (process.exitCode === 3) {
    try {
      z.strictObject({ unavailable: z.literal("java-toolchain") }).parse(
        JSON.parse(process.stdout),
      );
      return {
        status: "unavailable",
        reason: "The verified Temurin Java compiler is unavailable",
      };
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0)
    return {
      status: "error",
      reason: "Java evidence collection did not complete normally",
      findingsComplete: false,
    };
  try {
    const data = schema.parse(JSON.parse(process.stdout));
    const planned = javaInvocationSchema.parse(
      JSON.parse(check.commands[0]!.args[2]!),
    );
    if (
      JSON.stringify(planned.scope) !== JSON.stringify(check.scope) ||
      data.finished !== 1 ||
      data.extra.trim()
    )
      return incomplete;
    const expected = new Set(
      check.scope.map((file) => path.resolve(root, check.project, file)),
    );
    const findings: Finding[] = data.diagnostics.map((item) => ({
      ruleId: `javac/${item.code}`,
      level:
        item.kind === "ERROR"
          ? "error"
          : item.kind.endsWith("WARNING")
            ? "warning"
            : "note",
      message: item.message,
      ...(item.file && expected.has(item.file) && item.line > 0
        ? {
            file: path.relative(root, item.file).split(path.sep).join("/"),
            line: item.line,
          }
        : {}),
    }));
    const errors = data.diagnostics.some((item) => item.kind === "ERROR");
    if (errors && !data.success)
      return {
        status: "failed",
        reason:
          "Java reported compiler errors; failed compilation does not establish complete analysis",
        findings,
        findingsComplete: false,
      };
    if (
      errors ||
      !data.success ||
      !expected.size ||
      data.sources.length !== expected.size ||
      new Set(data.sources.map((item) => item.file)).size !== expected.size ||
      data.sources.some(
        (item) =>
          !expected.has(item.file) ||
          item.parsed !== 1 ||
          new Set(item.declared).size !== item.declared.length ||
          new Set(item.analyzed).size !== item.analyzed.length ||
          item.declared.some((type) => !item.analyzed.includes(type)),
      )
    )
      return { ...incomplete, findings };
    return {
      status: "passed",
      reason:
        "The configured Java sources compiled with complete parse/analysis accounting; no application code or tests were executed",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
