import { z } from "zod";
import { reviewFamilySchema } from "./review-hypotheses.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(1_000_000_000);
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const span = z.strictObject({ start: count, end: count });
export const reviewProbeRecipeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("node-export-boolean-v1"),
  id: identifier,
  family: reviewFamilySchema,
  file: z.string().min(1).max(1024),
  exportName: identifier,
  minimumTriggerScale: z.number().int().min(1).max(1024),
  guard: span.nullable(),
  cases: z
    .array(
      z.strictObject({
        id: identifier,
        role: z.enum(["baseline", "trigger", "near-miss"]),
        args: z.array(z.json()).max(8),
        expected: z.boolean(),
      }),
    )
    .min(3)
    .max(16),
});
export const reviewProbeWireSchema = z.strictObject({
  requestDigest: digest,
  sourceDigest: digest,
  actual: z.boolean(),
  functionRange: span,
  ranges: z.array(span.extend({ count })).min(1).max(128),
});
export const reviewNativeBudgetLimitsSchema = z.strictObject({
  maxCalls: z.number().int().min(0).max(16),
  maxOutputBytes: z.number().int().min(0).max(16_777_216),
});
export type ReviewNativeBudgetLimits = z.infer<
  typeof reviewNativeBudgetLimitsSchema
>;
const execution = z.strictObject({
  call: z.number().int().min(1).max(16),
  outputLimitBytes: z.number().int().min(1).max(1_048_576),
  outputBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  truncated: z.boolean(),
});
const nativeBudget = z.strictObject({
  scope: z.literal("native-probe-run"),
  limits: reviewNativeBudgetLimitsSchema.extend({
    wallMs: z.number().int().min(1).max(120_000),
    maxCallOutputBytes: z.number().int().min(1).max(1_048_576),
  }),
  calls: z.number().int().nonnegative().max(16),
  outputBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  stopReason: z.enum(["none", "call-limit", "output-limit"]),
  outputByteCeilingGuaranteed: z.literal(false),
});
const trial = z.strictObject({
  id: identifier,
  role: z.enum(["baseline", "trigger", "near-miss"]),
  status: z.enum(["observed", "unresolved", "not-run"]),
  reason: z.enum([
    "boolean-observed",
    "scale-not-met",
    "guard-not-covered",
    "runtime-error",
    "malformed-evidence",
    "timeout",
    "cancelled",
    "output-limit",
    "budget-exhausted",
    "not-started",
    "call-limit",
    "output-budget",
    "cleanup-failed",
  ]),
  inputScale: count,
  functionExecuted: z.boolean(),
  guardCoverage: z.enum([
    "not-requested",
    "executed",
    "not-executed",
    "unknown",
  ]),
  expected: z.boolean(),
  actual: z.boolean().nullable(),
  matchesExpectation: z.boolean().nullable(),
  durationMs: count,
  ranges: z.array(span.extend({ count })).max(128),
});
const metadata = {
  format: z.literal("review-probe-run"),
  engineVersion: z.string(),
  channel: z.literal("advisory"),
  claimsVerified: z.literal(false),
  deterministicOutcomeChanged: z.literal(false),
  nativeExecution: z.boolean(),
  executionSandboxed: z.literal(false),
  profile: z.literal("node-export-boolean-v1"),
  recipeDigest: digest,
  workerDigest: digest,
  sourceDigest: digest,
  functionRange: span,
  minimumTriggerScale: z.number().int().min(1).max(1024),
  guard: span.nullable(),
  contextDigest: digest,
  candidateDigest: digest,
  runtime: z.strictObject({ name: z.literal("node"), version: z.string() }),
  status: z.enum([
    "completed",
    "incomplete",
    "cancelled",
    "timed-out",
    "stale",
    "unsupported",
  ]),
  behavior: z.enum(["violated", "satisfied", "unresolved"]),
  requirementProvenance: z.literal("operator-pinned-expectations"),
  callerReachability: z.literal("not-established"),
  mechanismVerified: z.literal(false),
  fixVerified: z.literal(false),
  freshness: z.enum(["current", "stale"]),
  temporaryArtifacts: z.enum(["removed", "cleanup-failed", "not-created"]),
  counts: z.strictObject({
    selected: count,
    observed: count,
    unresolved: count,
    notRun: count,
    triggerMismatches: count,
    controlMismatches: count,
  }),
};
export const reviewProbeRunSchema = z.discriminatedUnion("schemaVersion", [
  z.strictObject({
    ...metadata,
    schemaVersion: z.literal(1),
    trials: z.array(trial).max(16),
  }),
  z.strictObject({
    ...metadata,
    schemaVersion: z.literal(2),
    nativeBudget,
    trials: z.array(trial.extend({ execution: execution.nullable() })).max(16),
  }),
]);
export const reviewProbeSummarySchema = z.discriminatedUnion("schemaVersion", [
  z.strictObject({
    ...metadata,
    schemaVersion: z.literal(1),
    sourceIncluded: z.literal(false),
  }),
  z.strictObject({
    ...metadata,
    schemaVersion: z.literal(2),
    nativeBudget,
    sourceIncluded: z.literal(false),
  }),
]);
export type ReviewProbeRecipe = z.infer<typeof reviewProbeRecipeSchema>;
export type ReviewProbeRun = z.infer<typeof reviewProbeRunSchema>;
