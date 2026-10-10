import { z } from "zod";
import { capturedProcessOutputSchema } from "./process-output.js";
export const fsharpDigest = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.string().min(1).max(8192),
  count = z.number().int().nonnegative();
export const fsharpDiagnosticSchema = z.strictObject({
  severity: z.enum(["Error", "Warning", "Info"]),
  subcategory: z.string().max(1024),
  code: z.number().int().nonnegative().nullable(),
  message: z.string().max(65536),
  range: z
    .strictObject({
      file,
      startLine: z.number().int().positive(),
      startColumn: count,
      endLine: z.number().int().positive(),
      endColumn: count,
    })
    .nullable(),
});
export const fsharpNativeSchema = z.strictObject({
  processId: z.number().int().positive(),
  runtime: z.literal("10.0.12"),
  fantomas: z.literal("8.0.7.0"),
  helperSha256: fsharpDigest,
  loaded: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(256),
        version: z.string().min(1).max(128),
        file,
      }),
    )
    .min(4)
    .max(128),
  documents: z
    .array(
      z.strictObject({
        file,
        signature: z.boolean(),
        sourceBytes: count.max(65536),
        sourceSha256: fsharpDigest,
        utf8Bom: z.boolean(),
        text: z.string().max(65536),
        textSha256: fsharpDigest,
        validationInvoked: z.literal(true),
        isValid: z.boolean(),
        validationDiagnosticScope: z.literal(
          "intolerant-first-failing-combination",
        ),
        diagnostics: z.array(fsharpDiagnosticSchema).max(1024),
        formattingInvoked: z.literal(true),
        error: z
          .strictObject({
            kind: z.enum(["parse", "define-parse", "format"]),
            type: z.string().min(1).max(1024),
            message: z.string().min(1).max(131072),
            combinations: z.array(z.string().min(1).max(1024)).max(1024),
            diagnostics: z.array(fsharpDiagnosticSchema).max(1024),
          })
          .nullable(),
        after: z.string().max(131072).nullable(),
        afterSha256: fsharpDigest.nullable(),
        changed: z.boolean(),
      }),
    )
    .min(1)
    .max(128),
  complete: z.literal(true),
});
export const fsharpPacketSchema = z.strictObject({
  version: z.literal(1),
  profile: z.literal("fantomas-core-default-v1"),
  requestSha256: fsharpDigest,
  sdkRoot: file,
  sdkPinsSha256: fsharpDigest,
  temporary: file,
  helperSourceSha256: fsharpDigest,
  helperSha256: fsharpDigest,
  runtimeConfigSha256: fsharpDigest,
  requestFileSha256: fsharpDigest,
  marker: z.strictObject({
    processId: z.number().int().positive(),
    phase: z.literal("formatter-observer-body"),
    runtime: z.literal("10.0.12"),
    fantomas: z.literal("8.0.7.0"),
  }),
  firstDocument: z.strictObject({
    processId: z.number().int().positive(),
    phase: z.literal("formatter-first-document-completed"),
    file,
    sourceSha256: fsharpDigest,
    formatterReturned: z.boolean(),
  }),
  phases: z
    .array(
      z.strictObject({
        phase: z.enum(["compile-observer", "format-documents"]),
        tool: file,
        args: z.array(z.string().max(8192)).max(512),
        cwd: file,
        status: z.literal(0),
        signal: z.null(),
        pid: z.number().int().positive(),
        stdoutBytes: count.max(2 * 1024 * 1024),
        stderrBytes: count.max(2 * 1024 * 1024),
        stdoutSha256: fsharpDigest,
        stderrSha256: fsharpDigest,
        stdout: z.string().max(2 * 1024 * 1024),
        stderr: z.string().max(2 * 1024 * 1024),
        capturedOutput: capturedProcessOutputSchema,
      }),
    )
    .length(2),
  mirroredBytes: count.max(2 * 1024 * 1024),
  mirroredSha256: fsharpDigest,
  complete: z.literal(true),
});
export const fsharpRuntimeConfig = JSON.stringify({
  runtimeOptions: {
    tfm: "net10.0",
    framework: { name: "Microsoft.NETCore.App", version: "10.0.12" },
    rollForward: "Disable",
  },
});
export function fsharpCompileArguments(
  sdkRoot: string,
  temporary: string,
  references: string[],
) {
  const helper = temporary + "/observer/ChecktrailFsharpFormat.dll";
  return [
    "exec",
    sdkRoot + "/sdk/10.0.401/Roslyn/bincore/csc.dll",
    "-nologo",
    "-noconfig",
    "-nostdlib+",
    "-target:exe",
    `-out:${helper}`,
    ...references.map((f) => `-r:${f}`),
    ...["FSharp.Core.dll", "Fantomas.Core.dll", "Fantomas.FCS.dll"].map(
      (f) => `-r:${temporary}/observer/${f}`,
    ),
    temporary + "/observer/ChecktrailFsharpFormat.cs",
  ];
}
// Retain these two exact observed compatibility warnings. Any additional compiler
// diagnostic is a collection failure; no blanket compiler warning suppression.
export function fsharpCompileWarnings(stdout: string) {
  const lines = stdout.replaceAll("\r\n", "\n").trimEnd().split("\n");
  const suffix =
    " matches identity 'FSharp.Core, Version=10.1.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a' of 'FSharp.Core', you may need to supply runtime policy";
  return (
    lines.length === 2 &&
    ["Fantomas.Core", "Fantomas.FCS"].every(
      (name) =>
        lines.filter(
          (line) =>
            line ===
            `warning CS1701: Assuming assembly reference 'FSharp.Core, Version=10.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a' used by '${name}'${suffix}`,
        ).length === 1,
    )
  );
}
