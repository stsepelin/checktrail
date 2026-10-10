import { z } from "zod";
import { capturedProcessOutputSchema } from "./process-output.js";
import { dotnetBuildPacketSchema } from "./dotnet-build-evidence.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.string().min(1).max(8192);
// Roslyn generated document IDs are deterministic CLR GUIDs with arbitrary RFC version bits.
const guid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
const count = z.number().int().nonnegative();
const position = z.strictObject({
  file: z.string().max(8192),
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
});
const document = z.strictObject({
  project: file,
  projectId: guid,
  language: z.enum(["C#", "Visual Basic"]),
  file,
  documentId: guid,
  selected: z.boolean(),
  sourceGenerated: z.boolean(),
  route: z.enum([
    "sdk-pipeline",
    "native-generated-whitespace",
    "native-generated-diagnostics",
  ]),
  sourceBytes: count.max(65536),
  sourceSha256: digest,
  utf8Bom: z.boolean(),
  lineMappings: z
    .array(
      z.strictObject({
        span: position.omit({ file: true }),
        characterOffset: count.max(65536).nullable(),
        mapped: position.nullable(),
        mappedValid: z.boolean(),
        hasMappedPath: z.boolean(),
        pdbFile: file.nullable(),
      }),
    )
    .max(4096),
  before: z.string().max(65536),
  after: z.string().max(131072),
  beforeSha256: digest,
  afterSha256: digest,
  changed: z.boolean(),
  changes: z
    .array(
      z.strictObject({
        start: count.max(65536),
        length: count.max(65536),
        newText: z.string().max(131072),
        line: z.number().int().positive(),
        column: z.number().int().positive(),
      }),
    )
    .max(4096),
});
const diagnostic = z.strictObject({
  id: z.string().min(1).max(64),
  severity: z.enum(["Info", "Warning", "Error"]),
  message: z.string().max(65536),
  project: file,
  projectId: guid,
  file: file.nullable(),
  documentId: guid.nullable(),
  locationKind: z.enum(["SourceFile", "None"]),
  start: count.max(65536),
  length: count.max(65536),
  physical: position,
  mapped: position,
  sourceTextSha256: digest.nullable(),
});
const report = z
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
            DiagnosticId: z.string().min(1).max(64),
            FormatDescription: z.string().min(1).max(65536),
          }),
        )
        .min(1)
        .max(4096),
    }),
  )
  .max(4096);
export const dotnetFormatExtensionsNativeSchema = z.strictObject({
  processId: z.number().int().positive(),
  runtime: z.literal("10.0.12"),
  helperSha256: digest,
  formatterAssembly: file,
  formatterSha256: digest,
  constructorParameters: z.array(z.string().max(64)).length(15),
  workspaceFailures: z.array(z.string().max(65536)).max(1024),
  allDocuments: z.number().int().min(1).max(4096),
  loaded: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(256),
        version: z.string().min(1).max(128),
        file,
        sha256: digest,
      }),
    )
    .min(1)
    .max(512),
  phases: z
    .array(
      z.strictObject({
        mode: z.enum(["Whitespace", "CodeStyle", "Analyzers"]),
        nativeFormattingInvoked: z.literal(true),
        nativeDiagnosticsInvoked: z.boolean(),
        catalog: z
          .array(
            z.strictObject({
              project: file,
              projectId: guid,
              language: z.enum(["C#", "Visual Basic"]),
              supported: z.array(z.string().min(1).max(64)).max(2048),
              selectedAnalyzers: z
                .array(
                  z.strictObject({
                    name: z.string().min(1).max(1024),
                    assembly: file,
                  }),
                )
                .max(1024),
            }),
          )
          .max(64),
        diagnostics: z.array(diagnostic).max(4096),
        analyzerExceptions: z.array(z.string().max(65536)).max(1024),
        documents: z.array(document).min(1).max(4096),
        sdkReport: report,
        sdkReportScope: z.literal(
          "ordinary-selected-diagnostics-and-document-whitespace-summaries",
        ),
        generatedSemanticFixesSupported: z.literal(false),
      }),
    )
    .length(3),
  complete: z.literal(true),
});
export const dotnetFormatExtensionsPacketSchema = z.strictObject({
  version: z.literal(1),
  build: dotnetBuildPacketSchema,
  extensions: z
    .strictObject({
      sdkRoot: file,
      temporary: file,
      observerDirectory: file,
      policySha256: digest,
      sdkPinsSha256: digest,
      helperSourceSha256: digest,
      helperSha256: digest,
      requestFileSha256: digest,
      runtimeConfigSha256: digest,
      marker: z.strictObject({
        phase: z.literal("sdk-formatting-observer-body"),
        processId: z.number().int().positive(),
        runtime: z.literal("10.0.12"),
      }),
      firstDocument: z.strictObject({
        phase: z.literal("sdk-formatting-first-document-completed"),
        processId: z.number().int().positive(),
        mode: z.literal("Whitespace"),
        file,
        sourceSha256: digest,
        beforeSha256: digest,
      }),
      completed: z.strictObject({
        phase: z.literal("sdk-formatting-observer-completed"),
        processId: z.number().int().positive(),
        helperSha256: digest,
        observationSha256: digest,
        allDocuments: z.number().int().min(1).max(4096),
        phases: z
          .array(
            z.strictObject({
              mode: z.enum(["Whitespace", "CodeStyle", "Analyzers"]),
              documents: z.number().int().min(1).max(4096),
              diagnostics: count.max(4096),
              reportRows: count.max(4096),
              changedDocuments: count.max(4096),
            }),
          )
          .length(3),
      }),
      phases: z
        .array(
          z.strictObject({
            phase: z.enum([
              "compile-formatting-observer",
              "formatting-documents",
            ]),
            tool: file,
            args: z.array(z.string().max(8192)).max(512),
            cwd: file,
            status: z.literal(0),
            signal: z.null(),
            pid: z.number().int().positive(),
            stdoutBytes: count.max(2 * 1024 * 1024),
            stderrBytes: count.max(2 * 1024 * 1024),
            stdoutSha256: digest,
            stderrSha256: digest,
            stdout: z.string().max(2 * 1024 * 1024),
            stderr: z.string().max(2 * 1024 * 1024),
            capturedOutput: capturedProcessOutputSchema,
          }),
        )
        .length(2),
      mirroredBytes: count.max(2 * 1024 * 1024),
      mirroredSha256: digest,
      complete: z.literal(true),
    })
    .nullable(),
});
export const dotnetFormatExtensionsRuntimeConfig = JSON.stringify({
  runtimeOptions: {
    tfm: "net10.0",
    framework: { name: "Microsoft.NETCore.App", version: "10.0.12" },
    rollForward: "Disable",
  },
});
export const dotnetFormatExtensionsConstructorParameters = [
  "WorkspaceFilePath",
  "WorkspaceType",
  "NoRestore",
  "LogLevel",
  "FixCategory",
  "CodeStyleSeverity",
  "AnalyzerSeverity",
  "Diagnostics",
  "ExcludeDiagnostics",
  "SaveFormattedFiles",
  "ChangesAreErrors",
  "FileMatcher",
  "ReportPath",
  "BinaryLogPath",
  "IncludeGeneratedFiles",
] as const;

export const dotnetFormattingCompileWarning =
  "warning CS1701: Assuming assembly reference 'System.Runtime, Version=8.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a' used by 'Microsoft.Build.Locator' matches identity 'System.Runtime, Version=10.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a' of 'System.Runtime', you may need to supply runtime policy\n";
export function dotnetFormattingCompileArguments(
  sdk: string,
  directory: string,
  references: string[],
) {
  return [
    "exec",
    sdk + "/Roslyn/bincore/csc.dll",
    "-nologo",
    "-noconfig",
    "-nostdlib+",
    "-target:exe",
    "-out:" + directory + "/ChecktrailFormattingExtensions.dll",
    ...references.map((file) => "-r:" + file),
    ...[
      "Microsoft.CodeAnalysis.dll",
      "Microsoft.CodeAnalysis.Workspaces.dll",
      "Microsoft.CodeAnalysis.Workspaces.MSBuild.dll",
      "BuildHost-netcore/Microsoft.Build.Locator.dll",
      "Microsoft.Extensions.Logging.Abstractions.dll",
    ].map((file) => "-r:" + sdk + "/DotnetTools/dotnet-format/" + file),
    directory + "/ChecktrailFormattingExtensions.cs",
  ];
}
