import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  reviewProbeRecipeSchema,
  reviewProbeRunSchema,
} from "./review-probe-schema.js";
import { createHypothesisPlan } from "./review-hypotheses.js";
import type { ReviewContext } from "./review.js";
import {
  projectReviewCandidateForIndependentStage,
  type ReviewCandidate,
} from "./review-provider-schema.js";
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
const hypothesis = projectReviewCandidateForIndependentStage;
const probeFields = reviewProbeRunSchema.options[0].shape;
const probeCase = probeFields.trials.element.shape;
const recipeFields = reviewProbeRecipeSchema.options[0].shape;
const booleanNativeObservationSchema = z.strictObject({
  profile: recipeFields.profile,
  file: recipeFields.file,
  exportName: recipeFields.exportName,
  sourceDigest: probeFields.sourceDigest,
  workerDigest: probeFields.workerDigest,
  runtime: probeFields.runtime,
  functionRange: probeFields.functionRange,
  guard: recipeFields.guard,
  minimumTriggerScale: recipeFields.minimumTriggerScale,
  expectationProvenance: z.literal("operator-pinned-expectations"),
  executionSandboxed: z.literal(false),
  cases: z
    .array(
      z.strictObject({
        role: recipeFields.cases.element.shape.role,
        args: recipeFields.cases.element.shape.args,
        expected: probeCase.expected,
        actual: probeCase.actual,
        inputScale: probeCase.inputScale,
        functionExecuted: probeCase.functionExecuted,
        guardCoverage: probeCase.guardCoverage,
        ranges: probeCase.ranges,
      }),
    )
    .min(3)
    .max(16),
});
export const reviewNativeObservationSchema = z.discriminatedUnion("profile", [
  booleanNativeObservationSchema,
  booleanNativeObservationSchema.extend({
    profile: z.literal("node-export-json-v1"),
    cases: z
      .array(
        booleanNativeObservationSchema.shape.cases.element.extend({
          expected: z.json(),
          actual: z.json().nullable(),
        }),
      )
      .min(3)
      .max(16),
  }),
]);
/** Raw case observations only; prior labels, aggregate verdicts and model metadata stay private. */
export function projectReviewNativeObservations(
  recipe: ReviewProbeRecipe,
  probe: ReviewProbeRun,
) {
  if (
    recipe.profile !== probe.profile ||
    recipe.cases.length !== probe.trials.length ||
    recipe.cases.some((c, i) => {
      const t = probe.trials[i]!;
      return (
        c.id !== t.id ||
        c.role !== t.role ||
        !isDeepStrictEqual(c.expected, t.expected)
      );
    })
  )
    throw new Error("Independent native case identities disagree");
  return reviewNativeObservationSchema.parse({
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
  });
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
    nativeObservations: projectReviewNativeObservations(recipe, probe),
  });
}
export const adjudicationDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
