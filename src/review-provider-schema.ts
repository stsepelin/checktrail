import { z } from "zod";
import { reviewFamilySchema } from "./review-hypotheses.js";
import { reviewReceiptSchema } from "./review.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const model = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export const reviewAdmissionBudgetSchema = z.strictObject({
  inputTokenAllowance: z.number().int().min(1).max(1_048_576),
  maxTotalTokens: z.number().int().min(0).max(2_000_000),
  maxEstimatedCostMicrousd: z
    .number()
    .int()
    .min(0)
    .max(1_000_000_000_000)
    .nullable(),
});
export const reviewAggregateBudgetLimitsSchema =
  reviewAdmissionBudgetSchema.extend({
    maxCalls: z.number().int().min(0).max(6),
    maxRequestBodyBytes: z.number().int().min(0).max(6_291_456),
    maxResponseBodyBytes: z.number().int().min(0).max(6_291_456),
  });
const rates = z.strictObject({
  inputUSDPerMillion: z.number().nonnegative().max(1_000_000),
  outputUSDPerMillion: z.number().nonnegative().max(1_000_000),
});
export const reviewProviderBudgetSchema = z.strictObject({
  profile: z.literal("reported-usage-admission-v1"),
  operatorRates: rates.nullable(),
  reservationTokens: count,
  reservationMicrousd: count.nullable(),
  observedTokens: count.nullable(),
  observedMicrousd: count.nullable(),
  decision: z.enum([
    "within-budget",
    "reservation-does-not-fit",
    "usage-unknown",
    "input-allowance-exceeded",
    "output-allowance-exceeded",
    "token-limit-exceeded",
    "cost-limit-exceeded",
    "pricing-unavailable",
  ]),
  inputAllowanceVerified: z.literal(false),
  billingCeilingGuaranteed: z.literal(false),
});
export const reviewProviderConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.enum(["openai-responses", "anthropic-messages"]),
  model,
  credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  limits: z.strictObject({
    wallMs: z.number().int().min(1).max(120_000),
    maxAttempts: z.number().int().min(1).max(3),
    retryDelayMs: z.number().int().min(0).max(5000),
    maxRequestBytes: z.number().int().min(1).max(1_048_576),
    maxResponseBytes: z.number().int().min(1).max(1_048_576),
    maxOutputTokens: z.number().int().min(1).max(65_536),
    admissionBudget: reviewAdmissionBudgetSchema.optional(),
    aggregateBudget: reviewAggregateBudgetLimitsSchema.optional(),
  }),
  pricing: z
    .strictObject({
      inputUSDPerMillion: z.number().nonnegative().max(1_000_000),
      outputUSDPerMillion: z.number().nonnegative().max(1_000_000),
      reference: z.string().min(1).max(1024),
    })
    .nullable(),
});
const relative = z.string().min(1).max(1024);
export const reviewCandidateSchema = z.strictObject({
  id: z.string().min(1).max(128),
  family: reviewFamilySchema,
  severity: z.enum(["suggestion", "concern"]),
  claim: z.string().min(1).max(4096),
  trigger: z.string().min(1).max(2048),
  consequence: z.string().min(1).max(2048),
  evidenceGaps: z.array(z.string().min(1).max(1024)).max(16),
  attribution: z.enum(["regression", "pre-existing", "unknown"]),
  fixScope: z.enum(["this-change", "follow-up", "unknown"]),
  citations: z
    .array(
      z.strictObject({
        file: relative,
        revision: z.enum(["base", "current"]),
        sourceDigest: digest,
        startLine: z.number().int().min(1).max(65537),
        endLine: z.number().int().min(1).max(65537),
        quote: z.string().min(1).max(2048),
      }),
    )
    .min(1)
    .max(8),
});
export const reviewModelOutputSchema = z.strictObject({
  files: z
    .array(
      z.strictObject({
        path: relative,
        disposition: z.enum(["reviewed", "not-reviewed"]),
        note: z.string().max(1024),
      }),
    )
    .max(16),
  candidates: z.array(reviewCandidateSchema).max(32),
});
export const reviewAttemptStatusSchema = z.enum([
  "completed",
  "capacity",
  "rate-limited",
  "authentication",
  "unavailable",
  "refused",
  "output-limit",
  "incomplete",
  "malformed",
  "tool-request",
  "transport-error",
  "timed-out",
  "cancelled",
  "budget-exhausted",
]);
const usage = z.strictObject({
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  costUSD: z.number().nonnegative().max(1_000_000).nullable(),
  costProvenance: z.enum(["unknown", "operator-rates-estimate"]),
});
export const reviewProviderAttemptSchema = z.strictObject({
  id: z.string().uuid(),
  status: reviewAttemptStatusSchema,
  durationMs: count,
  responseBytes: count,
  // Optional only for retained version 1 reports from before body accounting.
  requestBytes: count.optional(),
  observedModel: z.string().min(1).max(256).nullable(),
  usage,
});
export const reviewAggregateBudgetSchema = reviewProviderBudgetSchema.extend({
  profile: z.literal("reported-usage-run-admission-v1"),
  id: z.string().uuid(),
  priorAttempts: z.array(reviewProviderAttemptSchema).max(3),
  requestBytes: count,
  observedCalls: z.number().int().min(0).max(6),
  observedRequestBodyBytes: count,
  observedResponseBodyBytes: count,
  transportByteCeilingGuaranteed: z.literal(false),
  decision: z.enum([
    ...reviewProviderBudgetSchema.shape.decision.options,
    "call-limit-exceeded",
    "request-byte-limit-exceeded",
    "response-byte-limit-exceeded",
    "response-reservation-does-not-fit",
  ]),
});
const common = {
  schemaVersion: z.literal(1),
  format: z.literal("review-provider-run"),
  engineVersion: z.string(),
  channel: z.literal("advisory"),
  claimsVerified: z.literal(false),
  automatedCoverage: z.literal(false),
  deterministicOutcomeChanged: z.literal(false),
  runId: z.string().uuid(),
  contextDigest: digest,
  configDigest: digest,
  packetDigest: digest,
  catalogueDigest: digest,
  provider: z.enum(["openai-responses", "anthropic-messages"]),
  requestedModel: model,
  status: z.enum([
    "completed",
    "incomplete",
    "cancelled",
    "timed-out",
    "stale",
    "budget-exhausted",
    "unavailable",
  ]),
  disposition: z.enum(["advisory-completed", "no-complete-review"]),
  freshness: z.enum(["current", "stale", "not-checked"]),
  durationMs: count,
  limits: reviewProviderConfigSchema.shape.limits,
  budget: reviewProviderBudgetSchema.optional(),
  aggregateBudget: reviewAggregateBudgetSchema.optional(),
  attempts: z.array(reviewProviderAttemptSchema).max(3),
  usage: usage.extend({
    attemptsWithUnknownUsage: z.number().int().min(0).max(3),
  }),
  independence: z.strictObject({
    profile: z.literal("stateless-inline-api-v1"),
    priorMessages: z.literal(0),
    tools: z.literal(0),
    historyRetrieval: z.literal(false),
    localMemory: z.literal(false),
    providerTrainingContamination: z.literal("unknown"),
    providerRetention: z.literal("provider-policy"),
  }),
  nativeExecution: z.literal(false),
  selectedPaths: z.number().int().min(1).max(16),
  declaredReviewed: z.number().int().min(0).max(16),
  declaredNotReviewed: z.number().int().min(0).max(16),
  unaccounted: z.number().int().min(0).max(16),
};
export const reviewProviderRunSchema = z.strictObject({
  ...common,
  candidates: z.array(reviewCandidateSchema).max(32),
  receipt: reviewReceiptSchema.nullable(),
});
export const reviewProviderSummarySchema = z.strictObject({
  ...common,
  candidates: z.number().int().min(0).max(32),
  matchedCitations: count,
  unmatchedCitations: count,
  sourceIncluded: z.literal(false),
});
export type ReviewProviderConfig = z.infer<typeof reviewProviderConfigSchema>;
export type ReviewCandidate = z.infer<typeof reviewCandidateSchema>;
export type ReviewModelOutput = z.infer<typeof reviewModelOutputSchema>;
export type ReviewProviderRun = z.infer<typeof reviewProviderRunSchema>;
export type ReviewAttemptStatus = z.infer<typeof reviewAttemptStatusSchema>;

export type ReviewProviderBudget = z.infer<typeof reviewProviderBudgetSchema>;
