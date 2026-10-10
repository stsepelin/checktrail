import path from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { scalaHash } from "./scala-archive.js";
import { kotlinReadSync } from "./kotlin-io.js";
import { scalaConfigSchema, scalaInvocationSchema } from "./scala.js";
import { scalaArtifacts } from "./scala-artifacts.js";
import {
  validateScalaExtensionScope,
  scalaScriptSource,
} from "./scala-extensions.js";
import { scalaEvidence, scalaEvidenceSchema } from "./scala-evidence.js";
import {
  jvmGeneratedSchema,
  jvmGeneratedClassSchema,
} from "./jvm-workspace-extensions.js";
import { jvmToolchainPins } from "./jvm-toolchain-pins.js";
import {
  capturedProcessOutputSchema,
  parseCapturedProcessOutput,
} from "./process-output.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  file = z.string().min(1).max(16384),
  bytes = z
    .number()
    .int()
    .nonnegative()
    .max(1024 * 1024);
const binding = z.strictObject({ file, sha256: digest, bytes }),
  source = binding.extend({ nativeFile: file }),
  output = z.strictObject({
    file,
    sha256: digest,
    bytes: z
      .number()
      .int()
      .positive()
      .max(32 * 1024 * 1024),
  }),
  names = z.array(file).max(2000);
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
export const scalaExtensionEvidenceSchema = z.strictObject({
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
  stages: z
    .array(
      z.strictObject({ id: file, output: file, evidence: scalaEvidenceSchema }),
    )
    .min(1)
    .max(8),
  java: javaSchema.nullable(),
  javaOutputAfter: z.array(output).max(4000),
  invocations: z.array(invocationResult).min(3).max(28),
  mirrored: capturedProcessOutputSchema,
});
const same = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const requireEvidence = (valid: unknown) => {
  if (!valid) throw Error("Mixed Scala evidence does not reconcile");
};
export function scalaExtensionEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Mixed Scala evidence lacks complete fresh source roles, ordered stage participation, generator output or native Java and class/TASTy origins",
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
    return scalaEvidence(check, processes, root);
  if (process.exitCode !== 0)
    return {
      status: "error",
      reason: "Mixed Scala native collection did not complete normally",
      findingsComplete: false,
    };
  try {
    const serialized = check.commands[0]!.args[2]!,
      planned = scalaInvocationSchema.parse(JSON.parse(serialized));
    if (
      planned.config.profile !== scalaArtifacts.profile ||
      !planned.config.extensions
    )
      return incomplete;
    const ext = planned.config.extensions,
      roles = validateScalaExtensionScope(ext, planned.scope);
    requireEvidence(
      JSON.stringify(planned.scope) === JSON.stringify(check.scope),
    );
    const actualConfig = scalaConfigSchema.parse(
      JSON.parse(
        kotlinReadSync(
          path.resolve(root, check.project, "checktrail.scala.json"),
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
        scalaHash(kotlinReadSync(archive, scalaArtifacts.archiveBytes)) ===
          planned.config.sha256,
    );
    for (const dep of planned.config.classPath) {
      const file = path.resolve(root, check.project, dep.path);
      requireEvidence(
        realpathSync(file) === file &&
          scalaHash(kotlinReadSync(file, 32 * 1024 * 1024)) === dep.sha256,
      );
    }
    const data = scalaExtensionEvidenceSchema.parse(JSON.parse(process.stdout));
    requireEvidence(
      data.requestDigest === scalaHash(serialized) &&
        path.isAbsolute(data.toolchain) &&
        realpathSync(data.toolchain) === data.toolchain &&
        path.isAbsolute(data.snapshot),
    );
    for (const pin of jvmToolchainPins) {
      const file = path.join(data.toolchain, pin.path),
        bytes = kotlinReadSync(file, pin.bytes + 1);
      requireEvidence(
        bytes.length === pin.bytes && scalaHash(bytes) === pin.sha256,
      );
    }
    const mirror = parseCapturedProcessOutput(data.mirrored);
    requireEvidence(
      mirror.completeForObservedStreams &&
        mirror.stdout.bytes === 0 &&
        mirror.stderr.bytes === Buffer.byteLength(process.stderr) &&
        mirror.stderr.sha256 === scalaHash(process.stderr),
    );
    let observedBytes = 0;
    for (const i of data.invocations) {
      requireEvidence(
        i.stdoutBytes === Buffer.byteLength(i.stdout) &&
          i.stderrBytes === Buffer.byteLength(i.stderr) &&
          i.stdoutSha256 === scalaHash(i.stdout) &&
          i.stderrSha256 === scalaHash(i.stderr),
      );
      observedBytes += i.stdoutBytes + i.stderrBytes;
    }
    requireEvidence(observedBytes === mirror.stderr.bytes);
    const expected = planned.scope.map((f) =>
        path.resolve(root, check.project, f),
      ),
      original = new Map<string, Buffer>();
    requireEvidence(
      data.sources.length === expected.length &&
        data.after.length === expected.length &&
        data.snapshotAfter.length === expected.length,
    );
    let sourceBytes = 0;
    for (const [i, b] of data.sources.entries()) {
      const f = planned.scope[i]!,
        physical = kotlinReadSync(expected[i]!, 1024 * 1024),
        staged = path.join(data.snapshot, f),
        after = data.after[i]!,
        snapshot = data.snapshotAfter[i]!;
      requireEvidence(
        b.file === expected[i] &&
          realpathSync(b.file) === b.file &&
          b.nativeFile === staged &&
          b.bytes === physical.length &&
          b.sha256 === scalaHash(physical) &&
          after.file === b.file &&
          after.bytes === b.bytes &&
          after.sha256 === b.sha256 &&
          snapshot.file === staged &&
          snapshot.bytes === b.bytes &&
          snapshot.sha256 === b.sha256,
      );
      new TextDecoder("utf-8", { fatal: true }).decode(physical);
      sourceBytes += physical.length;
      original.set(f, physical);
    }
    requireEvidence(sourceBytes <= 32 * 1024 * 1024);
    requireEvidence(
      same(
        data.generated.map((g) => g.source),
        ext.generators.map((g) => g.source),
      ) &&
        same(
          data.payloads.map((p) => p.path),
          roles.generated,
        ),
    );
    const payloads = new Map<string, Buffer>();
    let generatedBytes = 0;
    for (const g of ext.generators) {
      const native = data.generated.find((x) => x.source === g.source)!;
      requireEvidence(
        native.sourceSha256 === scalaHash(original.get(g.source)!) &&
          same(
            native.outputs.map((o) => o.path),
            g.outputs.map((o) => o.file),
          ),
      );
      for (const o of g.outputs) {
        const p = data.payloads.find((x) => x.path === o.file)!,
          binding = native.outputs.find((x) => x.path === o.file)!,
          decoded = Buffer.from(p.base64, "base64");
        requireEvidence(
          p.className === o.className &&
            binding.className === o.className &&
            p.sha256 === binding.sha256 &&
            p.bytes === binding.bytes &&
            decoded.length === p.bytes &&
            decoded.toString("base64") === p.base64 &&
            scalaHash(decoded) === p.sha256,
        );
        new TextDecoder("utf-8", { fatal: true }).decode(decoded);
        generatedBytes += decoded.length;
        payloads.set(path.resolve(root, check.project, o.file), decoded);
      }
    }
    requireEvidence(generatedBytes <= 2 * 1024 * 1024);
    const compiler = new Map<string, Buffer>(),
      nativeFiles = new Map<string, string>();
    for (const f of roles.compilerSources) {
      const bytes =
        payloads.get(path.resolve(root, check.project, f)) ?? original.get(f)!;
      requireEvidence(bytes);
      const script = ext.scripts.find((s) => s.file === f),
        wrapped = script ? scalaScriptSource(script, bytes) : null;
      compiler.set(
        path.resolve(root, check.project, f),
        wrapped?.bytes ?? bytes,
      );
      nativeFiles.set(f, path.join(data.snapshot, wrapped?.file ?? f));
    }
    const findings: Finding[] = [];
    const seenOutputs = new Set<string>();
    const allOutputs = [
      ...data.stages.flatMap((s) => s.evidence.outputAfter),
      ...data.javaOutputAfter,
    ];
    requireEvidence(
      allOutputs.length <= 4001 &&
        allOutputs.reduce((sum, o) => sum + o.bytes, 0) <= 64 * 1024 * 1024,
    );
    requireEvidence(data.stages.length <= ext.stages.length);
    for (const [i, stage] of data.stages.entries()) {
      const expectedStage = ext.stages[i]!;
      requireEvidence(
        stage.id === expectedStage.id &&
          stage.output ===
            path.join(path.dirname(data.snapshot), "stage-" + stage.id),
      );
      requireEvidence(
        stage.evidence.sources.every(
          (s) =>
            s.nativeFile ===
            nativeFiles.get(
              path
                .relative(path.resolve(root, check.project), s.file)
                .split(path.sep)
                .join("/"),
            ),
        ),
      );
      const derived = JSON.stringify({
          config: planned.config,
          scope: expectedStage.sources,
        }),
        nestedProcess = {
          ...process,
          stdout: JSON.stringify(stage.evidence),
          stderr: "",
        };
      delete nestedProcess.capturedOutput;
      const raw = parseCapturedProcessOutput(stage.evidence.nativeOutput);
      requireEvidence(
        data.invocations.filter(
          (x) =>
            x.stdoutSha256 === raw.stdout.sha256 &&
            x.stderrSha256 === raw.stderr.sha256,
        ).length === 1,
      );
      const nested = scalaEvidence(
        {
          ...check,
          scope: expectedStage.sources,
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
        compiler,
      );
      for (const f of nested.findings ?? []) {
        const relative = f.file
            ? path.posix.relative(check.project, f.file)
            : "",
          script = ext.scripts.find((s) => s.file === relative),
          generator = ext.generators.find((g) =>
            g.outputs.some((o) => o.file === relative),
          );
        if (generator)
          findings.push({
            ruleId: f.ruleId,
            level: f.level,
            file: path.posix.join(check.project, generator.source),
            message: `${relative}:${f.line ?? "?"}: ${f.message}`,
          });
        else if (script) {
          const offset = scalaScriptSource(
            script,
            original.get(relative)!,
          ).lineOffset;
          requireEvidence(f.line !== undefined && f.line > offset);
          findings.push({ ...f, line: f.line! - offset });
        } else findings.push(f);
      }
      for (const output of stage.evidence.native?.outputs ?? []) {
        requireEvidence(!seenOutputs.has(output.file));
        seenOutputs.add(output.file);
      }
      if (nested.status !== "passed") {
        if (nested.status === "failed")
          requireEvidence(
            i === data.stages.length - 1 &&
              data.java === null &&
              data.javaOutputAfter.length === 0 &&
              data.generatedClasses.length === 0 &&
              data.invocations.length ===
                2 + ext.generators.length * 2 + data.stages.length,
          );
        return { ...nested, findings };
      }
    }
    requireEvidence(
      data.stages.length === ext.stages.length &&
        same(
          data.generatedClasses.map((c) => c.path),
          roles.generated,
        ),
    );
    for (const p of data.payloads) {
      const stage = data.stages.find((s) =>
          ext.stages.find((x) => x.id === s.id)!.sources.includes(p.path),
        )!,
        witness = data.generatedClasses.find((c) => c.path === p.path)!,
        physical = stage.evidence.outputAfter.find(
          (c) => c.file === p.className.replaceAll(".", "/") + ".class",
        );
      requireEvidence(
        witness.className === p.className &&
          witness.sourceFile === path.posix.basename(p.path) &&
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
        2 +
          ext.generators.length * 2 +
          ext.stages.length +
          (ext.javaSources.length ? 1 : 0) +
          (roles.generated.length ? 1 : 0),
    );
    if (!ext.javaSources.length) {
      requireEvidence(data.java === null && data.javaOutputAfter.length === 0);
      return {
        status: "passed",
        reason:
          "Every declared Scala stage and compile-only script completed native typed-tree, class and TASTy output participation with fresh inputs",
        findings,
        findingsComplete: true,
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
      requireEvidence(!seenOutputs.has(c.file));
      seenOutputs.add(c.file);
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
      if (d.file === null) {
        requireEvidence(
          d.kind === "ERROR" &&
            planned.config.warningsAsErrors &&
            d.code === "compiler.err.warnings.and.werror" &&
            d.line === -1 &&
            d.column === -1,
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
          "Native Java compilation against fresh Scala classes reported selected-source diagnostics",
        findings,
        findingsComplete: false,
      };
    }
    return {
      status: "passed",
      reason:
        "Every declared Java/Scala source and compile-only script completed native participation with fresh generated sources and physical class origins",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
