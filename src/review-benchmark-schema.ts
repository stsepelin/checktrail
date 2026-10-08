import { z } from "zod";
import { reviewNativeObservationSchema } from "./review-adjudication.js";
import { reviewFamilySchema } from "./review-hypotheses.js";
import {
  reviewPairedProtocolSchema,
  reviewPairedReportSchema,
  reviewPairedSummarySchema,
} from "./review-paired-scoring.js";
import {
  reviewCandidateSchema,
  reviewBlindCandidateSchema,
  reviewModelOutputSchema,
} from "./review-provider-schema.js";
import { reviewWorkflowNativeReceiptSchema } from "./review-workflow-schema.js";
import { reviewContextSchema } from "./review.js";
import { reviewWorkflowAuditSettingsSchema } from "./review-workflow-audit.js";
import {
  reviewMultiReportSchema,
  reviewMultiSummarySchema,
} from "./review-multi-scoring.js";
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
export const reviewBenchmarkJudgeProfileSchema = z.strictObject({
  instructions: z.string().min(1).max(8192),
  host: z.strictObject({
    client: identity,
    clientVersion: identity,
    provider: identity,
    model: identity,
  }),
});
const judgmentStatus = z.enum([
  "missing",
  "unavailable",
  "invalid",
  "foreign",
  "incomplete",
  "accepted",
]);
export const reviewBenchmarkJudgmentSummarySchema = z.strictObject({
  planned: z.number().int().min(2).max(16),
  accounted: z.number().int().min(0).max(16),
  accepted: z.number().int().min(0).max(16),
  resolved: z.number().int().min(0).max(16),
  archiveDigest: digest.nullable(),
});
export const reviewBenchmarkScoringProfileSchema = z.strictObject({
  profile: z.literal("sealed-single-claim-paired-synthetic-v1"),
  seed: reviewPairedProtocolSchema.shape.seed,
  resamples: reviewPairedProtocolSchema.shape.resamples,
  confidenceLevel: reviewPairedProtocolSchema.shape.confidenceLevel,
  cases: z
    .array(z.strictObject({ id: identity, family: reviewFamilySchema }))
    .min(1)
    .max(4),
});
export const reviewBenchmarkMultiProfileSchema = z.strictObject({
  profile: z.literal("sealed-multi-claim-paired-synthetic-v1"),
  seed: reviewPairedProtocolSchema.shape.seed,
  resamples: reviewPairedProtocolSchema.shape.resamples,
  confidenceLevel: reviewPairedProtocolSchema.shape.confidenceLevel,
  matching: reviewBenchmarkJudgeProfileSchema,
  cases: z
    .array(
      z.strictObject({
        id: identity,
        defects: z
          .array(
            z.strictObject({
              id: identity,
              family: reviewFamilySchema,
              material: z.boolean(),
            }),
          )
          .max(32),
      }),
    )
    .min(1)
    .max(4),
});
const scoreCount = z.number().int().min(0).max(512);
const scoreFields = {
  schemaVersion: z.literal(1),
  profile: reviewBenchmarkScoringProfileSchema.shape.profile,
  protocolDigest: digest,
  collectionDigest: digest,
  judgingDigest: digest,
  judgmentsDigest: digest,
  scoringParametersDigest: digest,
  armDigests: z.tuple([digest, digest]),
  accounting: z.strictObject({
    plannedTrials: scoreCount,
    selectedPairs: scoreCount,
    completedTrials: scoreCount,
    retainedClaims: scoreCount,
    unscoredClaims: scoreCount,
    missingJudgments: scoreCount,
    rejectedJudgments: scoreCount,
    unresolvedClaimJudgments: scoreCount,
    labelDisagreements: scoreCount,
    unknownJudgeLabels: scoreCount,
    unexpectedFamilyClaims: scoreCount,
    declaredClaimProbabilities: scoreCount,
    unknownClaimProbabilities: scoreCount,
  }),
  scoringReady: z.boolean(),
  artifactBindingsChecked: z.literal(true),
  pairingBoundToManifest: z.literal(true),
  labelSource: z.literal("frozen-declared-synthetic-case-variants"),
  probabilitiesAvailable: z.boolean(),
  probabilitySource: z.literal(
    "sealed-host-declared-uncalibrated-claim-probability",
  ),
  sourceIncluded: z.literal(false),
  claimsVerified: z.literal(false),
  labelsVerified: z.literal(false),
  hostIsolationVerified: z.literal(false),
  externalAttemptsComplete: z.literal(false),
  calibratedConfidence: z.literal(false),
  qualityAssessed: z.literal(false),
  inferenceInvoked: z.literal(false),
  fieldEvaluationExecuted: z.literal(false),
};
export const reviewBenchmarkScoreReportSchema = z.strictObject({
  ...scoreFields,
  format: z.literal("review-benchmark-scoring-report"),
  paired: reviewPairedReportSchema,
});
export const reviewBenchmarkScoreSummarySchema = z.strictObject({
  ...scoreFields,
  format: z.literal("review-benchmark-scoring-summary"),
  paired: reviewPairedSummarySchema,
});
export const reviewBenchmarkPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("workflow-journal-paired-synthetic-v1"),
  provenance: z.literal("operator-declared-original-synthetic"),
  curatorSessionId: identity,
  judging: reviewBenchmarkJudgeProfileSchema.optional(),
  scoring: reviewBenchmarkScoringProfileSchema.optional(),
  multiScoring: reviewBenchmarkMultiProfileSchema.optional(),
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
    settings: reviewWorkflowAuditSettingsSchema.omit({ candidateScope: true }),
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
  state: z.enum([
    "frozen",
    "collected",
    "judging-prepared",
    "judgments-sealed",
    "matching-prepared",
    "mappings-sealed",
  ]),
  judgments: reviewBenchmarkJudgmentSummarySchema.nullable().optional(),
  mappings: reviewBenchmarkJudgmentSummarySchema.nullable().optional(),
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

const judgingEvidence = reviewBenchmarkJudgingSchema.shape.packets.element;
const blindOutput = reviewModelOutputSchema.extend({
  candidates: z.array(reviewBlindCandidateSchema).max(32),
});
const blindEvidence = judgingEvidence.extend({
  outputs: z.array(blindOutput).max(6),
  native: z
    .array(
      z.strictObject({
        candidate: reviewBlindCandidateSchema,
        observations: reviewNativeObservationSchema,
      }),
    )
    .max(1),
});
export const reviewBenchmarkJudgePacketSchema = z.strictObject({
  ...flags,
  format: z.literal("review-benchmark-judge-packet"),
  blindId: z.string().uuid(),
  assignmentDigest: digest,
  instructions: z.string().min(1).max(8192),
  sessionRequirement: z.literal("fresh-host-session"),
  sourceTrust: z.literal("untrusted-source-and-review-text"),
  sourceIncluded: z.literal(true),
  evidence: blindEvidence,
  claims: z
    .array(
      z.strictObject({
        claimId: digest,
        candidate: reviewBlindCandidateSchema,
      }),
    )
    .max(192),
});
export const reviewBenchmarkJudgmentOutputSchema = z.strictObject({
  label: z.enum(["defect", "valid", "near-miss", "unresolved"]),
  rationale: z.string().min(1).max(4096),
  citations: z.array(reviewCandidateSchema.shape.citations.element).max(8),
  claims: z
    .array(
      z.strictObject({
        claimId: digest,
        judgement: z.enum([
          "supported",
          "wrong-mechanism",
          "wrong-address",
          "unreachable-fix",
          "out-of-scope",
          "refuted",
          "unresolved",
        ]),
        rationale: z.string().min(1).max(4096),
        citations: z
          .array(reviewCandidateSchema.shape.citations.element)
          .max(8),
      }),
    )
    .max(192),
});
export const reviewBenchmarkJudgmentResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  blindId: z.string().uuid(),
  assignmentDigest: digest,
  host: reviewBenchmarkJudgeProfileSchema.shape.host.extend({
    sessionId: identity,
    isolation: z.enum(["fresh", "unknown"]),
  }),
  status: z.enum([
    "completed",
    "incomplete",
    "refused",
    "unavailable",
    "cancelled",
  ]),
  usage: z.strictObject({
    inputTokens: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    outputTokens: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    durationMs: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    costUSD: z.number().nonnegative().max(1_000_000).nullable(),
  }),
  output: reviewBenchmarkJudgmentOutputSchema.nullable(),
});
export const reviewBenchmarkJudgeWorkerSummarySchema = z.strictObject({
  ...flags,
  format: z.literal("review-benchmark-judge-worker-summary"),
  state: reviewBenchmarkSummarySchema.shape.state,
  blindId: z.string().uuid(),
  status: judgmentStatus.nullable(),
  responseDigest: digest.nullable(),
  sourceIncluded: z.literal(false),
});
export const reviewBenchmarkJudgmentArchiveSchema = z.strictObject({
  schemaVersion: z.literal(1),
  protocolDigest: digest,
  collectionDigest: digest,
  judgingDigest: digest,
  createdAt: z.string().datetime(),
  judgments: z
    .array(
      z.strictObject({
        blindId: z.string().uuid(),
        status: judgmentStatus,
        responseDigest: digest.nullable(),
        responseBase64: z.string().max(349528).nullable(),
      }),
    )
    .min(2)
    .max(16),
});
export type ReviewBenchmarkJudgePacket = z.infer<
  typeof reviewBenchmarkJudgePacketSchema
>;
export type ReviewBenchmarkJudgmentResponse = z.infer<
  typeof reviewBenchmarkJudgmentResponseSchema
>;

// Matching sees the frozen common inventory after independent judgments are sealed.
// It is curation, never another blinded review or proof of an authoritative label.
export const reviewBenchmarkMatchingPacketSchema = z.strictObject({
  ...flags,
  format: z.literal("review-benchmark-matching-packet"),
  matchingId: z.string().uuid(),
  assignmentDigest: digest,
  instructions: z.string().min(1).max(8192),
  context: reviewContextSchema,
  claims: reviewBenchmarkJudgePacketSchema.shape.claims,
  defects: z
    .array(
      z.strictObject({
        id: digest,
        family: reviewFamilySchema,
        claim: z.string().min(1).max(8192),
      }),
    )
    .max(32),
  sessionRequirement: z.literal("fresh-host-session"),
  sourceTrust: z.literal("untrusted-source-and-review-text"),
  sourceIncluded: z.literal(true),
  expectedInventoryIncluded: z.literal(true),
  priorVerdictsIncluded: z.literal(false),
});
export const reviewBenchmarkMatchingResponseSchema =
  reviewBenchmarkJudgmentResponseSchema
    .omit({ blindId: true, output: true })
    .extend({
      matchingId: z.string().uuid(),
      output: z
        .array(
          z.strictObject({
            claimId: digest,
            match: z.enum(["defect", "none", "unresolved"]),
            defectId: digest.nullable(),
            rationale: z.string().min(1).max(4096),
            citations: reviewBenchmarkJudgmentOutputSchema.shape.citations,
          }),
        )
        .max(192)
        .nullable(),
    });
export const reviewBenchmarkMatchingBookSchema = z.strictObject({
  schemaVersion: z.literal(1),
  protocolDigest: digest,
  collectionDigest: digest,
  judgingDigest: digest,
  judgmentsDigest: digest,
  slots: z
    .array(
      z.strictObject({
        matchingId: z.string().uuid(),
        assignmentDigest: digest,
      }),
    )
    .min(2)
    .max(16),
});
export const reviewBenchmarkMappingArchiveSchema =
  reviewBenchmarkMatchingBookSchema.omit({ slots: true }).extend({
    matchingDigest: digest,
    createdAt: z.string().datetime(),
    mappings: z
      .array(
        z.strictObject({
          matchingId: z.string().uuid(),
          status: judgmentStatus,
          responseDigest: digest.nullable(),
          responseBase64: z.string().max(349528).nullable(),
        }),
      )
      .min(2)
      .max(16),
  });
export const reviewBenchmarkMatchingWorkerSummarySchema = z.strictObject({
  ...flags,
  format: z.literal("review-benchmark-matching-worker-summary"),
  matchingId: z.string().uuid(),
  state: z.enum(["matching-prepared", "mappings-sealed"]),
  status: judgmentStatus.nullable(),
  responseDigest: digest.nullable(),
  sourceIncluded: z.literal(false),
});
const multiScoreFields = {
  ...flags,
  profile: reviewBenchmarkMultiProfileSchema.shape.profile,
  protocolDigest: digest,
  collectionDigest: digest,
  judgingDigest: digest,
  judgmentsDigest: digest,
  matchingDigest: digest,
  mappingsDigest: digest,
  scoringParametersDigest: digest,
  armDigests: z.tuple([digest, digest]),
  accounting: z.strictObject({
    plannedTrials: scoreCount,
    selectedPairs: scoreCount,
    completedTrials: scoreCount,
    retainedClaims: z.number().int().min(0).max(4096),
    unscoredClaims: z.number().int().min(0).max(4096),
    missingJudgments: scoreCount,
    rejectedJudgments: scoreCount,
    missingMappings: scoreCount,
    rejectedMappings: scoreCount,
    unresolvedClaims: z.number().int().min(0).max(4096),
    labelDisagreements: scoreCount,
  }),
  scoringReady: z.boolean(),
  artifactBindingsChecked: z.literal(true),
  pairingBoundToManifest: z.literal(true),
  labelSource: z.literal("frozen-declared-synthetic-defect-inventory"),
  probabilitySource: z.literal(
    "sealed-host-declared-uncalibrated-claim-probability",
  ),
  sourceIncluded: z.literal(false),
  labelsVerified: z.literal(false),
  calibratedConfidence: z.literal(false),
  inferenceInvoked: z.literal(false),
  fieldEvaluationExecuted: z.literal(false),
};
export const reviewBenchmarkMultiScoreReportSchema = z.strictObject({
  ...multiScoreFields,
  format: z.literal("review-benchmark-multi-scoring-report"),
  multi: reviewMultiReportSchema,
});
export const reviewBenchmarkMultiScoreSummarySchema = z.strictObject({
  ...multiScoreFields,
  format: z.literal("review-benchmark-multi-scoring-summary"),
  multi: reviewMultiSummarySchema,
});
