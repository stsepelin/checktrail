import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { reviewFamilySchema } from "./review-hypotheses.js";
import { reviewScoringObservationSchema } from "./review-scoring.js";
import { reviewPairedProtocolSchema } from "./review-paired-scoring.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const count = z.number().int().min(0).max(8192);
const probability = z.number().min(0).max(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const metrics = [
  "supportedClaimPrecision",
  "uniqueDefectPrecision",
  "materialDefectRecall",
  "completedCoverage",
  "falseAlarmRate",
  "nearMissFalseAlarmRate",
] as const;
type Metric = (typeof metrics)[number];
const disposition = reviewScoringObservationSchema.shape.judgement.exclude([
  "none",
]);
export const reviewMultiProtocolSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("declared-multi-claim-paired-v1"),
  purpose: reviewPairedProtocolSchema.shape.purpose,
  seed: reviewPairedProtocolSchema.shape.seed,
  resamples: reviewPairedProtocolSchema.shape.resamples,
  confidenceLevel: reviewPairedProtocolSchema.shape.confidenceLevel,
  trials: z
    .array(z.strictObject({ id, clusterId: id }))
    .min(1)
    .max(512),
});
const label = z.strictObject({
  id,
  label: reviewScoringObservationSchema.shape.label,
  defects: z
    .array(
      z.strictObject({ id, family: reviewFamilySchema, material: z.boolean() }),
    )
    .max(32),
});
const observation = z.strictObject({
  id,
  status: reviewScoringObservationSchema.shape.status,
  claims: z
    .array(
      z.strictObject({
        id,
        family: reviewFamilySchema,
        judgement: disposition,
        defectId: id.nullable(),
        probability: probability.nullable(),
      }),
    )
    .max(192),
});
export const reviewMultiInputSchema = z.strictObject({
  protocol: reviewMultiProtocolSchema,
  labels: z.array(label).max(512),
  observations: z.strictObject({
    a: z.array(observation).max(512),
    b: z.array(observation).max(512),
  }),
});
const fraction = z.strictObject({
  numerator: count,
  denominator: count,
  value: probability.nullable(),
});
const armSchema = z.strictObject({
  selected: count,
  completed: count,
  missingObservations: count,
  retainedClaims: count,
  unscoredClaims: count,
  completedClaims: count,
  supportedClaims: count,
  uniqueSupportedDefects: count,
  duplicateSupportedClaims: count,
  unresolvedClaims: count,
  resolvedErrors: count,
  dispositions: z.strictObject(
    Object.fromEntries(disposition.options.map((k) => [k, count])),
  ),
  supportedClaimPrecision: fraction,
  uniqueDefectPrecision: fraction,
  materialDefectRecall: fraction,
  completedCoverage: fraction,
  falseAlarmRate: fraction,
  nearMissFalseAlarmRate: fraction,
  properScores: z.strictObject({
    scored: count,
    unscoredClaims: count,
    unknownProbabilities: count,
    brier: probability.nullable(),
    negativeLogLikelihood: z.number().nonnegative().nullable(),
    infiniteLogLoss: count,
  }),
});
const differencesSchema = z
  .array(
    z.strictObject({
      metric: z.enum(metrics),
      direction: z.enum(["higher-is-better", "lower-is-better"]),
      a: fraction,
      b: fraction,
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
    }),
  )
  .length(metrics.length);
const common = {
  schemaVersion: z.literal(1),
  profile: reviewMultiProtocolSchema.shape.profile,
  protocolDigest: digest,
  labelsDigest: digest,
  observationsDigest: digest,
  purpose: reviewMultiProtocolSchema.shape.purpose,
  channel: z.literal("advisory"),
  nativeExecution: z.literal(false),
  claimsVerified: z.literal(false),
  labelsVerified: z.literal(false),
  independenceVerified: z.literal(false),
  pairingVerified: z.literal(false),
  calibratedConfidence: z.literal(false),
  qualityGate: z.literal("not-assessed"),
  deterministicOutcomeChanged: z.literal(false),
  inputProvenance: z.literal("operator-supplied-unverified-defect-mappings"),
  method: z.literal("paired-whole-cluster-percentile"),
  random: z.literal("sha256-counter-rejection-v1"),
  estimand: z.literal(
    "ratio-of-pooled-case-and-claim-counts-with-whole-cluster-resampling",
  ),
  assumption: z.literal(
    "independent-representative-clusters-and-authoritative-paired-labels-not-verified",
  ),
  properScoreComparison: z.literal("not-computed-different-submitted-claims"),
  resamples: reviewMultiProtocolSchema.shape.resamples,
  confidenceLevel: reviewMultiProtocolSchema.shape.confidenceLevel,
  aggregate: z.strictObject({
    selected: count,
    clusters: count,
    repeatedClusters: count,
    missingLabels: count,
    unresolvedLabels: count,
    knownDefects: count,
    knownMaterialDefects: count,
    completePairs: count,
    incompletePairs: count,
    allSlotsComplete: z.boolean(),
    arms: z.strictObject({ a: armSchema, b: armSchema }),
    differences: differencesSchema,
  }),
};
export const reviewMultiReportSchema = z.strictObject({
  ...common,
  format: z.literal("review-multi-scoring-report"),
  input: reviewMultiInputSchema,
});
export const reviewMultiSummarySchema = z.strictObject({
  ...common,
  format: z.literal("review-multi-scoring-summary"),
  sourceIncluded: z.literal(false),
});
export type ReviewMultiReport = z.infer<typeof reviewMultiReportSchema>;
type Input = z.infer<typeof reviewMultiInputSchema>;
type Observation = z.infer<typeof observation>;
type Label = z.infer<typeof label>;
type Row = {
  id: string;
  clusterId: string;
  label: Label | undefined;
  a: Observation | undefined;
  b: Observation | undefined;
};
type Counts = Record<Metric, { numerator: number; denominator: number }>;
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const sorted = <T extends { id: string }>(v: T[]): T[] =>
  [...v].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const rate = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  value: denominator ? numerator / denominator : null,
});
const fractions = (counts: Counts) =>
  Object.fromEntries(
    metrics.map((k) => [k, rate(counts[k].numerator, counts[k].denominator)]),
  ) as Record<Metric, ReturnType<typeof rate>>;
const empty = (): Counts =>
  Object.fromEntries(
    metrics.map((k) => [k, { numerator: 0, denominator: 0 }]),
  ) as Counts;
function add(target: Counts, source: Counts) {
  for (const k of metrics) {
    target[k].numerator += source[k].numerator;
    target[k].denominator += source[k].denominator;
  }
}
function supported(row: Row, claim: Observation["claims"][number]) {
  return (
    row.label &&
    row.label.label !== "unresolved" &&
    claim.judgement === "supported"
  );
}
function rowCounts(row: Row, arm: "a" | "b"): Counts {
  const review = row[arm],
    completed = review?.status === "completed";
  const claims = completed ? review.claims : [];
  const matches = new Set(
    claims.filter((c) => supported(row, c)).map((c) => c.defectId!),
  );
  const known =
    row.label?.label !== undefined && row.label.label !== "unresolved";
  const material = known ? row.label!.defects.filter((d) => d.material) : [];
  return {
    supportedClaimPrecision: {
      numerator: claims.filter((c) => supported(row, c)).length,
      denominator: claims.length,
    },
    uniqueDefectPrecision: {
      numerator: matches.size,
      denominator: claims.length,
    },
    materialDefectRecall: {
      numerator: material.filter((d) => matches.has(d.id)).length,
      denominator: material.length,
    },
    completedCoverage: { numerator: Number(completed), denominator: 1 },
    falseAlarmRate: {
      numerator: Number(
        completed && row.label?.label === "valid" && claims.length > 0,
      ),
      denominator: Number(completed && row.label?.label === "valid"),
    },
    nearMissFalseAlarmRate: {
      numerator: Number(
        completed && row.label?.label === "near-miss" && claims.length > 0,
      ),
      denominator: Number(completed && row.label?.label === "near-miss"),
    },
  };
}
function armReport(rows: Row[], arm: "a" | "b") {
  const totals = empty();
  let completed = 0,
    missing = 0,
    retained = 0,
    unscored = 0,
    totalClaims = 0,
    support = 0,
    unique = 0;
  let scored = 0,
    brier = 0,
    logLoss = 0,
    infinite = 0,
    unknown = 0;
  const dispositions = Object.fromEntries(
    disposition.options.map((k) => [k, 0]),
  ) as Record<z.infer<typeof disposition>, number>;
  for (const row of rows) {
    add(totals, rowCounts(row, arm));
    const review = row[arm];
    if (!review) {
      missing++;
      continue;
    }
    retained += review.claims.length;
    if (review.status !== "completed") {
      unscored += review.claims.length;
      continue;
    }
    completed++;
    totalClaims += review.claims.length;
    const matches = new Set<string>();
    for (const claim of review.claims) {
      const known = row.label && row.label.label !== "unresolved";
      const state = known ? claim.judgement : "unresolved";
      dispositions[state]++;
      if (state === "supported") {
        support++;
        matches.add(claim.defectId!);
      }
      if (claim.probability === null) unknown++;
      if (state === "unresolved" || claim.probability === null) continue;
      scored++;
      const outcome = state === "supported" ? 1 : 0;
      brier += (claim.probability - outcome) ** 2;
      const likelihood = outcome ? claim.probability : 1 - claim.probability;
      if (likelihood === 0) infinite++;
      else logLoss -= Math.log(likelihood);
    }
    unique += matches.size;
  }
  return {
    selected: rows.length,
    completed,
    missingObservations: missing,
    retainedClaims: retained,
    unscoredClaims: unscored,
    completedClaims: totalClaims,
    supportedClaims: support,
    uniqueSupportedDefects: unique,
    duplicateSupportedClaims: support - unique,
    unresolvedClaims: dispositions.unresolved,
    resolvedErrors: totalClaims - support - dispositions.unresolved,
    dispositions,
    ...fractions(totals),
    properScores: {
      scored,
      unscoredClaims: totalClaims - scored,
      unknownProbabilities: unknown,
      brier: scored ? brier / scored : null,
      negativeLogLikelihood: scored && !infinite ? logLoss / scored : null,
      infiniteLogLoss: infinite,
    },
  };
}
function sampler(seed: string) {
  let counter = 0,
    offset = 32,
    bytes = Buffer.alloc(32);
  return (size: number) => {
    const boundary = Math.floor(2 ** 32 / size) * size;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (offset === 32) {
        if (counter >= 1000000)
          throw new Error("Multi-claim sampler budget exhausted");
        bytes = createHash("sha256")
          .update(JSON.stringify([seed, "multi-claim-aggregate", counter++]))
          .digest();
        offset = 0;
      }
      const next = bytes.readUInt32BE(offset);
      offset += 4;
      if (next < boundary) return next % size;
    }
    throw new Error("Multi-claim sampler rejection limit exhausted");
  };
}
function percentile(values: number[], q: number) {
  const at = (values.length - 1) * q,
    lo = Math.floor(at),
    hi = Math.ceil(at);
  return values[lo]! + (values[hi]! - values[lo]!) * (at - lo);
}
function summarize(rows: Row[], input: Input) {
  const groups = new Map<string, { a: Counts; b: Counts; size: number }>();
  for (const row of rows) {
    let group = groups.get(row.clusterId);
    if (!group) {
      group = { a: empty(), b: empty(), size: 0 };
      groups.set(row.clusterId, group);
    }
    group.size++;
    add(group.a, rowCounts(row, "a"));
    add(group.b, rowCounts(row, "b"));
  }
  const clusters = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, g]) => g);
  const arms = { a: armReport(rows, "a"), b: armReport(rows, "b") };
  const draws = new Map<Metric, number[]>(metrics.map((k) => [k, []]));
  if (clusters.length >= 2) {
    const next = sampler(input.protocol.seed);
    for (let iteration = 0; iteration < input.protocol.resamples; iteration++) {
      const totals = { a: empty(), b: empty() };
      for (let draw = 0; draw < clusters.length; draw++) {
        const group = clusters[next(clusters.length)]!;
        add(totals.a, group.a);
        add(totals.b, group.b);
      }
      for (const k of metrics) {
        const a = rate(totals.a[k].numerator, totals.a[k].denominator).value,
          b = rate(totals.b[k].numerator, totals.b[k].denominator).value;
        if (a !== null && b !== null) draws.get(k)!.push(b - a);
      }
    }
  }
  const completePairs = rows.filter(
    (r) => r.a?.status === "completed" && r.b?.status === "completed",
  ).length;
  return {
    selected: rows.length,
    clusters: clusters.length,
    repeatedClusters: clusters.filter((g) => g.size > 1).length,
    missingLabels: rows.filter((r) => !r.label).length,
    unresolvedLabels: rows.filter((r) => r.label?.label === "unresolved")
      .length,
    knownDefects: rows.reduce((n, r) => n + (r.label?.defects.length ?? 0), 0),
    knownMaterialDefects: rows.reduce(
      (n, r) => n + (r.label?.defects.filter((d) => d.material).length ?? 0),
      0,
    ),
    completePairs,
    incompletePairs: rows.length - completePairs,
    allSlotsComplete: completePairs === rows.length,
    arms,
    differences: metrics.map((k) => {
      const a = arms.a[k],
        b = arms.b[k],
        difference =
          a.value === null || b.value === null ? null : b.value - a.value;
      const values = draws.get(k)!.sort((a, b) => a - b);
      const state =
        clusters.length < 2
          ? "insufficient-clusters"
          : difference === null
            ? "undefined-point"
            : values.length !== input.protocol.resamples
              ? "undefined-resamples"
              : values[0] === values.at(-1)
                ? "degenerate"
                : "available";
      const tail = (1 - input.protocol.confidenceLevel) / 2;
      return {
        metric: k,
        direction:
          k === "falseAlarmRate" || k === "nearMissFalseAlarmRate"
            ? "lower-is-better"
            : "higher-is-better",
        a,
        b,
        differenceBMinusA: difference,
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
export function scoreMultiClaimReviewTrials(value: unknown): ReviewMultiReport {
  const parsed = reviewMultiInputSchema.parse(value);
  const input: Input = {
    protocol: { ...parsed.protocol, trials: sorted(parsed.protocol.trials) },
    labels: sorted(parsed.labels).map((l) => ({
      ...l,
      defects: sorted(l.defects),
    })),
    observations: {
      a: sorted(parsed.observations.a).map((r) => ({
        ...r,
        claims: sorted(r.claims),
      })),
      b: sorted(parsed.observations.b).map((r) => ({
        ...r,
        claims: sorted(r.claims),
      })),
    },
  };
  const ids = new Set(input.protocol.trials.map((r) => r.id));
  if (ids.size !== input.protocol.trials.length)
    throw new Error("Duplicate multi-claim trial identity");
  for (const list of [input.labels, input.observations.a, input.observations.b])
    if (
      new Set(list.map((r) => r.id)).size !== list.length ||
      list.some((r) => !ids.has(r.id))
    )
      throw new Error("Multi-claim identities do not reconcile");
  if (
    input.labels.reduce((n, l) => n + l.defects.length, 0) > 4096 ||
    [input.observations.a, input.observations.b].some(
      (list) => list.reduce((n, r) => n + r.claims.length, 0) > 4096,
    )
  )
    throw new Error("Multi-claim evidence budget exceeded");
  const labels = new Map(input.labels.map((l) => [l.id, l]));
  for (const l of input.labels) {
    if (new Set(l.defects.map((d) => d.id)).size !== l.defects.length)
      throw new Error("Duplicate expected defect identity");
    if (
      (l.label === "defect" && !l.defects.length) ||
      (l.label !== "defect" && l.defects.length)
    )
      throw new Error("Case label and expected defects contradict");
  }
  for (const list of [input.observations.a, input.observations.b])
    for (const r of list) {
      if (new Set(r.claims.map((c) => c.id)).size !== r.claims.length)
        throw new Error("Duplicate claim identity");
      if (r.status === "unreviewed" && r.claims.length)
        throw new Error("Unreviewed case cannot retain claims");
      for (const c of r.claims) {
        if ((c.judgement === "supported") !== (c.defectId !== null))
          throw new Error("Claim disposition and defect mapping contradict");
        const l = labels.get(r.id);
        if (
          c.defectId !== null &&
          l &&
          l.label !== "unresolved" &&
          !l.defects.some((d) => d.id === c.defectId && d.family === c.family)
        )
          throw new Error(
            "Supported claim does not map to the common expected defect family",
          );
      }
    }
  const observations = {
    a: new Map(input.observations.a.map((r) => [r.id, r])),
    b: new Map(input.observations.b.map((r) => [r.id, r])),
  };
  const rows: Row[] = input.protocol.trials.map((t) => ({
    ...t,
    label: labels.get(t.id),
    a: observations.a.get(t.id),
    b: observations.b.get(t.id),
  }));
  return reviewMultiReportSchema.parse({
    schemaVersion: 1,
    profile: input.protocol.profile,
    format: "review-multi-scoring-report",
    protocolDigest: hash(input.protocol),
    labelsDigest: hash(input.labels),
    observationsDigest: hash(input.observations),
    purpose: input.protocol.purpose,
    channel: "advisory",
    nativeExecution: false,
    claimsVerified: false,
    labelsVerified: false,
    independenceVerified: false,
    pairingVerified: false,
    calibratedConfidence: false,
    qualityGate: "not-assessed",
    deterministicOutcomeChanged: false,
    inputProvenance: "operator-supplied-unverified-defect-mappings",
    method: "paired-whole-cluster-percentile",
    random: "sha256-counter-rejection-v1",
    estimand:
      "ratio-of-pooled-case-and-claim-counts-with-whole-cluster-resampling",
    assumption:
      "independent-representative-clusters-and-authoritative-paired-labels-not-verified",
    properScoreComparison: "not-computed-different-submitted-claims",
    resamples: input.protocol.resamples,
    confidenceLevel: input.protocol.confidenceLevel,
    aggregate: summarize(rows, input),
    input,
  });
}
export function projectMultiClaimReviewScoring(
  value: unknown,
  detailed: boolean,
): Record<string, unknown> {
  const report = reviewMultiReportSchema.parse(value);
  if (!isDeepStrictEqual(report, scoreMultiClaimReviewTrials(report.input)))
    throw new Error(
      "Multi-claim scoring evidence and derived metrics do not reconcile",
    );
  if (detailed) return report;
  const { input, ...metadata } = report;
  void input;
  return reviewMultiSummarySchema.parse({
    ...metadata,
    format: "review-multi-scoring-summary",
    sourceIncluded: false,
  });
}
