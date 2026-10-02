export { createPlan, validate, aggregate } from "./engine.js";
export { validateContracts } from "./contracts.js";
export type { ContractBundle, ContractReport } from "./contract-schema.js";
export type { PlanOptions, ValidationOptions } from "./engine.js";
export { adapters } from "./adapters.js";
export {
  initialize,
  diagnose,
  mcpConfiguration,
  mcpClients,
} from "./onboarding.js";
export type {
  InitOptions,
  InitResult,
  DoctorIssue,
  DoctorResult,
  McpClient,
} from "./onboarding.js";
export type { PolicyPack, PackReference } from "./policy-pack.js";
export { fetchPolicyPack } from "./fetch-pack.js";
export type { FetchPackOptions, FetchedPack } from "./fetch-pack.js";
export { projectPlan, projectReport } from "./output.js";
export type {
  Plan,
  Report,
  Check,
  CheckResult,
  Status,
  Outcome,
  TestEvidence,
  ToolSpec,
  ToolEvidence,
  Finding,
  Workspace,
  GitIdentity,
  ChangeSelection,
} from "./types.js";

export { importJUnit } from "./junit.js";
export type { JUnitImport, JUnitCase } from "./junit.js";

export { exportSarif } from "./sarif.js";

export { createFindingBaseline, compareFindings } from "./finding-policy.js";
export { compareRuntimeInventories } from "./runtime-inventory.js";
export type {
  RuntimeInventory,
  RuntimeComparison,
} from "./runtime-inventory.js";
export type {
  FindingBaseline,
  FindingComparison,
} from "./finding-policy-schema.js";

export { checkArchitecture } from "./architecture.js";
export type {
  DependencyGraph,
  ArchitecturePolicy,
  ArchitectureReport,
} from "./architecture.js";

export { retrieveGuidance, projectGuidance } from "./guidance.js";
export type { GuidanceContext, GuidanceReport } from "./guidance.js";

export { runMutations, projectMutations } from "./mutation.js";
export type { MutationRecipe, MutationReport } from "./mutation.js";

export { loadExternalAdapters } from "./external-adapter.js";
export type {
  ExternalReference,
  ExternalIdentity,
} from "./external-adapter.js";

export {
  createReviewContext,
  parseReviewContext,
  projectReviewContext,
  receiveReview,
  projectReviewReceipt,
} from "./review.js";
export type {
  ReviewContext,
  ReviewAssessment,
  ReviewReceipt,
} from "./review.js";

export { openTaskStore } from "./task-store.js";
export type {
  ValidationTaskStore,
  StoredValidationTask,
  TaskStoreOptions,
  TaskTransition,
} from "./task-store.js";

export { openValidationTasks } from "./validation-tasks.js";
export type {
  ValidationTasks,
  ValidationTasksOptions,
} from "./validation-tasks.js";

export {
  createHypothesisPlan,
  projectHypothesisPlan,
} from "./review-hypotheses.js";
export type { HypothesisPlan } from "./review-hypotheses.js";

export {
  runProviderReview,
  projectProviderReview,
  loadReviewProviderConfig,
} from "./review-provider.js";
export type { ReviewProviderOptions } from "./review-provider.js";
export type {
  ReviewProviderConfig,
  ReviewProviderRun,
  ReviewProviderBudget,
  ReviewCandidate,
} from "./review-provider-schema.js";

export {
  runReviewProbe,
  projectReviewProbe,
  parseReviewProbe,
  parseReviewProbeRun,
  loadPinnedReviewProbe,
} from "./review-probe.js";
export type { ReviewProbeOptions, PinnedReviewProbe } from "./review-probe.js";
export type {
  ReviewProbeRecipe,
  ReviewProbeRun,
} from "./review-probe-schema.js";

export {
  runProviderRefutation,
  parseProviderRefutation,
  projectProviderRefutation,
} from "./review-refutation.js";
export type { ReviewRefutationRun } from "./review-refutation.js";

export {
  scoreReviewTrials,
  projectReviewScoring,
  reviewBinomialLower95,
} from "./review-scoring.js";
export type { ReviewScoringReport } from "./review-scoring.js";

export {
  runReviewVerification,
  parseReviewVerification,
  projectReviewVerification,
} from "./review-verification.js";
export type {
  ReviewVerificationOptions,
  ReviewVerificationRun,
} from "./review-verification.js";
