import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { parseReviewContext } from "./review.js";
import {
  runProviderRefutationAssignment,
  createRefutationPacket,
  projectProviderReview,
  parseProviderReview,
  type ReviewProviderOptions,
} from "./review-provider.js";
import {
  reviewCandidateSchema,
  reviewProviderRunSchema,
  reviewProviderSummarySchema,
} from "./review-provider-schema.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const REFUTATION_CHECKS = [
  "current-address",
  "mechanism",
  "defaults",
  "sibling-family",
  "caller-reachability",
  "trigger-scale",
  "test-adequacy",
  "fix-feasibility",
  "change-scope",
] as const;
const check = z.strictObject({
  dimension: z.enum(REFUTATION_CHECKS),
  status: z.literal("not-established"),
});
const common = {
  schemaVersion: z.literal(1),
  format: z.literal("review-refutation-run"),
  channel: z.literal("advisory"),
  claimsVerified: z.literal(false),
  deterministicOutcomeChanged: z.literal(false),
  contextDigest: digest,
  targetDigest: digest,
  assignmentDigest: digest,
  resolution: z.literal("unresolved"),
  disposition: z.enum(["refutation-attempt-completed", "no-complete-attempt"]),
  checks: z.array(check).length(REFUTATION_CHECKS.length),
  independence: z.strictObject({
    targetVisibility: z.literal("one-unverified-hypothesis"),
    priorReviewerResults: z.literal(false),
    originalReviewerIdentity: z.literal(false),
    originalSeverityAndConfidence: z.literal(false),
    nativeEvidenceIncluded: z.literal(false),
  }),
};
export const reviewRefutationRunSchema = z.strictObject({
  ...common,
  target: reviewCandidateSchema,
  verifier: reviewProviderRunSchema,
});
export const reviewRefutationSummarySchema = z.strictObject({
  ...common,
  verifier: reviewProviderSummarySchema,
  sourceIncluded: z.literal(false),
});
export type ReviewRefutationRun = z.infer<typeof reviewRefutationRunSchema>;
const hash = (input: unknown): string =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
export async function runProviderRefutation(
  root: string,
  contextInput: unknown,
  candidateInput: unknown,
  options: ReviewProviderOptions,
): Promise<ReviewRefutationRun> {
  const context = parseReviewContext(contextInput);
  const target = reviewCandidateSchema.parse(candidateInput);
  const verifier = await runProviderRefutationAssignment(
    root,
    context,
    target,
    options,
  );
  return parseProviderRefutation({
    schemaVersion: 1,
    format: "review-refutation-run",
    channel: "advisory",
    claimsVerified: false,
    deterministicOutcomeChanged: false,
    contextDigest: context.contextDigest,
    targetDigest: hash(target),
    assignmentDigest: createHash("sha256")
      .update(createRefutationPacket(context, target))
      .digest("hex"),
    target,
    verifier,
    resolution: "unresolved",
    disposition:
      verifier.status === "completed"
        ? "refutation-attempt-completed"
        : "no-complete-attempt",
    checks: REFUTATION_CHECKS.map((dimension) => ({
      dimension,
      status: "not-established",
    })),
    independence: {
      targetVisibility: "one-unverified-hypothesis",
      priorReviewerResults: false,
      originalReviewerIdentity: false,
      originalSeverityAndConfidence: false,
      nativeEvidenceIncluded: false,
    },
  });
}
export function parseProviderRefutation(input: unknown): ReviewRefutationRun {
  const run = reviewRefutationRunSchema.parse(input);
  parseProviderReview(run.verifier);
  if (
    run.targetDigest !== hash(run.target) ||
    run.assignmentDigest !== run.verifier.packetDigest ||
    run.contextDigest !== run.verifier.contextDigest ||
    !isDeepStrictEqual(
      run.checks.map((item) => item.dimension),
      REFUTATION_CHECKS,
    ) ||
    (run.disposition === "refutation-attempt-completed") !==
      (run.verifier.status === "completed")
  )
    throw new Error(
      "Refutation binding and attempt accounting do not reconcile",
    );
  return run;
}
export function projectProviderRefutation(
  input: unknown,
  detailed: boolean,
  allowReviewSource: boolean,
): Record<string, unknown> {
  const run = parseProviderRefutation(input);
  if (detailed && allowReviewSource) return run;
  const { target, verifier, ...metadata } = run;
  void target;
  return reviewRefutationSummarySchema.parse({
    ...metadata,
    verifier: projectProviderReview(verifier, false, false),
    sourceIncluded: false,
  });
}
