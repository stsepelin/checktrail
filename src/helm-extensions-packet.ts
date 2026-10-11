import { z } from "zod";
import { externalDigestSchema, externalPathSchema } from "./external-schema.js";
const file = z.string().min(1).max(8192),
  text = z.string().max(1024 * 1024),
  digest = externalDigestSchema;
const input = z.strictObject({
  path: externalPathSchema.max(256),
  sha256: digest,
  afterSha256: digest,
});
export const helmExtensionsPacketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  temporary: file,
  source: file,
  workspace: file,
  chart: file,
  inputSha256: digest,
  tool: z.strictObject({
    entry: file,
    resolved: file,
    bytes: z
      .number()
      .int()
      .min(1)
      .max(128 * 1024 * 1024),
    sha256: digest,
    afterSha256: digest,
  }),
  sourceInputs: z.array(input).min(13).max(128),
  nativeInputs: z.array(input).min(12).max(127),
  sourceFiles: z.array(externalPathSchema.max(256)).min(13).max(128),
  nativeFiles: z.array(externalPathSchema.max(256)).min(12).max(127),
  receipts: z
    .array(
      z.strictObject({
        phase: z.enum(["version", "lint", "render", "debug"]),
        executable: file,
        args: z.array(file).min(1).max(32),
        exitCode: z.number().int().min(0).max(255),
        stdout: text,
        stderr: text,
        stdoutSha256: digest,
        stderrSha256: digest,
      }),
    )
    .length(4),
});
export type HelmExtensionsPacket = z.infer<typeof helmExtensionsPacketSchema>;
