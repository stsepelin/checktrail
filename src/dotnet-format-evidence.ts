import path from "node:path";
import { z } from "zod";
import {
  dotnetBuildEvidence,
  dotnetBuildPacketSchema,
} from "./dotnet-build-evidence.js";
import { dotnetBuildInvocationSchema } from "./dotnet-build.js";
import { dotnetFormatNativeSource } from "./dotnet-format-native.js";
import { mavenHash } from "./maven.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  file = z.string().min(1).max(8192),
  guid = z.string().uuid();
const document = z.strictObject({
  file,
  documentId: guid,
  sourceBytes: z
    .number()
    .int()
    .nonnegative()
    .max(4 * 1024 * 1024),
  sourceSha256: digest,
  utf8Bom: z.boolean(),
  selected: z.boolean(),
  text: z.string().max(65536).nullable(),
  formatting: z.strictObject({
    tabSize: z.number().int().min(1).max(32),
    indentationSize: z.number().int().min(1).max(32),
    useTabs: z.boolean(),
    newLine: z.enum(["\n", "\r\n", "\r"]),
  }),
  changes: z
    .array(
      z.strictObject({
        start: z.number().int().nonnegative().max(65536),
        length: z.number().int().nonnegative().max(65536),
        newText: z.string().max(65536),
        line: z.number().int().positive(),
        column: z.number().int().positive(),
      }),
    )
    .max(4096),
  beforeSha256: digest,
  afterSha256: digest,
  changed: z.boolean(),
});
export const dotnetFormatDocumentsSchema = z.strictObject({
  processId: z.number().int().positive(),
  runtime: z.literal("10.0.12"),
  helperSha256: digest,
  workspaceAssembly: file,
  formatterAssembly: file,
  failures: z.array(z.string().max(65536)).max(1024),
  projects: z
    .array(
      z.strictObject({
        file,
        projectId: guid,
        language: z.enum(["C#", "Visual Basic"]),
        documents: z.array(document).min(1).max(4096),
      }),
    )
    .min(1)
    .max(64),
  complete: z.literal(true),
});
export const dotnetFormatReportSchema = z
  .array(
    z.strictObject({
      DocumentId: z.strictObject({
        ProjectId: z.strictObject({ Id: guid }),
        Id: guid,
      }),
      FileName: file,
      FilePath: file,
      FileChanges: z
        .array(
          z.strictObject({
            LineNumber: z.number().int().positive(),
            CharNumber: z.number().int().positive(),
            DiagnosticId: z.literal("WHITESPACE"),
            FormatDescription: z.string().min(1).max(65536),
          }),
        )
        .min(1)
        .max(4096),
    }),
  )
  .max(4096);
export const dotnetFormatPacketSchema = z.strictObject({
  version: z.literal(1),
  build: dotnetBuildPacketSchema,
  format: z
    .strictObject({
      observerDirectory: file,
      observerSourceSha256: digest,
      observerSha256: digest,
      documentLauncherPid: z.number().int().positive(),
      documents: z.string().max(1024 * 1024),
      formatterExitCode: z.number().int().min(0).max(255),
      formatterStdout: z.string().max(1024 * 1024),
      formatterStderr: z.string().max(1024 * 1024),
      report: z.string().max(1024 * 1024),
    })
    .nullable(),
  nativeReceipts: dotnetBuildPacketSchema.shape.nativeReceipts,
});
function requireEvidence(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
const same = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
function position(text: string, offset: number) {
  const prefix = text.slice(0, offset),
    lines = prefix.split(/\r\n|\r|\n/);
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}
export function dotnetFormatEvidence(
  check: Check,
  processes: ProcessResult[],
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    findingsComplete: false,
    reason:
      ".NET whitespace formatting does not reconcile fresh compilation, every native document, pinned edits and SDK reports",
  };
  if (processes.length !== 1) return incomplete;
  const process = processes[0]!;
  if (process.exitCode !== 0) return dotnetBuildEvidence(check, processes);
  let retainedFailures: Finding[] = [];
  try {
    const raw = JSON.parse(process.stdout);
    if (raw.prerequisiteFailure) return dotnetBuildEvidence(check, processes);
    const data = dotnetFormatPacketSchema.parse(raw),
      built = dotnetBuildEvidence(check, [
        { ...process, stdout: JSON.stringify(data.build) },
      ]);
    if (built.status !== "passed") return built;
    requireEvidence(data.format, "Native formatting phase reached");
    const f = data.format,
      observed = dotnetFormatDocumentsSchema.parse(JSON.parse(f.documents)),
      invocation = dotnetBuildInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      );
    requireEvidence(
      invocation.config.projects.every((p) => p.language !== "fsharp"),
      "Native formatter language applicability",
    );
    requireEvidence(
      f.observerSourceSha256 === mavenHash(dotnetFormatNativeSource) &&
        f.observerSha256 === observed.helperSha256 &&
        f.documentLauncherPid === observed.processId,
      "Pinned original native observer and actual process",
    );
    requireEvidence(
      f.observerDirectory ===
        path.join(path.dirname(data.build.workspace), "observer/format") &&
        observed.workspaceAssembly ===
          path.join(
            f.observerDirectory,
            "Microsoft.CodeAnalysis.Workspaces.MSBuild.dll",
          ) &&
        observed.formatterAssembly ===
          path.join(
            f.observerDirectory,
            "Microsoft.CodeAnalysis.Workspaces.dll",
          ),
      "Selected native formatter assemblies",
    );
    requireEvidence(
      observed.failures.length === 0,
      "No hidden native workspace errors",
    );
    const phases = [
      ...data.build.nativeReceipts.map((r) => r.phase),
      "format-observer-compile",
      "format-documents",
      "format-whitespace",
    ];
    requireEvidence(
      JSON.stringify(data.nativeReceipts.map((r) => r.phase)) ===
        JSON.stringify(phases) &&
        JSON.stringify(
          data.nativeReceipts.slice(0, data.build.nativeReceipts.length),
        ) === JSON.stringify(data.build.nativeReceipts),
      "Exact ordered native formatting call closure",
    );
    const compile = data.nativeReceipts.at(-3)!,
      documents = data.nativeReceipts.at(-2)!,
      formatted = data.nativeReceipts.at(-1)!;
    requireEvidence(
      compile.exitCode === 0 &&
        compile.stdoutBytes === 0 &&
        compile.stderrBytes === 0 &&
        compile.stdoutSha256 === mavenHash("") &&
        compile.stderrSha256 === mavenHash(""),
      "Original observer compiled without diagnostics",
    );
    requireEvidence(
      documents.exitCode === 0 &&
        documents.stderrBytes === 0 &&
        documents.stderrSha256 === mavenHash("") &&
        documents.stdoutBytes === Buffer.byteLength(f.documents) &&
        documents.stdoutSha256 === mavenHash(f.documents),
      "Exact native document output binding",
    );
    requireEvidence(
      formatted.exitCode === f.formatterExitCode &&
        formatted.stdoutBytes === Buffer.byteLength(f.formatterStdout) &&
        formatted.stderrBytes === Buffer.byteLength(f.formatterStderr) &&
        formatted.stdoutSha256 === mavenHash(f.formatterStdout) &&
        formatted.stderrSha256 === mavenHash(f.formatterStderr) &&
        data.nativeReceipts.reduce(
          (n, r) => n + r.stdoutBytes + r.stderrBytes,
          0,
        ) <=
          8 * 1024 * 1024,
      "Exact bounded formatter call output binding",
    );
    for (const name of [
      "dotnet-format.dll",
      "dotnet-format.deps.json",
      "dotnet-format.runtimeconfig.json",
      "Microsoft.CodeAnalysis.dll",
      "Microsoft.CodeAnalysis.CSharp.Workspaces.dll",
      "Microsoft.CodeAnalysis.VisualBasic.Workspaces.dll",
      "Microsoft.CodeAnalysis.Workspaces.dll",
      "Microsoft.CodeAnalysis.Workspaces.MSBuild.dll",
      "BuildHost-netcore/Microsoft.Build.Locator.dll",
      "BuildHost-netcore/Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.dll",
    ])
      requireEvidence(
        data.build.observedArtifacts.some(
          (p) =>
            p.file ===
              path.join(data.build.sdk, "DotnetTools/dotnet-format", name) &&
            p.bytes > 0,
        ),
        "Selected formatter SDK dependency was observed",
      );
    requireEvidence(
      same(
        observed.projects.map((p) => p.file),
        invocation.config.projects.map((p) =>
          path.join(data.build.workspace, p.file),
        ),
      ) &&
        new Set(observed.projects.map((p) => p.projectId)).size ===
          observed.projects.length,
      "Every unique native formatter project",
    );
    const selected = new Map<string, z.infer<typeof document>>(),
      allIds: string[] = [];
    for (const project of invocation.config.projects) {
      const native = observed.projects.find(
        (p) => p.file === path.join(data.build.workspace, project.file),
      )!;
      requireEvidence(
        native.language ===
          (project.language === "csharp" ? "C#" : "Visual Basic"),
        "Native formatter project language",
      );
      const start = data.build.events.find(
        (e) => e.type === "compilerStarted" && e.file === native.file,
      )!;
      const parameters = data.build.events.filter(
        (e) =>
          e.type === "parameter" &&
          e.name === "Sources" &&
          JSON.stringify(e.context) === JSON.stringify(start.context),
      );
      requireEvidence(
        parameters.length === 1,
        "Unique compiler source parameter",
      );
      const sources = z
        .array(file)
        .parse(parameters[0]!.values)
        .map((f) =>
          path.resolve(path.dirname(native.file), f.replaceAll("\\", "/")),
        );
      requireEvidence(
        same(
          native.documents.map((d) => d.file),
          sources,
        ),
        "Every compiled source participates as one native formatter document",
      );
      const declared = [...project.sources, ...project.generatedSources].map(
        (f) => path.join(data.build.workspace, f),
      );
      for (const doc of native.documents) {
        allIds.push(doc.documentId);
        const pin = data.build.compiledSources.find((p) => p.file === doc.file);
        requireEvidence(
          pin &&
            pin.sha256 === doc.sourceSha256 &&
            pin.bytes === doc.sourceBytes,
          "Native formatter source matches fresh compiler bytes",
        );
        requireEvidence(
          doc.selected === declared.includes(doc.file) &&
            doc.changed === (doc.beforeSha256 !== doc.afterSha256) &&
            doc.changed === doc.changes.length > 0,
          "Exact declared formatting scope and edit status",
        );
        if (!doc.selected) {
          requireEvidence(
            doc.text === null,
            "Generated SDK/package documents are accounted outside the selected formatting scope",
          );
          continue;
        }
        requireEvidence(
          doc.text !== null &&
            mavenHash(doc.text) === doc.beforeSha256 &&
            mavenHash(
              Buffer.concat([
                doc.utf8Bom ? Buffer.from([239, 187, 191]) : Buffer.alloc(0),
                Buffer.from(doc.text),
              ]),
            ) === pin.sha256 &&
            Buffer.byteLength(doc.text) + (doc.utf8Bom ? 3 : 0) === pin.bytes,
          "Observed selected source text binding",
        );
        let after = "",
          cursor = 0;
        for (const edit of doc.changes) {
          requireEvidence(
            edit.start >= cursor &&
              edit.start + edit.length <= doc.text.length &&
              JSON.stringify(position(doc.text, edit.start)) ===
                JSON.stringify({ line: edit.line, column: edit.column }),
            "Ordered bounded native text edit and address",
          );
          after += doc.text.slice(cursor, edit.start) + edit.newText;
          cursor = edit.start + edit.length;
        }
        after += doc.text.slice(cursor);
        requireEvidence(
          mavenHash(after) === doc.afterSha256,
          "Native formatting edits reconstruct the exact result",
        );
        selected.set(doc.file, doc);
      }
    }
    requireEvidence(
      new Set(allIds).size === allIds.length &&
        same(
          [...selected.keys()],
          invocation.config.projects
            .flatMap((p) => [...p.sources, ...p.generatedSources])
            .map((f) => path.join(data.build.workspace, f)),
        ),
      "Unique native document identities and complete selected scope",
    );
    retainedFailures = [...selected]
      .filter(([, doc]) => doc.changed)
      .map(([file, doc]) => ({
        ruleId: "dotnet-format/WHITESPACE",
        level: "error",
        message: "The native Roslyn formatter proposes a whitespace edit",
        file: path.posix.join(
          check.project,
          path.relative(data.build.workspace, file).replaceAll(path.sep, "/"),
        ),
        line: doc.changes[0]!.line,
      }));
    const report = dotnetFormatReportSchema.parse(JSON.parse(f.report));
    const changed = [...selected]
      .filter(([, d]) => d.changed)
      .map(([file]) => file);
    requireEvidence(
      same(
        report.map((r) => r.FilePath),
        changed,
      ) && new Set(report.map((r) => r.DocumentId.Id)).size === report.length,
      "Every changed native document reconciles with the SDK report",
    );
    requireEvidence(
      f.formatterExitCode === (changed.length ? 2 : 0),
      "Formatter native exit agrees with every document",
    );
    const diagnosticLines: string[] = [];
    const reportProjects = new Map<string, string>(),
      findings: Finding[] = [...(built.findings ?? [])];
    for (const row of report) {
      const doc = selected.get(row.FilePath)!;
      requireEvidence(
        row.FileName === path.basename(row.FilePath),
        "SDK report file address",
      );
      const project = observed.projects.find((p) =>
          p.documents.some((d) => d.file === row.FilePath),
        )!.file,
        prior = reportProjects.get(project);
      requireEvidence(
        !prior || prior === row.DocumentId.ProjectId.Id,
        "Stable native report project identity",
      );
      reportProjects.set(project, row.DocumentId.ProjectId.Id);
      const lines = doc.text!.split(/\r\n|\r|\n/),
        addresses: string[] = [];
      for (const change of row.FileChanges) {
        requireEvidence(
          change.LineNumber <= lines.length &&
            change.CharNumber <= lines[change.LineNumber - 1]!.length + 1,
          "SDK report address exists in selected source",
        );
        let offset = change.CharNumber - 1;
        const breaks = [...doc.text!.matchAll(/\r\n|\r|\n/g)];
        if (change.LineNumber > 1) {
          const boundary = breaks[change.LineNumber - 2]!;
          offset += boundary.index + boundary[0].length;
        }
        requireEvidence(
          doc.changes.some(
            (e) => offset >= e.start && offset <= e.start + e.length,
          ),
          "SDK report diagnostic intersects an actual native edit",
        );
        diagnosticLines.push(
          `${row.FilePath}(${change.LineNumber},${change.CharNumber}): error WHITESPACE: ${change.FormatDescription} [${project}]`,
        );
        addresses.push(
          JSON.stringify([
            change.LineNumber,
            change.CharNumber,
            change.DiagnosticId,
          ]),
        );
        findings.push({
          ruleId: "dotnet-format/WHITESPACE",
          level: "error",
          message: change.FormatDescription,
          file: path.posix.join(
            check.project,
            path
              .relative(data.build.workspace, row.FilePath)
              .replaceAll(path.sep, "/"),
          ),
          line: change.LineNumber,
        });
      }
      requireEvidence(
        new Set(addresses).size === addresses.length,
        "No duplicate native report diagnostic",
      );
    }
    requireEvidence(
      new Set(reportProjects.values()).size === reportProjects.size,
      "Unique native report project identities",
    );
    requireEvidence(
      same(
        f.formatterStderr.trimEnd()
          ? f.formatterStderr.trimEnd().split(/\r?\n/)
          : [],
        diagnosticLines,
      ),
      "Every formatter stderr diagnostic reconciles with the native report",
    );
    return {
      status: changed.length ? "failed" : "passed",
      findings,
      findingsComplete: true,
      reason: changed.length
        ? "Native whitespace edits disagree with the selected formatting policy"
        : "Every declared source reconciles with fresh native whitespace participation",
    };
  } catch {
    return retainedFailures.length
      ? {
          ...incomplete,
          status: "failed",
          findings: retainedFailures,
          reason:
            "Native source-bound whitespace edits remain failures while later SDK report reconciliation is incomplete",
        }
      : incomplete;
  }
}
