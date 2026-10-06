import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { reviewFamilySchema } from "./review-hypotheses.js";
import {
  reviewScoringObservationSchema,
  reviewScoringReportSchema,
  scoreReviewTrials,
} from "./review-scoring.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(512);
const metricNames = [
  "precision",
  "materialDefectRecall",
  "completedCoverage",
  "falseAlarmRate",
  "nearMissFalseAlarmRate",
] as const;
type Metric = (typeof metricNames)[number];
export const reviewPairedProtocolSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("declared-paired-cluster-v1"),
  purpose: z.enum(["development", "held-out"]),
  seed: digest,
  resamples: z.number().int().min(128).max(4096),
  confidenceLevel: z.number().min(0.8).max(0.99),
  trials: z
    .array(z.strictObject({ id, clusterId: id, family: reviewFamilySchema }))
    .min(1)
    .max(512),
});
const observationSchema = reviewScoringObservationSchema.omit({ label: true });
export const reviewPairedInputSchema = z.strictObject({
  protocol: reviewPairedProtocolSchema,
  labels: z
    .array(
      z.strictObject({ id, label: reviewScoringObservationSchema.shape.label }),
    )
    .max(512),
  observations: z.strictObject({
    a: z.array(observationSchema).max(512),
    b: z.array(observationSchema).max(512),
  }),
});
const metricsSchema = reviewScoringReportSchema.shape.aggregate;
const pairedMetricSchema = z.strictObject({
  metric: z.enum(metricNames),
  direction: z.enum(["higher-is-better", "lower-is-better"]),
  a: metricsSchema.shape.precision,
  b: metricsSchema.shape.precision,
  differenceBMinusA: z.number().min(-1).max(1).nullable(),
  bootstrap: z.strictObject({
    state: z.enum([
      "available",
      "insufficient-clusters",
      "undefined-point",
      "undefined-resamples",
      "degenerate",
    ]),
    validResamples: z.number().int().min(0).max(4096),
    undefinedResamples: z.number().int().min(0).max(4096),
    interval: z
      .strictObject({
        lower: z.number().min(-1).max(1),
        upper: z.number().min(-1).max(1),
      })
      .nullable(),
  }),
});
const sliceSchema = z.strictObject({
  selected: count,
  clusters: count,
  repeatedClusters: count,
  missingLabels: count,
  unresolvedLabels: count,
  missingObservations: z.strictObject({ a: count, b: count }),
  completePairs: count,
  incompletePairs: count,
  allSlotsComplete: z.boolean(),
  arms: z.strictObject({ a: metricsSchema, b: metricsSchema }),
  differences: z.array(pairedMetricSchema).length(5),
});
const common = {
  schemaVersion: z.literal(1),
  format: z.literal("review-paired-scoring-report"),
  profile: z.literal("declared-paired-cluster-v1"),
  protocolDigest: digest,
  labelsDigest: digest,
  observationsDigest: digest,
  purpose: z.enum(["development", "held-out"]),
  channel: z.literal("advisory"),
  nativeExecution: z.literal(false),
  claimsVerified: z.literal(false),
  calibratedConfidence: z.literal(false),
  independenceVerified: z.literal(false),
  pairingVerified: z.literal(false),
  inputProvenance: z.literal("operator-supplied-unverified-labels"),
  qualityGate: z.literal("not-assessed"),
  deterministicOutcomeChanged: z.literal(false),
  method: z.literal("paired-whole-cluster-percentile"),
  random: z.literal("sha256-counter-rejection-v1"),
  estimand: z.literal(
    "ratio-of-pooled-trial-counts-with-whole-cluster-resampling",
  ),
  assumption: z.literal(
    "independent-representative-clusters-and-authoritative-paired-labels-not-verified",
  ),
  properScoreComparison: z.literal("not-computed-different-submitted-claims"),
  resamples: z.number().int().min(128).max(4096),
  confidenceLevel: z.number().min(0.8).max(0.99),
  aggregate: sliceSchema,
  families: z
    .array(z.strictObject({ family: reviewFamilySchema, metrics: sliceSchema }))
    .min(1)
    .max(9),
};
export const reviewPairedReportSchema = z.strictObject({
  ...common,
  input: reviewPairedInputSchema,
});
export const reviewPairedSummarySchema = z.strictObject({
  ...common,
  sourceIncluded: z.literal(false),
});
export type ReviewPairedReport = z.infer<typeof reviewPairedReportSchema>;
type Input = z.infer<typeof reviewPairedInputSchema>;
type Trial = Input["protocol"]["trials"][number];
type Observation = z.infer<typeof observationSchema>;
type Row = Trial & {
  label: z.infer<typeof reviewScoringObservationSchema>["label"];
  missingLabel: boolean;
  a: Observation;
  b: Observation;
  missingA: boolean;
  missingB: boolean;
};
type Counts = Record<Metric, { numerator: number; denominator: number }>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sorted = <T extends { id: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const empty = (): Counts =>
  Object.fromEntries(
    metricNames.map((metric) => [metric, { numerator: 0, denominator: 0 }]),
  ) as Counts;
function counts(row: Row, arm: "a" | "b"): Counts {
  const observation = row[arm],
    finding = observation.decision === "finding",
    supported = observation.judgement === "supported",
    completed = observation.status === "completed";
  return {
    precision: { numerator: Number(supported), denominator: Number(finding) },
    materialDefectRecall: {
      numerator: Number(supported),
      denominator: Number(row.label === "defect"),
    },
    completedCoverage: { numerator: Number(completed), denominator: 1 },
    falseAlarmRate: {
      numerator: Number(completed && row.label === "valid" && finding),
      denominator: Number(completed && row.label === "valid"),
    },
    nearMissFalseAlarmRate: {
      numerator: Number(completed && row.label === "near-miss" && finding),
      denominator: Number(completed && row.label === "near-miss"),
    },
  };
}
function add(target: Counts, source: Counts) {
  for (const metric of metricNames) {
    target[metric].numerator += source[metric].numerator;
    target[metric].denominator += source[metric].denominator;
  }
}
const value = (count: { numerator: number; denominator: number }) =>
  count.denominator ? count.numerator / count.denominator : null;
// Sampling indices are shared by both arms. Rejection avoids modulo bias.
function sampler(seed: string, domain: string) {
  let counter = 0,
    offset = 32,
    bytes = Buffer.alloc(32);
  return (size: number): number => {
    const boundary = Math.floor(2 ** 32 / size) * size;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (offset === 32) {
        if (counter >= 1000000)
          throw new Error("Paired sampler budget exhausted");
        bytes = createHash("sha256")
          .update(JSON.stringify([seed, domain, counter++]))
          .digest();
        offset = 0;
      }
      const next = bytes.readUInt32BE(offset);
      offset += 4;
      if (next < boundary) return next % size;
    }
    throw new Error("Paired sampler rejection limit exhausted");
  };
}
function percentile(sortedValues: number[], q: number) {
  const at = (sortedValues.length - 1) * q,
    lo = Math.floor(at),
    hi = Math.ceil(at);
  return (
    sortedValues[lo]! + (sortedValues[hi]! - sortedValues[lo]!) * (at - lo)
  );
}
function summarize(rows: Row[], input: Input, domain: string) {
  const groups = new Map<string, { a: Counts; b: Counts; size: number }>();
  for (const row of rows) {
    let group = groups.get(row.clusterId);
    if (!group) {
      group = { a: empty(), b: empty(), size: 0 };
      groups.set(row.clusterId, group);
    }
    group.size++;
    add(group.a, counts(row, "a"));
    add(group.b, counts(row, "b"));
  }
  const clusters = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, group]) => group);
  const armReport = (arm: "a" | "b") => {
    const aggregate = scoreReviewTrials({
      protocol: {
        schemaVersion: 1,
        profile: "declared-claim-probability-v1",
        purpose: input.protocol.purpose,
        confidenceThresholds: [0.5],
        trials: rows.map(({ id, clusterId, family }) => ({
          id,
          clusterId,
          family,
        })),
      },
      observations: rows.map((row) => ({ ...row[arm], label: row.label })),
    }).aggregate;
    return {
      ...aggregate,
      missingObservations: rows.filter((row) =>
        arm === "a" ? row.missingA : row.missingB,
      ).length,
    };
  };
  const arms = { a: armReport("a"), b: armReport("b") };
  const draws = new Map<Metric, number[]>(
    metricNames.map((metric) => [metric, []]),
  );
  if (clusters.length >= 2) {
    const next = sampler(input.protocol.seed, domain);
    for (let iteration = 0; iteration < input.protocol.resamples; iteration++) {
      const totals = { a: empty(), b: empty() };
      for (let draw = 0; draw < clusters.length; draw++) {
        const group = clusters[next(clusters.length)]!;
        add(totals.a, group.a);
        add(totals.b, group.b);
      }
      for (const metric of metricNames) {
        const a = value(totals.a[metric]),
          b = value(totals.b[metric]);
        if (a !== null && b !== null) draws.get(metric)!.push(b - a);
      }
    }
  }
  const completePairs = rows.filter(
    (row) => row.a.status === "completed" && row.b.status === "completed",
  ).length;
  return {
    selected: rows.length,
    clusters: clusters.length,
    repeatedClusters: clusters.filter((group) => group.size > 1).length,
    missingLabels: rows.filter((row) => row.missingLabel).length,
    unresolvedLabels: rows.filter((row) => row.label === "unresolved").length,
    missingObservations: {
      a: rows.filter((row) => row.missingA).length,
      b: rows.filter((row) => row.missingB).length,
    },
    completePairs,
    incompletePairs: rows.length - completePairs,
    allSlotsComplete: completePairs === rows.length,
    arms,
    differences: metricNames.map((metric) => {
      const a = arms.a[metric],
        b = arms.b[metric],
        differenceBMinusA =
          a.value === null || b.value === null ? null : b.value - a.value;
      const values = draws.get(metric)!.sort((a, b) => a - b);
      const state =
        clusters.length < 2
          ? "insufficient-clusters"
          : differenceBMinusA === null
            ? "undefined-point"
            : values.length !== input.protocol.resamples
              ? "undefined-resamples"
              : values[0] === values.at(-1)
                ? "degenerate"
                : "available";
      const tail = (1 - input.protocol.confidenceLevel) / 2;
      return {
        metric,
        direction:
          metric === "falseAlarmRate" || metric === "nearMissFalseAlarmRate"
            ? "lower-is-better"
            : "higher-is-better",
        a,
        b,
        differenceBMinusA,
        bootstrap: {
          state,
          validResamples: values.length,
          undefinedResamples:
            clusters.length >= 2 ? input.protocol.resamples - values.length : 0,
          interval:
            state === "available"
              ? {
                  lower: percentile(values, tail),
                  upper: percentile(values, 1 - tail),
                }
              : null,
        },
      };
    }),
  };
}
export function scorePairedReviewTrials(value: unknown): ReviewPairedReport {
  const parsed = reviewPairedInputSchema.parse(value);
  const input = {
    protocol: { ...parsed.protocol, trials: sorted(parsed.protocol.trials) },
    labels: sorted(parsed.labels),
    observations: {
      a: sorted(parsed.observations.a),
      b: sorted(parsed.observations.b),
    },
  };
  const ids = new Set(input.protocol.trials.map((row) => row.id));
  if (ids.size !== input.protocol.trials.length)
    throw new Error("Duplicate paired trial identity");
  for (const records of [
    input.labels,
    input.observations.a,
    input.observations.b,
  ])
    if (
      new Set(records.map((row) => row.id)).size !== records.length ||
      records.some((row) => !ids.has(row.id))
    )
      throw new Error(
        "Paired labels and observations do not reconcile with frozen identities",
      );
  const labels = new Map(input.labels.map((row) => [row.id, row.label]));
  const observations = {
    a: new Map(input.observations.a.map((row) => [row.id, row])),
    b: new Map(input.observations.b.map((row) => [row.id, row])),
  };
  const absent = (id: string): Observation => ({
    id,
    status: "unreviewed",
    decision: "abstain",
    probability: null,
    judgement: "none",
  });
  const rows = input.protocol.trials.map((trial) => ({
    ...trial,
    label: labels.get(trial.id) ?? "unresolved",
    missingLabel: !labels.has(trial.id),
    a: observations.a.get(trial.id) ?? absent(trial.id),
    b: observations.b.get(trial.id) ?? absent(trial.id),
    missingA: !observations.a.has(trial.id),
    missingB: !observations.b.has(trial.id),
  }));
  const families = [...new Set(rows.map((row) => row.family))].sort();
  return reviewPairedReportSchema.parse({
    schemaVersion: 1,
    format: "review-paired-scoring-report",
    profile: input.protocol.profile,
    protocolDigest: hash(input.protocol),
    labelsDigest: hash(input.labels),
    observationsDigest: hash(input.observations),
    purpose: input.protocol.purpose,
    channel: "advisory",
    nativeExecution: false,
    claimsVerified: false,
    calibratedConfidence: false,
    independenceVerified: false,
    pairingVerified: false,
    inputProvenance: "operator-supplied-unverified-labels",
    qualityGate: "not-assessed",
    deterministicOutcomeChanged: false,
    method: "paired-whole-cluster-percentile",
    random: "sha256-counter-rejection-v1",
    estimand: "ratio-of-pooled-trial-counts-with-whole-cluster-resampling",
    assumption:
      "independent-representative-clusters-and-authoritative-paired-labels-not-verified",
    properScoreComparison: "not-computed-different-submitted-claims",
    resamples: input.protocol.resamples,
    confidenceLevel: input.protocol.confidenceLevel,
    aggregate: summarize(rows, input, "aggregate"),
    families: families.map((family) => ({
      family,
      metrics: summarize(
        rows.filter((row) => row.family === family),
        input,
        family,
      ),
    })),
    input,
  });
}
export function projectPairedReviewScoring(
  value: unknown,
  detailed: boolean,
): Record<string, unknown> {
  const report = reviewPairedReportSchema.parse(value);
  if (!isDeepStrictEqual(report, scorePairedReviewTrials(report.input)))
    throw new Error(
      "Paired scoring evidence and derived metrics do not reconcile",
    );
  if (detailed) return report;
  const { input, ...metadata } = report;
  void input;
  return reviewPairedSummarySchema.parse({
    ...metadata,
    sourceIncluded: false,
  });
}
