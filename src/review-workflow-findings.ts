import { replayReviewFindings } from "./review-findings.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  reviewFindingJudgmentSchema,
  reviewFindingsInputSchema,
  reviewFindingsReportSchema,
} from "./review-findings-schema.js";
import type { ReviewContext } from "./review.js";
import type { ReviewWorkflowResponse } from "./review-workflow-schema.js";
import type {
  ReviewCandidate,
  ReviewModelOutput,
} from "./review-provider-schema.js";
import type { ReviewProbeRun } from "./review-probe-schema.js";
const text = z.string().trim().min(1).max(4096);
export const reviewWorkflowFindingsDeclarationsSchema = z.strictObject({
  decisions: z
    .array(
      z.strictObject({
        target: z.string().uuid(),
        refutationRationale: text,
        adjudicationRationale: text,
        judgment: reviewFindingJudgmentSchema,
      }),
    )
    .max(32),
  commonDefects: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(128),
        rootFunctionId: z.string().regex(/^[a-f0-9]{64}$/),
        targets: z.array(z.string().uuid()).min(1).max(32),
        rationale: text,
      }),
    )
    .max(32),
});
export type ReviewWorkflowFindingsDeclarations = z.infer<
  typeof reviewWorkflowFindingsDeclarationsSchema
>;
type Host = ReviewWorkflowResponse["host"];
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const session = (host: Host) =>
  hash([host.provider, host.client, host.sessionId]);
/** Internal adapter for an engine-owned quiescent snapshot; never accepts imported workflow receipts. */
export function workflowFindingsInput(
  evidence: {
    context: ReviewContext;
    reviewer: {
      output: ReviewModelOutput;
      host: Host;
      usage: ReviewWorkflowResponse["usage"];
    };
    pending?: Array<{
      target: string;
      candidate: ReviewCandidate;
      run: ReviewProbeRun | null;
    }>;
    cycles: Array<{
      target: string;
      candidate: ReviewCandidate;
      run: ReviewProbeRun;
      refuter: Host;
      adjudicator: Host;
    }>;
  },
  serialized: string,
) {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > 262144)
    throw Error("Bounded workflow findings declarations required");
  const declarations = reviewWorkflowFindingsDeclarationsSchema.parse(
    JSON.parse(serialized),
  );
  const cycles = new Map(evidence.cycles.map((c) => [c.target, c]));
  const targets = new Map([
    ...evidence.cycles.map((c) => [c.target, c] as const),
    ...(evidence.pending ?? []).map((c) => [c.target, c] as const),
  ]);
  const decisions = declarations.decisions.map((d) => {
    const cycle = cycles.get(d.target);
    if (!cycle) throw Error("Unknown workflow findings target");
    return {
      candidateId: cycle.candidate.id,
      contextDigest: evidence.context.contextDigest,
      candidateDigest: hash(cycle.candidate),
      nativeRunDigest: hash(cycle.run),
      nativeCaseIds: cycle.run.trials.map((t) => t.id),
      refutation: {
        state: "completed",
        sessionId: session(cycle.refuter),
        rationale: d.refutationRationale,
      },
      adjudication: {
        state: "completed",
        sessionId: session(cycle.adjudicator),
        rationale: d.adjudicationRationale,
        judgment: d.judgment,
      },
    };
  });
  if (new Set(decisions.map((d) => d.candidateId)).size !== decisions.length)
    throw Error("Unique workflow findings decisions required");
  const commonDefects = declarations.commonDefects.map((g) => ({
    id: g.id,
    rootFunctionId: g.rootFunctionId,
    candidateIds: g.targets.map((target) => {
      const cycle = targets.get(target);
      if (!cycle) throw Error("Unknown common-defect workflow target");
      return cycle.candidate.id;
    }),
    rationale: g.rationale,
  }));
  const reviewer = evidence.reviewer;
  return reviewFindingsInputSchema.parse({
    schemaVersion: 1,
    profile: "source-bound-declared-findings-v1",
    provenance: {
      schemaVersion: 1,
      context: evidence.context,
      assessment: {
        schemaVersion: 2,
        contextDigest: evidence.context.contextDigest,
        reviewer: {
          kind: "model",
          provider: reviewer.host.provider,
          model: reviewer.host.model,
          version: reviewer.host.clientVersion,
        },
        createdAt: new Date().toISOString(),
        usage: reviewer.usage,
        files: reviewer.output.files,
        observations: reviewer.output.candidates.map(
          ({ id, severity, claim, citations, attribution, fixScope }) => ({
            id,
            severity,
            claim,
            citations,
            attribution,
            fixScope,
          }),
        ),
      },
      candidates: reviewer.output.candidates,
      native: [
        ...evidence.cycles.map((c) => ({
          candidateId: c.candidate.id,
          run: c.run,
        })),
        ...(evidence.pending ?? []).flatMap((c) =>
          c.run ? [{ candidateId: c.candidate.id, run: c.run }] : [],
        ),
      ],
      scoring: null,
    },
    reviewerSessionId: session(reviewer.host),
    decisions,
    commonDefects,
  });
}

export const reviewWorkflowFindingsResultSchema = reviewFindingsReportSchema
  .omit({ input: true, receipt: true })
  .extend({
    format: z.literal("review-workflow-findings"),
    detailsIncluded: z.literal(true),
  });
export type ReviewWorkflowFindingsResult = z.infer<
  typeof reviewWorkflowFindingsResultSchema
>;
/** Detailed candidate outcomes without resending captured source, stage prose or native output. */
export function projectWorkflowFindings(
  value: unknown,
): ReviewWorkflowFindingsResult {
  const report = reviewFindingsReportSchema.parse(
    replayReviewFindings(value, true),
  );
  const { input, receipt, ...details } = report;
  void input;
  void receipt;
  return reviewWorkflowFindingsResultSchema.parse({
    ...details,
    format: "review-workflow-findings",
    detailsIncluded: true,
  });
}
