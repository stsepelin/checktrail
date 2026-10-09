import { z } from "zod";
import { javascriptPathSchema } from "./node-loader-contract.js";
import { eslintSourceIdentitySchema } from "./eslint-participation.js";
export const viteLibraryConfigSchema = z.strictObject({
  sourceDirectory: javascriptPathSchema,
  entry: javascriptPathSchema,
  consumers: z.array(javascriptPathSchema).min(1).max(64),
});
export const viteLibraryManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  profile: viteLibraryConfigSchema,
  sources: z.array(eslintSourceIdentitySchema).min(1).max(256),
  consumers: z.array(eslintSourceIdentitySchema).min(1).max(64),
});
const diagnostic = z.strictObject({
  code: z.number().int(),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
});
const artifact = z.strictObject({
  path: z.string().min(1),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(16 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const viteLibraryReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  manifest: viteLibraryManifestSchema,
  versions: z.strictObject({
    vite: z.literal("8.3.0"),
    rolldown: z.literal("1.2.9"),
    typescript: z.literal("6.0.3"),
  }),
  complete: z.boolean(),
  producerFiles: z.array(z.string()).max(20000),
  consumerFiles: z.array(z.string()).max(20000),
  resolutions: z
    .array(z.strictObject({ consumer: z.string(), declaration: z.string() }))
    .max(1024),
  diagnostics: z.array(diagnostic).max(10000),
  declarations: z.array(artifact).max(4096),
  builds: z
    .array(
      z.strictObject({
        format: z.enum(["es", "cjs"]),
        modules: z.array(z.string()).max(20000),
        chunks: z
          .array(
            z.strictObject({
              artifact,
              exports: z.array(z.string()).max(4096),
              entry: z.string(),
              imports: z.array(z.string()).max(4096),
              dynamicImports: z.array(z.string()).max(4096),
            }),
          )
          .max(4096),
      }),
    )
    .max(2),
});
