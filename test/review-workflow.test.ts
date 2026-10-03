import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { reviewModelOutputSchema } from "../src/review-provider-schema.js";
import { ReviewWorkflowEngine } from "../src/review-workflow.js";
import {
  reviewWorkflowAssignmentSchema,
  reviewWorkflowSummarySchema,
} from "../src/review-workflow-schema.js";
import {
  source,
  limits,
  recipe,
  pin,
  setup,
  response,
} from "./review-workflow-fixture.js";
const assigned = (value: unknown) =>
  reviewWorkflowAssignmentSchema.parse(value);
const summary = (value: unknown) => reviewWorkflowSummarySchema.parse(value);

test("neutral workflow runs reviewer refuter live native and adjudicator stages with blind packets for broken fixed and near-miss controls", async (t) => {
  for (const [content, actual] of [
    [source, true],
    [
      "export function decision(name){return name==='grant' || name.startsWith('grant:');}\n",
      false,
    ],
    [
      "export function decision(name){return ['grant:read','grant:write'].includes(name);}\n",
      false,
    ],
  ] as const) {
    const { root, context, target } = await setup(t, content);
    const engine = new ReviewWorkflowEngine(root, {
      allowReviewSource: true,
      trusted: true,
      probes: [pin()],
    });
    try {
      const opened = await engine.open(context);
      const id = opened.workflowId;
      const reviewer = assigned(await engine.next(id));
      assert.equal(reviewer.stage, "reviewer");
      const reviewerResponse = response(reviewer, [target]);
      const reviewed = await engine.submit(id, reviewerResponse);
      assert.equal(reviewed.nextStage, "refuter");
      assert.equal(reviewed.hostIsolationVerified, false);
      assert.equal(reviewed.assignments[0]!.usage!.inputTokens, null);
      const refuter = assigned(
        await engine.next(id, reviewed.candidateHandles[0]),
      );
      const packet = JSON.parse(refuter.packet);
      assert.equal(packet.refutationTarget.claim, target.claim);
      assert.equal(packet.refutationTarget.id, undefined);
      assert.equal(packet.refutationTarget.severity, undefined);
      assert.equal(packet.refutationTarget.attribution, undefined);
      for (const excluded of [
        target.id,
        reviewerResponse.host.model,
        reviewerResponse.host.sessionId,
        reviewer.assignmentId,
      ])
        assert.equal(refuter.packet.includes(excluded), false);
      const counterclaim = {
        ...target,
        id: "OriginalCounterclaim",
        severity: "suggestion" as const,
        claim: "The source alone cannot establish caller reachability.",
      };
      const refuted = await engine.submit(
        id,
        response(refuter, [counterclaim]),
      );
      assert.equal(refuted.nextStage, "probe");
      assert.equal(refuted.resolution, "unresolved");
      const native = await engine.probe(id, recipe.id);
      assert.equal(native.native.status, "completed");
      assert.equal(native.native.accountingComplete, true);
      assert.equal(native.native.calls, 3);
      assert.equal(native.native.rawEvidenceRetained, true);
      const adjudicator = assigned(await engine.next(id));
      const raw = JSON.parse(adjudicator.packet);
      assert.equal(raw.nativeObservations.cases[1].actual, actual);
      assert.equal(raw.nativeObservations.cases[1].expected, false);
      assert.equal(raw.nativeObservations.behavior, undefined);
      assert.equal(raw.nativeObservations.status, undefined);
      assert.equal(raw.nativeObservations.nativeBudget, undefined);
      assert.equal(raw.unverifiedCounterclaims[0].id, undefined);
      assert.equal(raw.unverifiedCounterclaims[0].severity, undefined);
      for (const excluded of [
        counterclaim.id,
        reviewerResponse.host.sessionId,
        refuter.assignmentId,
      ])
        assert.equal(adjudicator.packet.includes(excluded), false);
      const completed = await engine.submit(id, response(adjudicator));
      assert.equal(completed.status, "completed");
      assert.equal(completed.disposition, "advisory-stages-completed");
      assert.equal(completed.resolution, "unresolved");
      assert.equal(completed.severity, "unassigned");
      assert.equal(completed.claimsVerified, false);
      assert.equal(completed.unverifiedCandidates, 1);
      assert.equal(completed.assignments.length, 3);
      assert.equal(
        completed.assignments.every((attempt) => attempt.status === "accepted"),
        true,
      );
      assert.equal(JSON.stringify(completed).includes(target.claim), false);
      assert.equal(JSON.stringify(completed).includes("subject.mjs"), false);
      assert.equal(engine.close(id).retainedBytes, 0);
    } finally {
      engine.dispose();
    }
  }
});

test("neutral workflow consumes malformed forged and replayed responses without advancing or leaking failed output into a retry", async (t) => {
  const { root, context, target } = await setup(t);
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const id = (await engine.open(context)).workflowId;
    const first = assigned(await engine.next(id));
    const forged = {
      ...response(first, [target]),
      assignmentDigest: "0".repeat(64),
    };
    assert.equal(
      (await engine.submit(id, forged)).assignments[0]!.status,
      "invalid-binding",
    );
    const second = assigned(await engine.next(id));
    assert.notEqual(second.assignmentId, first.assignmentId);
    assert.equal(second.packet.includes(target.claim), false);
    assert.equal(
      (await engine.submit(id, response(first))).assignments[1]!.status,
      "invalid-binding",
    );
    const third = assigned(await engine.next(id));
    assert.equal(
      (
        await engine.submit(id, {
          ...response(third),
          allowExecution: true,
          limits: { maxAssignments: 999 },
        })
      ).assignments[2]!.status,
      "malformed",
    );
    const fourth = assigned(await engine.next(id));
    const invalidQuote = {
      ...target,
      citations: [{ ...target.citations[0]!, quote: "not the current source" }],
    };
    const checked = await engine.submit(id, response(fourth, [invalidQuote]));
    assert.equal(checked.assignments[3]!.status, "incomplete");
    assert.equal(checked.nextStage, "reviewer");
    assert.equal(checked.candidateHandles.length, 0);
    await assert.rejects(
      engine.command({
        operation: "next",
        workflowId: id,
        allowReviewSource: true,
      }),
    );
    const fifth = assigned(await engine.next(id));
    const originalClaim = target.claim;
    const output = response(fifth, [target]);
    const pending = engine.submit(id, output);
    output.output!.candidates[0]!.claim =
      "Mutated caller object after admission";
    assert.equal((await pending).assignments[4]!.status, "accepted");
    const refuter = assigned(
      await engine.next(id, engine.status(id).candidateHandles[0]),
    );
    assert.equal(refuter.packet.includes("Mutated caller object"), false);
    assert.equal(refuter.packet.includes(originalClaim), true);
  } finally {
    engine.dispose();
  }
});

test("neutral workflow keeps empty and partial reviews distinct and rejects reused or undeclared fresh host sessions", async (t) => {
  const { root, context } = await setup(t);
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const a = (await engine.open(context)).workflowId;
    const issued = assigned(await engine.next(a));
    const output = response(issued);
    const completed = await engine.submit(a, output);
    assert.equal(completed.disposition, "no-candidates-declared");
    assert.equal(completed.claimsVerified, false);
    assert.equal(completed.hostModelBudgetsEnforced, false);
    assert.equal(completed.resolution, "unresolved");
    engine.close(a);
    const b = (await engine.open(context)).workflowId;
    const second = assigned(await engine.next(b));
    const reused = response(second);
    reused.host = output.host;
    assert.equal(
      (await engine.submit(b, reused)).assignments[0]!.status,
      "host-session-reused",
    );
    const third = assigned(await engine.next(b));
    const unknown = response(third);
    unknown.host.session = "unknown";
    assert.equal(
      (await engine.submit(b, unknown)).assignments[1]!.status,
      "host-independence-unknown",
    );
    const fourth = assigned(await engine.next(b));
    const partial = response(fourth);
    partial.output!.files[0]!.disposition = "not-reviewed";
    assert.equal(
      (await engine.submit(b, partial)).assignments[2]!.status,
      "incomplete",
    );
    const fifth = assigned(await engine.next(b));
    const missing = response(fifth);
    missing.output!.files = [];
    assert.equal(
      (await engine.submit(b, missing)).assignments[3]!.status,
      "incomplete",
    );
  } finally {
    engine.dispose();
  }
});

test("neutral workflow zero exact and exhausted operator budgets are immutable and do not reset on close", async (t) => {
  const { root, context } = await setup(t);
  const empty = new ReviewWorkflowEngine(root, {
    allowReviewSource: true,
    limits: { ...limits, maxWorkflows: 0 },
  });
  await assert.rejects(empty.open(context));
  empty.dispose();
  const options = {
    allowReviewSource: true,
    limits: { ...limits, maxWorkflows: 1, maxAssignments: 0 },
  };
  const zero = new ReviewWorkflowEngine(root, options);
  options.limits.maxAssignments = 6;
  const zeroId = (await zero.open(context)).workflowId;
  const stopped = summary(await zero.next(zeroId));
  assert.equal(stopped.stopReason, "assignments-exhausted");
  assert.equal(stopped.assignments.length, 0);
  zero.close(zeroId);
  await assert.rejects(zero.open(context));
  zero.dispose();
  const reference = new ReviewWorkflowEngine(root, {
    allowReviewSource: true,
    limits,
  });
  const refId = (await reference.open(context)).workflowId;
  const initialBytes = reference.status(refId).retainedBytes;
  assigned(await reference.next(refId));
  const measured = reference.status(refId);
  reference.dispose();
  for (const delta of [0, -1]) {
    const engine = new ReviewWorkflowEngine(root, {
      allowReviewSource: true,
      limits: { ...limits, maxPacketBytes: measured.issuedPacketBytes + delta },
    });
    const id = (await engine.open(context)).workflowId;
    const next = await engine.next(id);
    assert.equal(next.format === "review-workflow-assignment", delta === 0);
    if (next.format === "review-workflow-summary")
      assert.equal(next.stopReason, "packet-limit");
    engine.dispose();
    const retained = new ReviewWorkflowEngine(root, {
      allowReviewSource: true,
      limits: { ...limits, maxRetainedBytes: measured.retainedBytes + delta },
    });
    const retainedId = (await retained.open(context)).workflowId;
    assert.equal(
      (await retained.next(retainedId)).format === "review-workflow-assignment",
      delta === 0,
    );
    retained.dispose();
  }
  const noRetention = new ReviewWorkflowEngine(root, {
    allowReviewSource: true,
    limits: { ...limits, maxRetainedBytes: initialBytes - 1 },
  });
  await assert.rejects(noRetention.open(context));
  noRetention.dispose();
  const noResponse = new ReviewWorkflowEngine(root, {
    allowReviewSource: true,
    limits: { ...limits, maxResponseBytes: 0, maxAssignments: 1 },
  });
  const id = (await noResponse.open(context)).workflowId;
  const next = assigned(await noResponse.next(id));
  const failed = await noResponse.submit(id, response(next));
  assert.equal(failed.assignments[0]!.status, "response-limit");
  assert.equal(failed.responseBytes > 0, true);
  assert.equal(
    summary(await noResponse.next(id)).stopReason,
    "assignments-exhausted",
  );
  noResponse.dispose();
});

test("neutral workflow stage order foreign handles source disclosure and native execution remain independently gated", async (t) => {
  const { root, context, target } = await setup(t);
  const denied = new ReviewWorkflowEngine(root, { allowReviewSource: false });
  const deniedId = (await denied.open(context)).workflowId;
  await assert.rejects(denied.next(deniedId));
  assert.equal(denied.status(deniedId).assignments.length, 0);
  denied.dispose();
  const engine = new ReviewWorkflowEngine(root, {
    allowReviewSource: true,
    probes: [pin()],
  });
  try {
    const id = (await engine.open(context)).workflowId;
    await assert.rejects(engine.probe(id, recipe.id));
    await assert.rejects(engine.next(id, randomUUID()));
    const first = assigned(await engine.next(id));
    await assert.rejects(engine.next(id));
    const reviewed = await engine.submit(id, response(first, [target]));
    await assert.rejects(engine.next(id, randomUUID()));
    const refuter = assigned(
      await engine.next(id, reviewed.candidateHandles[0]),
    );
    await engine.submit(id, response(refuter));
    await assert.rejects(engine.next(id));
    await assert.rejects(engine.probe(id, recipe.id));
    assert.equal(engine.status(id).native.status, "not-started");
    await assert.rejects(
      engine.command({
        operation: "probe",
        workflowId: id,
        probeId: recipe.id,
        trusted: true,
      }),
    );
  } finally {
    engine.dispose();
  }
});

test("neutral workflow concurrency reservations stale source timeout and cancellation preserve reached attempt accounting", async (t) => {
  const { root, context } = await setup(t);
  const single = new ReviewWorkflowEngine(root, {
    allowReviewSource: true,
    limits: { ...limits, maxWorkflows: 1 },
  });
  const concurrent = await Promise.allSettled([
    single.open(context),
    single.open(context),
  ]);
  assert.equal(
    concurrent.filter((entry) => entry.status === "fulfilled").length,
    1,
  );
  single.dispose();
  const stale = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  const staleId = (await stale.open(context)).workflowId;
  const issued = assigned(await stale.next(staleId));
  const beforeNext = (await stale.open(context)).workflowId;
  await writeFile(
    path.join(root, "subject.mjs"),
    source.replace("startsWith('grant')", "startsWith('other')"),
  );
  const prevented = summary(await stale.next(beforeNext));
  assert.equal(prevented.status, "stale");
  assert.equal(prevented.assignments.length, 0);
  assert.equal(prevented.issuedPacketBytes, 0);
  const result = await stale.submit(staleId, response(issued));
  assert.equal(result.status, "stale");
  assert.equal(result.assignments[0]!.status, "stale");
  assert.equal(result.retainedBytes, 0);
  stale.dispose();
  await writeFile(path.join(root, "subject.mjs"), source);
  const timed = new ReviewWorkflowEngine(root, {
    allowReviewSource: true,
    limits: { ...limits, wallMs: 100 },
  });
  const id = (await timed.open(context)).workflowId;
  assigned(await timed.next(id));
  await delay(150);
  const expired = timed.status(id);
  assert.equal(expired.status, "timed-out");
  assert.equal(expired.assignments[0]!.status, "timed-out");
  assert.equal(expired.retainedBytes, 0);
  timed.dispose();
  const cancelled = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  const cancelId = (await cancelled.open(context)).workflowId;
  const assignedCancel = assigned(await cancelled.next(cancelId));
  const controller = new AbortController();
  controller.abort();
  const stopped = await cancelled.submit(
    cancelId,
    response(assignedCancel),
    controller.signal,
  );
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.assignments[0]!.status, "cancelled");
  assert.equal(stopped.retainedBytes, 0);
  cancelled.dispose();
});

test("neutral workflow closing a running native case retains delivered bytes after cleanup without restoring discarded source", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "checktrail-original-ready-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const ready = path.join(temp, "ready");
  const content = `export async function decision(name){process.stdout.write('original-ready\\n',()=>process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready')); await new Promise(()=>{setInterval(()=>{},1000)}); return name.startsWith('grant');}\n`;
  const { root, context, target } = await setup(t, content);
  const engine = new ReviewWorkflowEngine(root, {
    allowReviewSource: true,
    trusted: true,
    probes: [pin()],
  });
  try {
    const id = (await engine.open(context)).workflowId;
    const reviewer = assigned(await engine.next(id));
    const reviewed = await engine.submit(id, response(reviewer, [target]));
    const refuter = assigned(
      await engine.next(id, reviewed.candidateHandles[0]),
    );
    await engine.submit(id, response(refuter));
    let settled: unknown;
    const pending = engine.probe(id, recipe.id).then((value) => {
      settled = value;
      return value;
    });
    const deadline = Date.now() + 10000;
    let observed = false;
    while (Date.now() < deadline) {
      assert.equal(settled, undefined, JSON.stringify(settled));
      try {
        await stat(ready);
        observed = true;
        break;
      } catch {
        await delay(10);
      }
    }
    assert.equal(
      observed,
      true,
      "The original native function must execute before cancellation",
    );
    const closing = engine.close(id);
    assert.equal(closing.status, "closed");
    assert.equal(closing.retainedBytes, 0);
    assert.equal(closing.native.accountingComplete, false);
    assert.equal(closing.native.calls, null);
    const stopped = await pending;
    assert.equal(stopped.status, "closed");
    assert.equal(stopped.retainedBytes, 0);
    assert.equal(stopped.native.accountingComplete, true);
    assert.equal(stopped.native.calls, 1);
    assert.ok(
      stopped.native.outputBytes! >= Buffer.byteLength("original-ready\n"),
    );
    assert.equal(stopped.native.rawEvidenceRetained, false);
  } finally {
    engine.dispose();
  }
});

test("neutral workflow packet preparation that spends the wall allowance cannot disclose an assignment", async (t) => {
  const { root, context } = await setup(t);
  const engine = new ReviewWorkflowEngine(root, {
    allowReviewSource: true,
    limits: { ...limits, wallMs: 500 },
  });
  const descriptor = Object.getOwnPropertyDescriptor(
    reviewModelOutputSchema,
    "toJSONSchema",
  );
  const original = reviewModelOutputSchema.toJSONSchema.bind(
    reviewModelOutputSchema,
  );
  try {
    const id = (await engine.open(context)).workflowId;
    Object.defineProperty(reviewModelOutputSchema, "toJSONSchema", {
      ...descriptor,
      configurable: true,
      value: () => {
        const until = performance.now() + 600;
        while (performance.now() < until) {
          /* Original delayed schema preparation. */
        }
        return original();
      },
    });
    const prepared = await engine.next(id);
    assert.equal(prepared.format, "review-workflow-summary");
    const denied = summary(prepared);
    assert.equal(denied.status, "timed-out");
    assert.equal(denied.assignments.length, 0);
    assert.equal(denied.issuedPacketBytes, 0);
    assert.equal(denied.retainedBytes, 0);
  } finally {
    if (descriptor)
      Object.defineProperty(
        reviewModelOutputSchema,
        "toJSONSchema",
        descriptor,
      );
    else Reflect.deleteProperty(reviewModelOutputSchema, "toJSONSchema");
    engine.dispose();
  }
  const fresh = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const id = (await fresh.open(context)).workflowId;
    assert.equal(assigned(await fresh.next(id)).stage, "reviewer");
  } finally {
    fresh.dispose();
  }
});
