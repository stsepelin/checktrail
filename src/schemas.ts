import { externalIdentitySchema } from "./external-adapter.js";
export {
  externalManifestSchema,
  externalReferenceSchema,
  externalRequestSchema,
  externalResultSchema,
} from "./external-adapter.js";
export { actionlintConfigSchema } from "./actionlint.js";
export { dotnetConfigSchema } from "./dotnet.js";
export { javaConfigSchema } from "./java.js";
export { clangDatabaseSchema } from "./clang.js";
import { PARSERS } from "./types.js";
export {
  dependencyGraphSchema,
  architecturePolicySchema,
  architectureReportSchema,
  architectureSummarySchema,
} from "./architecture.js";
export { laravelConfigSchema } from "./laravel.js";
import { z } from "zod";
import { runtimeInventorySchema } from "./runtime-inventory.js";
export { fastapiConfigSchema } from "./fastapi.js";
export { djangoConfigSchema } from "./django.js";
export { vueRouterConfigSchema } from "./vue-router.js";
export {
  contractBundleSchema,
  contractReportSchema,
  contractSummarySchema,
} from "./contract-schema.js";
export {
  runtimeInventorySchema,
  runtimeComparisonSchema,
  runtimeComparisonSummarySchema,
} from "./runtime-inventory.js";
export { configSchema } from "./config.js";
export { policyPackSchema } from "./policy-pack.js";
import { workspaceSchema } from "./config.js";

const count = z.number().int().nonnegative();
const strings = z.array(z.string());
const status = z.enum([
  "passed",
  "failed",
  "unavailable",
  "skipped",
  "error",
  "inconclusive",
]);
const outcome = z.enum(["passed", "failed", "incomplete"]);
const kind = z.enum(["format", "analysis", "test", "syntax", "unsupported"]);
const tests = z.strictObject({
  total: count,
  passed: count,
  failed: count,
  skipped: count,
});
const command = z.strictObject({
  temporaryDirectory: z.boolean().optional(),
  executable: z.string(),
  args: strings,
  cwd: z.string(),
  env: z.record(z.string(), z.string()).optional(),
});
const toolSpec = z.discriminatedUnion("source", [
  z.strictObject({
    name: z.literal("node"),
    source: z.literal("engine-runtime"),
  }),
  z.strictObject({
    name: z.string(),
    source: z.literal("package-metadata"),
    path: z.string().nullable(),
  }),
  z.strictObject({
    name: z.string(),
    source: z.literal("version-command"),
    command,
  }),
]);
const processResult = z.strictObject({
  command,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: count,
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  truncated: z.boolean(),
  errorCode: z.string().optional(),
});
const selection = z.strictObject({
  mode: z.enum(["full", "affected"]),
  reason: z.string(),
  changedFiles: strings,
  selectedProjects: strings,
  git: z
    .strictObject({
      baseCommit: z.string(),
      headCommit: z.string(),
      version: z.string(),
      worktreeId: z.string(),
      indexFingerprint: z.string(),
    })
    .optional(),
});
const selectionSummary = z.strictObject({
  mode: z.enum(["full", "affected"]),
  reason: z.string(),
  projectCount: count,
  changedFileCount: count,
});
const metadata = { schemaVersion: z.literal(1), engineVersion: z.string() };
const reportMetadata = {
  ...metadata,
  runId: z.string().uuid(),
  outcome,
  durationMs: count,
  sourceChanged: z.boolean(),
  sourceError: z.boolean(),
};

export const reportSchema = z.strictObject({
  ...reportMetadata,
  selection: selection.optional(),
  startedAt: z.iso.datetime(),
  sourceFingerprint: z.string(),
  finalSourceFingerprint: z.string().nullable(),
  policyFingerprint: z.string(),
  excluded: strings,
  checks: z.array(
    z.strictObject({
      external: externalIdentitySchema
        .extend({
          tools: z
            .array(
              z.strictObject({
                name: z.string(),
                version: z.string(),
                source: z.literal("adapter-reported"),
              }),
            )
            .optional(),
        })
        .optional(),
      id: z.string(),
      adapter: z.string(),
      project: z.string(),
      scope: strings,
      status,
      reason: z.string(),
      processes: z.array(processResult),
      tests: tests.optional(),
      findingsComplete: z.boolean().optional(),
      runtime: runtimeInventorySchema.optional(),
      findings: z
        .array(
          z.strictObject({
            ruleId: z.string().min(1),
            level: z.enum(["error", "warning", "note"]),
            message: z.string(),
            file: z.string().min(1).optional(),
            line: z.number().int().positive().optional(),
          }),
        )
        .optional(),
      environment: z
        .strictObject({ names: strings, fingerprint: z.string() })
        .optional(),
      tools: z
        .array(
          z.strictObject({
            name: z.string(),
            source: z.enum([
              "engine-runtime",
              "package-metadata",
              "version-command",
            ]),
            version: z.string().nullable(),
            status: z.enum(["identified", "unavailable", "inconclusive"]),
            process: processResult.optional(),
            path: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
});

export const reportSummarySchema = z.strictObject({
  ...reportMetadata,
  selection: selectionSummary.optional(),
  checks: z.array(
    z.strictObject({ id: z.string(), status, tests: tests.optional() }),
  ),
});

export const planSchema = z.strictObject({
  ...metadata,
  selection: selection.optional(),
  workspace: workspaceSchema.optional(),
  sourceFingerprint: z.string(),
  policyFingerprint: z.string(),
  excluded: strings,
  projects: z.array(
    z.strictObject({
      path: z.string(),
      adapter: z.string(),
      markers: strings,
      files: strings,
    }),
  ),
  checks: z.array(
    z.strictObject({
      external: externalIdentitySchema.optional(),
      id: z.string(),
      adapter: z.string(),
      project: z.string(),
      scope: strings,
      kind,
      parser: z.enum(PARSERS),
      commands: z.array(command),
      reason: z.string(),
      unavailableReason: z.string().optional(),
      tools: z.array(toolSpec).optional(),
      environment: strings.optional(),
    }),
  ),
});

export const planSummarySchema = z.strictObject({
  ...metadata,
  selection: selectionSummary.optional(),
  projectCount: count,
  adapters: strings,
  excludedCount: count,
  checks: z.array(z.strictObject({ id: z.string(), kind, ready: z.boolean() })),
});

export const junitImportSchema = z.strictObject({
  ...metadata,
  format: z.literal("junit"),
  provenance: z.literal("imported-report"),
  outcome,
  reason: z.string(),
  tests: tests.optional(),
  cases: z
    .array(
      z.strictObject({
        name: z.string(),
        file: z.string().optional(),
        status: z.enum(["passed", "failed", "skipped"]),
        assertions: count.optional(),
      }),
    )
    .optional(),
});

export {
  findingBaselineSchema,
  findingComparisonSchema,
  findingComparisonSummarySchema,
} from "./finding-policy-schema.js";

export {
  guidanceContextSchema,
  guidanceReportSchema,
  guidanceSummarySchema,
} from "./guidance.js";

export {
  mutationRecipeSchema,
  mutationReportSchema,
  mutationSummarySchema,
} from "./mutation.js";

export { nuxtConfigSchema } from "./nuxt.js";

export {
  reviewSelectionSchema,
  reviewContextSchema,
  reviewContextSummarySchema,
  reviewAssessmentSchema,
  reviewReceiptSchema,
  reviewReceiptSummarySchema,
} from "./review.js";
