import { createHash } from "node:crypto";
import path from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { javaCompilerEvidenceSchema, javaEvidence } from "./java-evidence.js";
import { spotbugsArtifacts } from "./spotbugs-artifacts.js";
import { spotbugsInvocationSchema } from "./spotbugs.js";
import type { Check, CheckResult, ProcessResult, Finding } from "./types.js";
const name = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/);
const compilerSchema = javaCompilerEvidenceSchema.extend({
  classes: z
    .array(
      z.strictObject({
        name,
        file: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
      }),
    )
    .max(20_000),
});
const analysisSchema = z.strictObject({
  version: z.literal(1),
  runtime: z.literal("25.0.4+7-LTS"),
  vendor: z.literal("Eclipse Adoptium"),
  spotbugs: z.literal("4.10.4"),
  completed: z.boolean(),
  detectors: z.array(name).min(1).max(512),
  effective: z.array(z.array(name).min(1).max(512)).min(1).max(16),
  predicted: z.array(z.number().int().positive()).min(1).max(16),
  passes: z
    .array(
      z.strictObject({
        expected: z.number().int().positive(),
        finished: z.number().int().nonnegative(),
        classes: z.array(name).min(1).max(100_000),
      }),
    )
    .min(1)
    .max(16),
  stats: z
    .array(z.strictObject({ name, source: z.string().min(1) }))
    .min(1)
    .max(20_000),
  bugs: z
    .array(
      z.strictObject({
        type: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        priority: z.number().int().min(1).max(3),
        rank: z.number().int().min(1).max(20),
        className: name,
        source: z.string().min(1),
        line: z.number().int(),
        endLine: z.number().int(),
        message: z.string().min(1).max(65536),
      }),
    )
    .max(2000),
  errors: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  errorMessages: z.array(z.string()).max(2000),
  missingClasses: z.array(z.string()).max(2000),
  skipped: z.array(z.string()).max(2000),
  oversized: z.array(name).max(20_000),
  messages: z.string().max(1024 * 1024),
});
const schema = z.strictObject({
  version: z.literal(1),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sources: z
    .array(
      z.strictObject({
        file: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        lines: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(20_000),
  compiler: compilerSchema,
  analysis: analysisSchema.nullable(),
});
export function spotbugsEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "SpotBugs evidence lacks fresh compiler, detector, class or complete pass accounting",
    findingsComplete: false,
  };
  if (!root || processes.length !== 1 || !check.scope.length) return incomplete;
  const process = processes[0]!;
  if (
    process.cancelled ||
    process.timedOut ||
    process.truncated ||
    process.signal ||
    process.errorCode
  )
    return incomplete;
  if (process.exitCode === 3) {
    try {
      z.strictObject({ unavailable: z.literal("spotbugs-toolchain") }).parse(
        JSON.parse(process.stdout),
      );
      return {
        status: "unavailable",
        reason: "The pinned SpotBugs JVM toolchain is unavailable",
        findingsComplete: false,
      };
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0 || process.stderr.trim())
    return {
      status: "error",
      reason: "SpotBugs native collection did not complete normally",
      findingsComplete: false,
    };
  try {
    const data = schema.parse(JSON.parse(process.stdout));
    const serialized = check.commands[0]!.args[2]!;
    const planned = spotbugsInvocationSchema.parse(JSON.parse(serialized));
    if (
      data.requestDigest !==
        createHash("sha256").update(serialized).digest("hex") ||
      JSON.stringify(planned.scope) !== JSON.stringify(check.scope)
    )
      return incomplete;
    const { classes, ...compiler } = data.compiler;
    const compilation = javaEvidence(
      {
        ...check,
        commands: [
          {
            ...check.commands[0]!,
            args: [
              "compiler",
              root,
              JSON.stringify({
                config: planned.compiler,
                scope: planned.scope,
              }),
            ],
          },
        ],
      },
      [{ ...process, stdout: JSON.stringify(compiler) }],
      root,
    );
    if (compilation.status !== "passed") return compilation;
    const sources = new Set(
      check.scope.map((file) => path.resolve(root, check.project, file)),
    );
    const names = new Set(classes.map((item) => item.name));
    if (
      data.sources.length !== sources.size ||
      new Set(data.sources.map((item) => item.file)).size !== sources.size
    )
      return incomplete;
    for (const binding of data.sources) {
      if (!sources.has(binding.file)) return incomplete;
      const bytes = readFileSync(binding.file);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (
        binding.sha256 !== createHash("sha256").update(bytes).digest("hex") ||
        binding.lines !== text.split(/\r\n?|\n/).length
      )
        return incomplete;
    }

    if (
      !classes.length ||
      names.size !== classes.length ||
      classes.reduce((sum, item) => sum + item.bytes, 0) > 32 * 1024 * 1024 ||
      classes.some((item) => !sources.has(item.file)) ||
      [...sources].some((file) => !classes.some((item) => item.file === file))
    )
      return incomplete;
    const analysis = data.analysis;
    if (
      !analysis ||
      !analysis.completed ||
      JSON.stringify(analysis.detectors) !==
        JSON.stringify(
          spotbugsArtifacts.defaultDetectors.filter(
            (name) =>
              name !== "edu.umd.cs.findbugs.detect.NoteSuppressedWarnings",
          ),
        ) ||
      analysis.predicted.length !== analysis.passes.length ||
      analysis.effective.length !== analysis.passes.length ||
      analysis.errors ||
      analysis.missing ||
      analysis.errorMessages.length ||
      analysis.missingClasses.length ||
      analysis.skipped.length ||
      analysis.oversized.length ||
      analysis.messages.trim()
    )
      return incomplete;
    const active = analysis.effective.flat();
    if (
      new Set(active).size !== active.length ||
      active.some(
        (name) =>
          !spotbugsArtifacts.allDetectors.includes(
            name as (typeof spotbugsArtifacts.allDetectors)[number],
          ),
      ) ||
      active.includes("edu.umd.cs.findbugs.detect.NoteSuppressedWarnings") ||
      JSON.stringify(analysis.effective) !==
        JSON.stringify(spotbugsArtifacts.effectivePlan)
    )
      return incomplete;
    if (
      analysis.stats.length !== names.size ||
      new Set(analysis.stats.map((item) => item.name)).size !== names.size ||
      analysis.stats.some(
        (item) =>
          !names.has(item.name) ||
          item.source !==
            path.basename(classes.find((c) => c.name === item.name)!.file),
      )
    )
      return incomplete;
    for (const [index, pass] of analysis.passes.entries()) {
      const seen = new Set(pass.classes);
      if (
        pass.expected !== analysis.predicted[index] ||
        pass.finished !== pass.expected ||
        pass.classes.length !== pass.finished ||
        seen.size !== pass.finished ||
        [...names].some((item) => !seen.has(item)) ||
        (index > 0 && seen.size !== names.size)
      )
        return incomplete;
    }
    const findings: Finding[] = [];
    for (const bug of analysis.bugs) {
      const item = classes.find((c) => c.name === bug.className);
      if (
        !item ||
        bug.source !== path.basename(item.file) ||
        bug.type === "SKIPPED_CLASS_TOO_BIG" ||
        (bug.line > 0 &&
          (bug.endLine < bug.line ||
            bug.endLine >
              data.sources.find((source) => source.file === item.file)!.lines))
      )
        return incomplete;
      findings.push({
        ruleId: `spotbugs/${bug.type}`,
        level: bug.priority === 1 ? "error" : "warning",
        message: bug.message,
        file: path.relative(root, item.file).split(path.sep).join("/"),
        ...(bug.line > 0 ? { line: bug.line } : {}),
      });
    }
    return {
      status: findings.length ? "failed" : "passed",
      reason: findings.length
        ? "Pinned SpotBugs default detectors reported native bytecode defects"
        : "Every freshly compiled selected class completed the pinned SpotBugs detector passes",
      findings: [...(compilation.findings ?? []), ...findings],
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
