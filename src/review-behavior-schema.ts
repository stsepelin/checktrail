import { z } from "zod";

const id = z.string().regex(/^[a-f0-9]{64}$/);
const offset = z.number().int().nonnegative().max(65536);
const range = {
  revision: z.enum(["base", "current"]),
  file: z.string().min(1).max(1024),
  start: offset,
  end: offset,
  startLine: z.number().int().min(1).max(65537),
  endLine: z.number().int().min(1).max(65537),
};
export const reviewBehaviorSchema = z.strictObject({
  profile: z.literal("js-ts-syntax-v1"),
  parser: z.literal("typescript"),
  parserVersion: z.literal("6.0.3"),
  state: z.enum(["collected", "partial"]),
  reachabilityVerified: z.literal(false),
  files: z
    .array(
      z.strictObject({
        revision: range.revision,
        file: range.file,
        sha256: id,
        role: z.enum(["primary", "support"]),
        state: z.enum([
          "collected",
          "unsupported",
          "malformed",
          "budget-exhausted",
          "error",
        ]),
      }),
    )
    .max(32),
  functions: z
    .array(
      z.strictObject({
        ...range,
        id,
        name: z.string().max(256).nullable(),
        kind: z.enum([
          "function",
          "arrow",
          "method",
          "constructor",
          "getter",
          "setter",
        ]),
        declarationId: id.nullable(),
        enclosingDeclarations: z.array(id).max(128),
        overlapsChange: z.boolean().nullable(),
      }),
    )
    .max(1024),
  declarations: z
    .array(
      z.strictObject({
        ...range,
        id,
        name: z.string().max(256).nullable(),
        kind: z.enum([
          "function",
          "variable",
          "class",
          "interface",
          "type",
          "enum",
          "property",
          "parameter",
          "import",
        ]),
        initializer: z.strictObject({ start: offset, end: offset }).nullable(),
      }),
    )
    .max(4096),
  calls: z
    .array(
      z.strictObject({
        ...range,
        callerFunctionId: id.nullable(),
        targetFunctionId: id.nullable(),
        kind: z.enum(["call", "construct"]),
        optional: z.boolean(),
        resolution: z.enum([
          "lexical-binding",
          "unsupported-dispatch",
          "no-selected-definition",
          "ambiguous-definition",
          "mutated-binding",
          "type-only-import",
        ]),
      }),
    )
    .max(4096),
  references: z
    .array(
      z.strictObject({
        ...range,
        fromFunctionId: id.nullable(),
        ownerDeclarationId: id.nullable(),
        targetDeclarationId: id,
      }),
    )
    .max(8192),
  modules: z
    .array(
      z.strictObject({
        ...range,
        kind: z.enum(["import", "re-export", "dynamic-import", "require"]),
        specifier: z.string().max(1024).nullable(),
        targetFile: range.file.nullable(),
        resolution: z.enum([
          "selected",
          "external",
          "outside-root",
          "missing",
          "ambiguous",
          "unparsed",
          "dynamic",
        ]),
      }),
    )
    .max(512),
  omissions: z
    .array(
      z.enum([
        "unselected-files",
        "runtime-dispatch",
        "runtime-rebinding",
        "project-module-resolution",
        "framework-assembly",
        "non-js-ts-semantics",
      ]),
    )
    .max(16),
});
export type ReviewBehavior = z.infer<typeof reviewBehaviorSchema>;
