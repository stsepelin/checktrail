import path from "node:path";
import { z } from "zod";
import {
  externalInvocationSchema,
  externalResultSchema,
} from "./external-adapter.js";
import type {
  Check,
  CheckResult,
  ProcessResult,
  TestEvidence,
} from "./types.js";

const envelopeSchema = z.strictObject({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});
export function externalEvidence(
  check: Check,
  processes: ProcessResult[],
): Partial<CheckResult> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "External adapter evidence is malformed, contradictory or incomplete",
    findingsComplete: false,
  };
  if (processes.length !== 1) return incomplete;
  const process = processes[0]!;
  if (process.exitCode === 3 && !process.stderr) {
    try {
      z.strictObject({ unavailable: z.literal("external-runtime") }).parse(
        JSON.parse(process.stdout),
      );
      return {
        status: "unavailable",
        reason: "The external adapter runtime is unavailable",
        findingsComplete: false,
      };
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0 || process.stderr)
    return {
      status: "error",
      reason: "External adapter execution did not complete",
      findingsComplete: false,
    };
  try {
    const envelope = envelopeSchema.parse(JSON.parse(process.stdout));
    if (![0, 1].includes(envelope.exitCode))
      return {
        status: "error",
        reason: "External adapter reported a tool or runtime error",
        findingsComplete: false,
      };
    const result = externalResultSchema.parse(JSON.parse(envelope.stdout));
    const invocation = externalInvocationSchema.parse(
      JSON.parse(check.commands[0]!.args[2]!),
    );
    if (
      JSON.stringify(result.identity) !== JSON.stringify(check.external) ||
      JSON.stringify(result.identity) !== JSON.stringify(invocation.identity) ||
      result.checkId !== check.id ||
      invocation.kind !== check.kind ||
      result.sourceFingerprint !== invocation.sourceFingerprint ||
      JSON.stringify(invocation.scope) !== JSON.stringify(check.scope)
    )
      return incomplete;
    const expected = new Set(check.scope);
    if (
      !expected.size ||
      result.files.length !== expected.size ||
      new Set(result.files.map((file) => file.path)).size !== expected.size ||
      result.files.some((file) => !expected.has(file.path)) ||
      result.findings.some(
        (finding) =>
          (finding.file && !expected.has(finding.file)) ||
          (finding.line && !finding.file),
      ) ||
      new Set(result.tools.map((tool) => tool.name)).size !==
        result.tools.length
    )
      return incomplete;
    const tests: TestEvidence = { total: 0, passed: 0, failed: 0, skipped: 0 };
    let complete =
      result.findingsComplete &&
      result.files.every((file) => file.status === "checked");
    for (const file of result.files) {
      if (check.kind !== "test") {
        if (file.tests) return incomplete;
        continue;
      }
      if (!file.tests) return incomplete;
      const counts = file.tests;
      if (counts.total !== counts.passed + counts.failed + counts.skipped)
        return incomplete;
      if (
        !counts.total ||
        counts.skipped ||
        counts.passed + counts.failed === 0
      )
        complete = false;
      for (const key of ["total", "passed", "failed", "skipped"] as const)
        tests[key] += counts[key];
    }
    const failed =
      tests.failed > 0 ||
      result.findings.some(
        (finding) =>
          finding.level === "error" ||
          (invocation.failOn === "warning" && finding.level === "warning"),
      );
    if (envelope.exitCode !== (failed ? 1 : 0)) return incomplete;
    const evidence: Partial<CheckResult> = {
      external: {
        ...result.identity,
        tools: result.tools.map((tool) => ({
          ...tool,
          source: "adapter-reported" as const,
        })),
      },
      findings: result.findings.map((finding) => ({
        ruleId: `${check.id}/${finding.ruleId}`,
        level: finding.level,
        message: finding.message,
        ...(finding.line ? { line: finding.line } : {}),
        ...(finding.file
          ? { file: path.posix.join(check.project, finding.file) }
          : {}),
      })),
      findingsComplete: complete,
      ...(check.kind === "test" ? { tests } : {}),
    };
    if (failed)
      return {
        ...evidence,
        status: "failed",
        reason:
          "The trusted external adapter reported failing diagnostics or tests",
      };
    if (!complete) return { ...evidence, ...incomplete };
    return {
      ...evidence,
      status: "passed",
      reason:
        "The trusted external adapter accounted for every planned file and completed its declared check",
    };
  } catch {
    return incomplete;
  }
}
