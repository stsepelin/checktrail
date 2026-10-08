import path from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { kotlinHash } from "./kotlin-archive.js";
import { kotlinReadSync } from "./kotlin-io.js";
import { kotlinArtifacts } from "./kotlin-artifacts.js";
import { kotlinInvocationSchema } from "./kotlin.js";
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
  kotlin: z.literal(kotlinArtifacts.version),
  runtime: z.literal("25.0.4+7-LTS"),
  vendor: z.literal("Eclipse Adoptium"),
  jdkHome: file,
  exit: z.enum([
    "OK",
    "COMPILATION_ERROR",
    "INTERNAL_ERROR",
    "SCRIPT_EXECUTION_ERROR",
  ]),
  hasErrors: z.boolean(),
  registrations: z.number().int().min(0).max(1),
  firNodes: count,
  unknownSources: count,
  irModules: z.number().int().min(0).max(1),
  irFiles: z.array(file).max(2000),
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
        fileCallbacks: z.number().int().min(0).max(1),
        declarations: count,
        expressions: count,
        types: count,
        unknownAnnotations: count,
        annotations: z.array(z.string().min(1).max(4096)).max(200000),
      }),
    )
    .min(1)
    .max(2000),
  messages: z
    .array(
      z.strictObject({
        severity: z.enum([
          "EXCEPTION",
          "ERROR",
          "STRONG_WARNING",
          "WARNING",
          "INFO",
          "LOGGING",
          "OUTPUT",
        ]),
        message: z
          .string()
          .min(1)
          .max(1024 * 1024),
        file: file.nullable(),
        line: z.number().int().min(-1),
        column: z.number().int().min(-1),
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
        classMajor: z.number().int().min(45).max(69).nullable(),
        file,
        sha256: digest,
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
        sources: z.array(file).min(1).max(2000),
      }),
    )
    .max(4001),
});
const evidenceSchema = z.strictObject({
  version: z.literal(1),
  requestDigest: digest,
  kotlin: z.literal(kotlinArtifacts.version),
  kotlinHome: file,
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
  warningJarUrl: file,
});
export function kotlinEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Kotlin evidence lacks fresh selected source, unsuppressed native diagnostics, complete frontend/IR participation or output bindings",
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
      z.strictObject({ unavailable: z.literal("kotlin-toolchain") }).parse(
        JSON.parse(process.stdout),
      );
      return {
        status: "unavailable",
        reason: "The pinned Kotlin JVM toolchain is unavailable",
        findingsComplete: false,
      };
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0 || process.stderr.trim())
    return {
      status: "error",
      reason: "Kotlin native collection did not complete normally",
      findingsComplete: false,
    };
  try {
    const data = evidenceSchema.parse(JSON.parse(process.stdout)),
      serialized = check.commands[0]!.args[2]!,
      planned = kotlinInvocationSchema.parse(JSON.parse(serialized));
    if (
      data.requestDigest !== kotlinHash(serialized) ||
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
      native.unknownSources ||
      !["OK", "COMPILATION_ERROR"].includes(native.exit)
    )
      return incomplete;
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(output.stdout.base64, "base64"),
    );
    if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(native))
      return incomplete;
    const warning =
      [
        "WARNING: A terminally deprecated method in sun.misc.Unsafe has been called",
        `WARNING: sun.misc.Unsafe::invokeCleaner has been called by org.jetbrains.kotlin.cli.jvm.compiler.jarfs.FastJarFileSystemKt (${data.warningJarUrl})`,
        "WARNING: Please consider reporting this to the maintainers of class org.jetbrains.kotlin.cli.jvm.compiler.jarfs.FastJarFileSystemKt",
        "WARNING: sun.misc.Unsafe::invokeCleaner will be removed in a future release",
      ].join("\n") + "\n";
    if (
      new TextDecoder("utf-8", { fatal: true })
        .decode(Buffer.from(output.stderr.base64, "base64"))
        .replace(/\r\n/g, "\n") !== warning
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
      texts = new Map<string, string[]>();
    if (
      new Set(expected).size !== expected.length ||
      data.sources.length !== expected.length ||
      data.after.length !== expected.length ||
      data.snapshotAfter.length !== expected.length ||
      native.sources.length !== expected.length
    )
      return incomplete;
    let bytesTotal = 0,
      nodes = 0;
    for (const [i, before] of data.sources.entries()) {
      if (
        before.file !== expected[i] ||
        snapshots.has(before.nativeFile) ||
        !path.isAbsolute(before.nativeFile) ||
        realpathSync(before.file) !== before.file
      )
        return incomplete;
      snapshots.set(before.nativeFile, i);
      const physical = kotlinReadSync(before.file, 1024 * 1024),
        nativeBytes = physical.subarray(
          physical.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ? 3 : 0,
        );
      bytesTotal += physical.length;
      if (
        physical.length !== before.bytes ||
        kotlinHash(physical) !== before.sha256 ||
        nativeBytes.length !== before.nativeBytes ||
        kotlinHash(nativeBytes) !== before.nativeSha256
      )
        return incomplete;
      const after = data.after[i]!,
        snapshot = data.snapshotAfter[i]!;
      if (
        after.file !== before.file ||
        after.bytes !== before.bytes ||
        after.sha256 !== before.sha256 ||
        snapshot.file !== before.nativeFile ||
        snapshot.bytes !== before.bytes ||
        snapshot.sha256 !== before.sha256
      )
        return incomplete;
      const observed = native.sources.find((s) => s.file === before.nativeFile);
      if (
        !observed ||
        native.sources.filter((s) => s.file === before.nativeFile).length !==
          1 ||
        observed.unknownAnnotations ||
        observed.annotations.some(
          (a) => a === "kotlin.Suppress" || a === "java.lang.SuppressWarnings",
        )
      )
        return incomplete;
      nodes += observed.declarations + observed.expressions + observed.types;
      if (observed.fileCallbacks === 1) {
        if (
          observed.sha256 !== before.nativeSha256 ||
          observed.bytes !== before.nativeBytes ||
          observed.declarations < 1
        )
          return incomplete;
      } else if (
        native.exit === "OK" ||
        observed.sha256 !== null ||
        observed.bytes !== -1 ||
        observed.declarations ||
        observed.expressions ||
        observed.types
      )
        return incomplete;
      texts.set(
        before.nativeFile,
        new TextDecoder("utf-8", { fatal: true })
          .decode(nativeBytes)
          .replace(/\r\n?/g, "\n")
          .split("\n"),
      );
    }
    if (bytesTotal > 32 * 1024 * 1024 || nodes !== native.firNodes)
      return incomplete;
    const findings: Finding[] = [],
      progress: string[] = [],
      outputMessages: typeof native.messages = [];
    let errors = 0,
      warningCount = 0,
      globalWarningFailure = 0;
    for (const message of native.messages) {
      if (message.severity === "LOGGING") {
        if (
          message.file !== null ||
          message.line !== -1 ||
          message.column !== -1 ||
          message.lineContent !== null
        )
          return incomplete;
        progress.push(message.message);
        continue;
      }
      if (message.severity === "OUTPUT") {
        outputMessages.push(message);
        continue;
      }
      if (message.severity === "EXCEPTION" || message.severity === "INFO")
        return incomplete;
      if (message.severity === "ERROR") errors++;
      else warningCount++;
      if (message.file === null) {
        if (
          message.severity !== "ERROR" ||
          !planned.config.warningsAsErrors ||
          message.message !== "warnings found and -Werror specified" ||
          message.line !== -1 ||
          message.column !== -1 ||
          message.lineContent !== null
        )
          return incomplete;
        globalWarningFailure++;
        continue;
      }
      const index = snapshots.get(message.file),
        lines = texts.get(message.file);
      if (
        index === undefined ||
        !lines ||
        message.line < 1 ||
        message.line > lines.length ||
        message.column < 1 ||
        message.column > lines[message.line - 1]!.length + 1 ||
        message.lineContent !== lines[message.line - 1]
      )
        return incomplete;
      const rule = /^\[([A-Z][A-Z0-9_]*)\] /.exec(message.message)?.[1];
      if (!rule) return incomplete;
      findings.push({
        ruleId: "kotlinc/" + rule,
        level: message.severity === "ERROR" ? "error" : "warning",
        message: message.message,
        file: path
          .relative(root, data.sources[index]!.file)
          .split(path.sep)
          .join("/"),
        line: message.line,
      });
    }
    if (
      progress.length !== 4 ||
      progress[0] !== "Using Kotlin home directory " + data.kotlinHome ||
      progress[1] !== "Configuring the compilation environment" ||
      progress[2] !== "Using JDK home directory " + native.jdkHome ||
      !/^Loading modules: \[(?:[a-z][a-z0-9_.]*(?:, )?)+\]$/.test(progress[3]!)
    )
      return incomplete;
    if (
      native.hasErrors !== errors > 0 ||
      globalWarningFailure > 1 ||
      (globalWarningFailure && !warningCount)
    )
      return incomplete;
    if (
      native.outputs.length !== outputMessages.length ||
      data.outputAfter.length !== native.outputs.length ||
      new Set(data.outputAfter.map((o) => o.file)).size !==
        data.outputAfter.length
    )
      return incomplete;
    const outputNames = new Set<string>();
    let outputBytes = 0;
    for (const [i, item] of native.outputs.entries()) {
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
        (!name.endsWith(".class") && name !== "META-INF/main.kotlin_module") ||
        new Set(item.sources).size !== item.sources.length ||
        item.sources.some((s) => !snapshots.has(s))
      )
        return incomplete;
      outputNames.add(name);
      outputBytes += item.bytes;
      const message = outputMessages[i]!;
      if (
        message.file !== null ||
        message.line !== -1 ||
        message.column !== -1 ||
        message.lineContent !== null
      )
        return incomplete;
      const outputPath = path.join(
        path.dirname(data.kotlinHome),
        "output",
        item.file,
      );
      if (
        message.message !==
        "Output:\n" + outputPath + "\nSources:\n" + item.sources.join("\n")
      )
        return incomplete;
    }
    if (outputBytes > 64 * 1024 * 1024) return incomplete;
    if (native.exit === "COMPILATION_ERROR") {
      if (!errors || !findings.length) return incomplete;
      return {
        status: "failed",
        reason:
          "Pinned Kotlin compilation reported selected-source diagnostics; compilation stopped before a complete output profile",
        findings,
        findingsComplete: false,
      };
    }
    if (
      errors ||
      native.hasErrors ||
      native.irModules !== 1 ||
      native.irFiles.length !== snapshots.size ||
      new Set(native.irFiles).size !== snapshots.size ||
      native.irFiles.some((f) => !snapshots.has(f))
    )
      return incomplete;
    const module = native.outputs.find(
      (o) => o.file.split(path.sep).join("/") === "META-INF/main.kotlin_module",
    );
    if (
      !module ||
      module.sources.length !== snapshots.size ||
      module.sources.some((f) => !snapshots.has(f)) ||
      !native.outputs.length
    )
      return incomplete;
    return {
      status: "passed",
      reason:
        "Every selected Kotlin source completed native frontend and IR processing with fresh output bindings and no suppression under the declared warning policy",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
