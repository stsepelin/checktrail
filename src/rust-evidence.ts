import path from "node:path";
import { z } from "zod";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";

const target = z.object({
  name: z.string(),
  src_path: z.string(),
  kind: z.array(z.string()).min(1),
  test: z.boolean(),
});
const event = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("build-finished"), success: z.boolean() }),
  z.object({
    reason: z.literal("compiler-artifact"),
    package_id: z.string(),
    target,
    fresh: z.boolean(),
    profile: z.object({ test: z.boolean() }),
  }),
  z.object({
    reason: z.literal("compiler-message"),
    package_id: z.string(),
    message: z.object({
      level: z.enum(["error", "warning", "note", "help", "failure-note"]),
      code: z.object({ code: z.string() }).nullable(),
      message: z.string(),
      spans: z.array(
        z.object({
          file_name: z.string(),
          line_start: z.number().int().nonnegative(),
          is_primary: z.boolean(),
        }),
      ),
    }),
  }),
  z.object({
    reason: z.literal("build-script-executed"),
    package_id: z.string(),
  }),
]);
const schema = z.strictObject({
  version: z.literal(1),
  cargoVersion: z.literal("1.98.1"),
  rustcVersion: z.literal("1.98.1"),
  project: z.string(),
  packageId: z.string(),
  exitCode: z.number().int(),
  targets: z.array(target).min(1),
  events: z.array(event).max(20_000),
  observedSources: z.array(z.string()).max(20_000),
  depInfoCount: z.number().int().nonnegative().max(20_000),
  scopeError: z.boolean(),
});

const clippySchema = schema.extend({
  version: z.literal(2),
  mode: z.literal("clippy"),
  clippyVersion: z.literal("0.1.98"),
  forcedLintGroup: z.literal("clippy::all"),
});

export function rustEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Rust evidence is malformed, stale or missing native target/source coverage.",
  };
  if (processes.length !== 1 || !root) return incomplete;
  const process = processes[0]!;
  if (process.exitCode === 3) {
    try {
      z.strictObject({
        unavailable: z.literal("rust-toolchain"),
        reason: z.enum(["unsupported-version", "unsupported-workspace"]),
      }).parse(JSON.parse(process.stdout));
      return {
        status: "unavailable",
        reason:
          "The installed Rust version or Cargo workspace shape is outside the verified profile.",
      };
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0)
    return {
      status: "error",
      reason:
        "Rust tooling could not resolve the package or complete native evidence collection.",
    };
  try {
    const data = (
      check.id === "rust.cargo-clippy" ? clippySchema : schema
    ).parse(JSON.parse(process.stdout));
    if (data.project !== check.project) return incomplete;
    const expected = new Set(
      check.scope.map((file) => path.resolve(root, check.project, file)),
    );
    const findings: Finding[] = [];
    const seenFindings = new Set<string>();
    let errors = 0;
    let configurationErrors = 0;
    for (const item of data.events) {
      if (item.reason !== "compiler-message") continue;
      if (item.message.level === "error") errors++;
      if (
        check.id === "rust.cargo-clippy" &&
        item.message.level === "error" &&
        item.message.code === null &&
        item.message.message.startsWith(
          "error reading Clippy's configuration file:",
        ) &&
        item.message.spans.some(
          (span) =>
            span.is_primary &&
            ["clippy.toml", ".clippy.toml"].some(
              (name) =>
                path.resolve(root, check.project, span.file_name) ===
                path.resolve(root, check.project, name),
            ),
        )
      )
        configurationErrors++;
      if (!["error", "warning"].includes(item.message.level)) continue;
      const location = item.message.spans.find((span) => span.is_primary);
      const absolute = location
        ? path.resolve(root, check.project, location.file_name)
        : undefined;
      const finding: Finding = {
        ruleId: item.message.code?.code.startsWith("clippy::")
          ? "clippy/" + item.message.code.code.slice("clippy::".length)
          : `rustc/${item.message.code?.code ?? "diagnostic"}`,
        level: item.message.level === "error" ? "error" : "warning",
        message: item.message.message,
        ...(absolute && expected.has(absolute) && location!.line_start > 0
          ? {
              file: path.relative(root, absolute).split(path.sep).join("/"),
              line: location!.line_start,
            }
          : {}),
      };
      const key = JSON.stringify(finding);
      if (check.id !== "rust.cargo-clippy" || !seenFindings.has(key))
        findings.push(finding);
      seenFindings.add(key);
    }
    if (configurationErrors)
      return {
        status: "error",
        reason:
          "Clippy could not read its project configuration; source analysis is incomplete.",
        findings,
        findingsComplete: false,
      };
    if (errors)
      return {
        status: "failed",
        reason:
          "The Rust compiler reported errors; compilation failures do not establish complete analysis.",
        findings,
        findingsComplete: false,
      };
    if (data.exitCode !== 0)
      return {
        status: "error",
        reason: "Cargo failed without structured compiler-error evidence.",
        findings,
        findingsComplete: false,
      };
    const finished = data.events.filter(
      (item) => item.reason === "build-finished",
    );
    const artifacts = data.events
      .filter((item) => item.reason === "compiler-artifact")
      .filter((item) => item.package_id === data.packageId);
    const observed = new Set(
      data.observedSources.map((file) =>
        path.resolve(root, check.project, file),
      ),
    );
    if (
      finished.length !== 1 ||
      !finished[0]!.success ||
      data.events.at(-1)?.reason !== "build-finished" ||
      data.scopeError ||
      !data.depInfoCount ||
      !expected.size ||
      observed.size !== data.observedSources.length ||
      observed.size !== expected.size ||
      [...observed].some((file) => !expected.has(file)) ||
      !artifacts.length ||
      artifacts.some((item) => item.fresh) ||
      data.targets.some(
        (item) =>
          !expected.has(path.resolve(item.src_path)) ||
          !artifacts.some(
            (artifact) =>
              artifact.target.name === item.name &&
              artifact.target.src_path === item.src_path &&
              JSON.stringify(artifact.target.kind) ===
                JSON.stringify(item.kind) &&
              (!item.test ||
                item.kind.includes("custom-build") ||
                artifact.profile.test),
          ),
      )
    )
      return { ...incomplete, findings, findingsComplete: false };
    const lintFailure =
      check.id === "rust.cargo-clippy" &&
      findings.some((finding) => finding.ruleId.startsWith("clippy/"));
    const complete =
      check.id !== "rust.cargo-clippy" ||
      findings.every((finding) => finding.file !== undefined);
    return {
      status: lintFailure ? "failed" : complete ? "passed" : "inconclusive",
      reason:
        check.id === "rust.cargo-clippy"
          ? !complete
            ? "Clippy retained diagnostics without verified source addresses; complete analysis is not established."
            : lintFailure
              ? "Clippy reported lint diagnostics after fresh complete native target/source accounting; no tests were executed."
              : "Clippy checked all declared targets with fresh output and exact inventoried dep-info scope; no tests were executed."
          : "Cargo checked all declared targets with fresh output and dep-info coverage of inventoried Rust source; no tests were executed.",
      findings,
      findingsComplete: complete,
    };
  } catch {
    return incomplete;
  }
}
