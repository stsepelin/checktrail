import path from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { scalaInvocationSchema } from "./scala.js";
import { scala2ConfigSchema } from "./scala2.js";
import { scala2Artifacts } from "./scala2-artifacts.js";
import { scalaArtifacts } from "./scala-artifacts.js";
import { scala2Hash, scala2Libraries } from "./scala2-archive.js";
import { kotlinReadSync } from "./kotlin-io.js";
import { kotlinJar } from "./kotlin-jar.js";
import { jvmToolchainPins } from "./jvm-toolchain-pins.js";
import {
  capturedProcessOutputSchema,
  parseCapturedProcessOutput,
} from "./process-output.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  file = z.string().min(1).max(16384),
  count = z.number().int().nonnegative().max(200000),
  binding = z.strictObject({
    file,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024),
    sha256: digest,
  });
export const scala2EvidenceSchema = z.strictObject({
  version: z.literal(1),
  requestDigest: digest,
  scala: z.literal("2.13.18"),
  javaHome: file,
  toolchain: z.string().min(1).max(4096),
  stagedArtifactsVerified: z.literal(true),
  sources: z
    .array(binding.extend({ nativeFile: file }))
    .min(1)
    .max(2000),
  after: z.array(binding).min(1).max(2000),
  snapshotAfter: z.array(binding).min(1).max(2000),
  outputAfter: z
    .array(
      z.strictObject({
        file,
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
        sha256: digest,
      }),
    )
    .max(4001),
  nativeOutput: capturedProcessOutputSchema,
  mirroredOutput: capturedProcessOutputSchema,
  invocations: z
    .array(
      z.strictObject({
        stdoutBytes: z
          .number()
          .int()
          .nonnegative()
          .max(2 * 1024 * 1024),
        stderrBytes: z
          .number()
          .int()
          .nonnegative()
          .max(2 * 1024 * 1024),
      }),
    )
    .min(2)
    .max(2),
  native: z.strictObject({
    version: z.literal(1),
    scala: z.literal("2.13.18"),
    runtime: z.literal("25.0.4+7-LTS"),
    vendor: z.literal("Eclipse Adoptium"),
    unknownSources: count,
    nodes: count,
    types: count,
    declarations: count,
    phases: z.array(z.string().min(1).max(100)).min(1).max(100),
    errors: count,
    warnings: count,
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
          complete: z.number().int().min(0).max(1),
          nodes: count,
          types: count,
          declarations: count,
          unknownAnnotations: count,
          annotations: z.array(z.string().min(1).max(16384)).max(200000),
          primaryNames: z.array(z.string().min(1).max(16384)).max(200000),
        }),
      )
      .min(1)
      .max(2000),
    messages: z
      .array(
        z.strictObject({
          level: z.number().int().min(0).max(2),
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
          file,
          source: file,
          sourceFile: z.string().min(1).max(16384),
          binaryName: z.string().min(1).max(16384),
          bytes: z
            .number()
            .int()
            .positive()
            .max(32 * 1024 * 1024),
          sha256: digest,
          classMajor: z.number().int().min(61).max(69),
        }),
      )
      .max(4001),
  }),
});
const phases = [
  "parser",
  "namer",
  "packageobjects",
  "typer",
  "checktrail-original-frontend",
  "superaccessors",
  "extmethods",
  "pickler",
  "refchecks",
  "patmat",
  "uncurry",
  "fields",
  "tailcalls",
  "specialize",
  "explicitouter",
  "erasure",
  "posterasure",
  "lambdalift",
  "constructors",
  "flatten",
  "mixin",
  "cleanup",
  "delambdafy",
  "jvm",
  "checktrail-original-complete",
  "terminal",
];
export function scala2Evidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Scala 2 evidence lacks fresh pinned inputs, exact native source/backend participation, unsuppressed diagnostics or physical class origins",
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
        reason: "The pinned Scala 2 JVM toolchain is unavailable",
        findingsComplete: false,
      };
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0)
    return {
      status: "error",
      reason: "Scala 2 native collection did not complete",
      findingsComplete: false,
    };
  try {
    const data = scala2EvidenceSchema.parse(JSON.parse(process.stdout)),
      serialized = check.commands[0]!.args[2]!,
      planned = scalaInvocationSchema.parse(JSON.parse(serialized)),
      config = scala2ConfigSchema.parse(planned.config),
      native = data.native;
    if (
      data.requestDigest !== scala2Hash(serialized) ||
      JSON.stringify(planned.scope) !== JSON.stringify(check.scope) ||
      native.unknownSources ||
      JSON.stringify(native.phases) !== JSON.stringify(phases)
    )
      return incomplete;
    const currentFile = path.resolve(
      root,
      check.project,
      "checktrail.scala.json",
    );
    if (realpathSync(currentFile) !== currentFile) return incomplete;
    const current = scala2ConfigSchema.parse(
      JSON.parse(kotlinReadSync(currentFile, 100 * 1024).toString("utf8")),
    );
    if (JSON.stringify(current) !== JSON.stringify(config)) return incomplete;
    const archive = path.resolve(root, check.project, config.archive);
    if (realpathSync(archive) !== archive) return incomplete;
    scala2Libraries(kotlinReadSync(archive, scala2Artifacts.archiveBytes));
    let dependencyBytes = 0;
    const dependencyPaths = new Set<string>();
    for (const dep of config.classPath) {
      const absolute = path.resolve(root, check.project, dep.path);
      if (realpathSync(absolute) !== absolute || dependencyPaths.has(absolute))
        return incomplete;
      dependencyPaths.add(absolute);
      const bytes = kotlinReadSync(absolute, 32 * 1024 * 1024);
      dependencyBytes += bytes.length;
      if (
        dependencyBytes > 64 * 1024 * 1024 ||
        scala2Hash(bytes) !== dep.sha256 ||
        kotlinJar(bytes).classPath.length
      )
        return incomplete;
    }
    if (realpathSync(data.javaHome) !== data.javaHome) return incomplete;
    for (const pin of jvmToolchainPins) {
      const absolute = path.join(data.javaHome, pin.path);
      if (realpathSync(absolute) !== absolute) return incomplete;
      const bytes = kotlinReadSync(absolute, pin.bytes);
      if (bytes.length !== pin.bytes || scala2Hash(bytes) !== pin.sha256)
        return incomplete;
    }
    if (
      !data.toolchain.startsWith(
        "openjdk 25.0.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25.0.4+7 ",
      )
    )
      return incomplete;
    const raw = parseCapturedProcessOutput(data.nativeOutput),
      mirror = parseCapturedProcessOutput(data.mirroredOutput);
    if (
      !raw.completeForObservedStreams ||
      raw.stderr.bytes ||
      !mirror.completeForObservedStreams ||
      mirror.stdout.bytes ||
      Buffer.from(mirror.stderr.base64, "base64").toString("utf8") !==
        process.stderr ||
      data.invocations.reduce(
        (n, r) => n + r.stdoutBytes + r.stderrBytes,
        0,
      ) !== mirror.stderr.bytes ||
      JSON.stringify(
        scala2EvidenceSchema.shape.native.parse(
          JSON.parse(Buffer.from(raw.stdout.base64, "base64").toString("utf8")),
        ),
      ) !== JSON.stringify(native)
    )
      return incomplete;
    if (
      data.invocations[0]!.stdoutBytes ||
      data.invocations[0]!.stderrBytes ||
      data.invocations[1]!.stdoutBytes !== raw.stdout.bytes ||
      data.invocations[1]!.stderrBytes !== raw.stderr.bytes
    )
      return incomplete;
    const expected = check.scope.map((f) =>
      path.resolve(root, check.project, f),
    );
    if (
      new Set(expected).size !== expected.length ||
      [data.sources, data.after, data.snapshotAfter, native.sources].some(
        (a) => a.length !== expected.length,
      )
    )
      return incomplete;
    const snapshots = new Map<string, { file: string; text: string }>();
    let sourceBytes = 0,
      nodes = 0,
      types = 0,
      declarations = 0;
    for (const [i, before] of data.sources.entries()) {
      if (
        before.file !== expected[i] ||
        realpathSync(before.file) !== before.file ||
        !path.isAbsolute(before.nativeFile) ||
        snapshots.has(before.nativeFile)
      )
        return incomplete;
      const bytes = kotlinReadSync(before.file, 1024 * 1024);
      sourceBytes += bytes.length;
      if (bytes.length !== before.bytes || scala2Hash(bytes) !== before.sha256)
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
      snapshots.set(before.nativeFile, {
        file: before.file,
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes,
        ),
      });
      const observed = native.sources.filter(
        (s) => s.file === before.nativeFile,
      );
      if (observed.length !== 1) return incomplete;
      const source = observed[0]!;
      if (
        source.unknownAnnotations ||
        source.annotations.some((a) =>
          (scalaArtifacts.suppressionAnnotations as readonly string[]).includes(
            a,
          ),
        ) ||
        new Set(source.primaryNames).size !== source.primaryNames.length
      )
        return incomplete;
      nodes += source.nodes;
      types += source.types;
      declarations += source.declarations;
      if (source.frontend === 1) {
        if (
          source.sha256 !== before.sha256 ||
          source.bytes !== before.bytes ||
          !source.nodes
        )
          return incomplete;
      } else if (
        !native.errors ||
        source.sha256 !== null ||
        source.bytes !== -1 ||
        source.complete ||
        source.nodes ||
        source.types ||
        source.declarations ||
        source.annotations.length ||
        source.primaryNames.length
      )
        return incomplete;
    }
    if (
      sourceBytes > 32 * 1024 * 1024 ||
      nodes !== native.nodes ||
      types !== native.types ||
      declarations !== native.declarations
    )
      return incomplete;
    const findings: Finding[] = [];
    let errors = 0,
      warnings = 0,
      warningFailure = 0;
    for (const message of native.messages) {
      if (message.file === null) {
        if (
          !config.warningsAsErrors ||
          message.level !== 2 ||
          message.message !== "No warnings can be incurred under -Werror." ||
          message.line !== -1 ||
          message.column !== -1 ||
          message.lineContent !== null
        )
          return incomplete;
        errors++;
        warningFailure++;
        continue;
      }
      if (message.level === 0) return incomplete;
      const source = snapshots.get(message.file);
      if (!source) return incomplete;
      const lines = source.text.split(/\r?\n/);
      if (
        message.line < 0 ||
        message.line >= lines.length ||
        message.column < 0 ||
        message.column > lines[message.line]!.length ||
        message.lineContent !== lines[message.line]
      )
        return incomplete;
      if (message.level === 2) errors++;
      else warnings++;
      findings.push({
        ruleId: "scalac2/native-diagnostic",
        level: message.level === 2 ? "error" : "warning",
        message: message.message,
        file: path.relative(root, source.file).split(path.sep).join("/"),
        line: message.line + 1,
      });
    }
    if (
      errors !== native.errors ||
      warnings !== native.warnings ||
      warningFailure > 1 ||
      (warningFailure && !warnings)
    )
      return incomplete;
    const names = new Set<string>();
    let outputBytes = 0;
    if (
      data.outputAfter.length !== native.outputs.length ||
      new Set(data.outputAfter.map((o) => o.file)).size !==
        data.outputAfter.length
    )
      return incomplete;
    for (const output of native.outputs) {
      const physical = data.outputAfter.find((o) => o.file === output.file),
        source = native.sources.find((s) => s.file === output.source);
      if (
        !physical ||
        physical.sha256 !== output.sha256 ||
        physical.bytes !== output.bytes ||
        !source ||
        !snapshots.has(output.source) ||
        path.basename(output.source) !== output.sourceFile ||
        output.classMajor !== Number(config.jvmTarget) + 44 ||
        !source.primaryNames.some(
          (p) =>
            output.binaryName === p || output.binaryName.startsWith(p + "$"),
        )
      )
        return incomplete;
      const name = output.file.split(path.sep).join("/");
      if (
        names.has(name) ||
        name.startsWith("/") ||
        name.split("/").some((p) => !p || p === "." || p === "..") ||
        name !== output.binaryName.replaceAll(".", "/") + ".class"
      )
        return incomplete;
      names.add(name);
      outputBytes += output.bytes;
    }
    if (outputBytes > 64 * 1024 * 1024) return incomplete;
    if (errors) {
      if (!findings.length) return incomplete;
      return {
        status: "failed",
        reason: warningFailure
          ? "Pinned Scala 2 warning escalation failed with retained source warnings and the exact native global summary"
          : "Pinned Scala 2 compilation reported source-bound native diagnostics; failed compilation does not establish complete coverage",
        findings,
        findingsComplete: false,
      };
    }
    if (
      !native.declarations ||
      native.sources.some((s) => s.frontend !== 1 || s.complete !== 1) ||
      !native.outputs.length
    )
      return incomplete;
    return {
      status: "passed",
      reason:
        "Every selected Scala 2 source completed native typed-tree and backend observation with fresh physical class origins and no resolved suppression",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
