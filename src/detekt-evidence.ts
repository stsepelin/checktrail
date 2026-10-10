import { readFileSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { detektHash } from "./detekt-configuration.js";
import { detektArtifacts } from "./detekt-artifacts.js";
import { detektInvocationSchema } from "./detekt.js";
import {
  capturedProcessOutputSchema,
  parseCapturedProcessOutput,
} from "./process-output.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const filename = z.string().min(1).max(16384);
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/);
const severity = z.enum(["Error", "Warning", "Info"]);
const rule = z.strictObject({
  set: identifier,
  id: identifier,
  active: z.boolean(),
  severity,
});
export const detektNativeSchema = z.strictObject({
  version: z.literal(1),
  events: z
    .array(
      z.strictObject({
        kind: z.enum([
          "analysis-started",
          "file-started",
          "file-finished",
          "analysis-finished",
        ]),
        file: filename.nullable(),
      }),
    )
    .min(4)
    .max(4002),
  rules: z.array(rule).min(1).max(512),
  sources: z
    .array(
      z.strictObject({
        file: filename,
        physicalBefore: digest,
        physicalAfter: digest,
        psiSha256: digest,
        syntaxErrors: z.number().int().nonnegative(),
        excluded: z.array(z.string()).max(512),
        suppressed: z.array(z.string()).max(512),
      }),
    )
    .min(1)
    .max(2000),
  notifications: z
    .array(
      z.strictObject({
        level: severity,
        message: z.string().max(65536),
      }),
    )
    .max(2000),
  findings: z
    .array(
      z.strictObject({
        file: filename,
        line: z.number().int().positive(),
        column: z.number().int().positive(),
        set: identifier,
        id: identifier,
        severity,
        message: z.string().min(1).max(65536),
        suppressionReasons: z.array(z.string()).max(512),
      }),
    )
    .max(2000),
});
const binding = z.strictObject({
  file: filename,
  sha256: digest,
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(1024 * 1024),
});
export const detektEvidenceSchema = z.strictObject({
  version: z.literal(1),
  requestDigest: digest,
  detekt: z.literal(detektArtifacts.version),
  configurationSha256: z.literal(detektArtifacts.configurationSha256),
  sources: z
    .array(
      binding.extend({
        canonicalSha256: digest,
        nativeFile: filename,
      }),
    )
    .min(1)
    .max(2000),
  after: z.array(binding).min(1).max(2000),
  native: detektNativeSchema.nullable(),
  nativeExit: z.number().int().nullable(),
  nativeSignal: z.string().nullable(),
  nativeError: z.string().nullable(),
  nativeOutput: capturedProcessOutputSchema,
  warningJarUrl: z.string().min(1).max(16384),
});
export function detektEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "detekt evidence lacks fresh selected source, complete native rules, lifecycle or suppression accounting",
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
      z.strictObject({ unavailable: z.literal("detekt-toolchain") }).parse(
        JSON.parse(process.stdout),
      );
      return {
        status: "unavailable",
        reason: "The pinned detekt JVM toolchain is unavailable",
        findingsComplete: false,
      };
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0 || process.stderr.trim())
    return {
      status: "error",
      reason: "detekt native collection did not complete normally",
      findingsComplete: false,
    };
  try {
    const data = detektEvidenceSchema.parse(JSON.parse(process.stdout));
    const serialized = check.commands[0]!.args[2]!;
    const planned = detektInvocationSchema.parse(JSON.parse(serialized));
    if (
      data.requestDigest !== detektHash(serialized) ||
      JSON.stringify(planned.scope) !== JSON.stringify(check.scope)
    )
      return incomplete;
    const output = parseCapturedProcessOutput(data.nativeOutput);
    if (
      !output.completeForObservedStreams ||
      data.nativeSignal ||
      data.nativeError
    )
      return incomplete;
    const native = data.native;
    if (
      !native ||
      native.notifications.length ||
      JSON.stringify(native.rules) !== JSON.stringify(detektArtifacts.rules)
    )
      return incomplete;
    const expected = check.scope.map((file) =>
      path.resolve(root, check.project, file),
    );
    if (
      new Set(expected).size !== expected.length ||
      data.sources.length !== expected.length ||
      data.after.length !== expected.length ||
      native.sources.length !== expected.length
    )
      return incomplete;
    const originals = new Set<string>(),
      snapshots = new Set<string>();
    const texts = new Map<string, string[]>();
    let bytesTotal = 0;
    for (const [index, before] of data.sources.entries()) {
      if (
        before.file !== expected[index] ||
        originals.has(before.file) ||
        snapshots.has(before.nativeFile) ||
        !path.isAbsolute(before.nativeFile)
      )
        return incomplete;
      originals.add(before.file);
      snapshots.add(before.nativeFile);
      if (
        realpathSync(before.file) !== before.file ||
        !statSync(before.file).isFile() ||
        statSync(before.file).size > 1024 * 1024
      )
        return incomplete;
      const bytes = readFileSync(before.file);
      bytesTotal += bytes.length;
      const text = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .replace(/\r\n?/g, "\n");
      if (
        bytes.length !== before.bytes ||
        detektHash(bytes) !== before.sha256 ||
        detektHash(text) !== before.canonicalSha256
      )
        return incomplete;
      const after = data.after[index]!;
      if (
        after.file !== before.file ||
        after.sha256 !== before.sha256 ||
        after.bytes !== before.bytes
      )
        return incomplete;
      const observed = native.sources[index]!;
      if (
        observed.file !== before.nativeFile ||
        observed.physicalBefore !== before.sha256 ||
        observed.physicalAfter !== before.sha256 ||
        observed.psiSha256 !== before.canonicalSha256 ||
        observed.syntaxErrors ||
        observed.excluded.length ||
        observed.suppressed.length
      )
        return incomplete;
      texts.set(before.file, text.split("\n"));
    }
    if (bytesTotal > 32 * 1024 * 1024) return incomplete;
    if (
      native.events.length !== 2 * expected.length + 2 ||
      native.events[0]!.kind !== "analysis-started" ||
      native.events[0]!.file !== null ||
      native.events.at(-1)!.kind !== "analysis-finished" ||
      native.events.at(-1)!.file !== null
    )
      return incomplete;
    const started = new Set<string>(),
      finished = new Set<string>();
    for (const event of native.events.slice(1, -1)) {
      if (!event.file || !snapshots.has(event.file)) return incomplete;
      if (event.kind === "file-started") {
        if (started.has(event.file)) return incomplete;
        started.add(event.file);
      } else if (event.kind === "file-finished") {
        if (!started.has(event.file) || finished.has(event.file))
          return incomplete;
        finished.add(event.file);
      } else return incomplete;
    }
    if (started.size !== expected.length || finished.size !== expected.length)
      return incomplete;
    const warnings =
      [
        "WARNING: A terminally deprecated method in sun.misc.Unsafe has been called",
        `WARNING: sun.misc.Unsafe::objectFieldOffset has been called by com.github.benmanes.caffeine.cache.UnsafeAccess (${data.warningJarUrl})`,
        "WARNING: Please consider reporting this to the maintainers of class com.github.benmanes.caffeine.cache.UnsafeAccess",
        "WARNING: sun.misc.Unsafe::objectFieldOffset will be removed in a future release",
      ].join("\n") + "\n";
    if (
      new TextDecoder("utf-8", { fatal: true })
        .decode(Buffer.from(output.stderr.base64, "base64"))
        .replace(/\r\n/g, "\n") !== warnings
    )
      return incomplete;
    const findings: Finding[] = [],
      consoleLines: string[] = [];
    for (const issue of native.findings) {
      const sourceIndex = check.scope.indexOf(
        issue.file.split(path.sep).join("/"),
      );
      if (sourceIndex < 0 || issue.suppressionReasons.length) return incomplete;
      const active = native.rules.find(
        (r) => r.set === issue.set && r.id === issue.id,
      );
      if (!active?.active || active.severity !== issue.severity)
        return incomplete;
      const source = data.sources[sourceIndex]!;
      const lines = texts.get(source.file)!;
      if (
        issue.line > lines.length ||
        issue.column > lines[issue.line - 1]!.length + 1
      )
        return incomplete;
      findings.push({
        ruleId: `detekt/${issue.set}/${issue.id}`,
        level:
          issue.severity === "Error"
            ? "error"
            : issue.severity === "Warning"
              ? "warning"
              : "note",
        message: issue.message,
        file: path.relative(root, source.file).split(path.sep).join("/"),
        line: issue.line,
      });
      consoleLines.push(
        `${issue.severity === "Error" ? "e" : issue.severity === "Warning" ? "w" : "i"}: ${source.nativeFile}:${issue.line}:${issue.column} ${issue.message} [${issue.id}]\n`,
      );
    }
    const expectedConsole = findings.length
      ? consoleLines.join("") +
        `\nAnalysis failed with ${findings.length} issues.\n`
      : "";
    if (
      data.nativeExit !== (findings.length ? 2 : 0) ||
      new TextDecoder("utf-8", { fatal: true })
        .decode(Buffer.from(output.stdout.base64, "base64"))
        .replace(/\r\n/g, "\n") !== expectedConsole
    )
      return incomplete;
    return {
      status: findings.length ? "failed" : "passed",
      reason: findings.length
        ? "Pinned detekt light rules reported selected Kotlin findings"
        : "Every selected Kotlin source completed the pinned light rule plan without suppression; compilation and type analysis remain separate",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
