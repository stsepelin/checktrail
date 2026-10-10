import type { TestContext } from "node:test";
import { setup, source, pin } from "./review-workflow-fixture.js";
import { runReviewProbe } from "../src/review-probe.js";
import { reviewProvenanceInputSchema } from "../src/review-provenance.js";
export async function provenanceFixture(
  t: TestContext,
  content = source,
  native = true,
) {
  const original = await setup(t, content),
    target = {
      ...original.target,
      confidence: {
        profile: "declared-claim-support-probability-v1" as const,
        event: "supported-in-scope-actionable" as const,
        probability: 0.95,
        calibratedConfidence: false as const,
      },
    };
  const input = reviewProvenanceInputSchema.parse({
    schemaVersion: 1,
    context: original.context,
    assessment: {
      schemaVersion: 2,
      contextDigest: original.context.contextDigest,
      reviewer: {
        kind: "model",
        provider: "original-host",
        model: "original-model",
        version: "fixture-1",
      },
      createdAt: new Date().toISOString(),
      usage: {
        inputTokens: null,
        outputTokens: null,
        elapsedMs: null,
        costUSD: null,
      },
      files: [
        {
          path: "subject.mjs",
          disposition: "reviewed",
          note: "Original declared review",
        },
      ],
      observations: [
        {
          id: target.id,
          severity: target.severity,
          claim: target.claim,
          citations: target.citations,
          attribution: target.attribution,
          fixScope: target.fixScope,
        },
      ],
    },
    candidates: [target],
    native: [],
    scoring: {
      protocol: {
        schemaVersion: 1,
        profile: "declared-claim-probability-v1",
        purpose: "development",
        confidenceThresholds: [0, 0.5, 0.9],
        trials: [
          target.id,
          "OriginalUnsupported",
          "OriginalUnreviewed",
          "OriginalAbstained",
        ].map((id) => ({ id, clusterId: id, family: target.family })),
      },
      observations: [
        {
          id: target.id,
          status: "completed",
          decision: "finding",
          probability: 0.95,
          label: "defect",
          judgement: "supported",
        },
        {
          id: "OriginalUnsupported",
          status: "unsupported",
          decision: "abstain",
          probability: null,
          label: "unresolved",
          judgement: "none",
        },
        {
          id: "OriginalAbstained",
          status: "completed",
          decision: "abstain",
          probability: null,
          label: "valid",
          judgement: "none",
        },
      ],
      bindings: [
        target.id,
        "OriginalUnsupported",
        "OriginalUnreviewed",
        "OriginalAbstained",
      ].map((trialId) => ({
        trialId,
        candidateId: trialId === target.id ? target.id : null,
        file: "subject.mjs",
        sourceDigest: original.context.files[0]!.sha256,
      })),
    },
  });
  if (native)
    input.native.push({
      candidateId: target.id,
      run: await runReviewProbe(
        original.root,
        input.context,
        input.candidates[0],
        { trusted: true, recipe: pin(), timeoutMs: 12000 },
      ),
    });
  return { ...original, target: input.candidates[0]!, input };
}
