import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as library from "../src/index.js";
import {
  inspectReviewEvaluationMetering,
  reviewEvaluationMeteringInputSchema,
} from "../src/review-evaluation-metering.js";
import { inspectReviewEvaluationProtocol } from "../src/review-evaluation-protocol.js";
import { meteringFixture } from "./review-evaluation-metering-fixture.js";
import {
  protocolHex,
  protocolSha,
} from "./review-evaluation-protocol-fixture.js";
const inspect = inspectReviewEvaluationMetering;
const script = fileURLToPath(
  new URL("../../scripts/check-evaluation-metering.mjs", import.meta.url),
);
const measurementNames = [
  "inputTokens",
  "outputTokens",
  "toolCalls",
  "outputBytes",
  "costMicrousd",
  "elapsedMs",
] as const;

test("evaluation metering retains failed retries in exact common-arm totals without invoking a host", () => {
  const input = meteringFixture(),
    original = structuredClone(input),
    report = inspect(input);
  assert.equal(report.measurementAccountingComplete, true);
  assert.equal(report.terminalCoverageComplete, true);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.counts, {
    plannedSlots: 18,
    receivedSlots: 18,
    receivedUniquePlannedSlots: 18,
    missingSlots: 0,
    duplicateSlots: 0,
    foreignSlots: 0,
    receivedAttempts: 36,
    unattributedAttempts: 0,
  });
  for (const arm of Object.values(report.arms)) {
    assert.equal(arm.plannedSlots, 6);
    assert.equal(arm.completedSlots, 6);
    assert.equal(arm.attempts, 12);
    assert.equal(arm.noncompletedAttempts, 6);
    assert.equal(arm.attemptStates.capacity, 6);
    assert.equal(arm.attemptStates.completed, 6);
    assert.deepEqual(arm.sources, {
      "operator-meter": 12,
      "provider-reported": 0,
      unknown: 0,
    });
    for (const [metric, value] of Object.entries({
      inputTokens: 1200,
      outputTokens: 240,
      toolCalls: 12,
      outputBytes: 960,
      costMicrousd: 480,
      slotElapsedMs: 180,
      attemptElapsedMs: 120,
    }))
      assert.deepEqual(
        arm.measurements[metric as keyof typeof arm.measurements],
        {
          observedTotal: value,
          unknownRecords: 0,
          completeForPlannedSlots: true,
        },
      );
    assert.equal(arm.budgetExceededSlots, 0);
    assert.equal(arm.budgetUnknownSlots, 0);
  }
  assert.deepEqual(input, original);
  assert.deepEqual(library.inspectReviewEvaluationMetering(input), report);
  for (const flag of [
    "sourceIncluded",
    "privateIdentitiesIncluded",
    "meterAuthenticityVerified",
    "actualAttemptsComplete",
    "hostIndependenceVerified",
    "billingVerified",
    "hostBudgetsEnforced",
    "qualityAssessed",
    "gateAClosed",
    "inferenceInvokedByInspector",
  ] as const)
    assert.equal(report[flag], false, flag);
});

test("evaluation metering partitions missing duplicate foreign and excluded slots without shrinking the plan", () => {
  const input = meteringFixture();
  input.metering.slots.pop();
  input.metering.slots.push(structuredClone(input.metering.slots[0]!));
  const foreign = structuredClone(input.metering.slots[1]!);
  foreign.caseId = "case-" + protocolHex(9999);
  input.metering.slots.push(foreign);
  const report = inspect(input);
  assert.deepEqual(report.issues, ["slot-inventory"]);
  assert.equal(report.terminalCoverageComplete, false);
  assert.equal(report.measurementAccountingComplete, false);
  assert.deepEqual(report.counts, {
    plannedSlots: 18,
    receivedSlots: 19,
    receivedUniquePlannedSlots: 17,
    missingSlots: 1,
    duplicateSlots: 1,
    foreignSlots: 1,
    receivedAttempts: 38,
    unattributedAttempts: 4,
  });
  assert.equal(
    Object.values(report.arms).reduce((n, a) => n + a.attempts, 0) +
      report.counts.unattributedAttempts,
    report.counts.receivedAttempts,
  );
  assert.ok(
    Object.values(report.arms).every(
      (a) => !a.measurements.inputTokens.completeForPlannedSlots,
    ),
  );
  for (const change of ["repetition", "excluded"] as const) {
    const value = meteringFixture();
    if (change === "repetition") value.metering.slots[0]!.repetition = 1;
    else {
      value.declaration.cohort.cases[0]!.disposition = {
        status: "excluded",
        reasons: ["out-of-scope"],
      };
      value.declaration.cohort.cases[0]!.inScope = false;
      const { inspectReviewCohortDeclaration } = library;
      value.declaration.protocol.cohortDeclarationSha256 =
        inspectReviewCohortDeclaration(
          value.declaration.cohort,
        ).declarationSha256;
      value.expectedProtocolSha256 = inspectReviewEvaluationProtocol(
        value.declaration,
      ).protocolSha256;
      value.metering.protocolSha256 = value.expectedProtocolSha256;
    }
    const result = inspect(value);
    assert.ok(result.issues.includes("slot-inventory"));
    assert.equal(result.measurementAccountingComplete, false);
  }
});

test("evaluation metering rejects reused declared sessions and complete-record identities across every arm and retry", () => {
  for (const field of ["sessionId", "recordSha256"] as const)
    for (const acrossSlots of [false, true]) {
      const value = meteringFixture(),
        first = value.metering.slots[0]!.attempts[0]!;
      const second = acrossSlots
        ? value.metering.slots[1]!.attempts[0]!
        : value.metering.slots[0]!.attempts[1]!;
      second[field] = first[field];
      const report = inspect(value);
      assert.deepEqual(report.issues, [
        field === "sessionId" ? "session-reuse" : "record-reuse",
      ]);
      assert.equal(report.terminalCoverageComplete, false);
      assert.equal(report.counts.receivedAttempts, 36);
    }
  // Distinct exact identifiers are valid; sharing all but their last byte is not reuse.
  assert.equal(inspect(meteringFixture()).terminalCoverageComplete, true);
});

test("evaluation metering preserves ordered retry admissions and rejects success followed by another attempt", () => {
  for (const ordinals of [
    [1, 2],
    [0, 0],
    [1, 0],
  ]) {
    const value = meteringFixture();
    value.metering.slots[0]!.attempts.forEach(
      (row, i) => (row.ordinal = ordinals[i]!),
    );
    assert.deepEqual(inspect(value).issues, ["attempt-order"]);
  }
  const value = meteringFixture();
  value.metering.slots[0]!.attempts[0]!.status = "completed";
  assert.deepEqual(inspect(value).issues, ["terminal-accounting"]);
});

test("evaluation metering keeps explicit nonexecution separate from successful review and reconciles terminal failures", () => {
  const none = meteringFixture();
  for (const row of none.metering.slots) {
    row.status = "not-run";
    row.attempts = [];
    row.elapsedMs = 0;
  }
  const report = inspect(none);
  assert.equal(report.measurementAccountingComplete, true);
  assert.equal(report.counts.receivedAttempts, 0);
  assert.ok(
    Object.values(report.arms).every(
      (arm) => arm.completedSlots === 0 && arm.terminalStates["not-run"] === 6,
    ),
  );
  for (const status of [
    "refused",
    "cancelled",
    "timed-out",
    "error",
    "unavailable",
    "incomplete",
    "budget-exhausted",
  ] as const) {
    const value = meteringFixture(),
      slot = value.metering.slots[0]!;
    slot.status = status;
    slot.attempts[1]!.status =
      status === "budget-exhausted" ? "incomplete" : status;
    const result = inspect(value);
    assert.equal(result.measurementAccountingComplete, true, status);
    assert.equal(result.arms[slot.role].completedSlots, 5, status);
  }
  for (const kind of [
    "no-success",
    "phantom-success",
    "not-run-with-attempt",
    "mismatched-terminal",
  ] as const) {
    const value = meteringFixture(),
      slot = value.metering.slots[0]!;
    if (kind === "no-success") slot.attempts = [];
    if (kind === "phantom-success") slot.status = "incomplete";
    if (kind === "not-run-with-attempt") slot.status = "not-run";
    if (kind === "mismatched-terminal") {
      slot.status = "cancelled";
      slot.attempts[1]!.status = "error";
    }
    assert.ok(inspect(value).issues.includes("terminal-accounting"), kind);
  }
});

test("evaluation metering keeps unknown and provider-reported usage explicit without treating null as zero", () => {
  for (const metric of measurementNames) {
    const value = meteringFixture(),
      slot = value.metering.slots[0]!;
    slot.attempts[0]![metric] = null;
    const report = inspect(value),
      total =
        report.arms[slot.role].measurements[
          metric === "elapsedMs" ? "attemptElapsedMs" : metric
        ];
    assert.equal(report.measurementAccountingComplete, false, metric);
    assert.equal(report.terminalCoverageComplete, true, metric);
    assert.equal(total.unknownRecords, 1, metric);
    assert.equal(total.completeForPlannedSlots, false, metric);
    assert.ok(total.observedTotal > 0, metric);
    assert.equal(
      report.arms[slot.role].budgetUnknownSlots,
      metric === "costMicrousd" ? 0 : 1,
      metric,
    );
  }
  const unknown = meteringFixture(),
    attempt = unknown.metering.slots[0]!.attempts[0]!;
  attempt.source = "unknown";
  assert.deepEqual(inspect(unknown).issues, ["unknown-source-measurement"]);
  for (const metric of measurementNames) attempt[metric] = null;
  const result = inspect(unknown);
  assert.deepEqual(result.issues, ["unknown-measurements"]);
  const reported = meteringFixture();
  for (const slot of reported.metering.slots)
    for (const row of slot.attempts) row.source = "provider-reported";
  const provider = inspect(reported);
  assert.equal(provider.measurementAccountingComplete, true);
  assert.equal(provider.arms.baseline.sources["provider-reported"], 12);
  assert.equal(provider.meterAuthenticityVerified, false);
  assert.equal(provider.billingVerified, false);
});

test("evaluation metering checks equal per-arm budgets against every failed retry and preserves boundary equality", () => {
  const mapping = {
    inputTokens: "inputTokensPerArm",
    outputTokens: "outputTokensPerArm",
    toolCalls: "toolCallsPerArm",
    outputBytes: "outputBytesPerArm",
  } as const;
  for (const [metric, limit] of Object.entries(mapping) as [
    keyof typeof mapping,
    (typeof mapping)[keyof typeof mapping],
  ][]) {
    const value = meteringFixture(),
      slot = value.metering.slots[0]!,
      budget = value.declaration.protocol.budgets[limit];
    slot.attempts[0]![metric] = budget - slot.attempts[1]![metric]!;
    assert.equal(inspect(value).measurementAccountingComplete, true, metric);
    slot.attempts[0]![metric]!++;
    let report = inspect(value);
    assert.deepEqual(report.issues, ["budget-exceeded"], metric);
    assert.equal(report.arms[slot.role].budgetExceededSlots, 1, metric);
    slot.attempts[1]![metric] = null;
    slot.attempts[0]![metric] = budget + 1;
    report = inspect(value);
    assert.ok(report.issues.includes("budget-exceeded"), metric);
    assert.equal(report.arms[slot.role].budgetUnknownSlots, 1, metric);
  }
  const wall = meteringFixture(),
    slot = wall.metering.slots[0]!,
    budget = wall.declaration.protocol.budgets.wallMsPerArm;
  slot.elapsedMs = budget;
  assert.equal(inspect(wall).measurementAccountingComplete, true);
  slot.elapsedMs = budget + 1;
  assert.deepEqual(inspect(wall).issues, ["budget-exceeded"]);
  slot.elapsedMs = null;
  slot.attempts[0]!.elapsedMs = budget + 1;
  const report = inspect(wall);
  assert.ok(report.issues.includes("budget-exceeded"));
  assert.ok(report.issues.includes("unknown-measurements"));
});

test("evaluation metering reconciles total arm wall time against all sequential attempts without claiming timestamp verification", () => {
  const value = meteringFixture(),
    slot = value.metering.slots[0]!;
  slot.elapsedMs = 20;
  assert.equal(inspect(value).measurementAccountingComplete, true);
  slot.elapsedMs = 19;
  assert.deepEqual(inspect(value).issues, ["elapsed-accounting"]);
  slot.attempts[0]!.elapsedMs = null;
  assert.deepEqual(inspect(value).issues, ["unknown-measurements"]);
});

test("evaluation metering binds the frozen protocol and external procedure and rejects stale or incomplete declarations", () => {
  for (const field of ["protocolSha256", "procedureSha256"] as const) {
    const value = meteringFixture();
    value.metering[field] = protocolSha(9999);
    assert.deepEqual(inspect(value).issues, [
      field === "protocolSha256"
        ? "meter-protocol-binding"
        : "meter-procedure-binding",
    ]);
  }
  const stale = meteringFixture();
  stale.declaration.protocol.budgets.wallMsPerArm++;
  assert.throws(() => inspect(stale), /Evaluation protocol identity changed/);
  const incomplete = meteringFixture();
  incomplete.declaration.cohort.cases[0]!.exposure = "inspected";
  const report = inspect(incomplete);
  assert.ok(report.issues.includes("protocol-incomplete"));
  assert.equal(report.terminalCoverageComplete, false);
  const missingCluster = meteringFixture();
  missingCluster.declaration.protocol.caseClusters.pop();
  missingCluster.expectedProtocolSha256 = inspectReviewEvaluationProtocol(
    missingCluster.declaration,
  ).protocolSha256;
  missingCluster.metering.protocolSha256 =
    missingCluster.expectedProtocolSha256;
  const clustered = inspect(missingCluster);
  assert.deepEqual(clustered.issues, ["protocol-incomplete"]);
  assert.equal(clustered.counts.plannedSlots, 18);
  assert.equal(clustered.counts.receivedUniquePlannedSlots, 18);
  assert.equal(clustered.counts.missingSlots, 0);
  assert.equal(clustered.arms.baseline.plannedSlots, 6);
});

test("evaluation metering bounds all slot and attempt collections and rejects extra private fields and malformed counters", () => {
  const input = meteringFixture();
  for (const bad of [-1, 1.1, Infinity, NaN, 1_000_000_001, "unknown"]) {
    const value = structuredClone(input) as unknown as {
      metering: { slots: { attempts: { inputTokens: unknown }[] }[] };
    };
    value.metering.slots[0]!.attempts[0]!.inputTokens = bad;
    assert.throws(() => inspect(value));
  }
  const tooMany = structuredClone(input);
  tooMany.metering.slots = Array.from(
    { length: 1537 },
    () => input.metering.slots[0]!,
  );
  assert.throws(() => inspect(tooMany), /slot bound/);
  const tooManyAttempts = structuredClone(input);
  tooManyAttempts.metering.slots[0]!.attempts = Array.from(
    { length: 17 },
    () => input.metering.slots[0]!.attempts[0]!,
  );
  assert.throws(() => inspect(tooManyAttempts), /attempt bound/);
  for (const bad of [
    null,
    [],
    {},
    { ...input, privateSource: "synthetic-private-marker" },
    {
      ...input,
      metering: { ...input.metering, credential: "synthetic-private-marker" },
    },
  ])
    assert.equal(
      reviewEvaluationMeteringInputSchema.safeParse(bad).success,
      false,
    );
  const text = JSON.stringify(inspect(input));
  for (const forbidden of [
    input.metering.slots[0]!.caseId,
    input.metering.slots[0]!.attempts[0]!.sessionId,
    input.metering.slots[0]!.attempts[0]!.recordSha256,
    input.metering.collectorConfigurationSha256,
  ])
    assert.ok(!text.includes(forbidden), forbidden);
});

test("evaluation metering supports every bounded prospective slot and leaves declared totals independent of row order", () => {
  const value = meteringFixture(256),
    report = inspect(value);
  assert.equal(report.counts.plannedSlots, 1536);
  assert.equal(report.counts.receivedAttempts, 3072);
  assert.equal(report.measurementAccountingComplete, true);
  value.metering.slots.reverse();
  assert.deepEqual(inspect(value), report);
});

test("evaluation metering stdin checker emits aggregate accounting only and invalid input never echoes private data", () => {
  const run = (input: string | Buffer) =>
    spawnSync(process.execPath, [script], {
      input,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1048576,
    });
  const fixture = meteringFixture(),
    ok = run(JSON.stringify(fixture));
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), inspect(fixture));
  fixture.metering.slots.pop();
  const missing = run(JSON.stringify(fixture));
  assert.equal(missing.status, 2, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).counts.missingSlots, 1);
  for (const input of [
    "synthetic-private-marker",
    JSON.stringify({ private: "synthetic-private-marker" }),
    Buffer.from([0xff, 0xfe]),
    Buffer.alloc(4 * 1048576 + 1, 32),
  ]) {
    const result = run(input);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "Evaluation metering input invalid or unavailable\n",
    );
  }
});
