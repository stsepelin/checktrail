import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { reviewFamilySchema } from "./review-hypotheses.js";
const count = z.number().int().min(0).max(512);
const probability = z.number().min(0).max(1);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewScoringProtocolSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("declared-claim-probability-v1"),
  purpose: z.enum(["development", "held-out"]),
  confidenceThresholds: z.array(probability).min(1).max(16),
  trials: z
    .array(z.strictObject({ id, clusterId: id, family: reviewFamilySchema }))
    .min(1)
    .max(512),
});
export const reviewScoringObservationSchema = z.strictObject({
  id,
  status: z.enum([
    "completed",
    "unsupported",
    "incomplete",
    "budget-exhausted",
    "unreviewed",
    "stale",
    "cancelled",
  ]),
  decision: z.enum(["finding", "abstain"]),
  probability: probability.nullable(),
  label: z.enum(["defect", "valid", "near-miss", "unresolved"]),
  judgement: z.enum([
    "supported",
    "wrong-mechanism",
    "wrong-address",
    "unreachable-fix",
    "out-of-scope",
    "refuted",
    "unresolved",
    "none",
  ]),
});
export const reviewScoringInputSchema = z.strictObject({
  protocol: reviewScoringProtocolSchema,
  observations: z.array(reviewScoringObservationSchema).max(512),
});
const fraction = z.strictObject({
  numerator: count,
  denominator: count,
  value: probability.nullable(),
});
const metrics = z.strictObject({
  selected: count,
  statuses: z.strictObject({
    completed: count,
    unsupported: count,
    incomplete: count,
    "budget-exhausted": count,
    unreviewed: count,
    stale: count,
    cancelled: count,
  }),
  labels: z.strictObject({
    defect: count,
    valid: count,
    "near-miss": count,
    unresolved: count,
  }),
  findings: count,
  supported: count,
  errors: count,
  unresolvedFindings: count,
  unknownProbabilities: count,
  missingObservations: count,
  precision: fraction,
  materialDefectRecall: fraction,
  completedCoverage: fraction,
  falseAlarmRate: fraction,
  nearMissFalseAlarmRate: fraction,
  oneSided95: z.strictObject({
    method: z.literal("exact-binomial-inversion"),
    assumption: z.literal("independent-Bernoulli-trials-not-verified"),
    eligible: z.boolean(),
    precisionLower: probability.nullable(),
    falseAlarmUpper: probability.nullable(),
    nearMissFalseAlarmUpper: probability.nullable(),
  }),
  properScores: z.strictObject({
    scored: count,
    unscoredFindings: count,
    brier: probability.nullable(),
    negativeLogLikelihood: z.number().nonnegative().max(1000).nullable(),
    infiniteLogLoss: count,
  }),
  reliability: z
    .array(
      z.strictObject({
        lower: probability,
        upper: probability,
        scored: count,
        unscored: count,
        meanProbability: probability.nullable(),
        supportedFraction: probability.nullable(),
      }),
    )
    .length(10),
  riskCoverage: z
    .array(
      z.strictObject({
        threshold: probability,
        selected: count,
        findings: count,
        supported: count,
        unresolved: count,
        coverage: fraction,
        conservativeRisk: fraction,
      }),
    )
    .min(1)
    .max(16),
});
const common = {
  schemaVersion: z.literal(1),
  format: z.literal("review-scoring-report"),
  profile: z.literal("declared-claim-probability-v1"),
  protocolDigest: digest,
  observationsDigest: digest,
  purpose: z.enum(["development", "held-out"]),
  channel: z.literal("advisory"),
  nativeExecution: z.literal(false),
  claimsVerified: z.literal(false),
  calibratedConfidence: z.literal(false),
  independenceVerified: z.literal(false),
  inputProvenance: z.literal("operator-supplied-unverified-labels"),
  qualityGate: z.literal("not-assessed"),
  deterministicOutcomeChanged: z.literal(false),
  aggregate: metrics,
  families: z
    .array(z.strictObject({ family: reviewFamilySchema, metrics }))
    .min(1)
    .max(9),
};
export const reviewScoringReportSchema = z.strictObject({
  ...common,
  input: reviewScoringInputSchema,
});
export const reviewScoringSummarySchema = z.strictObject({
  ...common,
  sourceIncluded: z.literal(false),
});
export type ReviewScoringReport = z.infer<typeof reviewScoringReportSchema>;
type Observation = z.infer<typeof reviewScoringObservationSchema>;
type Row = Observation & {
  clusterId: string;
  family: z.infer<typeof reviewFamilySchema>;
  missing: boolean;
};
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rate = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  value: denominator ? numerator / denominator : null,
});

/** Exact binomial inversion with bounded counts; independence is an explicit unverified assumption. */
export function reviewBinomialLower95(
  successes: number,
  trials: number,
): number | null {
  if (
    !Number.isInteger(successes) ||
    !Number.isInteger(trials) ||
    trials < 0 ||
    trials > 512 ||
    successes < 0 ||
    successes > trials
  )
    throw new Error("Invalid binomial evidence counts");
  if (!trials) return null;
  if (!successes) return 0;
  if (successes === trials) return Math.pow(0.05, 1 / trials);
  const logFactorial = [0];
  for (let k = 1; k <= trials; k++)
    logFactorial.push(logFactorial[k - 1]! + Math.log(k));
  const terms = Array.from({ length: trials - successes + 1 }, (_, offset) => {
    const k = successes + offset;
    return {
      k,
      choose:
        logFactorial[trials]! - logFactorial[k]! - logFactorial[trials - k]!,
    };
  });
  let lower = 0,
    upper = 1;
  for (let iteration = 0; iteration < 64; iteration++) {
    const p = (lower + upper) / 2;
    const tail = terms.reduce(
      (sum, { k, choose }) =>
        sum +
        Math.exp(choose + k * Math.log(p) + (trials - k) * Math.log1p(-p)),
      0,
    );
    if (tail < 0.05) lower = p;
    else upper = p;
  }
  return (lower + upper) / 2;
}
function summarize(rows: Row[], thresholds: number[]) {
  const statuses = {
    completed: 0,
    unsupported: 0,
    incomplete: 0,
    "budget-exhausted": 0,
    unreviewed: 0,
    stale: 0,
    cancelled: 0,
  };
  const labels = { defect: 0, valid: 0, "near-miss": 0, unresolved: 0 };
  for (const row of rows) {
    statuses[row.status]++;
    labels[row.label]++;
  }
  const findings = rows.filter((row) => row.decision === "finding");
  const supported = findings.filter(
    (row) => row.judgement === "supported",
  ).length;
  const unresolved = findings.filter(
    (row) => row.judgement === "unresolved",
  ).length;
  const completedValid = rows.filter(
    (row) => row.status === "completed" && row.label === "valid",
  );
  const completedNear = rows.filter(
    (row) => row.status === "completed" && row.label === "near-miss",
  );
  const falseAlarms = completedValid.filter(
    (row) => row.decision === "finding",
  ).length;
  const nearAlarms = completedNear.filter(
    (row) => row.decision === "finding",
  ).length;
  const eligible =
    new Set(rows.map((row) => row.clusterId)).size === rows.length;
  const lower = eligible
    ? reviewBinomialLower95(supported, findings.length)
    : null;
  const upper = (alarms: number, total: number) => {
    const complement = eligible
      ? reviewBinomialLower95(total - alarms, total)
      : null;
    return complement === null ? null : 1 - complement;
  };
  const scored = findings.filter(
    (row) => row.probability !== null && row.judgement !== "unresolved",
  );
  let brier = 0,
    logLoss = 0,
    infiniteLogLoss = 0;
  for (const row of scored) {
    const y = row.judgement === "supported" ? 1 : 0;
    const p = row.probability!;
    brier += (p - y) ** 2;
    const likelihood = y ? p : 1 - p;
    if (likelihood === 0) infiniteLogLoss++;
    else logLoss += y ? -Math.log(p) : -Math.log1p(-p);
  }
  return {
    selected: rows.length,
    statuses,
    labels,
    findings: findings.length,
    supported,
    errors: findings.length - supported - unresolved,
    unresolvedFindings: unresolved,
    unknownProbabilities: findings.filter((row) => row.probability === null)
      .length,
    missingObservations: rows.filter((row) => row.missing).length,
    precision: rate(supported, findings.length),
    materialDefectRecall: rate(supported, labels.defect),
    completedCoverage: rate(statuses.completed, rows.length),
    falseAlarmRate: rate(falseAlarms, completedValid.length),
    nearMissFalseAlarmRate: rate(nearAlarms, completedNear.length),
    oneSided95: {
      method: "exact-binomial-inversion" as const,
      assumption: "independent-Bernoulli-trials-not-verified" as const,
      eligible,
      precisionLower: lower,
      falseAlarmUpper: upper(falseAlarms, completedValid.length),
      nearMissFalseAlarmUpper: upper(nearAlarms, completedNear.length),
    },
    properScores: {
      scored: scored.length,
      unscoredFindings: findings.length - scored.length,
      brier: scored.length ? brier / scored.length : null,
      negativeLogLikelihood:
        scored.length && !infiniteLogLoss ? logLoss / scored.length : null,
      infiniteLogLoss,
    },
    reliability: Array.from({ length: 10 }, (_, index) => {
      const bucket = findings.filter(
        (row) =>
          row.probability !== null &&
          Math.min(9, Math.floor(row.probability * 10)) === index,
      );
      const known = bucket.filter((row) => row.judgement !== "unresolved");
      return {
        lower: index / 10,
        upper: (index + 1) / 10,
        scored: known.length,
        unscored: bucket.length - known.length,
        meanProbability: known.length
          ? known.reduce((sum, row) => sum + row.probability!, 0) / known.length
          : null,
        supportedFraction: known.length
          ? known.filter((row) => row.judgement === "supported").length /
            known.length
          : null,
      };
    }),
    riskCoverage: thresholds.map((threshold) => {
      const accepted = findings.filter(
        (row) => row.probability !== null && row.probability >= threshold,
      );
      const successes = accepted.filter(
        (row) => row.judgement === "supported",
      ).length;
      return {
        threshold,
        selected: rows.length,
        findings: accepted.length,
        supported: successes,
        unresolved: accepted.filter((row) => row.judgement === "unresolved")
          .length,
        coverage: rate(accepted.length, rows.length),
        conservativeRisk: rate(accepted.length - successes, accepted.length),
      };
    }),
  };
}
export function scoreReviewTrials(input: unknown): ReviewScoringReport {
  const packet = reviewScoringInputSchema.parse(input);
  const { protocol, observations } = packet;
  const ids = new Set(protocol.trials.map((row) => row.id));
  if (
    ids.size !== protocol.trials.length ||
    new Set(observations.map((row) => row.id)).size !== observations.length ||
    observations.some((row) => !ids.has(row.id)) ||
    protocol.confidenceThresholds.some(
      (value, index) =>
        index > 0 && value <= protocol.confidenceThresholds[index - 1]!,
    )
  )
    throw new Error(
      "Scoring trial identities and frozen thresholds do not reconcile",
    );
  for (const row of observations) {
    if (
      (row.status !== "completed" &&
        (row.decision !== "abstain" || row.probability !== null)) ||
      (row.decision === "abstain" &&
        (row.probability !== null || row.judgement !== "none")) ||
      (row.decision === "finding" && row.judgement === "none") ||
      (row.judgement === "supported" && row.label !== "defect")
    )
      throw new Error(
        "Scoring decisions labels and incomplete states contradict",
      );
  }
  const map = new Map(observations.map((row) => [row.id, row]));
  const rows: Row[] = protocol.trials.map((trial) => ({
    ...trial,
    ...(map.get(trial.id) ?? {
      status: "unreviewed",
      decision: "abstain",
      probability: null,
      label: "unresolved",
      judgement: "none",
    }),
    missing: !map.has(trial.id),
  }));
  const families = [...new Set(rows.map((row) => row.family))].sort();
  return reviewScoringReportSchema.parse({
    schemaVersion: 1,
    format: "review-scoring-report",
    profile: protocol.profile,
    protocolDigest: hash(protocol),
    observationsDigest: hash(observations),
    purpose: protocol.purpose,
    channel: "advisory",
    nativeExecution: false,
    claimsVerified: false,
    calibratedConfidence: false,
    independenceVerified: false,
    inputProvenance: "operator-supplied-unverified-labels",
    qualityGate: "not-assessed",
    deterministicOutcomeChanged: false,
    aggregate: summarize(rows, protocol.confidenceThresholds),
    families: families.map((family) => ({
      family,
      metrics: summarize(
        rows.filter((row) => row.family === family),
        protocol.confidenceThresholds,
      ),
    })),
    input: packet,
  });
}
export function projectReviewScoring(
  input: unknown,
  detailed: boolean,
): Record<string, unknown> {
  const report = reviewScoringReportSchema.parse(input);
  if (!isDeepStrictEqual(report, scoreReviewTrials(report.input)))
    throw new Error("Scoring evidence and derived metrics do not reconcile");
  if (detailed) return report;
  const { input: packet, ...metadata } = report;
  void packet;
  return reviewScoringSummarySchema.parse({
    ...metadata,
    sourceIncluded: false,
  });
}
