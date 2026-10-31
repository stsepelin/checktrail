import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  inspectReviewEvaluationProtocol,
  reviewEvaluationProtocolInputSchema,
} from "./review-evaluation-protocol.js";
import {
  inspectReviewEvaluationMetering,
  reviewEvaluationMeteringInputSchema,
} from "./review-evaluation-metering.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const roles = ["baseline", "verifier", "reference"] as const;
type Role = (typeof roles)[number];
const state = z.enum([
  "completed",
  "not-run",
  "budget-exhausted",
  "refused",
  "unavailable",
  "cancelled",
  "timed-out",
  "error",
  "incomplete",
]);
export const reviewEvaluationCaptureInputSchema =
  reviewEvaluationMeteringInputSchema.extend({
    captures: z
      .array(
        z.strictObject({
          caseId: z.string().regex(/^case-[a-f0-9]{32}$/),
          repetition: z.number().int().min(0).max(1),
          role: z.enum(roles),
          assignmentSha256: digest,
          configurationSha256: digest,
          sourceArchiveSha256: digest,
          contentSha256: digest,
          captureSha256: digest,
          status: state,
          attemptRecords: z.array(digest).max(16),
          output: z
            .strictObject({
              sha256: digest,
              bytes: z
                .number()
                .int()
                .min(0)
                .max(4 * 1048576),
            })
            .nullable(),
        }),
      )
      .max(1536),
  });
export type ReviewEvaluationCaptureInput = z.infer<
  typeof reviewEvaluationCaptureInputSchema
>;
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const key = (row: { caseId: string; repetition: number; role: Role }) =>
  JSON.stringify([row.caseId, row.repetition, row.role]);
/** Operator addressing metadata only; execution order remains the declared protocol schedule. */
export function reviewEvaluationCaptureAssignments(value: unknown) {
  const declaration = reviewEvaluationProtocolInputSchema.parse(value);
  const report = inspectReviewEvaluationProtocol(declaration);
  const configurations = {
    baseline: declaration.protocol.priorWorkflow.configurationSha256,
    verifier: declaration.protocol.verifierConfigurationSha256,
    reference: declaration.protocol.reference.configurationSha256,
  };
  // Incomplete clustering must never shrink the selected-case denominator.
  return declaration.cohort.cases
    .filter((c) => c.disposition.status === "selected")
    .sort((a, b) => a.id.localeCompare(b.id, "en"))
    .flatMap((c) =>
      Array.from(
        { length: declaration.protocol.scoring.repetitions },
        (_, repetition) =>
          roles.map((role) => {
            const address = {
              schemaVersion: 1 as const,
              profile: "external-review-capture-assignment-v1" as const,
              protocolSha256: report.protocolSha256,
              caseId: c.id,
              repetition,
              role,
              configurationSha256: configurations[role],
              sourceArchiveSha256: c.sourceArchiveSha256,
              contentSha256: c.contentSha256,
              sourceIncluded: false as const,
              peerOutputsIncluded: false as const,
            };
            return { ...address, assignmentSha256: hash(address) };
          }),
      ).flat(),
    );
}
type Issue =
  | "protocol-incomplete"
  | "metering-incomplete"
  | "capture-inventory"
  | "capture-assignment-binding"
  | "capture-configuration-binding"
  | "capture-source-binding"
  | "capture-attempt-binding"
  | "capture-status-binding"
  | "empty-completed-output"
  | "capture-output-budget"
  | "capture-output-accounting"
  | "capture-record-reuse";
/** Bind external review declarations; no reviewer, source, output blob or answer is opened. */
export function inspectReviewEvaluationCaptures(value: unknown) {
  const candidate = value as { captures?: unknown } | null;
  if (Array.isArray(candidate?.captures)) {
    if (candidate.captures.length > 1536)
      throw Error("Capture slot bound exceeded");
    for (const row of candidate.captures) {
      const records = (row as { attemptRecords?: unknown } | null)
        ?.attemptRecords;
      if (Array.isArray(records) && records.length > 16)
        throw Error("Capture attempt bound exceeded");
    }
  }
  const input = reviewEvaluationCaptureInputSchema.parse(value);
  const { declaration, expectedProtocolSha256, metering, captures } = input;
  const protocol = inspectReviewEvaluationProtocol(
    declaration,
    expectedProtocolSha256,
  );
  const meter = inspectReviewEvaluationMetering({
    declaration,
    expectedProtocolSha256,
    metering,
  });
  const assignments = reviewEvaluationCaptureAssignments(declaration);
  const expected = new Map(assignments.map((a) => [key(a), a]));
  const received = new Map<string, typeof captures>();
  for (const row of captures) {
    const k = key(row);
    received.set(k, [...(received.get(k) ?? []), row]);
  }
  const measured = new Map<string, typeof metering.slots>();
  for (const row of metering.slots) {
    const k = key(row);
    measured.set(k, [...(measured.get(k) ?? []), row]);
  }
  const captureUses = new Map<string, number>();
  for (const row of captures)
    captureUses.set(
      row.captureSha256,
      (captureUses.get(row.captureSha256) ?? 0) + 1,
    );
  const issues = new Set<Issue>();
  if (!protocol.declarationComplete) issues.add("protocol-incomplete");
  if (!meter.terminalCoverageComplete) issues.add("metering-incomplete");
  let boundSlots = 0,
    invalidPlannedSlots = 0,
    missingSlots = 0,
    duplicateRecords = 0,
    foreignRecords = 0,
    completedOutputs = 0;
  const byRole = Object.fromEntries(
    roles.map((role) => [role, { planned: 0, bound: 0, completedOutputs: 0 }]),
  ) as Record<
    Role,
    { planned: number; bound: number; completedOutputs: number }
  >;
  for (const row of captures) if (!expected.has(key(row))) foreignRecords++;
  for (const [k, assignment] of expected) {
    byRole[assignment.role].planned++;
    const rows = received.get(k) ?? [];
    if (!rows.length) {
      missingSlots++;
      continue;
    }
    if (rows.length !== 1) {
      duplicateRecords += rows.length - 1;
      invalidPlannedSlots++;
      continue;
    }
    const row = rows[0]!;
    let valid = true;
    const refuse = (issue: Issue) => {
      issues.add(issue);
      valid = false;
    };
    if (captureUses.get(row.captureSha256)! > 1) refuse("capture-record-reuse");
    if (row.assignmentSha256 !== assignment.assignmentSha256)
      refuse("capture-assignment-binding");
    if (row.configurationSha256 !== assignment.configurationSha256)
      refuse("capture-configuration-binding");
    if (
      row.sourceArchiveSha256 !== assignment.sourceArchiveSha256 ||
      row.contentSha256 !== assignment.contentSha256
    )
      refuse("capture-source-binding");
    const meters = measured.get(k) ?? [];
    const m = meters.length === 1 ? meters[0] : undefined;
    if (
      !m ||
      !isDeepStrictEqual(
        row.attemptRecords,
        m.attempts.map((a) => a.recordSha256),
      )
    )
      refuse("capture-attempt-binding");
    if (!m || m.status !== row.status) refuse("capture-status-binding");
    if (row.status === "completed" && (!row.output || row.output.bytes === 0))
      refuse("empty-completed-output");
    if (
      row.output &&
      row.output.bytes > declaration.protocol.budgets.outputBytesPerArm
    )
      refuse("capture-output-budget");
    const terminal = m?.attempts.at(-1);
    if (
      row.output &&
      (!terminal ||
        (terminal.outputBytes !== null &&
          row.output.bytes > terminal.outputBytes))
    )
      refuse("capture-output-accounting");
    if (valid) {
      boundSlots++;
      byRole[row.role].bound++;
      if (row.status === "completed") {
        completedOutputs++;
        byRole[row.role].completedOutputs++;
      }
    } else invalidPlannedSlots++;
  }
  if (missingSlots || duplicateRecords || foreignRecords)
    issues.add("capture-inventory");
  const captureInventoryComplete =
    assignments.length > 0 &&
    issues.size === 0 &&
    boundSlots === assignments.length;
  return {
    schemaVersion: 1 as const,
    profile: "external-review-capture-declarations-v1" as const,
    protocolSha256: protocol.protocolSha256,
    inputSha256: hash(input),
    captureInventoryComplete,
    declaredOutputsComplete:
      captureInventoryComplete && completedOutputs === assignments.length,
    measurementAccountingComplete: meter.measurementAccountingComplete,
    counts: {
      plannedSlots: assignments.length,
      suppliedRecords: captures.length,
      receivedUniquePlannedSlots: assignments.length - missingSlots,
      boundSlots,
      invalidPlannedSlots,
      missingSlots,
      duplicateRecords,
      foreignRecords,
      completedOutputs,
    },
    byRole,
    issues: [...issues].sort(),
    metering: meter,
    sourceIncluded: false as const,
    privateIdentitiesIncluded: false as const,
    physicalArtifactsVerified: false as const,
    collectorAuthenticityVerified: false as const,
    actualAttemptsComplete: false as const,
    hostIndependenceVerified: false as const,
    claimTruthVerified: false as const,
    qualityAssessed: false as const,
    gateAClosed: false as const,
    inferenceInvokedByInspector: false as const,
  };
}
export type ReviewEvaluationCaptureReport = ReturnType<
  typeof inspectReviewEvaluationCaptures
>;
