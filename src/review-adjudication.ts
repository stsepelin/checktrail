import { createHash } from "node:crypto";
import { createHypothesisPlan } from "./review-hypotheses.js";
import type { ReviewContext } from "./review.js";
import type { ReviewCandidate } from "./review-provider-schema.js";
import type {
  ReviewProbeRecipe,
  ReviewProbeRun,
} from "./review-probe-schema.js";

export interface AdjudicationEvidence {
  target: ReviewCandidate;
  recipe: ReviewProbeRecipe;
  probe: ReviewProbeRun;
  counterclaims: ReviewCandidate[];
}
function hypothesis(candidate: ReviewCandidate) {
  return {
    family: candidate.family,
    claim: candidate.claim,
    trigger: candidate.trigger,
    consequence: candidate.consequence,
    evidenceGaps: candidate.evidenceGaps,
    citations: candidate.citations,
  };
}
/** Internal packet: raw observations, no previous provider labels or verdicts. */
export function createAdjudicationPacket(
  context: ReviewContext,
  evidence: AdjudicationEvidence,
): string {
  const { target, recipe, probe, counterclaims } = evidence;
  return JSON.stringify({
    context,
    hypotheses: createHypothesisPlan(context),
    unverifiedTarget: hypothesis(target),
    unverifiedCounterclaims: counterclaims.map(hypothesis),
    nativeObservations: {
      profile: recipe.profile,
      file: recipe.file,
      exportName: recipe.exportName,
      sourceDigest: probe.sourceDigest,
      workerDigest: probe.workerDigest,
      runtime: probe.runtime,
      functionRange: probe.functionRange,
      guard: recipe.guard,
      minimumTriggerScale: recipe.minimumTriggerScale,
      expectationProvenance: "operator-pinned-expectations",
      executionSandboxed: false,
      cases: recipe.cases.map((item, index) => {
        const trial = probe.trials[index]!;
        return {
          role: item.role,
          args: item.args,
          expected: item.expected,
          actual: trial.actual,
          inputScale: trial.inputScale,
          functionExecuted: trial.functionExecuted,
          guardCoverage: trial.guardCoverage,
          ranges: trial.ranges,
        };
      }),
    },
  });
}
export const adjudicationDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
