import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Check, CheckResult, ProcessResult, Finding } from "./types.js";
const native = z.strictObject({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.strictObject({
  version: z.literal(1),
  cargoVersion: z.literal("1.98.1"),
  rustfmtVersion: z.literal("1.9.0-stable"),
  project: z.string(),
  files: z
    .array(
      z.strictObject({
        file: z.string(),
        inputSha256: digest,
        nativeOutputSha256: digest.nullable(),
        disabled: z.boolean(),
        skipped: z.boolean(),
        empty: z.boolean(),
        process: native.nullable(),
      }),
    )
    .min(1)
    .max(1000),
  cargo: native,
});
export function rustfmtEvidence(
  check: Check,
  processes: ProcessResult[],
  root?: string,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Rust formatting lacks complete active native per-file and Cargo evidence.",
  };
  if (!root || processes.length !== 1 || !check.scope.length) return incomplete;
  const process = processes[0]!;
  if (process.exitCode !== 0)
    return {
      status: "error",
      reason:
        "Rust formatting could not resolve its pinned workspace/configuration/runtime profile.",
    };
  try {
    const data = schema.parse(JSON.parse(process.stdout));
    if (
      data.files.some(
        (file) =>
          file.process &&
          file.nativeOutputSha256 !==
            createHash("sha256").update(file.process.stdout).digest("hex"),
      )
    )
      return incomplete;
    const expected = new Set(
      check.scope.map((file) => path.resolve(root, check.project, file)),
    );
    const observed = data.files.map((file) =>
      path.resolve(root, check.project, file.file),
    );
    if (
      data.project !== check.project ||
      process.stderr.trim() ||
      expected.size !== data.files.length ||
      new Set(observed).size !== observed.length ||
      observed.some((file) => !expected.has(file))
    )
      return incomplete;
    if (
      data.files.some(
        (file) =>
          file.disabled ||
          file.skipped ||
          file.empty ||
          !file.process ||
          !file.nativeOutputSha256,
      )
    )
      return incomplete;
    if (
      data.files.some(
        (file) =>
          ![0, 1].includes(file.process!.exitCode) ||
          file.process!.stderr.trim(),
      ) ||
      data.cargo.stderr.trim()
    )
      return {
        status: "error",
        reason:
          "Rustfmt reported a parse or runtime/configuration failure; no complete style evidence was produced.",
      };
    if (![0, 1].includes(data.cargo.exitCode))
      return {
        status: "error",
        reason: "Cargo formatting did not exit normally.",
      };
    for (const file of data.files) {
      const native = file.process!;
      const prefix =
        "Diff in " + path.resolve(root, check.project, file.file) + ":";
      const headers = native.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith("Diff in "));
      if (
        native.exitCode === 0
          ? Boolean(native.stdout.trim())
          : !headers.length ||
            headers.some(
              (line) =>
                !line.startsWith(prefix) ||
                !/^\d+:$/.test(line.slice(prefix.length)),
            )
      )
        return incomplete;
    }
    const cargoFiles = data.cargo.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("Formatting "))
      .map((line) => line.slice("Formatting ".length));
    if (
      !cargoFiles.length ||
      cargoFiles.some((file) => !expected.has(path.resolve(file)))
    )
      return incomplete;
    const findings: Finding[] = data.files
      .filter((file) => file.process!.exitCode === 1)
      .map((file) => ({
        ruleId: "rustfmt/style",
        level: "error",
        file: path
          .relative(root, path.resolve(root, check.project, file.file))
          .split(path.sep)
          .join("/"),
        message: "Native Rustfmt requires formatting changes.",
      }));
    if (!findings.length && data.cargo.exitCode !== 0) return incomplete;
    return {
      status: findings.length ? "failed" : "passed",
      reason: findings.length
        ? "Native Rustfmt reported formatting changes for declared source."
        : "Cargo formatting and active per-file Rustfmt checks reported no changes.",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
