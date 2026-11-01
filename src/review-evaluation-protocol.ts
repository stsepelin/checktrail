import { createHash } from "node:crypto";
import { z } from "zod";
import {
  inspectReviewCohortDeclaration,
  reviewCohortDeclarationSchema,
} from "./review-cohort.js";
import { reviewMultiProtocolSchema } from "./review-multi-scoring.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = (kind: string) =>
  z.string().regex(new RegExp("^" + kind + "-[a-f0-9]{32}$"));
const fraction = z.number().min(0).max(1);
const roles = ["baseline", "verifier", "reference"] as const;
type Role = (typeof roles)[number];
const orders: Role[][] = [
  ["baseline", "verifier", "reference"],
  ["verifier", "reference", "baseline"],
  ["reference", "baseline", "verifier"],
  ["reference", "verifier", "baseline"],
  ["verifier", "baseline", "reference"],
  ["baseline", "reference", "verifier"],
];
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Configuration bytes and actual identities remain in operator-owned storage. */
export const reviewEvaluationProtocolSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("prospective-review-protocol-declaration-v1"),
  reference: z.strictObject({
    id: identity("reference"),
    configurationSha256: digest,
  }),
  priorWorkflow: z.strictObject({
    kind: z.enum(["previous-workflow", "declared-comparison-baseline"]),
    id: identity("workflow"),
    configurationSha256: digest,
  }),
  verifierConfigurationSha256: digest,
  cohortDeclarationSha256: digest,
  implementation: z.strictObject({
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    inventoryScopeSha256: digest,
    engineArtifactsSha256: digest,
    packageLockSha256: digest,
    nativeToolsSha256: digest,
    environmentSha256: digest,
  }),
  procedures: z.strictObject({
    acquisitionSha256: digest,
    answerSeparationSha256: digest,
    hostIsolationSha256: digest,
    independentJudgmentSha256: digest,
    commonDefectMatchingSha256: digest,
    externalMeteringSha256: digest,
    stopRulesSha256: digest,
  }),
  budgets: z.strictObject({
    wallMsPerArm: z.number().int().min(1).max(3_600_000),
    inputTokensPerArm: z.number().int().min(1).max(10_000_000),
    outputTokensPerArm: z.number().int().min(1).max(1_000_000),
    toolCallsPerArm: z.number().int().min(1).max(10_000),
    outputBytesPerArm: z.number().int().min(1).max(16_777_216),
  }),
  scoring: z.strictObject({
    profile: z.literal("declared-multi-claim-paired-v1"),
    seed: reviewMultiProtocolSchema.shape.seed,
    confidenceLevel: reviewMultiProtocolSchema.shape.confidenceLevel,
    resamples: reviewMultiProtocolSchema.shape.resamples,
    repetitions: z.number().int().min(1).max(2),
    minimumClusters: z.number().int().min(2).max(256),
    order: z.literal("balanced-three-arm-rotation-v1"),
    thresholds: z.strictObject({
      minimumSupportedClaimPrecision: fraction,
      minimumMaterialDefectRecall: fraction,
      maximumValidCaseFalseAlarmRate: fraction,
      maximumNearMissFalseAlarmRate: fraction,
      maximumRecallNoninferiorityMargin: fraction,
      maximumPrecisionNoninferiorityMargin: fraction,
      minimumCompletedCoverage: fraction,
    }),
  }),
  caseClusters: z
    .array(
      z.strictObject({
        caseId: identity("case"),
        clusterId: identity("cluster"),
      }),
    )
    .min(1)
    .max(256),
});
export type ReviewEvaluationProtocol = z.infer<
  typeof reviewEvaluationProtocolSchema
>;
export const reviewEvaluationProtocolInputSchema = z.strictObject({
  protocol: reviewEvaluationProtocolSchema,
  cohort: reviewCohortDeclarationSchema,
});
type Issue =
  | "cohort-incomplete"
  | "cohort-binding"
  | "reference-binding"
  | "prior-workflow-binding"
  | "cluster-inventory"
  | "cluster-split"
  | "selected-not-reserved"
  | "insufficient-selected-clusters";
export interface ReviewEvaluationProtocolReport {
  schemaVersion: 1;
  profile: "prospective-review-protocol-declaration-v1";
  protocolSha256: string;
  cohortDeclarationSha256: string;
  declarationComplete: boolean;
  baselineKind: ReviewEvaluationProtocol["priorWorkflow"]["kind"];
  counts: {
    totalCases: number;
    selectedCases: number;
    excludedCases: number;
    selectedClusters: number;
    pairedTrialsPerComparison: number;
    plannedArmSlots: number;
  };
  issues: Issue[];
  schedule: {
    caseId: string;
    clusterId: string;
    repetition: number;
    order: Role[];
  }[];
  sourceContentInspected: false;
  labelsInspected: false;
  configurationBytesVerified: false;
  chronologyVerified: false;
  licenseGrantVerified: false;
  hostIndependenceVerified: false;
  qualityAssessed: false;
  gateAClosed: false;
  inferenceExecuted: false;
  fieldEvaluationExecuted: false;
}

/** A declaration preflight; no source, configuration, answers or services are opened. */
export function inspectReviewEvaluationProtocol(
  input: unknown,
  expectedProtocolSha256?: string,
): ReviewEvaluationProtocolReport {
  const bounded = input as {
    cohort?: { cases?: unknown };
    protocol?: { caseClusters?: unknown };
  } | null;
  for (const rows of [bounded?.cohort?.cases, bounded?.protocol?.caseClusters])
    if (Array.isArray(rows) && rows.length > 256)
      throw new Error("Evaluation protocol exceeds case bound");
  const { protocol, cohort } = reviewEvaluationProtocolInputSchema.parse(input);
  const protocolSha256 = hash(protocol);
  if (
    expectedProtocolSha256 !== undefined &&
    digest.parse(expectedProtocolSha256) !== protocolSha256
  )
    throw new Error("Evaluation protocol identity changed");
  const report = inspectReviewCohortDeclaration(cohort);
  const issues = new Set<Issue>();
  if (!report.declarationComplete) issues.add("cohort-incomplete");
  if (report.declarationSha256 !== protocol.cohortDeclarationSha256)
    issues.add("cohort-binding");
  if (protocol.reference.id !== cohort.referenceId)
    issues.add("reference-binding");
  if (protocol.priorWorkflow.id !== cohort.priorWorkflowId)
    issues.add("prior-workflow-binding");
  const clusters = new Map<string, string>();
  const caseIds = new Set(cohort.cases.map((row) => row.id));
  for (const row of protocol.caseClusters) {
    if (clusters.has(row.caseId) || !caseIds.has(row.caseId))
      issues.add("cluster-inventory");
    clusters.set(row.caseId, row.clusterId);
  }
  if (
    clusters.size !== cohort.cases.length ||
    cohort.cases.some((row) => !clusters.has(row.id))
  )
    issues.add("cluster-inventory");
  // Excluded variants participate too: an exclusion cannot sever a dependency
  // between repeated observations of the same incident/content/repository/family.
  const bindings = new Map<string, string>();
  for (const row of cohort.cases) {
    const cluster = clusters.get(row.id);
    if (!cluster) continue;
    const keys = ["lineage:" + row.lineageId, "content:" + row.contentSha256];
    if (cohort.grouping.holdoutRepositories)
      keys.push("repository:" + row.repositoryId);
    if (cohort.grouping.holdoutFamilies) keys.push("family:" + row.familyId);
    for (const key of keys) {
      const prior = bindings.get(key);
      if (prior !== undefined && prior !== cluster) issues.add("cluster-split");
      bindings.set(key, cluster);
    }
  }
  const selected = cohort.cases.filter(
    (row) => row.disposition.status === "selected",
  );
  if (
    selected.some(
      (row) => row.split !== "reserved" || row.exposure !== "uninspected",
    )
  )
    issues.add("selected-not-reserved");
  const selectedClusters = new Set(
    selected
      .map((row) => clusters.get(row.id))
      .filter((id) => id !== undefined),
  );
  if (selectedClusters.size < protocol.scoring.minimumClusters)
    issues.add("insufficient-selected-clusters");
  const schedule: ReviewEvaluationProtocolReport["schedule"] = [];
  // Lexical IDs and explicit repetitions make input array reordering incapable of
  // changing the balanced order. This is a declared rotation, not random sampling.
  for (const row of [...selected].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    const clusterId = clusters.get(row.id);
    if (!clusterId) continue;
    for (
      let repetition = 0;
      repetition < protocol.scoring.repetitions;
      repetition++
    )
      schedule.push({
        caseId: row.id,
        clusterId,
        repetition,
        order: [...orders[schedule.length % orders.length]!],
      });
  }
  return {
    schemaVersion: 1,
    profile: protocol.profile,
    protocolSha256,
    cohortDeclarationSha256: report.declarationSha256,
    declarationComplete: issues.size === 0,
    baselineKind: protocol.priorWorkflow.kind,
    counts: {
      totalCases: report.counts.total,
      selectedCases: report.counts.selected,
      excludedCases: report.counts.excluded,
      selectedClusters: selectedClusters.size,
      pairedTrialsPerComparison: selected.length * protocol.scoring.repetitions,
      plannedArmSlots:
        selected.length * protocol.scoring.repetitions * roles.length,
    },
    issues: [...issues].sort(),
    schedule,
    sourceContentInspected: false,
    labelsInspected: false,
    configurationBytesVerified: false,
    chronologyVerified: false,
    licenseGrantVerified: false,
    hostIndependenceVerified: false,
    qualityAssessed: false,
    gateAClosed: false,
    inferenceExecuted: false,
    fieldEvaluationExecuted: false,
  };
}

export function projectReviewEvaluationProtocol(
  report: ReviewEvaluationProtocolReport,
) {
  return {
    schemaVersion: 1 as const,
    profile: "prospective-review-protocol-declaration-v1" as const,
    protocolSha256: report.protocolSha256,
    cohortDeclarationSha256: report.cohortDeclarationSha256,
    declarationComplete: report.declarationComplete,
    baselineKind: report.baselineKind,
    counts: {
      totalCases: report.counts.totalCases,
      selectedCases: report.counts.selectedCases,
      excludedCases: report.counts.excludedCases,
      selectedClusters: report.counts.selectedClusters,
      pairedTrialsPerComparison: report.counts.pairedTrialsPerComparison,
      plannedArmSlots: report.counts.plannedArmSlots,
    },
    issues: [...report.issues],
    sourceContentInspected: false as const,
    labelsInspected: false as const,
    configurationBytesVerified: false as const,
    chronologyVerified: false as const,
    licenseGrantVerified: false as const,
    hostIndependenceVerified: false as const,
    qualityAssessed: false as const,
    gateAClosed: false as const,
    inferenceExecuted: false as const,
    fieldEvaluationExecuted: false as const,
    sourceIncluded: false as const,
    privateIdentitiesIncluded: false as const,
  };
}
