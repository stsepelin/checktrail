import { z } from "zod";
export const javascriptPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^(?![A-Za-z]:)(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\\0\r\n]+$/);
export const nodeLoaderSchema = z.strictObject({
  kind: z.enum(["import", "require"]),
  path: javascriptPathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const nodeLoaderManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  runtime: z.string().regex(/^\d+\.\d+\.\d+$/),
  loaders: z.array(nodeLoaderSchema).min(1).max(16),
  files: z
    .array(
      z.strictObject({
        path: javascriptPathSchema,
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(8 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(256),
});
export type NodeLoaderManifest = z.infer<typeof nodeLoaderManifestSchema>;
