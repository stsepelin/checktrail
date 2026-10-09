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
export const reviewJavascriptBehaviorSchema = z.strictObject({
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
export const reviewPolyglotBehaviorSchema =
  reviewJavascriptBehaviorSchema.extend({
    profile: z.literal("selected-syntax-v1"),
    files: z.array(reviewJavascriptBehaviorSchema.shape.files.element).max(64),
    parser: z.literal("typescript-and-tree-sitter-wasm"),
    parserVersion: z.literal("6.0.3/0.27.0"),
    grammarManifestDigest: id,
    grammarBindings: z
      .array(
        z.strictObject({
          grammar: z
            .string()
            .regex(/^[a-z_]+$/)
            .max(64),
          sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
          wasmSha256: id,
        }),
      )
      .max(16),
    decisions: z
      .array(
        z.strictObject({
          ...range,
          id,
          nodeType: z
            .string()
            .regex(/^[a-z_]+$/)
            .max(128),
        }),
      )
      .max(4096),
  });
export const reviewPythonBehaviorSchema = reviewPolyglotBehaviorSchema.extend({
  profile: z.literal("python-selected-bindings-v1"),
  pythonBindings: z.strictObject({
    moduleRoots: z.array(z.string().min(1).max(1024)).min(1).max(16),
    scope: z.literal("selected-captured-python-source"),
    state: z.enum(["collected", "partial"]),
    callerDepthLimit: z.literal(8),
    callerEdges: z
      .array(
        z.strictObject({
          revision: range.revision,
          targetFunctionId: id,
          callerFunctionId: id,
          depth: z.number().int().min(1).max(8),
        }),
      )
      .max(4096),
    counts: z.strictObject({
      calls: z.number().int().min(0).max(4096),
      resolvedCalls: z.number().int().min(0).max(4096),
      unresolvedCalls: z.number().int().min(0).max(4096),
      imports: z.number().int().min(0).max(512),
      resolvedImports: z.number().int().min(0).max(512),
      unresolvedImports: z.number().int().min(0).max(512),
    }),
    fullImpactFallback: z.literal(true),
    runtimeReachabilityVerified: z.literal(false),
    validationPlanUnchanged: z.literal(true),
    omissions: z
      .array(
        z.enum([
          "unselected-source",
          "runtime-rebinding",
          "runtime-dispatch",
          "unsupported-binding",
          "unsupported-scope-mutation",
          "wildcard-import",
          "unsupported-import",
          "unresolved-call",
          "unresolved-import",
          "binding-cycle",
          "depth-limit",
          "budget-exhausted",
          "partial-syntax",
          "no-selected-functions",
          "outside-module-roots",
          "non-python-source",
        ]),
      )
      .max(16),
  }),
});
export const goModuleRootSchema = z.string().min(1).max(1024);
export const goModuleManifestSchema = z.strictObject({
  revision: range.revision,
  root: goModuleRootSchema,
  file: z.string().min(1).max(1024),
  sha256: id.nullable(),
  modulePath: z.string().min(1).max(1024).nullable(),
  state: z.enum(["captured", "missing", "unsupported"]),
});
export const reviewGoBehaviorSchema = reviewPolyglotBehaviorSchema.extend({
  profile: z.literal("go-selected-bindings-v1"),
  goBindings: z.strictObject({
    moduleRoots: z.array(goModuleRootSchema).min(1).max(16),
    moduleRootsProvenance: z.literal("operator-selected"),
    moduleManifests: z.array(goModuleManifestSchema).min(1).max(32),
    scope: z.literal("selected-captured-go-source"),
    state: z.enum(["collected", "partial"]),
    callerDepthLimit: z.literal(8),
    callerEdges:
      reviewPythonBehaviorSchema.shape.pythonBindings.shape.callerEdges,
    counts: reviewPythonBehaviorSchema.shape.pythonBindings.shape.counts,
    fullImpactFallback: z.literal(true),
    runtimeReachabilityVerified: z.literal(false),
    nativeModuleResolutionVerified: z.literal(false),
    validationPlanUnchanged: z.literal(true),
    omissions: z
      .array(
        z.enum([
          "unselected-source",
          "runtime-rebinding",
          "runtime-dispatch",
          "build-selection-unknown",
          "captured-module-directives",
          "unsupported-binding",
          "unsupported-scope-mutation",
          "unsupported-import",
          "unresolved-call",
          "unresolved-import",
          "ambiguous-package",
          "outside-module-roots",
          "partial-syntax",
          "no-selected-functions",
          "non-go-source",
          "depth-limit",
          "missing-module-manifest",
          "unsupported-module-manifest",
        ]),
      )
      .max(24),
  }),
});
export const reviewPhpBehaviorSchema = reviewPolyglotBehaviorSchema.extend({
  profile: z.literal("php-selected-bindings-v1"),
  phpBindings: z.strictObject({
    moduleRoots: z.array(z.string().min(1).max(1024)).min(1).max(16),
    scope: z.literal("selected-captured-php-source"),
    state: z.enum(["collected", "partial"]),
    callerDepthLimit: z.literal(8),
    callerEdges:
      reviewPythonBehaviorSchema.shape.pythonBindings.shape.callerEdges,
    counts: reviewPythonBehaviorSchema.shape.pythonBindings.shape.counts,
    fullImpactFallback: z.literal(true),
    runtimeReachabilityVerified: z.literal(false),
    nativeNameResolutionVerified: z.literal(false),
    moduleLoadingVerified: z.literal(false),
    validationPlanUnchanged: z.literal(true),
    omissions: z
      .array(
        z.enum([
          "unselected-source",
          "runtime-rebinding",
          "runtime-dispatch",
          "module-loading-unknown",
          "unsupported-binding",
          "conditional-declaration",
          "unsupported-import",
          "unresolved-call",
          "unresolved-import",
          "unresolved-loading",
          "ambiguous-definition",
          "outside-module-roots",
          "partial-syntax",
          "non-php-source",
          "no-selected-functions",
          "depth-limit",
        ]),
      )
      .max(24),
  }),
});
export const reviewRustBehaviorSchema = reviewPolyglotBehaviorSchema.extend({
  profile: z.literal("rust-selected-bindings-v1"),
  rustBindings: z.strictObject({
    crateRoots: z.array(z.string().min(1).max(1024)).min(1).max(16),
    scope: z.literal("selected-captured-rust-source"),
    state: z.enum(["collected", "partial"]),
    callerDepthLimit: z.literal(8),
    callerEdges:
      reviewPythonBehaviorSchema.shape.pythonBindings.shape.callerEdges,
    counts: reviewPythonBehaviorSchema.shape.pythonBindings.shape.counts,
    fullImpactFallback: z.literal(true),
    runtimeReachabilityVerified: z.literal(false),
    nativeNameResolutionVerified: z.literal(false),
    moduleLoadingVerified: z.literal(false),
    validationPlanUnchanged: z.literal(true),
    omissions: z
      .array(
        z.enum([
          "unselected-source",
          "runtime-rebinding",
          "runtime-dispatch",
          "module-loading-unknown",
          "build-selection-unknown",
          "unsupported-binding",
          "unsupported-pattern",
          "unsupported-attributes",
          "unsupported-module",
          "macro-expansion-unknown",
          "missing-crate-root",
          "unresolved-module",
          "unsupported-import",
          "unresolved-call",
          "unresolved-import",
          "unresolved-loading",
          "ambiguous-definition",
          "outside-crate-roots",
          "partial-syntax",
          "non-rust-source",
          "no-selected-functions",
          "depth-limit",
        ]),
      )
      .max(24),
  }),
});
export const reviewBehaviorSchema = z.discriminatedUnion("profile", [
  reviewJavascriptBehaviorSchema,
  reviewPolyglotBehaviorSchema,
  reviewPythonBehaviorSchema,
  reviewGoBehaviorSchema,
  reviewPhpBehaviorSchema,
  reviewRustBehaviorSchema,
]);
export type ReviewBehavior = z.infer<typeof reviewBehaviorSchema>;
