import path from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { z } from "zod";
import {
  detektEvidence,
  detektEvidenceSchema,
  detektNativeSchema,
} from "./detekt-evidence.js";
import { detektConfigSchema, detektInvocationSchema } from "./detekt.js";
import {
  detektFullConfigFile,
  validateDetektFullScope,
} from "./detekt-extensions.js";
import {
  detektFullRules,
  detektFullSdkModules,
} from "./detekt-extensions-artifacts.js";
import { detektHash } from "./detekt-configuration.js";
import { detektArtifacts } from "./detekt-artifacts.js";
import { kotlinReadSync } from "./kotlin-io.js";
import { kotlinArtifacts } from "./kotlin-artifacts.js";
import { kotlinJar } from "./kotlin-jar.js";
import { jvmToolchainPins } from "./jvm-toolchain-pins.js";
import {
  capturedProcessOutputSchema,
  parseCapturedProcessOutput,
} from "./process-output.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";
const file = z.string().min(1).max(16384),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const typedSource = z.strictObject({
  file,
  visits: z.literal(1),
  languageVersion: z.literal("2.4"),
  apiVersion: z.literal("2.4"),
  roots: z.array(file).min(1).max(129),
  sdk: z.array(file).min(1).max(128),
  declarations: z.number().int().min(0).max(2000),
  symbols: z.array(z.string().min(1).max(128)).max(2000),
  annotations: z.array(file).max(2000),
  unknownAnnotations: z.number().int().min(0).max(2000),
  diagnostics: z
    .array(
      z.strictObject({
        code: file,
        severity: z.enum(["ERROR", "WARNING", "INFO"]),
        message: z.string().min(1).max(65536),
        line: z.number().int().positive(),
        column: z.number().int().positive(),
      }),
    )
    .max(2000),
});
const native = detektNativeSchema.extend({
  rules: detektNativeSchema.shape.rules.element
    .extend({ className: file, requiresAnalysisApi: z.boolean(), origin: file })
    .array()
    .min(1)
    .max(512),
  typed: typedSource.array().min(1).max(2000),
});
const invocation = z.strictObject({
  status: z.number().int().min(0).max(2),
  signal: z.null(),
  pid: z.number().int().positive(),
  stdoutBytes: z
    .number()
    .int()
    .min(0)
    .max(2 * 1024 * 1024),
  stderrBytes: z
    .number()
    .int()
    .min(0)
    .max(2 * 1024 * 1024),
  stdoutSha256: digest,
  stderrSha256: digest,
  stdout: z.string().max(2 * 1024 * 1024),
  stderr: z.string().max(2 * 1024 * 1024),
});
export const detektExtensionsEvidenceSchema = detektEvidenceSchema.extend({
  native: native.nullable(),
  snapshot: file,
  jdkHome: file,
  classPath: file.array().min(1).max(129),
  dependencies: z
    .array(
      z.strictObject({
        file,
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
        sha256: digest,
        nativeFile: file,
      }),
    )
    .max(128),
  projectConfiguration: z.strictObject({
    file,
    bytes: z
      .number()
      .int()
      .positive()
      .max(100 * 1024),
    sha256: digest,
  }),
  stagedArtifactsVerified: z.literal(true),
  invocations: invocation.array().length(3),
  mirrored: capturedProcessOutputSchema,
});
const requireEvidence = (valid: unknown) => {
  if (!valid) throw Error("Full detekt evidence does not reconcile");
};
const same = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
function physical(
  file: string,
  maximum: number,
  pin: { bytes?: number; sha256: string },
) {
  requireEvidence(path.isAbsolute(file) && realpathSync(file) === file);
  const bytes = kotlinReadSync(file, maximum);
  requireEvidence(
    (pin.bytes === undefined || pin.bytes === bytes.length) &&
      detektHash(bytes) === pin.sha256,
  );
  return bytes;
}
export function detektExtensionsEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Full detekt evidence lacks fresh native type, classpath, rule provenance, source participation or diagnostic accounting",
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
  if (process.exitCode === 3 && !process.stderr)
    return detektEvidence(check, processes, root);
  if (process.exitCode !== 0)
    return {
      status: "error",
      reason: "Full detekt native collection did not complete normally",
      findingsComplete: false,
    };
  try {
    const serialized = check.commands[0]!.args[2]!;
    const planned = detektInvocationSchema.parse(JSON.parse(serialized));
    requireEvidence(
      planned.config.profile === "core-default-full-all-selected-v1",
    );
    if (planned.config.profile !== "core-default-full-all-selected-v1")
      return incomplete;
    validateDetektFullScope(check.scope);
    requireEvidence(
      JSON.stringify(planned.scope) === JSON.stringify(check.scope),
    );
    const current = detektConfigSchema.parse(
      JSON.parse(
        kotlinReadSync(
          detektFullConfigFile(root, check.project),
          1024 * 1024,
        ).toString("utf8"),
      ),
    );
    requireEvidence(JSON.stringify(current) === JSON.stringify(planned.config));
    physical(
      path.resolve(root, check.project, planned.config.jar),
      detektArtifacts.jarBytes,
      { bytes: detektArtifacts.jarBytes, sha256: planned.config.sha256 },
    );
    physical(
      path.resolve(root, check.project, planned.config.types.kotlinArchive),
      kotlinArtifacts.archiveBytes,
      {
        bytes: kotlinArtifacts.archiveBytes,
        sha256: planned.config.types.kotlinSha256,
      },
    );
    const data = detektExtensionsEvidenceSchema.parse(
      JSON.parse(process.stdout),
    );
    requireEvidence(
      data.projectConfiguration.file ===
        detektFullConfigFile(root, check.project),
    );
    physical(
      data.projectConfiguration.file,
      100 * 1024,
      data.projectConfiguration,
    );
    requireEvidence(
      data.requestDigest === detektHash(serialized) &&
        path.isAbsolute(data.snapshot) &&
        path.basename(data.snapshot) === "snapshot" &&
        path.isAbsolute(data.jdkHome) &&
        data.warningJarUrl ===
          pathToFileURL(
            path.join(path.dirname(data.snapshot), "detekt.jar"),
          ).href.replace(/^file:\/\/\//, "file:/"),
    );
    for (const pin of jvmToolchainPins)
      physical(path.join(data.jdkHome, pin.path), pin.bytes, pin);
    const observed = data.native;
    requireEvidence(observed && observed.notifications.length === 0);
    if (!observed) return incomplete;
    const rules = observed.rules.map(({ origin, ...r }) => {
      requireEvidence(origin === data.warningJarUrl);
      return r;
    });
    requireEvidence(JSON.stringify(rules) === JSON.stringify(detektFullRules));
    requireEvidence(
      same(data.classPath, [
        path.join(path.dirname(data.snapshot), "libraries/kotlin-stdlib.jar"),
        ...data.dependencies.map((d) => d.nativeFile),
      ]),
    );
    requireEvidence(
      data.dependencies.length === planned.config.types.classPath.length,
    );
    let dependencyBytes = 0;
    for (const [i, d] of data.dependencies.entries()) {
      const expected = planned.config.types.classPath[i]!;
      requireEvidence(
        d.file === path.resolve(root, check.project, expected.path) &&
          d.sha256 === expected.sha256 &&
          d.nativeFile ===
            path.join(
              path.dirname(data.snapshot),
              "dependencies",
              String(i),
              "dependency.jar",
            ),
      );
      const bytes = physical(d.file, 32 * 1024 * 1024, d);
      dependencyBytes += bytes.length;
      requireEvidence(kotlinJar(bytes).classPath.length === 0);
    }
    requireEvidence(dependencyBytes <= 64 * 1024 * 1024);
    const expected = check.scope.map((f) =>
      path.resolve(root, check.project, f),
    );
    requireEvidence(
      data.sources.length === expected.length &&
        data.after.length === expected.length &&
        observed.sources.length === expected.length &&
        observed.typed.length === expected.length,
    );
    const texts = new Map<string, string[]>(),
      snapshotFiles = new Set<string>();
    let sourceBytes = 0,
      typeErrors = 0;
    const findings: Finding[] = [];
    for (const [i, before] of data.sources.entries()) {
      requireEvidence(
        before.file === expected[i] &&
          before.nativeFile === path.join(data.snapshot, check.scope[i]!),
      );
      const bytes = physical(before.file, 1024 * 1024, before);
      sourceBytes += bytes.length;
      const text = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .replace(/\r\n?/g, "\n");
      requireEvidence(detektHash(text) === before.canonicalSha256);
      const lines = text.split("\n");
      texts.set(before.file, lines);
      snapshotFiles.add(before.nativeFile);
      const after = data.after[i]!,
        s = observed.sources[i]!,
        typed = observed.typed[i]!;
      requireEvidence(
        after.file === before.file &&
          after.sha256 === before.sha256 &&
          after.bytes === before.bytes &&
          s.file === before.nativeFile &&
          s.physicalBefore === before.sha256 &&
          s.physicalAfter === before.sha256 &&
          s.psiSha256 === before.canonicalSha256 &&
          s.syntaxErrors === 0 &&
          s.excluded.length === 0 &&
          s.suppressed.length === 0,
      );
      requireEvidence(
        typed.file === before.nativeFile &&
          typed.declarations > 0 &&
          typed.symbols.length === typed.declarations &&
          typed.symbols.every((s) => s === "SOURCE") &&
          typed.unknownAnnotations === 0 &&
          !typed.annotations.includes("kotlin.Suppress"),
      );
      requireEvidence(
        same(typed.roots, data.classPath) &&
          same(
            typed.sdk,
            detektFullSdkModules.map((m) => data.jdkHome + "!/" + m),
          ),
      );
      for (const d of typed.diagnostics) {
        requireEvidence(
          d.line <= lines.length && d.column <= lines[d.line - 1]!.length + 1,
        );
        if (d.severity === "ERROR") typeErrors++;
        findings.push({
          ruleId: "kotlin/" + d.code,
          level:
            d.severity === "ERROR"
              ? "error"
              : d.severity === "WARNING"
                ? "warning"
                : "note",
          message: d.message,
          file: path.relative(root, before.file).split(path.sep).join("/"),
          line: d.line,
        });
      }
    }
    requireEvidence(sourceBytes <= 32 * 1024 * 1024 && typeErrors <= 2000);
    const events = observed.events;
    requireEvidence(
      events.length === expected.length * 2 + 2 &&
        events[0]!.kind === "analysis-started" &&
        events[0]!.file === null &&
        events.at(-1)!.kind === "analysis-finished" &&
        events.at(-1)!.file === null,
    );
    const started = new Set<string>(),
      finished = new Set<string>();
    for (const e of events.slice(1, -1)) {
      requireEvidence(e.file && snapshotFiles.has(e.file));
      if (!e.file) return incomplete;
      if (e.kind === "file-started") {
        requireEvidence(!started.has(e.file));
        started.add(e.file);
      } else {
        requireEvidence(
          e.kind === "file-finished" &&
            started.has(e.file) &&
            !finished.has(e.file),
        );
        finished.add(e.file);
      }
    }
    requireEvidence(
      started.size === expected.length && finished.size === expected.length,
    );
    const consoleLines: string[] = [];
    for (const issue of observed.findings) {
      const index = check.scope.indexOf(issue.file.split(path.sep).join("/"));
      requireEvidence(index >= 0 && issue.suppressionReasons.length === 0);
      const source = data.sources[index]!,
        lines = texts.get(source.file)!;
      const rule = observed.rules.find(
        (r) => r.set === issue.set && r.id === issue.id,
      );
      requireEvidence(
        rule?.active &&
          rule.severity === issue.severity &&
          issue.line <= lines.length &&
          issue.column <= lines[issue.line - 1]!.length + 1,
      );
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
    const warnings =
      [
        "WARNING: A terminally deprecated method in sun.misc.Unsafe has been called",
        `WARNING: sun.misc.Unsafe::objectFieldOffset has been called by com.github.benmanes.caffeine.cache.UnsafeAccess (${data.warningJarUrl})`,
        "WARNING: Please consider reporting this to the maintainers of class com.github.benmanes.caffeine.cache.UnsafeAccess",
        "WARNING: sun.misc.Unsafe::objectFieldOffset will be removed in a future release",
      ].join("\n") + "\n";
    const console =
      (typeErrors
        ? `There were ${typeErrors} compiler errors found during analysis. This affects accuracy of reporting.\nRun detekt CLI with --debug or set \`detekt { debug = true }\` in Gradle to see the error messages.\n`
        : "") +
      (observed.findings.length
        ? consoleLines.join("") +
          `\nAnalysis failed with ${observed.findings.length} issues.\n`
        : "");
    const output = parseCapturedProcessOutput(data.nativeOutput),
      mirror = parseCapturedProcessOutput(data.mirrored);
    requireEvidence(
      output.completeForObservedStreams &&
        mirror.completeForObservedStreams &&
        mirror.stdout.bytes === 0 &&
        mirror.stderr.bytes === Buffer.byteLength(process.stderr) &&
        mirror.stderr.sha256 === detektHash(process.stderr) &&
        !data.nativeSignal &&
        !data.nativeError,
    );
    requireEvidence(
      Buffer.from(output.stdout.base64, "base64")
        .toString("utf8")
        .replace(/\r\n/g, "\n") === console &&
        Buffer.from(output.stderr.base64, "base64")
          .toString("utf8")
          .replace(/\r\n/g, "\n") === warnings &&
        data.nativeExit === (observed.findings.length ? 2 : 0),
    );
    let nativeBytes = 0;
    for (const [i, invocation] of data.invocations.entries()) {
      requireEvidence(
        invocation.stdoutBytes === Buffer.byteLength(invocation.stdout) &&
          invocation.stderrBytes === Buffer.byteLength(invocation.stderr) &&
          invocation.stdoutSha256 === detektHash(invocation.stdout) &&
          invocation.stderrSha256 === detektHash(invocation.stderr),
      );
      nativeBytes += invocation.stdoutBytes + invocation.stderrBytes;
      if (i < 2)
        requireEvidence(
          invocation.status === 0 &&
            !invocation.stdoutBytes &&
            !invocation.stderrBytes,
        );
      else
        requireEvidence(
          invocation.status === data.nativeExit &&
            invocation.stdoutSha256 === output.stdout.sha256 &&
            invocation.stderrSha256 === output.stderr.sha256,
        );
    }
    requireEvidence(
      nativeBytes === mirror.stderr.bytes && nativeBytes <= 2 * 1024 * 1024,
    );
    return {
      status: typeErrors || observed.findings.length ? "failed" : "passed",
      reason: typeErrors
        ? "Native Kotlin type diagnostics make detekt rule analysis incomplete"
        : observed.findings.length
          ? "Pinned full detekt rules reported selected-source findings"
          : "Every selected source completed native type analysis and the pinned full rule plan with current classpath and rule origins",
      findings,
      findingsComplete: typeErrors === 0,
    };
  } catch {
    return incomplete;
  }
}
export function selectedDetektEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
) {
  try {
    const request = detektInvocationSchema.parse(
      JSON.parse(check.commands[0]!.args[2]!),
    );
    return request.config.profile === "core-default-full-all-selected-v1"
      ? detektExtensionsEvidence(check, processes, root)
      : detektEvidence(check, processes, root);
  } catch {
    return detektEvidence(check, processes, root);
  }
}
