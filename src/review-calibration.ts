import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { reviewFamilySchema } from "./review-hypotheses.js";
import {
  reviewScoringInputSchema,
  reviewScoringProtocolSchema,
  reviewScoringReportSchema,
  scoreReviewTrials,
} from "./review-scoring.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(256);
const probability = z.number().min(0).max(1);
const count = z.number().int().min(0).max(512);
export const reviewCalibrationModelSchema = z.strictObject({
  client: identity,
  clientVersion: identity,
  provider: identity,
  model: identity,
});
export const reviewCalibrationInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("declared-family-isotonic-v1"),
  model: reviewCalibrationModelSchema,
  training: reviewScoringInputSchema,
  reservedEvaluation: reviewScoringProtocolSchema,
});
const metrics = z.strictObject({
  aggregate: reviewScoringReportSchema.shape.aggregate,
  families: reviewScoringReportSchema.shape.families,
});
const accounting = z.strictObject({
  selected: count,
  eligible: count,
  missing: count,
  incomplete: count,
  abstained: count,
  unknownJudgement: count,
  unknownProbability: count,
});
const point = z.strictObject({
  score: probability,
  fittedProbability: probability,
  count: count,
  positives: count,
});
const curve = z.strictObject({
  family: reviewFamilySchema,
  state: z.enum([
    "available",
    "insufficient-training",
    "one-class",
    "constant-predictor",
  ]),
  eligible: count,
  positives: count,
  negatives: count,
  distinctProbabilities: count,
  distinctDeclaredClusters: count,
  points: z.array(point).max(512).nullable(),
});
const flags = {
  schemaVersion: z.literal(1),
  profile: z.literal("declared-family-isotonic-v1"),
  method: z.literal("tie-pooled-weighted-pava-with-linear-interpolation"),
  outsideSupport: z.literal("unknown-no-extrapolation"),
  channel: z.literal("advisory"),
  nativeExecution: z.literal(false),
  claimsVerified: z.literal(false),
  labelsVerified: z.literal(false),
  calibratedConfidence: z.literal(false),
  modelIdentityVerified: z.literal(false),
  splitIsolationVerified: z.literal(false),
  protocolFreezeVerified: z.literal(false),
  independenceVerified: z.literal(false),
  declaredSplitDisjoint: z.literal(true),
  qualityGate: z.literal("not-assessed"),
  deterministicOutcomeChanged: z.literal(false),
  inferenceInvoked: z.literal(false),
  fieldEvaluationExecuted: z.literal(false),
};
const fitFields = {
  ...flags,
  fitDigest: digest,
  trainingProtocolDigest: digest,
  observationsDigest: digest,
  reservedProtocolDigest: digest,
  state: z.enum(["available", "partial", "unavailable"]),
  accounting,
  trainingRaw: metrics,
  trainingMapped: metrics,
};
export const reviewCalibrationReportSchema = z.strictObject({
  ...fitFields,
  format: z.literal("review-calibration-report"),
  curves: z.array(curve).min(1).max(9),
  input: reviewCalibrationInputSchema,
});
export const reviewCalibrationSummarySchema = z.strictObject({
  ...fitFields,
  format: z.literal("review-calibration-summary"),
  sourceIncluded: z.literal(false),
  curves: z
    .array(
      curve.omit({ points: true }).extend({ pointsIncluded: z.literal(false) }),
    )
    .min(1)
    .max(9),
});
export const reviewCalibrationApplicationInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("declared-family-isotonic-application-v1"),
  model: reviewCalibrationModelSchema,
  fit: reviewCalibrationReportSchema,
  evaluation: reviewScoringInputSchema,
});
const mapping = z.strictObject({
  id: reviewScoringProtocolSchema.shape.trials.element.shape.id,
  state: z.enum([
    "available",
    "not-a-finding",
    "unknown-probability",
    "unseen-family",
    "fit-unavailable",
    "outside-training-support",
  ]),
  rawProbability: probability.nullable(),
  mappedProbability: probability.nullable(),
});
const applicationFields = {
  ...flags,
  profile: z.literal("declared-family-isotonic-application-v1"),
  fitDigest: digest,
  evaluationProtocolDigest: digest,
  observationsDigest: digest,
  modelBindingChecked: z.literal(true),
  mappings: z.strictObject({
    observed: count,
    available: count,
    notAFinding: count,
    unknownProbability: count,
    unseenFamily: count,
    fitUnavailable: count,
    outsideTrainingSupport: count,
  }),
  raw: metrics,
  mapped: metrics,
};
export const reviewCalibrationApplicationReportSchema = z.strictObject({
  ...applicationFields,
  format: z.literal("review-calibration-application-report"),
  rows: z.array(mapping).max(512),
  input: reviewCalibrationApplicationInputSchema,
});
export const reviewCalibrationApplicationSummarySchema = z.strictObject({
  ...applicationFields,
  format: z.literal("review-calibration-application-summary"),
  sourceIncluded: z.literal(false),
});
export type ReviewCalibrationReport = z.infer<
  typeof reviewCalibrationReportSchema
>;
export type ReviewCalibrationApplicationReport = z.infer<
  typeof reviewCalibrationApplicationReportSchema
>;
type Input = z.infer<typeof reviewCalibrationInputSchema>;
type Curve = z.infer<typeof curve>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const declaredFlags = {
  schemaVersion: 1,
  profile: "declared-family-isotonic-v1",
  method: "tie-pooled-weighted-pava-with-linear-interpolation",
  outsideSupport: "unknown-no-extrapolation",
  channel: "advisory",
  nativeExecution: false,
  claimsVerified: false,
  labelsVerified: false,
  calibratedConfidence: false,
  modelIdentityVerified: false,
  splitIsolationVerified: false,
  protocolFreezeVerified: false,
  independenceVerified: false,
  declaredSplitDisjoint: true,
  qualityGate: "not-assessed",
  deterministicOutcomeChanged: false,
  inferenceInvoked: false,
  fieldEvaluationExecuted: false,
} as const;
function canonical(value: unknown) {
  const input = scoreReviewTrials(value).input;
  input.protocol.trials.sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  input.observations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return input;
}
function metricReport(value: unknown) {
  const report = scoreReviewTrials(value);
  return { aggregate: report.aggregate, families: report.families };
}
function interpolate(
  points: NonNullable<Curve["points"]>,
  score: number,
): number | null {
  if (score < points[0]!.score || score > points.at(-1)!.score) return null;
  const high = points.findIndex((p) => p.score >= score);
  const right = points[high]!;
  if (score === right.score) return right.fittedProbability;
  const left = points[high - 1]!;
  return (
    left.fittedProbability +
    ((score - left.score) / (right.score - left.score)) *
      (right.fittedProbability - left.fittedProbability)
  );
}
/** Fit only declared development claims. No project/model execution or calibrated-quality assertion. */
export function fitReviewCalibration(value: unknown): ReviewCalibrationReport {
  const parsed = reviewCalibrationInputSchema.parse(value);
  const training = canonical(parsed.training);
  const reserved = canonical({
    protocol: parsed.reservedEvaluation,
    observations: [],
  }).protocol;
  if (
    training.protocol.purpose !== "development" ||
    reserved.purpose !== "held-out"
  )
    throw new Error(
      "Calibration requires development training and a reserved held-out protocol",
    );
  const ids = new Set(training.protocol.trials.map((t) => t.id));
  const groups = new Set(training.protocol.trials.map((t) => t.clusterId));
  if (reserved.trials.some((t) => ids.has(t.id) || groups.has(t.clusterId)))
    throw new Error(
      "Calibration training and reserved trial/cluster identities overlap",
    );
  const input: Input = { ...parsed, training, reservedEvaluation: reserved };
  const byId = new Map(training.observations.map((o) => [o.id, o]));
  const totals = {
    selected: training.protocol.trials.length,
    eligible: 0,
    missing: 0,
    incomplete: 0,
    abstained: 0,
    unknownJudgement: 0,
    unknownProbability: 0,
  };
  const eligible: {
    family: z.infer<typeof reviewFamilySchema>;
    score: number;
    y: number;
    clusterId: string;
  }[] = [];
  for (const trial of training.protocol.trials) {
    const obs = byId.get(trial.id);
    if (!obs) totals.missing++;
    else if (obs.status !== "completed") totals.incomplete++;
    else if (obs.decision !== "finding") totals.abstained++;
    else if (obs.judgement === "unresolved") totals.unknownJudgement++;
    else if (obs.probability === null) totals.unknownProbability++;
    else {
      totals.eligible++;
      eligible.push({
        family: trial.family,
        score: obs.probability,
        y: obs.judgement === "supported" ? 1 : 0,
        clusterId: trial.clusterId,
      });
    }
  }
  const curves = [...new Set(training.protocol.trials.map((t) => t.family))]
    .sort()
    .map((family): Curve => {
      const rows = eligible
        .filter((r) => r.family === family)
        .sort((a, b) => a.score - b.score);
      const ties: { score: number; count: number; positives: number }[] = [];
      for (const row of rows) {
        const last = ties.at(-1);
        if (last?.score === row.score) {
          last.count++;
          last.positives += row.y;
        } else ties.push({ score: row.score, count: 1, positives: row.y });
      }
      const positives = rows.reduce((n, r) => n + r.y, 0);
      const common = {
        family,
        eligible: rows.length,
        positives,
        negatives: rows.length - positives,
        distinctProbabilities: ties.length,
        distinctDeclaredClusters: new Set(rows.map((r) => r.clusterId)).size,
      };
      if (rows.length < 2)
        return { ...common, state: "insufficient-training", points: null };
      if (!positives || positives === rows.length)
        return { ...common, state: "one-class", points: null };
      if (ties.length < 2)
        return { ...common, state: "constant-predictor", points: null };
      const blocks: {
        start: number;
        end: number;
        count: number;
        positives: number;
      }[] = [];
      for (let i = 0; i < ties.length; i++) {
        blocks.push({
          start: i,
          end: i,
          count: ties[i]!.count,
          positives: ties[i]!.positives,
        });
        while (blocks.length > 1) {
          const a = blocks.at(-2)!,
            b = blocks.at(-1)!;
          if (a.positives / a.count <= b.positives / b.count) break;
          blocks.splice(-2, 2, {
            start: a.start,
            end: b.end,
            count: a.count + b.count,
            positives: a.positives + b.positives,
          });
        }
      }
      const points = ties.map((p) => ({ ...p, fittedProbability: 0 }));
      for (const block of blocks)
        for (let i = block.start; i <= block.end; i++)
          points[i]!.fittedProbability = block.positives / block.count;
      return { ...common, state: "available", points };
    });
  const fitByFamily = new Map(curves.map((c) => [c.family, c]));
  const familyById = new Map(
    training.protocol.trials.map((t) => [t.id, t.family]),
  );
  const mappedTraining = {
    ...training,
    observations: training.observations.map((o) => {
      const c = fitByFamily.get(familyById.get(o.id)!)!;
      return {
        ...o,
        probability:
          o.decision === "finding" && o.probability !== null && c.points
            ? interpolate(c.points, o.probability)
            : null,
      };
    }),
  };
  const available = curves.filter((c) => c.state === "available").length;
  return reviewCalibrationReportSchema.parse({
    ...declaredFlags,
    format: "review-calibration-report",
    fitDigest: hash(input),
    trainingProtocolDigest: hash(training.protocol),
    observationsDigest: hash(training.observations),
    reservedProtocolDigest: hash(reserved),
    state:
      available === curves.length
        ? "available"
        : available
          ? "partial"
          : "unavailable",
    accounting: totals,
    curves,
    trainingRaw: metricReport(training),
    trainingMapped: metricReport(mappedTraining),
    input,
  });
}
function checkedFit(value: unknown) {
  const report = reviewCalibrationReportSchema.parse(value);
  if (!isDeepStrictEqual(report, fitReviewCalibration(report.input)))
    throw new Error(
      "Calibration fit evidence and derived values do not reconcile",
    );
  return report;
}
export function projectReviewCalibration(value: unknown, detailed: boolean) {
  const report = checkedFit(value);
  if (detailed) return report;
  const { input, curves, ...rest } = report;
  void input;
  return reviewCalibrationSummarySchema.parse({
    ...rest,
    format: "review-calibration-summary",
    sourceIncluded: false,
    curves: curves.map(({ points, ...c }) => {
      void points;
      return { ...c, pointsIncluded: false };
    }),
  });
}
/** Apply a frozen fit only to its declared evaluation protocol/model. Availability is not calibration proof. */
export function applyReviewCalibration(
  value: unknown,
): ReviewCalibrationApplicationReport {
  const parsed = reviewCalibrationApplicationInputSchema.parse(value),
    fit = checkedFit(parsed.fit),
    evaluation = canonical(parsed.evaluation);
  if (
    !isDeepStrictEqual(parsed.model, fit.input.model) ||
    !isDeepStrictEqual(evaluation.protocol, fit.input.reservedEvaluation)
  )
    throw new Error(
      "Calibration application model or reserved evaluation protocol disagrees",
    );
  const input = { ...parsed, fit, evaluation };
  const familyById = new Map(
    evaluation.protocol.trials.map((t) => [t.id, t.family]),
  );
  const curves = new Map(fit.curves.map((c) => [c.family, c]));
  const rows = evaluation.observations.map((o): z.infer<typeof mapping> => {
    const c = curves.get(familyById.get(o.id)!);
    const base = {
      id: o.id,
      rawProbability: o.probability,
      mappedProbability: null,
    };
    if (o.decision !== "finding") return { ...base, state: "not-a-finding" };
    if (o.probability === null)
      return { ...base, state: "unknown-probability" };
    if (!c) return { ...base, state: "unseen-family" };
    if (!c.points) return { ...base, state: "fit-unavailable" };
    const mappedProbability = interpolate(c.points, o.probability);
    return {
      ...base,
      state:
        mappedProbability === null ? "outside-training-support" : "available",
      mappedProbability,
    };
  });
  const byId = new Map(rows.map((r) => [r.id, r.mappedProbability]));
  const mappedInput = {
    ...evaluation,
    observations: evaluation.observations.map((o) => ({
      ...o,
      probability: byId.get(o.id) ?? null,
    })),
  };
  const total = (state: z.infer<typeof mapping>["state"]) =>
    rows.filter((r) => r.state === state).length;
  return reviewCalibrationApplicationReportSchema.parse({
    ...declaredFlags,
    profile: "declared-family-isotonic-application-v1",
    format: "review-calibration-application-report",
    fitDigest: fit.fitDigest,
    evaluationProtocolDigest: hash(evaluation.protocol),
    observationsDigest: hash(evaluation.observations),
    modelBindingChecked: true,
    mappings: {
      observed: rows.length,
      available: total("available"),
      notAFinding: total("not-a-finding"),
      unknownProbability: total("unknown-probability"),
      unseenFamily: total("unseen-family"),
      fitUnavailable: total("fit-unavailable"),
      outsideTrainingSupport: total("outside-training-support"),
    },
    raw: metricReport(evaluation),
    mapped: metricReport(mappedInput),
    rows,
    input,
  });
}
export function projectReviewCalibrationApplication(
  value: unknown,
  detailed: boolean,
) {
  const report = reviewCalibrationApplicationReportSchema.parse(value);
  if (!isDeepStrictEqual(report, applyReviewCalibration(report.input)))
    throw new Error(
      "Calibration application evidence and derived values do not reconcile",
    );
  if (detailed) return report;
  const { input, rows, ...rest } = report;
  void input;
  void rows;
  return reviewCalibrationApplicationSummarySchema.parse({
    ...rest,
    format: "review-calibration-application-summary",
    sourceIncluded: false,
  });
}
