import { z } from "zod";
import { reviewProvenanceInputSchema } from "./review-provenance.js";
import { reviewReceiptSchema } from "./review.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(128);
const text = z.string().trim().min(1).max(4096);
const index = z.number().int().min(0).max(31);
const total = z.number().int().min(0).max(32);
export const reviewFindingConsequenceSchema = z.strictObject({
  category: z.enum([
    "security-boundary",
    "data-loss",
    "availability",
    "wrong-result",
    "maintainability",
    "unknown",
  ]),
  extent: z.enum(["single", "multiple", "systemwide", "unknown"]),
  access: z.enum(["unprivileged", "authenticated", "privileged", "unknown"]),
  recovery: z.enum(["reversible", "irreversible", "unknown"]),
  statement: text,
});
const repair = z.strictObject({
  citationIndex: index,
  functionId: digest,
  requiredParameters: z.array(z.string().min(1).max(256)).max(32),
  scope: z.enum(["this-change", "follow-up", "unknown"]),
  text,
});
const judgment = z.strictObject({
  disposition: z.enum(["supported", "refuted", "unresolved"]),
  citationIndex: index,
  functionId: digest,
  mechanism: text.nullable(),
  reachableCallers: text.nullable(),
  defaultsChecked: text.nullable(),
  consequence: reviewFindingConsequenceSchema.nullable(),
  repair: repair.nullable(),
});
const stage = {
  state: z.enum(["completed", "incomplete", "cancelled", "budget-exhausted"]),
  sessionId: id.nullable(),
  rationale: text.nullable(),
};
export const reviewFindingsInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("source-bound-declared-findings-v1"),
  provenance: reviewProvenanceInputSchema.extend({ scoring: z.null() }),
  reviewerSessionId: id,
  decisions: z
    .array(
      z.strictObject({
        candidateId: id,
        contextDigest: digest,
        candidateDigest: digest,
        nativeRunDigest: digest.nullable(),
        nativeCaseIds: z.array(id).max(16),
        refutation: z.strictObject(stage),
        adjudication: z.strictObject({
          ...stage,
          judgment: judgment.nullable(),
        }),
      }),
    )
    .max(32),
  commonDefects: z
    .array(
      z.strictObject({
        id,
        rootFunctionId: digest,
        candidateIds: z.array(id).min(1).max(32),
        rationale: text,
      }),
    )
    .max(32),
});
export const reviewFindingGapSchema = z.enum([
  "missing-decision",
  "stale-source",
  "unmatched-source",
  "binding-differs",
  "incomplete-stages",
  "reused-session",
  "native-unavailable",
  "ambiguous-native-address",
  "source-address-differs",
  "unresolved-judgment",
  "incomplete-reasoning",
  "native-predicate-not-violated",
  "consequence-unknown",
  "repair-missing",
  "repair-address-differs",
  "repair-parameters-unavailable",
  "repair-parameter-missing",
  "repair-scope-unknown",
]);
const state = z.enum(["declared-supported", "declared-refuted", "unresolved"]);
const severity = z.enum(["high", "moderate", "low", "unassigned"]);
const row = z.strictObject({
  candidateId: id,
  candidateDigest: digest,
  state,
  gaps: z.array(reviewFindingGapSchema).max(24),
  rootFunctionId: digest.nullable(),
  declaredSeverity: severity,
  repairParameters: z.strictObject({
    state: z.enum(["observed", "unavailable", "not-requested"]),
    available: z.array(z.string().max(256)).max(512),
    missing: z.array(z.string().max(256)).max(32),
  }),
});
const group = z.strictObject({
  id,
  candidateIds: z.array(id).min(1).max(32),
  state: z.enum(["declared-common-defect", "unresolved"]),
  reason: z.enum([
    "source-addresses-reconciled",
    "member-unresolved",
    "root-function-differs",
  ]),
});
const common = {
  schemaVersion: z.literal(1),
  format: z.literal("review-findings-report"),
  engineVersion: z.string(),
  channel: z.literal("advisory"),
  inputDigest: digest,
  contextDigest: digest,
  freshness: z.enum(["current", "stale"]),
  status: z.enum(["completed", "incomplete", "stale"]),
  judgmentProvenance: z.literal("host-declared-unverified"),
  nativeReceiptProvenance: z.literal("imported-unattested"),
  severityPolicy: z.literal("declared-consequence-matrix-v1"),
  severityVerified: z.literal(false),
  claimsVerified: z.literal(false),
  independenceVerified: z.literal(false),
  commonCauseVerified: z.literal(false),
  repairCorrectnessVerified: z.literal(false),
  nativeExecution: z.literal(false),
  deterministicOutcomeChanged: z.literal(false),
  qualityGate: z.literal("not-assessed"),
  candidates: z.strictObject({
    selected: total,
    "declared-supported": total,
    "declared-refuted": total,
    unresolved: total,
  }),
  commonDefects: z.strictObject({
    declared: total,
    reconciled: total,
    unresolved: total,
    mappedSupported: total,
    unmappedSupported: total,
  }),
};
export const reviewFindingsReportSchema = z.strictObject({
  ...common,
  input: reviewFindingsInputSchema,
  receipt: reviewReceiptSchema,
  findings: z.array(row).max(32),
  groups: z.array(group).max(32),
});
export const reviewFindingsSummarySchema = z.strictObject({
  ...common,
  sourceIncluded: z.literal(false),
});
export type ReviewFindingsInput = z.infer<typeof reviewFindingsInputSchema>;
export type ReviewFindingsReport = z.infer<typeof reviewFindingsReportSchema>;
export type ReviewFindingGap = z.infer<typeof reviewFindingGapSchema>;
