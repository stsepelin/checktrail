import { z } from "zod";
import { capturedProcessOutputSchema } from "./process-output.js";
export const nativeMutationProfiles = [
  "vitest-flat-tests",
  "jest-flat-tests",
  "pytest-flat-tests",
  "phpunit-flat-tests",
] as const;
const count = z.number().int().nonnegative(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export const mutationNativeRelative = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^(?![A-Za-z]:)(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^\\\0\r\n]+$/,
  );
export const nativeMutationRecipeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.enum(nativeMutationProfiles),
  mutations: z
    .array(
      z.strictObject({
        id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-z0-9][a-z0-9.-]*$/),
        file: mutationNativeRelative,
        expected: z.string().min(1).max(4096),
        replacement: z.string().max(4096),
      }),
    )
    .min(1)
    .max(8),
});
export const nativeMutationCaseSchema = z.strictObject({
  id: z.string().min(1).max(2048),
  file: mutationNativeRelative,
  line: z.number().int().positive(),
  name: z.string().min(1).max(1024),
  status: z.enum([
    "passed",
    "assertion-failure",
    "skipped",
    "setup-error",
    "execution-error",
  ]),
});
export const nativeMutationObservationSchema = z.strictObject({
  runId: z.string().uuid(),
  outcome: z.enum([
    "passed",
    "assertion-failure",
    "skipped",
    "setup-error",
    "execution-error",
    "inconclusive",
    "unavailable",
  ]),
  durationMs: count,
  sourceFingerprint: digest,
  sourceChanged: z.boolean(),
  sourceError: z.boolean(),
  dependencyFingerprint: digest.nullable(),
  dependenciesChanged: z.boolean(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  truncated: z.boolean(),
  cleanupError: z.boolean(),
  processError: z.boolean(),
  capturedOutput: capturedProcessOutputSchema,
  outputBytes: count,
  stdoutSha256: digest,
  stderrSha256: digest,
  tests: z
    .strictObject({
      total: count,
      passed: count,
      failed: count,
      skipped: count,
    })
    .optional(),
  cases: z.array(nativeMutationCaseSchema).max(256),
});
const metadata = {
  schemaVersion: z.literal(1),
  engineVersion: z.string(),
  profile: z.enum(nativeMutationProfiles),
  channel: z.literal("advisory"),
  provenance: z.literal("temporary-copy-mutation-experiment"),
  recipeDigest: digest,
  sourceFingerprint: digest,
  finalSourceFingerprint: digest.nullable(),
  dependencyFingerprint: digest.nullable(),
  finalDependencyFingerprint: digest.nullable(),
  complete: z.boolean(),
  reason: z.string(),
  durationMs: count,
  runtime: z.strictObject({
    name: z.literal("node"),
    version: z.string(),
    platform: z.string(),
    arch: z.string(),
    selectedRunner: z.strictObject({ name: z.string(), version: z.string() }),
  }),
  counts: z.strictObject({
    total: count,
    killed: count,
    survived: count,
    skipped: count,
    setupError: count,
    executionError: count,
    invalid: count,
    inconclusive: count,
    notRun: count,
  }),
};
export const nativeMutationReportSchema = z.strictObject({
  ...metadata,
  excluded: z.array(z.string()),
  baseline: nativeMutationObservationSchema.optional(),
  trials: z
    .array(
      z.strictObject({
        id: z.string(),
        file: mutationNativeRelative,
        status: z.enum([
          "killed",
          "survived",
          "skipped",
          "setup-error",
          "execution-error",
          "invalid",
          "inconclusive",
          "not-run",
        ]),
        reason: z.string(),
        observation: nativeMutationObservationSchema.optional(),
      }),
    )
    .max(8),
});
export const nativeMutationSummarySchema = z.strictObject(metadata);
export type NativeMutationRecipe = z.infer<typeof nativeMutationRecipeSchema>;
export type NativeMutationReport = z.infer<typeof nativeMutationReportSchema>;
export type NativeMutationObservation = z.infer<
  typeof nativeMutationObservationSchema
>;
export type NativeMutationCase = z.infer<typeof nativeMutationCaseSchema>;
export type NativeMutationProfile = NativeMutationRecipe["profile"];
