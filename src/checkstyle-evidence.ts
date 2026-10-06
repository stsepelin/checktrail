import path from "node:path";
import { z } from "zod";
import {
  checkstyleInvocationSchema,
  CHECKSTYLE_VERSION,
  type CheckstyleModule,
} from "./checkstyle.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";
const schema = z.strictObject({
  version: z.literal(1),
  runtime: z.literal("25.0.4+7-LTS"),
  vendor: z.literal("Eclipse Adoptium"),
  checkstyle: z.literal(CHECKSTYLE_VERSION),
  configuration: checkstyleInvocationSchema.shape.configuration,
  rules: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        type: z.string().min(1),
        moduleId: z.string().nullable(),
      }),
    )
    .min(1)
    .max(512),
  nativeErrors: z.number().int().nonnegative(),
  events: z
    .array(
      z.strictObject({
        kind: z.enum([
          "audit-started",
          "audit-finished",
          "file-started",
          "file-finished",
        ]),
        file: z.string().nullable(),
      }),
    )
    .min(4)
    .max(40002),
  diagnostics: z
    .array(
      z.strictObject({
        file: z.string().nullable(),
        line: z.number().int().nonnegative(),
        column: z.number().int().nonnegative(),
        severity: z.enum(["error", "warning", "info", "ignore"]),
        source: z.string().nullable(),
        moduleId: z.string().nullable(),
        message: z.string().min(1),
      }),
    )
    .max(2000),
  exceptions: z
    .array(
      z.strictObject({ file: z.string().nullable(), type: z.string().min(1) }),
    )
    .max(2000),
});
function canonical(module: CheckstyleModule): string {
  return JSON.stringify({
    name: module.name,
    properties: [...module.properties].sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    ),
    children: module.children.map((child) => JSON.parse(canonical(child))),
  });
}
const simpleName = (value: string) => {
  const final = value.split(".").at(-1)!;
  return final.endsWith("Check") ? final.slice(0, -5) : final;
};
export function checkstyleEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Checkstyle evidence lacks exact native configuration, rule, source or completion accounting",
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
      z.strictObject({ unavailable: z.literal("checkstyle-toolchain") }).parse(
        JSON.parse(process.stdout),
      );
      return {
        status: "unavailable",
        reason: "The pinned Checkstyle JVM toolchain is unavailable",
        findingsComplete: false,
      };
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0 || process.stderr.trim())
    return {
      status: "error",
      reason: "Checkstyle native collection did not complete normally",
      findingsComplete: false,
    };
  try {
    const planned = checkstyleInvocationSchema.parse(
      JSON.parse(check.commands[0]!.args[2]!),
    );
    const data = schema.parse(JSON.parse(process.stdout));
    if (
      JSON.stringify(planned.scope) !== JSON.stringify(check.scope) ||
      canonical(data.configuration) !== canonical(planned.configuration)
    )
      return incomplete;
    const leaves = planned.configuration.children.flatMap((child) =>
      simpleName(child.name) === "TreeWalker" ? child.children : [child],
    );
    if (data.rules.length !== leaves.length) return incomplete;
    for (let i = 0; i < leaves.length; i++) {
      const declaration = leaves[i]!,
        rule = data.rules[i]!;
      if (
        rule.name !== declaration.name ||
        !rule.type.startsWith("com.puppycrawl.tools.checkstyle.checks.") ||
        simpleName(rule.type) !== simpleName(rule.name) ||
        rule.moduleId !==
          (declaration.properties.find((p) => p.name === "id")?.value ?? null)
      )
        return incomplete;
    }
    if (
      data.nativeErrors !==
        data.diagnostics.filter((d) => d.severity === "error").length ||
      data.diagnostics.some((d) => d.severity === "ignore")
    )
      return incomplete;
    const expected = new Set(
      check.scope.map((file) => path.resolve(root, check.project, file)),
    );
    if (expected.size !== check.scope.length) return incomplete;
    const seen = new Set<string>();
    let audit = false,
      finished = false,
      current: string | null = null;
    for (const event of data.events) {
      if (event.kind === "audit-started") {
        if (audit || finished || event.file !== null) return incomplete;
        audit = true;
      } else if (event.kind === "audit-finished") {
        if (!audit || finished || current !== null || event.file !== null)
          return incomplete;
        finished = true;
      } else if (event.kind === "file-started") {
        if (
          !audit ||
          finished ||
          current !== null ||
          !event.file ||
          !expected.has(event.file) ||
          seen.has(event.file)
        )
          return incomplete;
        current = event.file;
      } else {
        if (!audit || finished || !event.file || current !== event.file)
          return incomplete;
        seen.add(event.file);
        current = null;
      }
    }
    if (!finished || current !== null || seen.size !== expected.size)
      return incomplete;
    if (data.diagnostics.some((d) => d.file !== null && !expected.has(d.file)))
      return incomplete;
    if (
      data.diagnostics.some(
        (d) =>
          d.source !== "com.puppycrawl.tools.checkstyle.TreeWalker" &&
          !data.rules.some(
            (rule) => rule.type === d.source && rule.moduleId === d.moduleId,
          ),
      )
    )
      return incomplete;
    const findings: Finding[] = data.diagnostics.map((d) => ({
      ruleId: `checkstyle/${d.source ?? "unknown"}${d.moduleId ? "/" + d.moduleId : ""}`,
      level:
        d.severity === "info"
          ? "note"
          : d.severity === "error"
            ? "error"
            : "warning",
      message: d.message,
      ...(d.file && d.line > 0
        ? {
            file: path.relative(root, d.file).split(path.sep).join("/"),
            line: d.line,
          }
        : {}),
    }));
    const failed = findings.some(
      (f) =>
        f.level === "error" ||
        (planned.config.failOn === "warning" && f.level === "warning"),
    );
    const complete =
      !data.exceptions.length &&
      data.diagnostics.every(
        (d) =>
          d.source !== "com.puppycrawl.tools.checkstyle.TreeWalker" &&
          d.file !== null &&
          d.line > 0,
      );
    return {
      status: failed ? "failed" : complete ? "passed" : "error",
      reason: failed
        ? "Configured Checkstyle rules reported native source violations"
        : complete
          ? "Every selected Java source completed the pinned configured Checkstyle audit"
          : "Checkstyle retained native errors with incomplete source analysis",
      findings,
      findingsComplete: complete,
    };
  } catch {
    return incomplete;
  }
}
