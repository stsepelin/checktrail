import { z } from "zod";
import { reviewModelOutputSchema } from "./review-provider-schema.js";
import { reviewWorkflowNativeReceiptSchema } from "./review-workflow-schema.js";
import { reviewContextSchema } from "./review.js";
import { reviewWorkflowAuditSettingsSchema } from "./review-workflow-audit.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export const reviewBenchmarkReferenceSchema = z.strictObject({
  directory: z.string().min(1).max(4096),
  sha256: digest,
});
export const reviewBenchmarkPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("workflow-journal-paired-synthetic-v1"),
  provenance: z.literal("operator-declared-original-synthetic"),
  curatorSessionId: identity,
  repetitions: z.number().int().min(1).max(2),
  runtime: z.strictObject({
    node: identity,
    platform: identity,
    arch: identity,
  }),
  arms: z.tuple([arm(), arm()]),
  cases: z
    .array(
      z.strictObject({
        id: identity,
        group: identity,
        context: reviewContextSchema,
        labels: z.strictObject({
          variant: z.enum(["broken", "fixed", "near-miss"]),
          expectedDefects: z
            .array(
              z.strictObject({
                id: identity,
                claim: z.string().min(1).max(8192),
              }),
            )
            .max(32),
        }),
      }),
    )
    .min(1)
    .max(4),
});
function arm() {
  return z.strictObject({
    id: identity,
    instructions: z.string().min(1).max(8192),
    settings: reviewWorkflowAuditSettingsSchema,
    host: z.strictObject({
      client: identity,
      clientVersion: identity,
      provider: identity,
      model: identity,
    }),
  });
}
export const reviewBenchmarkCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("status") }),
  z.strictObject({
    operation: z.literal("packet"),
    trialId: z.string().uuid(),
  }),
]);
const flags = {
  schemaVersion: z.literal(1),
  profile: z.literal("workflow-journal-paired-synthetic-v1"),
  claimsVerified: z.literal(false),
  hostIsolationVerified: z.literal(false),
  externalAttemptsComplete: z.literal(false),
  qualityAssessed: z.literal(false),
};
export const reviewBenchmarkSummarySchema = z.strictObject({
  ...flags,
  format: z.literal("review-benchmark-summary"),
  runId: z.string().uuid(),
  protocolDigest: digest,
  state: z.enum(["frozen", "collected", "judging-prepared"]),
  planned: z.number().int().min(2).max(16),
  accounted: z.number().int().min(0).max(16),
  completed: z.number().int().min(0).max(16),
  collectionDigest: digest.nullable(),
  sourceIncluded: z.literal(false),
  trials: z
    .array(
      z.strictObject({
        trialId: z.string().uuid(),
        status: z.enum([
          "uncollected",
          "missing",
          "unavailable",
          "invalid",
          "foreign",
          "interrupted",
          "sealed-incomplete",
          "sealed-completed",
        ]),
        journalDigest: digest.nullable(),
        commands: z.number().int().nonnegative().max(2048).nullable(),
        pendingCommands: z.number().int().nonnegative().max(16).nullable(),
      }),
    )
    .min(2)
    .max(16),
});
export const reviewBenchmarkPacketSchema = z.strictObject({
  ...flags,
  format: z.literal("review-benchmark-packet"),
  trialId: z.string().uuid(),
  instructions: z.string().min(1).max(8192),
  context: reviewContextSchema,
  sessionRequirement: z.literal("fresh-host-session"),
  sourceTrust: z.literal("untrusted-source-text"),
  sourceIncluded: z.literal(true),
});
export type ReviewBenchmarkReference = z.infer<
  typeof reviewBenchmarkReferenceSchema
>;
export type ReviewBenchmarkPlan = z.infer<typeof reviewBenchmarkPlanSchema>;
export type ReviewBenchmarkSummary = z.infer<
  typeof reviewBenchmarkSummarySchema
>;
export type ReviewBenchmarkPacket = z.infer<typeof reviewBenchmarkPacketSchema>;

export const reviewBenchmarkJudgingSchema = z.strictObject({
  ...flags,
  format: z.literal("review-benchmark-judging"),
  collectionDigest: digest,
  packets: z
    .array(
      z.strictObject({
        blindId: z.string().uuid(),
        status:
          reviewBenchmarkSummarySchema.shape.trials.element.shape.status.exclude(
            ["uncollected"],
          ),
        context: reviewContextSchema,
        outputs: z.array(reviewModelOutputSchema).max(6),
        native: z
          .array(
            reviewWorkflowNativeReceiptSchema.omit({
              workflowId: true,
              targetHandle: true,
              probeId: true,
            }),
          )
          .max(1),
      }),
    )
    .min(2)
    .max(16),
});
export const reviewBenchmarkWorkerCommandSchema = z.discriminatedUnion(
  "operation",
  [
    z.strictObject({ operation: z.literal("status") }),
    z.strictObject({ operation: z.literal("packet") }),
  ],
);
export const reviewBenchmarkWorkerSummarySchema = z.strictObject({
  ...flags,
  format: z.literal("review-benchmark-worker-summary"),
  protocolDigest: digest,
  state: reviewBenchmarkSummarySchema.shape.state,
  trial: reviewBenchmarkSummarySchema.shape.trials.element,
  sourceIncluded: z.literal(false),
});
