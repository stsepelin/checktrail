import { z } from "zod";
import {
  inspectReviewEvaluationProtocol,
  reviewEvaluationProtocolInputSchema,
} from "./review-evaluation-protocol.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const roles = ["baseline", "verifier", "reference"] as const;
const metrics = [
  "inputTokens",
  "outputTokens",
  "toolCalls",
  "outputBytes",
  "costMicrousd",
] as const;
const measurement = z.number().int().min(0).max(1_000_000_000).nullable();
const attemptStatus = z.enum([
  "completed",
  "capacity",
  "rate-limited",
  "refused",
  "unavailable",
  "cancelled",
  "timed-out",
  "error",
  "incomplete",
]);
const slotStatus = z.enum([
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
export const reviewEvaluationMeteringInputSchema = z.strictObject({
  declaration: reviewEvaluationProtocolInputSchema,
  expectedProtocolSha256: digest,
  metering: z.strictObject({
    schemaVersion: z.literal(1),
    profile: z.literal("external-review-attempt-metering-v1"),
    protocolSha256: digest,
    procedureSha256: digest,
    collectorConfigurationSha256: digest,
    slots: z
      .array(
        z.strictObject({
          caseId: z.string().regex(/^case-[a-f0-9]{32}$/),
          repetition: z.number().int().min(0).max(1),
          role: z.enum(roles),
          status: slotStatus,
          elapsedMs: measurement,
          attempts: z
            .array(
              z.strictObject({
                ordinal: z.number().int().min(0).max(15),
                sessionId: z.string().regex(/^session-[a-f0-9]{32}$/),
                status: attemptStatus,
                recordSha256: digest,
                source: z.enum([
                  "operator-meter",
                  "provider-reported",
                  "unknown",
                ]),
                elapsedMs: measurement,
                inputTokens: measurement,
                outputTokens: measurement,
                toolCalls: measurement,
                outputBytes: measurement,
                costMicrousd: measurement,
              }),
            )
            .max(16),
        }),
      )
      .max(1536),
  }),
});
export type ReviewEvaluationMeteringInput = z.infer<
  typeof reviewEvaluationMeteringInputSchema
>;
type Role = (typeof roles)[number];
type Metric = (typeof metrics)[number];
type Issue =
  | "protocol-incomplete"
  | "meter-protocol-binding"
  | "meter-procedure-binding"
  | "slot-inventory"
  | "attempt-order"
  | "session-reuse"
  | "record-reuse"
  | "terminal-accounting"
  | "elapsed-accounting"
  | "unknown-source-measurement"
  | "unknown-measurements"
  | "budget-exceeded";
interface Total {
  observedTotal: number;
  unknownRecords: number;
  completeForPlannedSlots: boolean;
}
interface Arm {
  plannedSlots: number;
  receivedUniqueSlots: number;
  completedSlots: number;
  attempts: number;
  noncompletedAttempts: number;
  sources: Record<"operator-meter" | "provider-reported" | "unknown", number>;
  terminalStates: Record<z.infer<typeof slotStatus>, number>;
  attemptStates: Record<z.infer<typeof attemptStatus>, number>;
  measurements: Record<Metric | "slotElapsedMs" | "attemptElapsedMs", Total>;
  budgetExceededSlots: number;
  budgetUnknownSlots: number;
}
export interface ReviewEvaluationMeteringReport {
  schemaVersion: 1;
  profile: "external-review-attempt-metering-v1";
  protocolSha256: string;
  terminalCoverageComplete: boolean;
  measurementAccountingComplete: boolean;
  counts: {
    plannedSlots: number;
    receivedSlots: number;
    receivedUniquePlannedSlots: number;
    missingSlots: number;
    duplicateSlots: number;
    foreignSlots: number;
    receivedAttempts: number;
    unattributedAttempts: number;
  };
  arms: Record<Role, Arm>;
  issues: Issue[];
  sourceIncluded: false;
  privateIdentitiesIncluded: false;
  meterAuthenticityVerified: false;
  actualAttemptsComplete: false;
  hostIndependenceVerified: false;
  billingVerified: false;
  hostBudgetsEnforced: false;
  qualityAssessed: false;
  gateAClosed: false;
  inferenceInvokedByInspector: false;
}
const key = (row: { caseId: string; repetition: number; role: Role }) =>
  JSON.stringify([row.caseId, row.repetition, row.role]);
const counts = <T extends string>(values: readonly T[]) =>
  Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;

/** Reconcile externally supplied metadata; this never starts or verifies a host. */
export function inspectReviewEvaluationMetering(
  input: unknown,
): ReviewEvaluationMeteringReport {
  // Apply collection bounds before parsing/allocating a second copy.
  const candidate = input as { metering?: { slots?: unknown } } | null;
  const rawSlots = candidate?.metering?.slots;
  if (Array.isArray(rawSlots)) {
    if (rawSlots.length > 1536) throw Error("Metering exceeds slot bound");
    for (const row of rawSlots) {
      const attempts = (row as { attempts?: unknown } | null)?.attempts;
      if (Array.isArray(attempts) && attempts.length > 16)
        throw Error("Metering exceeds attempt bound");
    }
  }
  const { declaration, expectedProtocolSha256, metering } =
    reviewEvaluationMeteringInputSchema.parse(input);
  const protocol = inspectReviewEvaluationProtocol(
    declaration,
    expectedProtocolSha256,
  );
  const issues = new Set<Issue>();
  if (!protocol.declarationComplete) issues.add("protocol-incomplete");
  if (metering.protocolSha256 !== protocol.protocolSha256)
    issues.add("meter-protocol-binding");
  if (
    metering.procedureSha256 !==
    declaration.protocol.procedures.externalMeteringSha256
  )
    issues.add("meter-procedure-binding");
  // Cluster omissions invalidate the declaration, but must not remove a planned
  // case from the usage denominator. Derive slots from all selected declarations.
  const expected = new Set(
    declaration.cohort.cases
      .filter((row) => row.disposition.status === "selected")
      .flatMap((row) =>
        Array.from(
          { length: declaration.protocol.scoring.repetitions },
          (_, repetition) =>
            roles.map((role) => key({ caseId: row.id, repetition, role })),
        ).flat(),
      ),
  );
  const arms = Object.fromEntries(
    roles.map((role) => [
      role,
      {
        plannedSlots: protocol.counts.pairedTrialsPerComparison,
        receivedUniqueSlots: 0,
        completedSlots: 0,
        attempts: 0,
        noncompletedAttempts: 0,
        sources: counts(["operator-meter", "provider-reported", "unknown"]),
        terminalStates: counts(slotStatus.options),
        attemptStates: counts(attemptStatus.options),
        measurements: Object.fromEntries(
          [...metrics, "slotElapsedMs", "attemptElapsedMs"].map((metric) => [
            metric,
            {
              observedTotal: 0,
              unknownRecords: 0,
              completeForPlannedSlots: false,
            },
          ]),
        ),
        budgetExceededSlots: 0,
        budgetUnknownSlots: 0,
      },
    ]),
  ) as Record<Role, Arm>;
  const received = new Set<string>(),
    sessions = new Set<string>(),
    records = new Set<string>();
  let duplicateSlots = 0,
    foreignSlots = 0,
    receivedAttempts = 0;
  const add = (total: Total, value: number | null) => {
    if (value === null) total.unknownRecords++;
    else total.observedTotal += value;
  };
  for (const slot of metering.slots) {
    receivedAttempts += slot.attempts.length;
    const identity = key(slot);
    if (!expected.has(identity)) {
      foreignSlots++;
      continue;
    }
    if (received.has(identity)) {
      duplicateSlots++;
      continue;
    }
    received.add(identity);
    const arm = arms[slot.role];
    arm.receivedUniqueSlots++;
    arm.terminalStates[slot.status]++;
    if (slot.status === "completed") arm.completedSlots++;
    const last = slot.attempts.at(-1);
    // A success is terminal. Failed attempts before it remain in all totals.
    if (
      (slot.status === "completed" && last?.status !== "completed") ||
      (slot.status === "not-run" && slot.attempts.length !== 0) ||
      (slot.status !== "completed" && last?.status === "completed") ||
      slot.attempts.slice(0, -1).some((row) => row.status === "completed") ||
      (["refused", "cancelled", "timed-out", "error"].includes(slot.status) &&
        last?.status !== slot.status)
    )
      issues.add("terminal-accounting");
    const totals: Record<Metric | "elapsedMs", number> = {
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      outputBytes: 0,
      costMicrousd: 0,
      elapsedMs: 0,
    };
    let elapsedKnown = true,
      budgetUnknown = slot.elapsedMs === null;
    add(arm.measurements.slotElapsedMs, slot.elapsedMs);
    for (const [ordinal, attempt] of slot.attempts.entries()) {
      arm.attempts++;
      arm.attemptStates[attempt.status]++;
      arm.sources[attempt.source]++;
      if (attempt.status !== "completed") arm.noncompletedAttempts++;
      if (attempt.ordinal !== ordinal) issues.add("attempt-order");
      if (sessions.has(attempt.sessionId)) issues.add("session-reuse");
      sessions.add(attempt.sessionId);
      if (records.has(attempt.recordSha256)) issues.add("record-reuse");
      records.add(attempt.recordSha256);
      if (
        attempt.source === "unknown" &&
        [...metrics, "elapsedMs" as const].some(
          (metric) => attempt[metric] !== null,
        )
      )
        issues.add("unknown-source-measurement");
      for (const metric of [...metrics, "elapsedMs" as const]) {
        const value = attempt[metric];
        add(
          arm.measurements[
            metric === "elapsedMs" ? "attemptElapsedMs" : metric
          ],
          value,
        );
        if (value !== null) totals[metric] += value;
        else {
          issues.add("unknown-measurements");
          if (metric === "elapsedMs") elapsedKnown = false;
          if (metric !== "costMicrousd") budgetUnknown = true;
        }
      }
    }
    if (slot.elapsedMs === null) issues.add("unknown-measurements");
    else if (elapsedKnown && slot.elapsedMs < totals.elapsedMs)
      issues.add("elapsed-accounting");
    const budgets = declaration.protocol.budgets;
    // Known subtotals alone can already prove an overage; null is never zero.
    if (
      (slot.elapsedMs !== null && slot.elapsedMs > budgets.wallMsPerArm) ||
      totals.elapsedMs > budgets.wallMsPerArm ||
      totals.inputTokens > budgets.inputTokensPerArm ||
      totals.outputTokens > budgets.outputTokensPerArm ||
      totals.toolCalls > budgets.toolCallsPerArm ||
      totals.outputBytes > budgets.outputBytesPerArm
    ) {
      arm.budgetExceededSlots++;
      issues.add("budget-exceeded");
    }
    if (budgetUnknown) arm.budgetUnknownSlots++;
  }
  const missingSlots = protocol.counts.plannedArmSlots - received.size;
  if (missingSlots || duplicateSlots || foreignSlots)
    issues.add("slot-inventory");
  const terminalCoverageComplete =
    protocol.declarationComplete &&
    ![
      "meter-protocol-binding",
      "meter-procedure-binding",
      "slot-inventory",
      "attempt-order",
      "session-reuse",
      "record-reuse",
      "terminal-accounting",
    ].some((issue) => issues.has(issue as Issue));
  for (const arm of Object.values(arms))
    for (const total of Object.values(arm.measurements))
      total.completeForPlannedSlots =
        terminalCoverageComplete &&
        !issues.has("unknown-source-measurement") &&
        !issues.has("elapsed-accounting") &&
        total.unknownRecords === 0;
  return {
    schemaVersion: 1,
    profile: metering.profile,
    protocolSha256: protocol.protocolSha256,
    terminalCoverageComplete,
    measurementAccountingComplete: issues.size === 0,
    counts: {
      plannedSlots: protocol.counts.plannedArmSlots,
      receivedSlots: metering.slots.length,
      receivedUniquePlannedSlots: received.size,
      missingSlots,
      duplicateSlots,
      foreignSlots,
      receivedAttempts,
      unattributedAttempts:
        receivedAttempts -
        Object.values(arms).reduce((sum, arm) => sum + arm.attempts, 0),
    },
    arms,
    issues: [...issues].sort(),
    sourceIncluded: false,
    privateIdentitiesIncluded: false,
    meterAuthenticityVerified: false,
    actualAttemptsComplete: false,
    hostIndependenceVerified: false,
    billingVerified: false,
    hostBudgetsEnforced: false,
    qualityAssessed: false,
    gateAClosed: false,
    inferenceInvokedByInspector: false,
  };
}
