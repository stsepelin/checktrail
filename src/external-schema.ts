import path from "node:path";
import { z } from "zod";
export const externalDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const externalPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !path.posix.isAbsolute(value) &&
      path.posix.normalize(value) === value &&
      value !== "." &&
      value !== ".." &&
      !value.startsWith("../") &&
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 &&
          character.charCodeAt(0) !== 127 &&
          character !== "\\",
      ),
  );
export const externalReferenceSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => path.isAbsolute(value) && !value.includes("\0")),
  sha256: externalDigestSchema,
});
export const externalReferencesSchema = z.array(externalReferenceSchema).max(8);
export const externalIdentitySchema = z.strictObject({
  id: z.string().regex(/^external\.[a-z][a-z0-9-]{0,63}$/),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
    .max(128),
  sha256: externalDigestSchema,
});
export const externalManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: externalIdentitySchema.shape.id,
  version: externalIdentitySchema.shape.version,
  description: z.string().min(1).max(4096),
  runtime: z.enum(["node", "python3", "php", "native"]),
  entry: externalPathSchema,
  files: z
    .array(
      z.strictObject({
        path: externalPathSchema,
        sha256: externalDigestSchema,
      }),
    )
    .min(1)
    .max(512),
  markers: z
    .array(
      z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,128}$/)
        .refine((value) => value !== "." && value !== ".."),
    )
    .min(1)
    .max(32),
  checks: z
    .array(
      z.strictObject({
        id: identifier,
        kind: z.enum(["analysis", "syntax", "format", "test"]),
        description: z.string().min(1).max(4096),
        failOn: z.enum(["error", "warning"]),
        scope: z.strictObject({
          extensions: z
            .array(z.string().regex(/^\.[A-Za-z0-9_.-]{1,64}$/))
            .max(32),
          names: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/)).max(32),
        }),
      }),
    )
    .min(1)
    .max(32),
});
