import { z } from "zod";
const file = z.string().min(1).max(8192),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  integer = z.number().int().nonnegative(),
  text = z.string().max(1024 * 1024);
const pin = z.strictObject({
  path: file,
  entry: file,
  bytes: integer.max(128 * 1024 * 1024),
  sha256: digest,
  afterSha256: digest,
});
export const terraformExtensionsPacketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  temporary: file,
  nativeTemporary: z.strictObject({
    path: z.string().regex(/^\/proc\/[1-9][0-9]{0,8}\/fd\/[0-9]{1,6}$/),
    before: file,
    after: file,
  }),
  workspace: file,
  source: file,
  data: file,
  mirror: file,
  preparedProvider: file,
  inputSha256: digest,
  tool: z.strictObject({
    entry: file,
    resolved: file,
    bytes: integer.max(128 * 1024 * 1024),
    sha256: digest,
    afterSha256: digest,
  }),
  artifacts: z.array(pin).length(4),
  providerMembers: z.array(pin).length(2),
  modules: z.strictObject({ file, text, sha256: digest, afterSha256: digest }),
  lock: z.strictObject({ file, sha256: digest, afterSha256: digest }),
  cliConfig: z.strictObject({
    file,
    text,
    sha256: digest,
    afterSha256: digest,
  }),
  copiedArchive: z.strictObject({ file, sha256: digest, afterSha256: digest }),
  sourceInputs: z
    .array(z.strictObject({ path: file, sha256: digest, afterSha256: digest }))
    .min(5)
    .max(128),
  nativeFiles: z.array(file).min(4).max(17),
  dataFiles: z.array(file).length(3),
  receipts: z
    .array(
      z.strictObject({
        phase: z.enum([
          "version",
          "init",
          "selected-version",
          "provider-schema",
          "validate",
        ]),
        executable: file,
        args: z.array(file).min(1).max(16),
        exitCode: integer.max(255),
        stdout: text,
        stderr: text,
        stdoutSha256: digest,
        stderrSha256: digest,
      }),
    )
    .length(5),
});
export const terraformExtensionsPositionSchema = z.strictObject({
  line: integer.min(1),
  column: integer.min(1),
  byte: integer,
});
export const terraformExtensionsDiagnosticSchema = z.strictObject({
  severity: z.enum(["error", "warning"]),
  summary: z.string().min(1).max(8192),
  detail: z.string().max(65536).optional(),
  range: z
    .strictObject({
      filename: file,
      start: terraformExtensionsPositionSchema,
      end: terraformExtensionsPositionSchema,
    })
    .nullable()
    .optional(),
  snippet: z
    .strictObject({
      context: z.string().nullable().optional(),
      code: z.string().max(65536),
      start_line: integer.min(1),
      highlight_start_offset: integer,
      highlight_end_offset: integer,
      values: z
        .array(
          z.strictObject({
            traversal: z.string().max(1024),
            statement: z.string().max(8192),
          }),
        )
        .max(64),
    })
    .nullable()
    .optional(),
});
export const terraformExtensionsNativeResultSchema = z.strictObject({
  format_version: z.literal("1.0"),
  valid: z.boolean(),
  error_count: integer,
  warning_count: integer,
  diagnostics: z.array(terraformExtensionsDiagnosticSchema).max(256),
});
