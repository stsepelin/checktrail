import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { clangInvocationSchema } from "./clang.js";
import { clangVersion, supportedClangVersion } from "./clang-protocol.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";

const location = z.object({
  physicalLocation: z.object({
    artifactLocation: z.object({
      uri: z.string(),
      index: z.number().int().nonnegative().optional(),
    }),
    region: z.object({ startLine: z.number().int().positive() }),
  }),
});
const sarif = z.object({
  version: z.literal("2.1.0"),
  runs: z
    .array(
      z.object({
        tool: z.object({
          driver: z.object({
            name: z.literal("clang"),
            version: z.string(),
            rules: z.array(z.object({ id: z.string() })),
          }),
        }),
        invocations: z
          .array(z.object({ executionSuccessful: z.boolean() }))
          .length(1)
          .optional(),
        results: z
          .array(
            z.object({
              level: z.enum(["error", "warning", "note"]),
              ruleId: z.string(),
              ruleIndex: z.number().int().nonnegative(),
              message: z.object({ text: z.string() }),
              locations: z.array(location).optional(),
            }),
          )
          .max(20_000),
      }),
    )
    .length(1),
});
const schema = z.strictObject({
  version: z.literal(1),
  project: z.string(),
  units: z
    .array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        file: z.string(),
        compiler: z.enum(["clang", "clang++"]),
        version: z.string(),
        exitCode: z.number().int(),
        diagnostics: z.unknown(),
        observedSources: z.array(z.string()).max(20_000),
        externalDependencyCount: z.number().int().nonnegative(),
        scopeError: z.boolean(),
      }),
    )
    .min(1)
    .max(64),
});

export function clangEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Clang evidence is malformed or lacks compilation/source accounting",
    findingsComplete: false,
  };
  if (!root || processes.length !== 1) return incomplete;
  const process = processes[0]!;
  if (process.exitCode === 3) {
    try {
      const value = z
        .strictObject({
          unavailable: z.literal("clang-toolchain"),
          reason: z.enum(["missing-tool", "unsupported-version"]),
        })
        .safeParse(JSON.parse(process.stdout));
      return value.success
        ? {
            status: "unavailable",
            reason:
              "The required Clang toolchain is missing or outside the verified native profile",
          }
        : incomplete;
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0)
    return {
      status: "error",
      reason: "Clang evidence collection did not complete normally",
    };
  try {
    const data = schema.parse(JSON.parse(process.stdout));
    const planned = clangInvocationSchema.parse(
      JSON.parse(check.commands[0]!.args[2]!),
    );
    if (
      data.project !== check.project ||
      data.units.length !== planned.units.length ||
      JSON.stringify(planned.scope) !== JSON.stringify(check.scope)
    )
      return incomplete;
    const observed = new Set<string>();
    const findings: Finding[] = [];
    let partial = false;
    let failed = false;
    for (const [index, unit] of data.units.entries()) {
      const expected = planned.units[index]!;
      if (
        unit.index !== index ||
        unit.file !== expected.file ||
        unit.compiler !== expected.compiler ||
        !supportedClangVersion(unit.version)
      )
        return incomplete;
      const parsed = sarif.safeParse(unit.diagnostics);
      if (!parsed.success) {
        partial = true;
        continue;
      }
      const run = parsed.data.runs[0]!;
      if (
        run.tool.driver.version !==
          (unit.version.startsWith("Apple ")
            ? unit.version.split("\n")[0]
            : clangVersion(unit.version)) ||
        (unit.version.startsWith("Apple ") && !run.invocations) ||
        (run.invocations !== undefined &&
          run.invocations[0]!.executionSuccessful !== (unit.exitCode === 0))
      ) {
        partial = true;
        continue;
      }
      let errors = 0;
      for (const diagnostic of run.results) {
        if (
          run.tool.driver.rules[diagnostic.ruleIndex]?.id !== diagnostic.ruleId
        ) {
          partial = true;
          continue;
        }
        if (diagnostic.level === "error") errors++;
        const first = diagnostic.locations?.[0]?.physicalLocation;
        let relative: string | undefined;
        if (first) {
          try {
            const absolute = fileURLToPath(first.artifactLocation.uri);
            const file = path
              .relative(path.resolve(root, check.project), absolute)
              .split(path.sep)
              .join("/");
            if (check.scope.includes(file))
              relative = path.posix.join(check.project, file);
          } catch {
            partial = true;
          }
        }
        findings.push({
          ruleId: `clang/${diagnostic.ruleId}`,
          level: diagnostic.level,
          message: diagnostic.message.text,
          ...(relative && first
            ? { file: relative, line: first.region.startLine }
            : {}),
        });
      }
      if (errors && unit.exitCode !== 0) failed = true;
      else if (unit.exitCode !== 0 || errors) partial = true;
      if (
        unit.scopeError ||
        new Set(unit.observedSources).size !== unit.observedSources.length ||
        !unit.observedSources.includes(unit.file)
      )
        partial = true;
      for (const file of unit.observedSources) {
        if (!check.scope.includes(file)) partial = true;
        else observed.add(file);
      }
    }
    if (failed)
      return {
        status: "failed",
        reason:
          "Clang reported native compiler errors; failed compilation does not establish complete analysis",
        findings,
        findingsComplete: false,
      };
    if (partial || observed.size !== check.scope.length || !observed.size)
      return { ...incomplete, findings };
    return {
      status: "passed",
      reason:
        "Every prepared Clang compilation completed with dependency coverage of inventoried C/C++ sources; linking and tests were not executed",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
