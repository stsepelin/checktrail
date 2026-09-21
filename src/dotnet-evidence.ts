import path from "node:path";
import { z } from "zod";
import { dotnetConfigSchema, dotnetInvocationSchema } from "./dotnet.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";

const schema = z.strictObject({
  sdkVersion: z.literal("10.0.401"),
  runtimeReferenceVersion: z.literal("10.0.12"),
  referenceFiles: z.number().int().min(2).max(509),
  compilerAndReferencesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  compilation: z.strictObject({
    version: z.literal(1),
    compiler: z.literal("5.9.0.0"),
    runtime: z.literal("10.0.12"),
    success: z.boolean(),
    outputBytes: z
      .number()
      .int()
      .nonnegative()
      .max(32 * 1024 * 1024),
    ownedTreeCount: z.number().int().min(0).max(1),
    referenceCount: z.number().int().positive(),
    settings: dotnetConfigSchema,
    sources: z
      .array(
        z.strictObject({
          file: z.string(),
          syntaxLength: z.number().int().nonnegative(),
          textLength: z.number().int().nonnegative(),
          semantic: z.boolean(),
          semanticDiagnosticCount: z.number().int().nonnegative().max(2000),
        }),
      )
      .max(20_000),
    diagnostics: z
      .array(
        z.strictObject({
          code: z.string().regex(/^CS\d+$/),
          severity: z.enum(["Error", "Warning", "Info", "Hidden"]),
          message: z.string(),
          suppressed: z.boolean(),
          file: z.string().nullable(),
          line: z.number().int().nonnegative(),
        }),
      )
      .max(2000),
  }),
});
export function dotnetEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      ".NET evidence is malformed, suppressed or missing native compilation/source accounting",
    findingsComplete: false,
  };
  if (!root || processes.length !== 1) return incomplete;
  const process = processes[0]!;
  if (process.exitCode === 3) {
    try {
      z.strictObject({ unavailable: z.literal("dotnet-toolchain") }).parse(
        JSON.parse(process.stdout),
      );
      return {
        status: "unavailable",
        reason: "The verified .NET SDK and Roslyn compiler are unavailable",
      };
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0)
    return {
      status: "error",
      reason: ".NET evidence collection did not complete normally",
      findingsComplete: false,
    };
  try {
    const data = schema.parse(JSON.parse(process.stdout));
    const result = data.compilation;
    const planned = dotnetInvocationSchema.parse(
      JSON.parse(check.commands[0]!.args[2]!),
    );
    if (
      JSON.stringify(planned.scope) !== JSON.stringify(check.scope) ||
      JSON.stringify(planned.config) !== JSON.stringify(result.settings) ||
      result.ownedTreeCount !== Number(planned.config.implicitUsings) ||
      result.referenceCount !==
        data.referenceFiles + planned.config.references.length
    )
      return incomplete;
    const expected = new Set(
      check.scope.map((file) => path.resolve(root, check.project, file)),
    );
    const findings: Finding[] = result.diagnostics
      .filter((item) => !item.suppressed)
      .map((item) => ({
        ruleId: `csharp/${item.code}`,
        level:
          item.severity === "Error"
            ? "error"
            : item.severity === "Warning"
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
    const errors = result.diagnostics.some(
      (item) => item.severity === "Error" && !item.suppressed,
    );
    if (errors && !result.success)
      return {
        status: "failed",
        reason:
          "Roslyn reported compiler errors; failed compilation does not establish complete analysis",
        findings,
        findingsComplete: false,
      };
    if (
      errors ||
      !result.success ||
      !result.outputBytes ||
      result.diagnostics.some((item) => item.suppressed) ||
      !expected.size ||
      result.sources.length !== expected.size ||
      new Set(result.sources.map((item) => item.file)).size !== expected.size ||
      result.sources.some(
        (item) =>
          !expected.has(item.file) ||
          !item.semantic ||
          item.syntaxLength !== item.textLength,
      )
    )
      return { ...incomplete, findings };
    return {
      status: "passed",
      reason:
        "Configured C# sources compiled with native syntax and semantic accounting; no application code, build targets or tests were executed",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
