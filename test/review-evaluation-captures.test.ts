import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import {
  inspectReviewEvaluationCaptures as inspect,
  reviewEvaluationCaptureInputSchema,
  reviewEvaluationCaptureAssignments,
} from "../src/review-evaluation-captures.js";
import { inspectReviewEvaluationProtocol } from "../src/review-evaluation-protocol.js";
import {
  captureFixture,
  rebindCaptures,
} from "./review-evaluation-captures-fixture.js";
import {
  protocolSha,
  protocolHex,
} from "./review-evaluation-protocol-fixture.js";
const cli = fileURLToPath(
  new URL("../../scripts/check-evaluation-captures.mjs", import.meta.url),
);
function arithmetic(r: ReturnType<typeof inspect>) {
  assert.equal(
    r.counts.plannedSlots,
    r.counts.boundSlots + r.counts.invalidPlannedSlots + r.counts.missingSlots,
  );
  assert.equal(
    r.counts.suppliedRecords,
    r.counts.receivedUniquePlannedSlots +
      r.counts.duplicateRecords +
      r.counts.foreignRecords,
  );
}
function unknown(r: ReturnType<typeof inspect>) {
  for (const flag of [
    "physicalArtifactsVerified",
    "collectorAuthenticityVerified",
    "actualAttemptsComplete",
    "hostIndependenceVerified",
    "claimTruthVerified",
    "qualityAssessed",
    "gateAClosed",
    "inferenceInvokedByInspector",
    "sourceIncluded",
    "privateIdentitiesIncluded",
  ] as const)
    assert.equal(r[flag], false, flag);
}
const run = (input: unknown) =>
  spawnSync(process.execPath, [cli], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 65536,
  });
test("evaluation captures bind every three-role slot without requiring review assistance from the baseline", () => {
  const input = captureFixture(),
    r = inspect(input);
  assert.equal(r.captureInventoryComplete, true);
  assert.equal(r.declaredOutputsComplete, true);
  assert.equal(r.measurementAccountingComplete, true);
  assert.equal(r.counts.plannedSlots, 18);
  assert.equal(r.counts.boundSlots, 18);
  assert.equal(r.metering.counts.receivedAttempts, 36);
  for (const role of ["baseline", "verifier", "reference"] as const)
    assert.deepEqual(r.byRole[role], {
      planned: 6,
      bound: 6,
      completedOutputs: 6,
    });
  const assignments = reviewEvaluationCaptureAssignments(input.declaration);
  assert.equal(new Set(assignments.map((a) => a.assignmentSha256)).size, 18);
  assert.ok(
    assignments.every((a) => !a.sourceIncluded && !a.peerOutputsIncluded),
  );
  assert.equal(
    input.declaration.protocol.priorWorkflow.kind,
    "declared-comparison-baseline",
  );
  arithmetic(r);
  unknown(r);
});
test("evaluation captures preserve planned denominators for missing duplicate foreign and malformed inventories", () => {
  const p = captureFixture();
  const missing = p.captures.shift()!;
  p.captures.push(structuredClone(p.captures[0]!));
  p.captures.push({ ...missing, caseId: "case-" + protocolHex(65535) });
  const r = inspect(p);
  assert.equal(r.captureInventoryComplete, false);
  assert.equal(r.counts.plannedSlots, 18);
  assert.equal(r.counts.missingSlots, 1);
  assert.equal(r.counts.duplicateRecords, 1);
  assert.equal(r.counts.foreignRecords, 1);
  assert.equal(r.counts.invalidPlannedSlots, 1);
  assert.equal(r.counts.boundSlots, 16);
  arithmetic(r);
});
test("evaluation captures bind assignments and exact source and configuration identities", () => {
  for (const field of [
    "assignmentSha256",
    "configurationSha256",
    "sourceArchiveSha256",
    "contentSha256",
  ] as const) {
    const p = captureFixture();
    p.captures[0]![field] = protocolSha(99999);
    const r = inspect(p);
    assert.equal(r.captureInventoryComplete, false, field);
    assert.equal(r.counts.invalidPlannedSlots, 1);
    arithmetic(r);
  }
  const p = captureFixture();
  const before = inspect(p);
  p.captures[0]!.captureSha256 = protocolSha(99999);
  const changed = inspect(p);
  assert.equal(changed.captureInventoryComplete, true);
  assert.notEqual(changed.inputSha256, before.inputSha256);
  assert.equal(changed.physicalArtifactsVerified, false);
});
test("evaluation captures preserve failed retry records and terminal status correspondence", () => {
  for (const mode of ["omitted", "reordered", "status"]) {
    const p = captureFixture();
    if (mode === "omitted") p.captures[0]!.attemptRecords.shift();
    else if (mode === "reordered") p.captures[0]!.attemptRecords.reverse();
    else p.captures[0]!.status = "cancelled";
    const r = inspect(p);
    assert.equal(r.captureInventoryComplete, false, mode);
    assert.equal(r.metering.counts.receivedAttempts, 36);
    assert.equal(r.counts.plannedSlots, 18);
    arithmetic(r);
  }
});
test("evaluation captures retain empty partial and unfinished review states without approving the cohort", () => {
  for (const empty of [null, { sha256: protocolSha(0), bytes: 0 }]) {
    const p = captureFixture();
    p.captures[0]!.output = empty;
    const r = inspect(p);
    assert.equal(r.declaredOutputsComplete, false);
    assert.ok(r.issues.includes("empty-completed-output"));
    arithmetic(r);
  }
  for (const status of [
    "not-run",
    "budget-exhausted",
    "refused",
    "unavailable",
    "cancelled",
    "timed-out",
    "error",
    "incomplete",
  ] as const) {
    const p = captureFixture();
    const c = p.captures[0]!,
      m = p.metering.slots[0]!;
    c.status = m.status = status;
    if (status === "not-run") {
      m.attempts = [];
      c.attemptRecords = [];
      c.output = null;
      m.elapsedMs = 0;
    } else
      m.attempts.at(-1)!.status =
        status === "budget-exhausted" ? "incomplete" : status;
    const r = inspect(p);
    assert.equal(r.captureInventoryComplete, true, status);
    assert.equal(r.declaredOutputsComplete, false, status);
    assert.equal(r.counts.completedOutputs, 17);
    arithmetic(r);
    unknown(r);
  }
});
test("evaluation captures retain unknown usage and reject budgets and inconsistent output bytes", () => {
  const p = captureFixture();
  const last = p.metering.slots[0]!.attempts.at(-1)!;
  last.inputTokens = null;
  last.outputBytes = null;
  last.costMicrousd = null;
  const r = inspect(p);
  assert.equal(r.captureInventoryComplete, true);
  assert.equal(r.measurementAccountingComplete, false);
  assert.equal(
    r.metering.arms[p.captures[0]!.role].measurements.inputTokens
      .unknownRecords,
    1,
  );
  assert.ok(
    r.metering.arms[p.captures[0]!.role].measurements.inputTokens
      .observedTotal > 0,
  );
  for (const mode of ["budget", "terminal-output"]) {
    const x = captureFixture();
    x.captures[0]!.output!.bytes =
      mode === "budget"
        ? x.declaration.protocol.budgets.outputBytesPerArm + 1
        : x.metering.slots[0]!.attempts.at(-1)!.outputBytes! + 1;
    const report = inspect(x);
    assert.equal(report.captureInventoryComplete, false);
    assert.ok(
      report.issues.includes(
        mode === "budget"
          ? "capture-output-budget"
          : "capture-output-accounting",
      ),
    );
  }
});
test("evaluation captures reject reused capture records and declared sessions while allowing matching review bodies", () => {
  const input = captureFixture();
  assert.equal(new Set(input.captures.map((c) => c.output!.sha256)).size, 1);
  assert.equal(inspect(input).captureInventoryComplete, true);
  const records = structuredClone(input);
  records.captures[1]!.captureSha256 = records.captures[0]!.captureSha256;
  const r = inspect(records);
  assert.equal(r.captureInventoryComplete, false);
  assert.equal(r.counts.invalidPlannedSlots, 2);
  assert.ok(r.issues.includes("capture-record-reuse"));
  const sessions = structuredClone(input);
  sessions.metering.slots[1]!.attempts[0]!.sessionId =
    sessions.metering.slots[0]!.attempts[0]!.sessionId;
  const s = inspect(sessions);
  assert.equal(s.captureInventoryComplete, false);
  assert.ok(s.metering.issues.includes("session-reuse"));
  unknown(s);
});
test("evaluation captures preserve the selected denominator when clustering or protocol commitments change", () => {
  const p = captureFixture();
  p.declaration.protocol.caseClusters.pop();
  assert.throws(() => inspect(p), /protocol identity changed/);
  p.expectedProtocolSha256 = inspectReviewEvaluationProtocol(
    p.declaration,
  ).protocolSha256;
  const r = inspect(p);
  assert.equal(r.captureInventoryComplete, false);
  assert.equal(r.counts.plannedSlots, 18);
  assert.equal(reviewEvaluationCaptureAssignments(p.declaration).length, 18);
  arithmetic(r);
});
test("evaluation captures enforce exact record output and role schema boundaries", () => {
  const input = captureFixture(256);
  const r = inspect(input);
  assert.equal(r.counts.plannedSlots, 1536);
  assert.equal(r.captureInventoryComplete, true);
  const slots = structuredClone(input);
  slots.captures.push(slots.captures[0]!);
  assert.throws(() => inspect(slots), /slot bound/);
  const attempts = captureFixture();
  attempts.captures[0]!.attemptRecords = Array.from({ length: 17 }, () =>
    protocolSha(1),
  );
  assert.throws(() => inspect(attempts), /attempt bound/);
  const edge = captureFixture();
  edge.declaration.protocol.budgets.outputBytesPerArm = 4 * 1048576;
  rebindCaptures(edge);
  edge.metering.slots[0]!.attempts[0]!.outputBytes = 0;
  edge.metering.slots[0]!.attempts.at(-1)!.outputBytes = 4 * 1048576;
  edge.captures[0]!.output!.bytes = 4 * 1048576;
  assert.equal(inspect(edge).captureInventoryComplete, true);
  edge.captures[0]!.output!.bytes++;
  assert.throws(() => inspect(edge));
  for (const bad of [
    null,
    [],
    {},
    { ...captureFixture(), trusted: true },
    { ...captureFixture(), credential: "OriginalPrivateCaptureCanary" },
  ])
    assert.equal(
      reviewEvaluationCaptureInputSchema.safeParse(bad).success,
      false,
    );
  const bad = captureFixture();
  (bad.captures[0] as unknown as { role: string }).role = "baseline-extra";
  assert.throws(() => inspect(bad));
});
test("evaluation captures do not mutate input or invoke model transports and keep authenticity unverified", () => {
  const p = captureFixture();
  const original = structuredClone(p);
  const fetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      throw Error("No model or service access permitted");
    };
    const r = inspect(p);
    assert.equal(calls, 0);
    assert.deepEqual(p, original);
    unknown(r);
    const reordered = structuredClone(p);
    reordered.captures.reverse();
    reordered.metering.slots.reverse();
    const changed = inspect(reordered);
    assert.deepEqual(changed.counts, r.counts);
    assert.deepEqual(changed.byRole, r.byRole);
    assert.notEqual(changed.inputSha256, r.inputSha256);
  } finally {
    globalThis.fetch = fetch;
  }
});
test("evaluation captures CLI preserves privacy and inclusive input limits for admissible incomplete and invalid metadata", () => {
  const p = captureFixture();
  const value = JSON.stringify(p);
  const exact = value + " ".repeat(4 * 1048576 - Buffer.byteLength(value));
  const valid = run(exact);
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), inspect(p));
  for (const secret of [
    p.captures[0]!.caseId,
    p.captures[0]!.captureSha256,
    p.captures[0]!.sourceArchiveSha256,
    p.metering.slots[0]!.attempts[0]!.sessionId,
  ])
    assert.equal(valid.stdout.includes(secret), false, secret);
  const over = run(exact + " ");
  assert.equal(over.status, 1);
  assert.equal(over.stdout, "");
  assert.equal(
    over.stderr,
    "Evaluation capture input invalid or unavailable\n",
  );
  const partial = captureFixture();
  partial.captures.pop();
  const incomplete = run(partial);
  assert.equal(incomplete.status, 2);
  assert.equal(JSON.parse(incomplete.stdout).counts.missingSlots, 1);
  const invalid = run({ ...p, credential: "OriginalPrivateCaptureCanary" });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr.includes("OriginalPrivateCaptureCanary"), false);
});
test(
  "evaluation captures run the same controls through a fresh offline production installation",
  { timeout: 120000 },
  async () => {
    if (process.env.CHECKTRAIL_EVALUATION_PROTOCOL_INSTALLED === "1") {
      const actual = await realpath(
        fileURLToPath(
          new URL("../src/review-evaluation-captures.js", import.meta.url),
        ),
      );
      assert.ok(
        actual.includes(path.join("node_modules", "@stsepelin", "checktrail")),
      );
      return;
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const script = fileURLToPath(
      new URL(
        "../../scripts/verify-evaluation-protocol-package.mjs",
        import.meta.url,
      ),
    );
    const r = spawnSync(process.execPath, [script, "--captures"], {
      env,
      encoding: "utf8",
      timeout: 115000,
      maxBuffer: 4 * 1048576,
    });
    assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-5000));
    const proof = JSON.parse(r.stdout);
    assert.equal(proof.offlineProductionInstall, true);
    assert.equal(proof.lifecycleScriptsExecuted, false);
    assert.equal(proof.profileEvidence.required, 12);
    assert.equal(proof.profileEvidence.passed, 12);
    assert.equal(proof.profileEvidence.complete, true);
    if (process.env.CHECKTRAIL_EVALUATION_CAPTURE_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_EVALUATION_CAPTURE_INSTALL_RECEIPT,
        JSON.stringify(proof) + "\n",
      );
  },
);
