import { inspectReviewCohortDeclaration } from "../src/review-cohort.js";
import type { ReviewCohortDeclaration } from "../src/review-cohort.js";
import type { ReviewEvaluationProtocol } from "../src/review-evaluation-protocol.js";
export const protocolHex = (n: number) => n.toString(16).padStart(32, "0");
export const protocolSha = (n: number) => n.toString(16).padStart(64, "0");
export function protocolFixture(total = 3) {
  const cohort: ReviewCohortDeclaration = {
    schemaVersion: 1,
    profile: "evaluation-cohort-declaration-v1",
    referenceId: "reference-" + protocolHex(1),
    priorWorkflowId: "workflow-" + protocolHex(2),
    grouping: { holdoutRepositories: false, holdoutFamilies: false },
    cases: Array.from({ length: total }, (_, i) => {
      const n = i + 1;
      return {
        id: "case-" + protocolHex(n),
        repositoryId: "repository-" + protocolHex(n),
        familyId: "family-" + protocolHex(n),
        lineageId: "lineage-" + protocolHex(n),
        contentSha256: protocolSha(n),
        sourceArchiveSha256: protocolSha(n + 1000),
        noticeSha256: protocolSha(n + 2000),
        license: "MIT",
        requiresPrivateService: false,
        distribution: "permitted" as const,
        inScope: true,
        split: "reserved" as const,
        exposure: "uninspected" as const,
        disposition: { status: "selected" as const },
      };
    }),
  };
  const protocol: ReviewEvaluationProtocol = {
    schemaVersion: 1,
    profile: "prospective-review-protocol-declaration-v1",
    reference: {
      id: cohort.referenceId,
      configurationSha256: protocolSha(3001),
    },
    priorWorkflow: {
      kind: "declared-comparison-baseline",
      id: cohort.priorWorkflowId,
      configurationSha256: protocolSha(3002),
    },
    verifierConfigurationSha256: protocolSha(3003),
    cohortDeclarationSha256:
      inspectReviewCohortDeclaration(cohort).declarationSha256,
    implementation: {
      sourceCommit: "a".repeat(40),
      inventoryScopeSha256: protocolSha(3010),
      engineArtifactsSha256: protocolSha(3011),
      packageLockSha256: protocolSha(3012),
      nativeToolsSha256: protocolSha(3013),
      environmentSha256: protocolSha(3014),
    },
    procedures: {
      acquisitionSha256: protocolSha(3020),
      answerSeparationSha256: protocolSha(3021),
      hostIsolationSha256: protocolSha(3022),
      independentJudgmentSha256: protocolSha(3023),
      commonDefectMatchingSha256: protocolSha(3024),
      externalMeteringSha256: protocolSha(3025),
      stopRulesSha256: protocolSha(3026),
    },
    budgets: {
      wallMsPerArm: 60000,
      inputTokensPerArm: 10000,
      outputTokensPerArm: 1000,
      toolCallsPerArm: 20,
      outputBytesPerArm: 65536,
    },
    scoring: {
      profile: "declared-multi-claim-paired-v1",
      seed: protocolSha(3030),
      confidenceLevel: 0.95,
      resamples: 128,
      repetitions: 2,
      minimumClusters: 2,
      order: "balanced-three-arm-rotation-v1",
      thresholds: {
        minimumSupportedClaimPrecision: 0.95,
        minimumMaterialDefectRecall: 0.8,
        maximumValidCaseFalseAlarmRate: 0.05,
        maximumNearMissFalseAlarmRate: 0.05,
        maximumRecallNoninferiorityMargin: 0.02,
        maximumPrecisionNoninferiorityMargin: 0.02,
        minimumCompletedCoverage: 1,
      },
    },
    caseClusters: cohort.cases.map((row, i) => ({
      caseId: row.id,
      clusterId: "cluster-" + protocolHex(i + 1),
    })),
  };
  return { protocol, cohort };
}
export function bindProtocolCohort(input: ReturnType<typeof protocolFixture>) {
  input.protocol.cohortDeclarationSha256 = inspectReviewCohortDeclaration(
    input.cohort,
  ).declarationSha256;
  return input;
}
