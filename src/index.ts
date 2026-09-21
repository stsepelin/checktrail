export { createPlan, validate, aggregate } from "./engine.js";
export { validateContracts } from "./contracts.js";
export type { ContractBundle, ContractReport } from "./contract-schema.js";
export type { PlanOptions, ValidationOptions } from "./engine.js";
export { adapters } from "./adapters.js";
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
