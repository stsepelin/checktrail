import path from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { scalaHash } from "./scala-archive.js";
import { kotlinReadSync as scalaReadSync } from "./kotlin-io.js";
import { scalaArtifacts } from "./scala-artifacts.js";
import { scalaInvocationSchema } from "./scala.js";
import {
  capturedProcessOutputSchema,
  parseCapturedProcessOutput,
} from "./process-output.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  file = z.string().min(1).max(16384),
  count = z.number().int().nonnegative().max(200000);
const binding = z.strictObject({
  file,
  sha256: digest,
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(1024 * 1024),
});
const nativeSchema = z.strictObject({
  version: z.literal(1),
  scala: z.literal(scalaArtifacts.version),
  runtime: z.literal("25.0.4+7-LTS"),
  vendor: z.literal("Eclipse Adoptium"),
  registrations: z.number().int().min(0).max(1),
  finishCalls: z.number().int().min(0).max(1),
  frontendStages: z.number().int().min(0).max(1),
  featureStages: z.number().int().min(0).max(1),
  completeStages: z.number().int().min(0).max(1),
  unknownSources: count,
  nodes: count,
  types: count,
  declarations: count,
  phases: z.array(z.string().min(1).max(4096)).min(1).max(256),
  errors: count,
  warnings: count,
  unreported: z
    .array(z.strictObject({ category: z.string().min(1).max(4096), count }))
    .max(2000),
  sources: z
    .array(
      z.strictObject({
        file,
        sha256: digest.nullable(),
        bytes: z
          .number()
          .int()
          .min(-1)
          .max(1024 * 1024),
        frontend: z.number().int().min(0).max(1),
        featureVisits: z.number().int().min(0).max(1),
        complete: z.number().int().min(0).max(1),
        compiled: z.number().int().min(0).max(1),
        nodes: count,
        types: count,
        declarations: count,
        unknownAnnotations: count,
        inline: z.boolean(),
        staging: z.boolean(),
        macro: z.boolean(),
        suspended: z.boolean(),
        annotations: z.array(z.string().min(1).max(4096)).max(200000),
      }),
    )
    .min(1)
    .max(2000),
  messages: z
    .array(
      z.strictObject({
        level: z.number().int().min(0).max(2),
        id: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
        message: z
          .string()
          .min(1)
          .max(1024 * 1024),
        file: file.nullable(),
        line: z.number().int().min(-1),
        column: z.number().int().min(-1),
        start: z.number().int().min(-1),
        end: z.number().int().min(-1),
        lineContent: z
          .string()
          .max(1024 * 1024)
          .nullable(),
      }),
    )
    .max(2000),
  outputs: z
    .array(
      z.strictObject({
        file,
        source: file,
        binaryName: z.string().min(1).max(16384),
        sha256: digest,
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
        classMajor: z.number().int().min(45).max(69).nullable(),
      }),
    )
    .max(4001),
});
export const scalaEvidenceSchema = z.strictObject({
  version: z.literal(1),
  requestDigest: digest,
  scala: z.literal(scalaArtifacts.version),
  scalaHome: file,
  toolchain: z.string().min(1).max(4096),
  sources: z
    .array(
      binding.extend({
        nativeFile: file,
        nativeSha256: digest,
        nativeBytes: z
          .number()
          .int()
          .nonnegative()
          .max(1024 * 1024),
      }),
    )
    .min(1)
    .max(2000),
  after: z.array(binding).min(1).max(2000),
  snapshotAfter: z.array(binding).min(1).max(2000),
  outputAfter: z
    .array(
      z.strictObject({
        file,
        sha256: digest,
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
      }),
    )
    .max(4001),
  native: nativeSchema.nullable(),
  nativeExit: z.number().int().nullable(),
  nativeSignal: z.string().nullable(),
  nativeError: z.string().nullable(),
  nativeOutput: capturedProcessOutputSchema,
});
export function scalaEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
  generatedSources: ReadonlyMap<string, Buffer> = new Map(),
  compilerSources: ReadonlyMap<string, Buffer> = new Map(),
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Scala evidence lacks fresh selected source, unsuppressed native diagnostics, complete typed-tree/backend participation or output bindings",
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
      z.strictObject({ unavailable: z.literal("scala-toolchain") }).parse(
        JSON.parse(process.stdout),
      );
      return {
        status: "unavailable",
        reason: "The pinned Scala JVM toolchain is unavailable",
        findingsComplete: false,
      };
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0 || process.stderr.trim())
    return {
      status: "error",
      reason: "Scala native collection did not complete normally",
      findingsComplete: false,
    };
  try {
    const data = scalaEvidenceSchema.parse(JSON.parse(process.stdout)),
      serialized = check.commands[0]!.args[2]!,
      planned = scalaInvocationSchema.parse(JSON.parse(serialized));
    if (
      data.requestDigest !== scalaHash(serialized) ||
      JSON.stringify(planned.scope) !== JSON.stringify(check.scope)
    )
      return incomplete;
    const output = parseCapturedProcessOutput(data.nativeOutput),
      native = data.native;
    if (
      !native ||
      !output.completeForObservedStreams ||
      data.nativeExit !== 0 ||
      data.nativeSignal ||
      data.nativeError ||
      native.registrations !== 1 ||
      native.finishCalls !== 1 ||
      native.unknownSources ||
      native.unreported.length ||
      JSON.stringify(native.phases) !== JSON.stringify(scalaArtifacts.phases)
    )
      return incomplete;
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(output.stdout.base64, "base64"),
    );
    if (
      JSON.stringify(JSON.parse(raw)) !== JSON.stringify(native) ||
      output.stderr.bytes !== 0
    )
      return incomplete;
    if (
      !data.toolchain.startsWith(
        "openjdk 25.0.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25.0.4+7 ",
      )
    )
      return incomplete;
    const expected = check.scope.map((name) =>
        path.resolve(root, check.project, name),
      ),
      snapshots = new Map<string, number>(),
      texts = new Map<string, { text: string; lines: string[] }>();
    if (
      new Set(expected).size !== expected.length ||
      data.sources.length !== expected.length ||
      data.after.length !== expected.length ||
      data.snapshotAfter.length !== expected.length ||
      native.sources.length !== expected.length
    )
      return incomplete;
    let totalBytes = 0,
      nodes = 0,
      types = 0,
      declarations = 0;
    for (const [i, before] of data.sources.entries()) {
      if (
        before.file !== expected[i] ||
        snapshots.has(before.nativeFile) ||
        !path.isAbsolute(before.nativeFile) ||
        (!generatedSources.has(before.file) &&
          realpathSync(before.file) !== before.file)
      )
        return incomplete;
      snapshots.set(before.nativeFile, i);
      const physical =
        generatedSources.get(before.file) ??
        scalaReadSync(before.file, 1024 * 1024);
      const compiledBytes = compilerSources.get(before.file) ?? physical;
      totalBytes += physical.length;
      if (
        physical.length !== before.bytes ||
        scalaHash(physical) !== before.sha256 ||
        compiledBytes.length !== before.nativeBytes ||
        scalaHash(compiledBytes) !== before.nativeSha256
      )
        return incomplete;
      const after = data.after[i]!,
        snapshot = data.snapshotAfter[i]!;
      if (
        after.file !== before.file ||
        after.bytes !== before.bytes ||
        after.sha256 !== before.sha256 ||
        snapshot.file !== before.nativeFile ||
        snapshot.bytes !== before.nativeBytes ||
        snapshot.sha256 !== before.nativeSha256
      )
        return incomplete;
      const observed = native.sources.find((s) => s.file === before.nativeFile);
      if (
        !observed ||
        native.sources.filter((s) => s.file === before.nativeFile).length !==
          1 ||
        observed.unknownAnnotations ||
        observed.annotations.some((a) =>
          (scalaArtifacts.suppressionAnnotations as readonly string[]).includes(
            a,
          ),
        ) ||
        (planned.config.profile === scalaArtifacts.profile &&
          !planned.config.extensions &&
          (observed.inline || observed.staging || observed.macro)) ||
        observed.suspended
      )
        return incomplete;
      nodes += observed.nodes;
      types += observed.types;
      declarations += observed.declarations;
      if (observed.frontend === 1) {
        if (
          observed.sha256 !== before.nativeSha256 ||
          observed.bytes !== before.nativeBytes ||
          observed.nodes < 1
        )
          return incomplete;
      } else if (
        !native.errors ||
        observed.sha256 !== null ||
        observed.bytes !== -1 ||
        observed.nodes ||
        observed.declarations ||
        observed.types ||
        observed.featureVisits ||
        observed.complete ||
        observed.compiled ||
        observed.annotations.length
      )
        return incomplete;
      const text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(compiledBytes),
        lines: string[] = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      if (!lines.length || text.endsWith("\n")) lines.push("");
      texts.set(before.nativeFile, { text, lines });
    }
    if (
      totalBytes > 32 * 1024 * 1024 ||
      nodes !== native.nodes ||
      types !== native.types ||
      declarations !== native.declarations
    )
      return incomplete;
    const findings: Finding[] = [],
      summaries: string[] = [];
    let errors = 0,
      warnings = 0,
      warningFailure = 0;
    for (const message of native.messages) {
      if (message.file === null) {
        if (
          message.line !== -1 ||
          message.column !== -1 ||
          message.start !== -1 ||
          message.end !== -1 ||
          message.lineContent !== null ||
          message.id !== "NoExplanationID"
        )
          return incomplete;
        if (
          message.level === 2 &&
          message.message === "No warnings can be incurred under -Werror" &&
          planned.config.warningsAsErrors
        ) {
          errors++;
          warningFailure++;
        } else if (message.level === 1) summaries.push(message.message);
        else return incomplete;
        continue;
      }
      const index = snapshots.get(message.file),
        source = texts.get(message.file);
      if (
        index === undefined ||
        !source ||
        message.level === 0 ||
        message.line < 0 ||
        message.line >= source.lines.length ||
        message.column < 0 ||
        message.column >
          source.lines[message.line]!.replace(/\r?\n$/, " ").length ||
        message.start < 0 ||
        message.end < message.start ||
        message.end > source.text.length ||
        message.lineContent !== source.lines[message.line]
      )
        return incomplete;
      if (message.level === 2) errors++;
      else warnings++;
      findings.push({
        ruleId: "scalac/" + message.id,
        level: message.level === 2 ? "error" : "warning",
        message: message.message,
        file: path
          .relative(root, data.sources[index]!.file)
          .split(path.sep)
          .join("/"),
        line: message.line + 1,
      });
    }
    const summary = [
      warnings ? `${warnings} warning${warnings === 1 ? "" : "s"} found` : null,
      errors ? `${errors} error${errors === 1 ? "" : "s"} found` : null,
    ]
      .filter((s) => s !== null)
      .join("\n");
    if (
      errors !== native.errors ||
      warnings !== native.warnings ||
      warningFailure > 1 ||
      (warningFailure && !warnings) ||
      JSON.stringify(summaries) !== JSON.stringify(summary ? [summary] : [])
    )
      return incomplete;
    if (
      data.outputAfter.length !== native.outputs.length ||
      new Set(data.outputAfter.map((o) => o.file)).size !==
        data.outputAfter.length
    )
      return incomplete;
    const outputNames = new Set<string>();
    let outputBytes = 0;
    for (const item of native.outputs) {
      const physical = data.outputAfter.find((o) => o.file === item.file);
      if (
        !physical ||
        physical.sha256 !== item.sha256 ||
        physical.bytes !== item.bytes
      )
        return incomplete;
      const name = item.file.split(path.sep).join("/");
      if (
        item.classMajor !==
        (name.endsWith(".class") ? Number(planned.config.jvmTarget) + 44 : null)
      )
        return incomplete;
      if (
        outputNames.has(name) ||
        name.startsWith("/") ||
        name.split("/").some((p) => p === "." || p === ".." || !p) ||
        (!name.endsWith(".class") && !name.endsWith(".tasty")) ||
        !snapshots.has(item.source)
      )
        return incomplete;
      if (
        name !==
        item.binaryName.replace(/\./g, "/") +
          (name.endsWith(".class") ? ".class" : ".tasty")
      )
        return incomplete;
      outputNames.add(name);
      outputBytes += item.bytes;
      if (
        name.endsWith(".tasty") &&
        !native.outputs.some(
          (o) =>
            o.file === item.file.replace(/\.tasty$/, ".class") &&
            o.source === item.source &&
            o.binaryName === item.binaryName,
        )
      )
        return incomplete;
    }
    if (outputBytes > 64 * 1024 * 1024) return incomplete;
    if (errors) {
      if (!findings.length) return incomplete;
      return {
        status: "failed",
        reason:
          "Pinned Scala compilation reported selected-source diagnostics; failed compilation does not establish complete unsuppressed analysis",
        findings,
        findingsComplete: false,
      };
    }
    if (
      !native.declarations ||
      native.frontendStages !== 1 ||
      native.featureStages !== 1 ||
      native.completeStages !== 1 ||
      native.sources.some(
        (s) =>
          s.frontend !== 1 ||
          s.featureVisits !== 1 ||
          s.complete !== 1 ||
          s.compiled !== 1,
      )
    )
      return incomplete;
    return {
      status: "passed",
      reason:
        "Every selected Scala source completed native typed-tree and JVM backend processing with fresh output bindings and no suppression under the declared warning policy",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
