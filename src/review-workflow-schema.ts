import { z } from "zod";
import {
  reviewModelOutputSchema,
  reviewCandidateSchema,
} from "./review-provider-schema.js";
import { reviewProbeRunSchema } from "./review-probe-schema.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export const reviewWorkflowSelectedLimitsSchema = z.strictObject({
  maxWorkflows: z.number().int().min(0).max(16),
  maxAssignments: z.number().int().min(0).max(6),
  wallMs: z.number().int().min(1).max(3_600_000),
  maxPacketBytes: z.number().int().min(0).max(8_388_608),
  maxResponseBytes: z.number().int().min(0).max(262_144),
  maxRetainedBytes: z.number().int().min(0).max(16_777_216),
});
export const reviewWorkflowAllLimitsSchema =
  reviewWorkflowSelectedLimitsSchema.extend({
    maxAssignments: z.number().int().min(0).max(128),
    maxNativeCalls: z.number().int().min(0).max(512),
    maxNativeOutputBytes: z.number().int().min(0).max(16_777_216),
  });
export const reviewWorkflowLimitsSchema = z.union([
  reviewWorkflowSelectedLimitsSchema,
  reviewWorkflowAllLimitsSchema,
]);
export const reviewWorkflowResponseSchema = z.strictObject({
  assignmentId: z.string().uuid(),
  assignmentDigest: digest,
  host: z.strictObject({
    client: identity,
    clientVersion: identity,
    provider: identity,
    model: identity,
    sessionId: identity,
    session: z.enum(["fresh", "unknown"]),
  }),
  status: z.enum([
    "completed",
    "incomplete",
    "refused",
    "unavailable",
    "cancelled",
  ]),
  usage: z.strictObject({
    inputTokens: count.nullable(),
    outputTokens: count.nullable(),
    elapsedMs: count.nullable(),
    costUSD: z.number().nonnegative().max(1_000_000).nullable(),
  }),
  output: reviewModelOutputSchema.nullable(),
});
export const reviewWorkflowCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("open"),
    context: z.string().min(1).max(1024),
  }),
  z.strictObject({
    operation: z.literal("next"),
    workflowId: z.string().uuid(),
    target: z.string().uuid().optional(),
  }),
  z.strictObject({
    operation: z.literal("submit"),
    workflowId: z.string().uuid(),
    response: z.unknown(),
  }),
  z.strictObject({
    operation: z.literal("probe"),
    workflowId: z.string().uuid(),
    probeId: z.string().min(1).max(64),
  }),
  z.strictObject({
    operation: z.literal("status"),
    workflowId: z.string().uuid(),
  }),
  z.strictObject({
    operation: z.literal("close"),
    workflowId: z.string().uuid(),
  }),
]);
export const reviewWorkflowStageSchema = z.enum([
  "reviewer",
  "refuter",
  "adjudicator",
]);
const flags = {
  engineVersion: z.string().min(1).max(128),
  channel: z.literal("advisory"),
  claimsVerified: z.literal(false),
  deterministicOutcomeChanged: z.literal(false),
  hostIsolationVerified: z.literal(false),
};
export const reviewWorkflowAssignmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.literal("review-workflow-assignment"),
  ...flags,
  assignmentId: z.string().uuid(),
  assignmentDigest: digest,
  stage: reviewWorkflowStageSchema,
  contextDigest: digest,
  instructions: z.string().max(8192),
  packet: z.string().max(8_388_608),
  responseSchema: z.string().max(65536),
  sessionRequirement: z.literal("fresh-host-session"),
  sourceTrust: z.literal("untrusted-source-text"),
});
const attempt = z.strictObject({
  assignmentId: z.string().uuid(),
  assignmentDigest: digest,
  stage: reviewWorkflowStageSchema,
  status: z.enum([
    "awaiting-host",
    "accepted",
    "malformed",
    "invalid-binding",
    "host-session-reused",
    "host-independence-unknown",
    "response-limit",
    "incomplete",
    "refused",
    "unavailable",
    "cancelled",
    "timed-out",
    "stale",
  ]),
  packetBytes: count,
  responseBytes: count,
  responseDigest: digest.nullable(),
  host: reviewWorkflowResponseSchema.shape.host.nullable(),
  usage: reviewWorkflowResponseSchema.shape.usage.nullable(),
  declaredCandidates: z.number().int().min(0).max(32),
});
export const reviewWorkflowSelectedSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.literal("review-workflow-summary"),
  ...flags,
  workflowId: z.string().uuid(),
  contextDigest: digest,
  status: z.enum([
    "ready",
    "awaiting-host",
    "running-native",
    "completed",
    "incomplete",
    "stale",
    "cancelled",
    "timed-out",
    "closed",
  ]),
  nextStage: z.enum([
    "reviewer",
    "refuter",
    "probe",
    "adjudicator",
    "finished",
  ]),
  stopReason: z.enum([
    "none",
    "assignments-exhausted",
    "packet-limit",
    "retention-limit",
    "stale",
    "cancelled",
    "timed-out",
    "native-incomplete",
    "native-error",
    "closed",
  ]),
  disposition: z.enum([
    "not-complete",
    "no-candidates-declared",
    "advisory-stages-completed",
  ]),
  resolution: z.literal("unresolved"),
  severity: z.literal("unassigned"),
  candidateHandles: z.array(z.string().uuid()).max(32),
  selectedTarget: z.string().uuid().nullable(),
  unverifiedCandidates: z.number().int().min(0).max(32),
  limits: reviewWorkflowSelectedLimitsSchema,
  assignments: z.array(attempt).max(6),
  issuedPacketBytes: count,
  responseBytes: count,
  retainedBytes: count,
  native: z.strictObject({
    status: z.enum([
      "not-started",
      "running",
      "cancellation-pending",
      "completed",
      "incomplete",
      "cancelled",
      "timed-out",
      "stale",
      "error",
    ]),
    calls: count.nullable(),
    outputBytes: count.nullable(),
    accountingComplete: z.boolean(),
    rawEvidenceRetained: z.boolean(),
  }),
  hostProvenance: z.literal("host-declared-unverified"),
  usageProvenance: z.literal("host-declared-unverified"),
  hostModelBudgetsEnforced: z.literal(false),
  sourceIncluded: z.literal(false),
});
export const reviewWorkflowAllSummarySchema =
  reviewWorkflowSelectedSummarySchema
    .extend({
      schemaVersion: z.literal(2),
      candidateScope: z.literal("all"),
      completedTargets: z.array(z.string().uuid()).max(32),
      limits: reviewWorkflowAllLimitsSchema,
      assignments: z.array(attempt).max(128),
    })
    .superRefine((value, ctx) => {
      const handles = new Set(value.candidateHandles);
      if (
        handles.size !== value.candidateHandles.length ||
        new Set(value.completedTargets).size !==
          value.completedTargets.length ||
        value.completedTargets.some((id) => !handles.has(id)) ||
        (value.selectedTarget !== null && !handles.has(value.selectedTarget)) ||
        (value.disposition === "advisory-stages-completed" &&
          value.completedTargets.length !== handles.size)
      )
        ctx.addIssue({
          code: "custom",
          message: "All-candidate coverage does not reconcile",
        });
    });
export const reviewWorkflowSummarySchema = z.discriminatedUnion(
  "schemaVersion",
  [reviewWorkflowSelectedSummarySchema, reviewWorkflowAllSummarySchema],
);
export type ReviewWorkflowLimits = z.infer<typeof reviewWorkflowLimitsSchema>;
export type ReviewWorkflowAssignment = z.infer<
  typeof reviewWorkflowAssignmentSchema
>;
export type ReviewWorkflowSummary = z.infer<typeof reviewWorkflowSummarySchema>;
export type ReviewWorkflowResponse = z.infer<
  typeof reviewWorkflowResponseSchema
>;

/** Operator-bound structured evidence, never returned by the workflow tool. */
export const reviewWorkflowNativeReceiptSchema = z.strictObject({
  workflowId: z.string().uuid(),
  targetHandle: z.string().uuid(),
  probeId: z.string().min(1).max(64),
  candidate: reviewCandidateSchema,
  recipe: z.strictObject({ contents: z.string().max(65536), sha256: digest }),
  run: reviewProbeRunSchema,
});
export type ReviewWorkflowNativeReceipt = z.infer<
  typeof reviewWorkflowNativeReceiptSchema
>;
