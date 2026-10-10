import { z } from "zod";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import {
  parseReviewContext,
  receiveReview,
  reviewContextSchema,
  reviewAssessmentSchema,
  reviewReceiptSchema,
  type ReviewReceipt,
} from "./review.js";
import { reviewCandidateSchema } from "./review-provider-schema.js";
import { parseReviewProbeRun } from "./review-probe.js";
import { reviewProbeRunSchema } from "./review-probe-schema.js";
import {
  scoreReviewTrials,
  projectReviewScoring,
  reviewScoringInputSchema,
  reviewScoringReportSchema,
  reviewScoringSummarySchema,
} from "./review-scoring.js";
import { VERSION } from "./types.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  id = z.string().min(1).max(128),
  count = z.number().int().nonnegative().max(512),
  hash = (s: string) => createHash("sha256").update(s).digest("hex");
const binding = z.strictObject({
  trialId: id,
  candidateId: id.nullable(),
  file: z.string().min(1).max(1024),
  sourceDigest: digest,
});
export const reviewProvenanceInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  context: reviewContextSchema,
  assessment: reviewAssessmentSchema,
  candidates: z.array(reviewCandidateSchema).max(32),
  native: z
    .array(z.strictObject({ candidateId: id, run: reviewProbeRunSchema }))
    .max(32),
  scoring: reviewScoringInputSchema
    .extend({ bindings: z.array(binding).min(1).max(512) })
    .nullable(),
});
const tier = z.enum([
  "native-receipt-reconciled",
  "source-bound-host-claim",
  "unmatched-source",
  "stale-source",
]);
const candidate = z.strictObject({
  id,
  candidateDigest: digest,
  tier,
  claimProvenance: z.literal("host-declared-unverified"),
  sourceAddressesVerified: z.boolean(),
  confidence: z.strictObject({
    probability: z.number().min(0).max(1).nullable(),
    provenance: z.enum(["host-declared-unverified", "unknown"]),
    event: z.literal("supported-in-scope-actionable"),
    verified: z.literal(false),
    calibrated: z.literal(false),
  }),
  native: z.strictObject({
    status: z.enum([
      "not-supplied",
      "completed",
      "incomplete",
      "cancelled",
      "timed-out",
      "stale",
      "unsupported",
    ]),
    provenance: z.enum(["not-supplied", "imported-receipt-unattested"]),
    structureAndAccountingReconciled: z.boolean(),
    executionAttested: z.literal(false),
    behavior: z.enum(["violated", "satisfied", "unresolved"]),
    observationEstablishesClaimTruth: z.literal(false),
  }),
  attribution: z.enum(["regression", "pre-existing", "unknown"]),
  fixScope: z.enum(["this-change", "follow-up", "unknown"]),
  scopeProvenance: z.literal("host-declared-unverified"),
  severityEstablished: z.literal(false),
});
const counts = z.strictObject({
  selected: count,
  "native-receipt-reconciled": count,
  "source-bound-host-claim": count,
  "unmatched-source": count,
  "stale-source": count,
  hostDeclaredProbabilities: count,
  unknownProbabilities: count,
});
const common = {
  schemaVersion: z.literal(1),
  format: z.literal("review-provenance-report"),
  engineVersion: z.string(),
  channel: z.literal("advisory"),
  inputDigest: digest,
  contextDigest: digest,
  freshness: z.enum(["current", "stale"]),
  status: z.enum(["completed", "incomplete", "stale"]),
  sourceProvenance: z.literal("engine-rechecked-source-addresses"),
  claimProvenance: z.literal("host-declared-unverified"),
  labelProvenance: z.enum(["not-supplied", "operator-declared-unverified"]),
  confidenceVerified: z.literal(false),
  calibratedConfidence: z.literal(false),
  nativeExecution: z.literal(false),
  importedNativeExecutionAttested: z.literal(false),
  claimsVerified: z.literal(false),
  independenceVerified: z.literal(false),
  deterministicOutcomeChanged: z.literal(false),
  qualityGate: z.literal("not-assessed"),
  coverage: z.strictObject({
    selected: count,
    declaredReviewed: count,
    declaredNotReviewed: count,
    unaccounted: count,
  }),
  citations: z.strictObject({
    matched: count.max(512),
    unmatched: count.max(512),
  }),
  candidates: counts,
  decisions: z.strictObject({
    selected: count,
    finding: count,
    abstained: count,
    unsupported: count,
    unreviewed: count,
    incomplete: count,
    "budget-exhausted": count,
    stale: count,
    cancelled: count,
  }),
};
export const reviewProvenanceReportSchema = z.strictObject({
  ...common,
  input: reviewProvenanceInputSchema,
  receipt: reviewReceiptSchema,
  candidateEvidence: z.array(candidate).max(32),
  scoring: reviewScoringReportSchema.nullable(),
});
export const reviewProvenanceSummarySchema = z.strictObject({
  ...common,
  scoring: reviewScoringSummarySchema.nullable(),
  sourceIncluded: z.literal(false),
});
export type ReviewProvenanceReport = z.infer<
  typeof reviewProvenanceReportSchema
>;
type Input = z.infer<typeof reviewProvenanceInputSchema>;
function require(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
function derive(input: Input, receipt: ReviewReceipt) {
  const context = parseReviewContext(input.context);
  require(input.assessment.schemaVersion === 2 &&
    receipt.schemaVersion === 2, "Revision-addressed assessment required");
  require(receipt.contextDigest === context.contextDigest &&
    isDeepStrictEqual(
      receipt.assessment,
      input.assessment,
    ), "Receipt input binding differs");
  const candidates = new Map(input.candidates.map((c) => [c.id, c]));
  require(candidates.size === input.candidates.length &&
    input.assessment.observations.length ===
      candidates.size, "Every unique assessed claim has one candidate");
  for (const observation of input.assessment.observations) {
    const c = candidates.get(observation.id);
    require(c &&
      isDeepStrictEqual(observation, {
        id: c.id,
        severity: c.severity,
        claim: c.claim,
        citations: c.citations,
        attribution: c.attribution,
        fixScope: c.fixScope,
      }), "Candidate and assessment claims differ");
  }
  const native = new Map(input.native.map((n) => [n.candidateId, n.run]));
  require(native.size ===
    input.native.length, "Duplicate native candidate binding");
  for (const [candidateId, raw] of native) {
    const c = candidates.get(candidateId),
      run = parseReviewProbeRun(raw);
    require(c &&
      run.contextDigest === context.contextDigest &&
      run.candidateDigest === hash(JSON.stringify(c)) &&
      c.citations.some(
        (citation) =>
          citation.revision === "current" &&
          citation.sourceDigest === run.sourceDigest &&
          context.files.some(
            (file) =>
              file.path === citation.file && file.sha256 === run.sourceDigest,
          ),
      ), "Native source/context/claim binding differs");
    require(context.schemaVersion >= 4 &&
      "analysis" in context &&
      c.citations.some(
        (citation) =>
          citation.revision === "current" &&
          context.analysis.functions.filter(
            (fn) =>
              fn.revision === "current" &&
              fn.file === citation.file &&
              fn.start === run.functionRange.start &&
              fn.end === run.functionRange.end &&
              citation.startLine <= fn.endLine &&
              citation.endLine >= fn.startLine,
          ).length === 1,
      ), "Native function/address binding differs");
    // Legacy receipts lack retained raw output; they cannot receive the strongest selected tier.
    require(run.schemaVersion === 3 ||
      run.schemaVersion === 4, "Raw-output-bound native receipt required");
  }
  const evidence = input.candidates.map((c) => {
    const addressChecks = receipt.citationChecks.filter(
        (check) => check.observationId === c.id,
      ),
      sourceAddressesVerified =
        receipt.freshness === "current" &&
        addressChecks.length === c.citations.length &&
        addressChecks.every((check) => check.matchesContext),
      run = native.get(c.id),
      reconciled =
        sourceAddressesVerified &&
        run?.status === "completed" &&
        run.freshness === "current";
    return candidate.parse({
      id: c.id,
      candidateDigest: hash(JSON.stringify(c)),
      tier:
        receipt.freshness === "stale"
          ? "stale-source"
          : !sourceAddressesVerified
            ? "unmatched-source"
            : reconciled
              ? "native-receipt-reconciled"
              : "source-bound-host-claim",
      claimProvenance: "host-declared-unverified",
      sourceAddressesVerified,
      confidence: {
        probability: c.confidence?.probability ?? null,
        provenance:
          c.confidence?.probability != null
            ? "host-declared-unverified"
            : "unknown",
        event: "supported-in-scope-actionable",
        verified: false,
        calibrated: false,
      },
      native: {
        status: run?.status ?? "not-supplied",
        provenance: run ? "imported-receipt-unattested" : "not-supplied",
        structureAndAccountingReconciled: !!run,
        executionAttested: false,
        behavior: run?.behavior ?? "unresolved",
        observationEstablishesClaimTruth: false,
      },
      attribution: c.attribution,
      fixScope: c.fixScope,
      scopeProvenance: "host-declared-unverified",
      severityEstablished: false,
    });
  });
  let scoring: ReturnType<typeof scoreReviewTrials> | null = null;
  if (input.scoring) {
    const { protocol, observations, bindings } = input.scoring,
      trials = new Map(protocol.trials.map((t) => [t.id, t])),
      map = new Map(bindings.map((b) => [b.trialId, b]));
    require(map.size === bindings.length &&
      trials.size === map.size &&
      [...trials.keys()].every((id) =>
        map.has(id),
      ), "Complete unique score/source bindings required");
    const boundCandidates = bindings
      .filter((b) => b.candidateId !== null)
      .map((b) => b.candidateId!);
    require(new Set(boundCandidates).size === boundCandidates.length &&
      candidates.size === boundCandidates.length &&
      boundCandidates.every((id) =>
        candidates.has(id),
      ), "Every scored claim has one exact trial binding");
    for (const b of bindings) {
      require(context.files.some(
        (f) => f.path === b.file && f.sha256 === b.sourceDigest,
      ), "Scoring source binding differs");
      if (b.candidateId) {
        const c = candidates.get(b.candidateId)!;
        require(c.family === trials.get(b.trialId)!.family &&
          c.citations.some(
            (p) =>
              p.revision === "current" &&
              p.file === b.file &&
              p.sourceDigest === b.sourceDigest,
          ), "Scored claim source/family differs");
      }
    }
    require(receipt.freshness === "current" ||
      observations.every(
        (row) => row.status === "stale",
      ), "Stale source cannot retain current scoring observations");
    for (const row of observations) {
      const b = map.get(row.id);
      require(b, "Foreign scoring observation");
      if (row.decision === "finding") {
        const c = b.candidateId ? candidates.get(b.candidateId) : null;
        require(c &&
          row.probability ===
            (c.confidence?.probability ??
              null), "Scoring probability is not the bound host declaration");
        require(evidence.find((e) => e.id === c.id)
          ?.sourceAddressesVerified, "Unmatched source cannot receive current claim scores");
      }
      if (!b.candidateId)
        require(row.decision ===
          "abstain", "An unclaimed trial cannot become a finding");
    }

    scoring = scoreReviewTrials({ protocol, observations });
  }
  const totals = {
    selected: evidence.length,
    "native-receipt-reconciled": 0,
    "source-bound-host-claim": 0,
    "unmatched-source": 0,
    "stale-source": 0,
    hostDeclaredProbabilities: 0,
    unknownProbabilities: 0,
  };
  for (const row of evidence) {
    totals[row.tier]++;
    if (row.confidence.probability === null) totals.unknownProbabilities++;
    else totals.hostDeclaredProbabilities++;
  }
  const decisions = {
    selected: scoring?.input.protocol.trials.length ?? 0,
    finding: 0,
    abstained: 0,
    unsupported: 0,
    unreviewed: 0,
    incomplete: 0,
    "budget-exhausted": 0,
    stale: 0,
    cancelled: 0,
  };
  if (scoring)
    for (const trial of scoring.input.protocol.trials) {
      const row = scoring.input.observations.find((row) => row.id === trial.id);
      if (!row) decisions.unreviewed++;
      else if (row.status !== "completed") decisions[row.status]++;
      else if (row.decision === "finding") decisions.finding++;
      else decisions.abstained++;
    }
  require(Object.entries(totals)
    .filter(
      ([k]) =>
        ![
          "selected",
          "hostDeclaredProbabilities",
          "unknownProbabilities",
        ].includes(k),
    )
    .reduce((n, [, v]) => n + v, 0) === totals.selected &&
    totals.hostDeclaredProbabilities + totals.unknownProbabilities ===
      totals.selected, "Candidate categories do not close");
  require(Object.entries(decisions)
    .filter(([k]) => k !== "selected")
    .reduce((n, [, v]) => n + v, 0) ===
    decisions.selected, "Decision categories do not close");
  return {
    schemaVersion: 1 as const,
    format: "review-provenance-report" as const,
    engineVersion: VERSION,
    channel: "advisory" as const,
    inputDigest: hash(JSON.stringify(input)),
    contextDigest: context.contextDigest,
    freshness: receipt.freshness,
    status:
      receipt.freshness === "stale"
        ? ("stale" as const)
        : receipt.citations.unmatched ||
            receipt.coverage.unaccounted ||
            receipt.coverage.declaredNotReviewed ||
            input.native.some((n) => n.run.status !== "completed")
          ? ("incomplete" as const)
          : ("completed" as const),
    sourceProvenance: "engine-rechecked-source-addresses" as const,
    claimProvenance: "host-declared-unverified" as const,
    labelProvenance:
      scoring && input.scoring!.observations.length
        ? ("operator-declared-unverified" as const)
        : ("not-supplied" as const),
    confidenceVerified: false as const,
    calibratedConfidence: false as const,
    nativeExecution: false as const,
    importedNativeExecutionAttested: false as const,
    claimsVerified: false as const,
    independenceVerified: false as const,
    deterministicOutcomeChanged: false as const,
    qualityGate: "not-assessed" as const,
    coverage: receipt.coverage,
    citations: {
      matched: receipt.citations.matched,
      unmatched: receipt.citations.unmatched,
    },
    candidates: totals,
    decisions,
    candidateEvidence: evidence,
    scoring,
  };
}
export async function inspectReviewProvenance(
  root: string,
  text: string,
  options: { signal?: AbortSignal; wallMs?: number } = {},
): Promise<ReviewProvenanceReport> {
  // This boundary accepts serialized JSON only; no project-owned getters/toJSON are evaluated.
  require(typeof text === "string" &&
    Buffer.byteLength(text) <=
      1048576, "Bounded serialized provenance JSON required");
  const wallMs = z
      .number()
      .int()
      .min(1)
      .max(120000)
      .parse(options.wallMs ?? 30000),
    deadline = performance.now() + wallMs;
  const guard = () => {
    require(!options.signal?.aborted, "Provenance inspection cancelled");
    require(performance.now() < deadline, "Provenance inspection timed out");
  };
  guard();
  const input = reviewProvenanceInputSchema.parse(JSON.parse(text));
  guard();
  const context = parseReviewContext(input.context),
    receipt = await receiveReview(root, context, input.assessment);
  guard();
  const body = derive(input, receipt);
  guard();
  return reviewProvenanceReportSchema.parse({ ...body, input, receipt });
}
export function projectReviewProvenance(value: unknown, allowSource = false) {
  const report = reviewProvenanceReportSchema.parse(value),
    { input, receipt, candidateEvidence, scoring, ...summary } = report,
    expected = derive(input, receipt),
    { candidateEvidence: e, scoring: s, ...base } = expected;
  require(isDeepStrictEqual(summary, base) &&
    isDeepStrictEqual(candidateEvidence, e) &&
    isDeepStrictEqual(
      scoring,
      s,
    ), "Provenance derived evidence does not reconcile");
  if (allowSource) return report;
  return reviewProvenanceSummarySchema.parse({
    ...summary,
    scoring: scoring ? projectReviewScoring(scoring, false) : null,
    sourceIncluded: false,
  });
}
