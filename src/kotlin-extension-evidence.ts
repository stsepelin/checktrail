import path from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { kotlinHash } from "./kotlin-archive.js";
import { kotlinReadSync } from "./kotlin-io.js";
import { kotlinConfigSchema, kotlinInvocationSchema } from "./kotlin.js";
import { validateKotlinExtensionScope } from "./kotlin-extensions.js";
import { kotlinEvidence, kotlinEvidenceSchema } from "./kotlin-evidence.js";
import {
  jvmGeneratedSchema,
  jvmGeneratedClassSchema,
} from "./jvm-workspace-extensions.js";
import {
  capturedProcessOutputSchema,
  parseCapturedProcessOutput,
} from "./process-output.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  file = z.string().min(1).max(16384);
const bytes = z
  .number()
  .int()
  .nonnegative()
  .max(1024 * 1024);
const binding = z.strictObject({ file, sha256: digest, bytes });
const source = binding.extend({
  nativeFile: file,
  nativeSha256: digest,
  nativeBytes: bytes,
});
const output = z.strictObject({
  file,
  sha256: digest,
  bytes: z
    .number()
    .int()
    .positive()
    .max(32 * 1024 * 1024),
});
const names = z.array(file).max(2000);
const javaSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runtime: z.literal("25.0.4+7-LTS"),
  vendor: z.literal("Eclipse Adoptium"),
  success: z.boolean(),
  finished: z.literal(1),
  extra: z.literal(""),
  sources: z
    .array(
      binding.extend({
        parsed: z.literal(1),
        declared: names,
        analyzed: names,
        annotations: names,
        unknownAnnotations: z.literal(0),
      }),
    )
    .min(1)
    .max(1000),
  diagnostics: z
    .array(
      z.strictObject({
        kind: z.enum([
          "ERROR",
          "WARNING",
          "MANDATORY_WARNING",
          "NOTE",
          "OTHER",
        ]),
        code: file,
        message: z
          .string()
          .min(1)
          .max(1024 * 1024),
        file: file.nullable(),
        line: z.number().int().min(-1),
        column: z.number().int().min(-1),
      }),
    )
    .max(2000),
  classes: z
    .array(
      output.extend({
        className: file,
        sourceFile: file,
        classMajor: z.number().int().min(61).max(69),
      }),
    )
    .max(4000),
});
const invocationResult = z.strictObject({
  status: z.literal(0),
  signal: z.null(),
  pid: z.number().int().positive(),
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
  stdoutSha256: digest,
  stderrSha256: digest,
  stdout: z.string().max(2 * 1024 * 1024),
  stderr: z.string().max(2 * 1024 * 1024),
});
export const kotlinExtensionEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  stagedArtifactsVerified: z.literal(true),
  requestDigest: digest,
  toolchain: file,
  snapshot: file,
  sources: z.array(source).min(1).max(2000),
  after: z.array(binding).min(1).max(2000),
  snapshotAfter: z.array(binding).min(1).max(2000),
  generated: jvmGeneratedSchema,
  payloads: z
    .array(
      z.strictObject({
        path: file,
        className: file,
        bytes: z.number().int().positive().max(131072),
        sha256: digest,
        base64: z.string().max(174764),
      }),
    )
    .max(256),
  generatedClasses: jvmGeneratedClassSchema,
  kotlin: kotlinEvidenceSchema,
  java: javaSchema.nullable(),
  javaOutputAfter: z.array(output).max(4000),
  invocations: z.array(invocationResult).min(3).max(21),
  mirrored: capturedProcessOutputSchema,
});
const same = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const requireEvidence = (valid: unknown) => {
  if (!valid) throw Error("Mixed Kotlin evidence does not reconcile");
};
export function kotlinExtensionEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Mixed Kotlin evidence lacks complete fresh source roles, generator outputs, native Java/Kotlin participation or physical class origins",
    findingsComplete: false,
  };
  if (!root || processes.length !== 1) return incomplete;
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
    return kotlinEvidence(check, processes, root);
  if (process.exitCode !== 0)
    return {
      status: "error",
      reason: "Mixed Kotlin native collection did not complete normally",
      findingsComplete: false,
    };
  try {
    const serialized = check.commands[0]!.args[2]!,
      planned = kotlinInvocationSchema.parse(JSON.parse(serialized)),
      ext = planned.config.extensions;
    requireEvidence(ext);
    if (!ext) return incomplete;
    validateKotlinExtensionScope(ext, planned.scope);
    requireEvidence(
      JSON.stringify(planned.scope) === JSON.stringify(check.scope),
    );
    const actualConfig = kotlinConfigSchema.parse(
      JSON.parse(
        kotlinReadSync(
          path.resolve(root, check.project, "checktrail.kotlin.json"),
          1024 * 1024,
        ).toString("utf8"),
      ),
    );
    requireEvidence(
      JSON.stringify(actualConfig) === JSON.stringify(planned.config),
    );
    const archive = path.resolve(root, check.project, planned.config.archive);
    requireEvidence(
      realpathSync(archive) === archive &&
        kotlinHash(kotlinReadSync(archive, 100 * 1024 * 1024)) ===
          planned.config.sha256,
    );
    for (const dependency of planned.config.classPath) {
      const file = path.resolve(root, check.project, dependency.path);
      requireEvidence(
        realpathSync(file) === file &&
          kotlinHash(kotlinReadSync(file, 32 * 1024 * 1024)) ===
            dependency.sha256,
      );
    }
    const data = kotlinExtensionEvidenceSchema.parse(
      JSON.parse(process.stdout),
    );
    requireEvidence(
      data.requestDigest === kotlinHash(serialized) &&
        path.isAbsolute(data.toolchain) &&
        path.isAbsolute(data.snapshot),
    );
    const mirror = parseCapturedProcessOutput(data.mirrored);
    requireEvidence(
      mirror.completeForObservedStreams &&
        mirror.stdout.bytes === 0 &&
        mirror.stderr.bytes === Buffer.byteLength(process.stderr) &&
        mirror.stderr.sha256 === kotlinHash(process.stderr),
    );
    let observedBytes = 0;
    for (const invocation of data.invocations) {
      requireEvidence(
        invocation.stdoutBytes === Buffer.byteLength(invocation.stdout) &&
          invocation.stderrBytes === Buffer.byteLength(invocation.stderr) &&
          invocation.stdoutSha256 === kotlinHash(invocation.stdout) &&
          invocation.stderrSha256 === kotlinHash(invocation.stderr),
      );
      observedBytes += invocation.stdoutBytes + invocation.stderrBytes;
    }
    requireEvidence(observedBytes === mirror.stderr.bytes);
    const expected = planned.scope.map((f) =>
      path.resolve(root, check.project, f),
    );
    requireEvidence(
      data.sources.length === expected.length &&
        data.after.length === expected.length &&
        data.snapshotAfter.length === expected.length,
    );
    const original = new Map<string, Buffer>();
    let total = 0;
    for (const [i, before] of data.sources.entries()) {
      requireEvidence(
        before.file === expected[i] &&
          realpathSync(before.file) === before.file &&
          before.nativeFile === path.join(data.snapshot, planned.scope[i]!),
      );
      const physical = kotlinReadSync(before.file, 1024 * 1024);
      total += physical.length;
      original.set(planned.scope[i]!, physical);
      const native = physical.subarray(
        physical.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ? 3 : 0,
      );
      requireEvidence(
        before.bytes === physical.length &&
          before.sha256 === kotlinHash(physical) &&
          before.nativeBytes === native.length &&
          before.nativeSha256 === kotlinHash(native),
      );
      for (const [after, name] of [
        [data.after[i]!, before.file],
        [data.snapshotAfter[i]!, before.nativeFile],
      ] as const)
        requireEvidence(
          after.file === name &&
            after.bytes === before.bytes &&
            after.sha256 === before.sha256,
        );
    }
    requireEvidence(total <= 32 * 1024 * 1024);
    requireEvidence(
      same(
        data.generated.map((g) => g.source),
        ext.generators.map((g) => g.source),
      ),
    );
    const payloads = new Map<string, Buffer>();
    const generatedOutputs = data.generated.flatMap((g) => g.outputs);
    requireEvidence(
      same(
        data.payloads.map((p) => p.path),
        generatedOutputs.map((p) => p.path),
      ),
    );
    let generatedBytes = 0;
    for (const generator of ext.generators) {
      const observed = data.generated.find(
        (g) => g.source === generator.source,
      )!;
      requireEvidence(
        observed.sourceSha256 === kotlinHash(original.get(generator.source)!) &&
          same(
            observed.outputs.map((o) => o.path),
            generator.outputs.map((o) => o.file),
          ),
      );
      for (const output of generator.outputs) {
        const found = observed.outputs.find((o) => o.path === output.file)!,
          payload = data.payloads.find((p) => p.path === output.file)!;
        requireEvidence(
          found.className === output.className &&
            payload.className === output.className &&
            found.bytes === payload.bytes &&
            found.sha256 === payload.sha256,
        );
        const decoded = Buffer.from(payload.base64, "base64");
        requireEvidence(
          decoded.toString("base64") === payload.base64 &&
            decoded.length === payload.bytes &&
            kotlinHash(decoded) === payload.sha256,
        );
        new TextDecoder("utf-8", { fatal: true }).decode(decoded);
        generatedBytes += decoded.length;
        payloads.set(path.resolve(root, check.project, output.file), decoded);
      }
    }
    requireEvidence(generatedBytes <= 2 * 1024 * 1024);
    const compilerScope = [
      ...planned.scope.filter((f) => /\.(kt|kts)$/.test(f)),
      ...generatedOutputs.map((o) => o.path),
    ];
    const derived = JSON.stringify({
      config: planned.config,
      scope: compilerScope,
    });
    requireEvidence(
      data.kotlin.sources.every(
        (s) =>
          s.nativeFile ===
          path.join(
            data.snapshot,
            path.relative(path.resolve(root, check.project), s.file),
          ),
      ),
    );
    requireEvidence(data.kotlin.native?.jdkHome === data.toolchain);
    const nativeOutput = parseCapturedProcessOutput(data.kotlin.nativeOutput);
    requireEvidence(
      data.invocations.filter(
        (i) =>
          i.stdoutSha256 === nativeOutput.stdout.sha256 &&
          i.stderrSha256 === nativeOutput.stderr.sha256,
      ).length === 1,
    );
    const nestedProcess = {
      ...process,
      stdout: JSON.stringify(data.kotlin),
      stderr: "",
    };
    delete nestedProcess.capturedOutput;
    const nested = kotlinEvidence(
      {
        ...check,
        scope: compilerScope,
        commands: [
          {
            ...check.commands[0]!,
            args: [check.commands[0]!.args[0]!, root, derived],
          },
        ],
      },
      [nestedProcess],
      root,
      payloads,
    );
    const findings = (nested.findings ?? []).map((f) => {
      const relative = f.file ? path.posix.relative(check.project, f.file) : "";
      const generator = ext.generators.find((g) =>
        g.outputs.some((o) => o.file === relative),
      );
      return generator
        ? {
            ruleId: f.ruleId,
            level: f.level,
            file: path.posix.join(check.project, generator.source),
            message: `${relative}:${f.line ?? "?"}: ${f.message}`,
          }
        : f;
    });
    if (nested.status !== "passed") {
      requireEvidence(
        data.java === null &&
          data.javaOutputAfter.length === 0 &&
          data.generatedClasses.length === 0,
      );
      requireEvidence(
        data.invocations.length === ext.generators.length * 2 + 3,
      );
      return { ...nested, findings };
    }
    requireEvidence(
      same(
        data.generatedClasses.map((c) => c.path),
        generatedOutputs.map((o) => o.path),
      ),
    );
    for (const output of generatedOutputs) {
      const witness = data.generatedClasses.find(
        (c) => c.path === output.path,
      )!;
      const physical = data.kotlin.outputAfter.find(
        (o) => o.file === output.className.replaceAll(".", "/") + ".class",
      );
      requireEvidence(
        witness.className === output.className &&
          witness.sourceFile === path.posix.basename(output.path) &&
          physical?.sha256 === witness.sha256 &&
          physical.bytes === witness.bytes,
      );
    }
    if (data.generatedClasses.length)
      requireEvidence(
        data.invocations.filter((i) => {
          try {
            return (
              JSON.stringify(JSON.parse(i.stdout)) ===
              JSON.stringify(data.generatedClasses)
            );
          } catch {
            return false;
          }
        }).length === 1,
      );
    requireEvidence(
      data.invocations.length ===
        ext.generators.length * 2 +
          3 +
          (ext.javaSources.length ? 1 : 0) +
          (generatedOutputs.length ? 1 : 0),
    );
    if (!ext.javaSources.length) {
      requireEvidence(data.java === null && data.javaOutputAfter.length === 0);
      return {
        ...nested,
        findings,
        reason:
          "Declared generated Kotlin and compile-only scripts completed native processing with fresh physical outputs",
      };
    }
    const java = data.java;
    requireEvidence(java);
    if (!java) return incomplete;
    requireEvidence(
      data.invocations.filter((i) => {
        try {
          return (
            !i.stderrBytes &&
            JSON.stringify(javaSchema.parse(JSON.parse(i.stdout))) ===
              JSON.stringify(java)
          );
        } catch {
          return false;
        }
      }).length === 1,
    );
    requireEvidence(
      same(
        java.sources.map((s) => s.file),
        ext.javaSources.map((f) => path.join(data.snapshot, f)),
      ),
    );
    for (const s of java.sources) {
      const relative = path.relative(data.snapshot, s.file),
        originalSource = data.sources.find((o) => o.nativeFile === s.file)!;
      requireEvidence(
        s.sha256 === originalSource.sha256 &&
          s.bytes === originalSource.bytes &&
          !s.annotations.includes("java.lang.SuppressWarnings"),
      );
      if (java.success) {
        requireEvidence(s.declared.length > 0 && same(s.analyzed, s.declared));
        for (const name of s.declared)
          requireEvidence(
            java.classes.some(
              (c) =>
                c.className === name &&
                c.sourceFile === path.basename(relative),
            ),
          );
      }
    }
    requireEvidence(
      same(
        java.classes.map((c) => c.file),
        data.javaOutputAfter.map((c) => c.file),
      ),
    );
    let classBytes = 0;
    for (const c of java.classes) {
      const physical = data.javaOutputAfter.find((o) => o.file === c.file)!;
      const owners = java.sources.filter(
        (s) =>
          path.basename(s.file) === c.sourceFile &&
          s.declared.some(
            (n) => c.className === n || c.className.startsWith(n + "$"),
          ),
      );
      requireEvidence(
        owners.length === 1 &&
          c.file === c.className.replaceAll(".", "/") + ".class" &&
          c.classMajor === Number(planned.config.jvmTarget) + 44 &&
          c.sha256 === physical.sha256 &&
          c.bytes === physical.bytes,
      );
      classBytes += c.bytes;
    }
    requireEvidence(classBytes <= 64 * 1024 * 1024);
    let errors = 0,
      warnings = 0,
      globalWarnings = 0;
    for (const d of java.diagnostics) {
      requireEvidence(
        ["ERROR", "WARNING", "MANDATORY_WARNING"].includes(d.kind),
      );
      if (d.kind === "ERROR") errors++;
      else warnings++;
      if (
        d.file === null ||
        (d.kind === "ERROR" && d.code === "compiler.err.warnings.and.werror")
      ) {
        requireEvidence(
          d.kind === "ERROR" &&
            planned.config.warningsAsErrors &&
            d.code === "compiler.err.warnings.and.werror" &&
            d.line === -1 &&
            d.column === -1 &&
            (d.file === null ||
              ext.javaSources.includes(
                path.relative(data.snapshot, d.file).split(path.sep).join("/"),
              )),
        );
        globalWarnings++;
        continue;
      }
      const relative = path
        .relative(data.snapshot, d.file)
        .split(path.sep)
        .join("/");
      requireEvidence(ext.javaSources.includes(relative));
      const lines = new TextDecoder("utf-8", { fatal: true })
        .decode(original.get(relative)!)
        .replace(/\r\n?/g, "\n")
        .split("\n");
      requireEvidence(
        d.line >= 1 &&
          d.line <= lines.length &&
          d.column >= 1 &&
          d.column <= lines[d.line - 1]!.length + 1,
      );
      findings.push({
        ruleId: "javac/" + d.code,
        level: d.kind === "ERROR" ? "error" : "warning",
        message: d.message,
        file: path.posix.join(check.project, relative),
        line: d.line,
      } satisfies Finding);
    }
    requireEvidence(
      globalWarnings <= 1 &&
        (!globalWarnings || warnings > 0) &&
        java.success === (errors === 0),
    );
    if (!java.success) {
      requireEvidence(
        findings.some((f) => f.level === "error") ||
          (globalWarnings === 1 && warnings > 0),
      );
      return {
        status: "failed",
        reason:
          "Native Java compilation against fresh Kotlin classes reported selected-source diagnostics",
        findings,
        findingsComplete: false,
      };
    }
    return {
      status: "passed",
      reason:
        "Every declared Java/Kotlin source and compile-only script completed native participation with fresh generated sources and physical class origins",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}

export function selectedKotlinEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
) {
  try {
    const planned = kotlinInvocationSchema.parse(
      JSON.parse(check.commands[0]!.args[2]!),
    );
    return planned.config.extensions
      ? kotlinExtensionEvidence(check, processes, root)
      : kotlinEvidence(check, processes, root);
  } catch {
    return kotlinEvidence(check, processes, root);
  }
}
