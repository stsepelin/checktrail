import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ReviewWorkflowEngine } from "../src/review-workflow.js";
import {
  projectReviewFindings,
  reviewFindingsSummarySchema,
} from "../src/review-findings.js";
import {
  reviewWorkflowAssignmentSchema,
  reviewWorkflowAllSummarySchema,
} from "../src/review-workflow-schema.js";
import { type ReviewWorkflowFindingsDeclarations } from "../src/review-workflow-findings.js";
import {
  setup,
  pin,
  recipe,
  response,
  source,
} from "./review-workflow-fixture.js";
const options = {
  allowReviewSource: true,
  candidateScope: "all" as const,
  trusted: true,
  probes: [pin()],
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function complete(t: TestContext, content = source, empty = false) {
  const d = await setup(t, content);
  const engine = new ReviewWorkflowEngine(d.root, options);
  t.after(() => engine.dispose());
  const opened = await engine.open(d.context);
  const reviewer = response(
    reviewWorkflowAssignmentSchema.parse(await engine.next(opened.workflowId)),
    empty
      ? []
      : [
          d.target,
          {
            ...d.target,
            id: "OriginalSiblingClaim",
            claim: "A separately declared symptom of the synthetic boundary.",
          },
        ],
  );
  const state = reviewWorkflowAllSummarySchema.parse(
    await engine.submit(opened.workflowId, reviewer),
  );
  const hosts: Array<{
    target: string;
    refuter: typeof reviewer.host;
    adjudicator: typeof reviewer.host;
  }> = [];
  // Deliberately process the second handle first. Retained completion order is not reviewer order.
  for (const target of [...state.candidateHandles].reverse()) {
    const refuter = response(
      reviewWorkflowAssignmentSchema.parse(
        await engine.next(state.workflowId, target),
      ),
    );
    await engine.submit(state.workflowId, refuter);
    await engine.probe(state.workflowId, recipe.id);
    const adjudicator = response(
      reviewWorkflowAssignmentSchema.parse(await engine.next(state.workflowId)),
    );
    await engine.submit(state.workflowId, adjudicator);
    hosts.push({
      target,
      refuter: refuter.host,
      adjudicator: adjudicator.host,
    });
  }
  if (!("analysis" in d.context)) throw Error("Captured functions required");
  const fn = d.context.analysis.functions.find(
    (f) => f.name === "decision" && f.revision === "current",
  )!;
  const declarations: ReviewWorkflowFindingsDeclarations = {
    decisions: state.candidateHandles.map((target) => ({
      target,
      refutationRationale:
        "A declared independent counterexample search; host isolation is unverified.",
      adjudicationRationale:
        "A declared reading of the original synthetic source and observed predicate.",
      judgment: {
        disposition: "supported",
        citationIndex: 0,
        functionId: fn.id,
        mechanism:
          "The identifier prefix includes a synthetic sibling identifier.",
        reachableCallers:
          "The synthetic exported function is the declared caller boundary.",
        defaultsChecked: "This original function has no inherited defaults.",
        consequence: {
          category: "wrong-result",
          extent: "single",
          access: "unprivileged",
          recovery: "reversible",
          statement:
            "The synthetic caller receives a different Boolean from its pinned expectation.",
        },
        repair: {
          citationIndex: 0,
          functionId: fn.id,
          requiredParameters: ["name"],
          scope: "this-change",
          text: "Compare the complete parameter name.",
        },
      },
    })),
    commonDefects: empty
      ? []
      : [
          {
            id: "OriginalCommonBoundary",
            rootFunctionId: fn.id,
            targets: state.candidateHandles,
            rationale:
              "Explicit shared-root declaration, not semantic duplicate detection.",
          },
        ],
  };
  return {
    ...d,
    engine,
    id: state.workflowId,
    state,
    declarations,
    hosts,
    reviewer,
  };
}
test("workflow findings bind reversed target completion to original candidates native receipts and accepted host sessions", async (t) => {
  const d = await complete(t);
  const report = await d.engine.inspectFindings(
    d.id,
    JSON.stringify(d.declarations),
  );
  assert.deepEqual(report.candidates, {
    selected: 2,
    "declared-supported": 2,
    "declared-refuted": 0,
    unresolved: 0,
  });
  assert.equal(report.commonDefects.reconciled, 1);
  assert.equal(report.commonDefects.mappedSupported, 2);
  assert.deepEqual(
    report.input.provenance.candidates.map((c) => c.id),
    [d.target.id, "OriginalSiblingClaim"],
  );
  const key = (h: typeof d.reviewer.host) =>
    hash([h.provider, h.client, h.sessionId]);
  assert.equal(report.input.reviewerSessionId, key(d.reviewer.host));
  for (const decision of report.input.decisions) {
    const index = report.input.provenance.candidates.findIndex(
      (c) => c.id === decision.candidateId,
    );
    const host = d.hosts.find(
      (h) => h.target === d.state.candidateHandles[index],
    )!;
    const native = report.input.provenance.native.find(
      (n) => n.candidateId === decision.candidateId,
    )!;
    assert.equal(decision.refutation.sessionId, key(host.refuter));
    assert.equal(decision.adjudication.sessionId, key(host.adjudicator));
    assert.equal(decision.nativeRunDigest, hash(native.run));
    assert.equal(native.run.candidateDigest, decision.candidateDigest);
    assert.deepEqual(
      decision.nativeCaseIds,
      native.run.trials.map((c) => c.id),
    );
  }
  assert.deepEqual(report.input.provenance.assessment.usage, d.reviewer.usage);
  assert.equal(report.input.provenance.scoring, null);
  assert.ok(report.findings.every((f) => f.declaredSeverity === "moderate"));
  assert.equal(report.claimsVerified, false);
  assert.equal(report.independenceVerified, false);
  assert.equal(report.nativeExecution, false);
  assert.equal(report.qualityGate, "not-assessed");
});
test("workflow findings keep a satisfied fixed native predicate unresolved despite supported host declarations", async (t) => {
  const d = await complete(
    t,
    "export function decision(name){return name === 'grant:read';}\n",
  );
  const report = await d.engine.inspectFindings(
    d.id,
    JSON.stringify(d.declarations),
  );
  assert.equal(report.candidates.unresolved, 2);
  assert.equal(report.candidates["declared-supported"], 0);
  assert.ok(
    report.findings.every((f) =>
      f.gaps.includes("native-predicate-not-violated"),
    ),
  );
});
test("workflow findings retain every candidate and native receipt when a judgment declaration is absent", async (t) => {
  const d = await complete(t);
  d.declarations.decisions.pop();
  const report = await d.engine.inspectFindings(
    d.id,
    JSON.stringify(d.declarations),
  );
  assert.equal(report.candidates.selected, 2);
  assert.equal(report.candidates.unresolved, 1);
  assert.equal(report.input.provenance.native.length, 2);
  assert.equal(report.findings[1]!.candidateId, "OriginalSiblingClaim");
  assert.deepEqual(report.findings[1]!.gaps, ["missing-decision"]);
  assert.equal(report.groups[0]!.state, "unresolved");
});
test("workflow findings reject foreign duplicate and caller supplied identity or receipt bindings", async (t) => {
  const d = await complete(t);
  const valid = JSON.stringify(d.declarations);
  for (const mutate of [
    (v: typeof d.declarations) => {
      v.decisions[0]!.target = randomUUID();
    },
    (v: typeof d.declarations) => {
      v.decisions.push(structuredClone(v.decisions[0]!));
    },
    (v: typeof d.declarations) => {
      v.commonDefects[0]!.targets[0] = randomUUID();
    },
    (v: typeof d.declarations) => {
      v.commonDefects[0]!.targets.push(v.commonDefects[0]!.targets[0]!);
    },
  ]) {
    const changed = JSON.parse(valid) as typeof d.declarations;
    mutate(changed);
    await assert.rejects(
      d.engine.inspectFindings(d.id, JSON.stringify(changed)),
    );
  }
  for (const key of [
    "provenance",
    "reviewerSessionId",
    "nativeRunDigest",
    "contextDigest",
  ]) {
    await assert.rejects(
      d.engine.inspectFindings(
        d.id,
        JSON.stringify({ ...d.declarations, [key]: "ForeignIdentity" }),
      ),
    );
  }
  await assert.rejects(
    d.engine.inspectFindings(d.id, " ".repeat(262145) + valid),
  );
  const report = await d.engine.inspectFindings(d.id, valid);
  assert.equal(report.candidates["declared-supported"], 2);
});
test("workflow findings require completed all candidate evidence and protected startup source disclosure", async (t) => {
  const d = await setup(t);
  for (const extra of [
    {},
    { candidateScope: "selected" as const },
    { allowReviewSource: false },
  ]) {
    const engine = new ReviewWorkflowEngine(d.root, { ...options, ...extra });
    try {
      const state = await engine.open(d.context);
      await assert.rejects(
        engine.inspectFindings(state.workflowId, "{}"),
        /Completed disclosed all-candidate/,
      );
    } finally {
      engine.dispose();
    }
  }
  const done = await complete(t);
  done.engine.close(done.id);
  await assert.rejects(
    done.engine.inspectFindings(done.id, JSON.stringify(done.declarations)),
    /Completed disclosed all-candidate/,
  );
});
test("workflow findings recheck final current source and preserve stale candidates", async (t) => {
  const d = await complete(t);
  await writeFile(
    path.join(d.root, "subject.mjs"),
    "export function decision(name){return false;}\n",
  );
  const report = await d.engine.inspectFindings(
    d.id,
    JSON.stringify(d.declarations),
  );
  assert.equal(report.status, "stale");
  assert.equal(report.candidates.selected, 2);
  assert.equal(report.candidates.unresolved, 2);
  assert.ok(report.findings.every((f) => f.gaps.includes("stale-source")));
});
test("workflow findings reject unreachable repair parameters and keep unknown consequences unassigned", async (t) => {
  const d = await complete(t);
  d.declarations.decisions[0]!.judgment.repair!.requiredParameters.push(
    "requestCeiling",
  );
  d.declarations.decisions[1]!.judgment.consequence!.category = "unknown";
  const report = await d.engine.inspectFindings(
    d.id,
    JSON.stringify(d.declarations),
  );
  assert.equal(report.candidates.unresolved, 2);
  assert.deepEqual(report.findings[0]!.repairParameters.missing, [
    "requestCeiling",
  ]);
  assert.ok(report.findings[0]!.gaps.includes("repair-parameter-missing"));
  assert.equal(report.findings[1]!.declaredSeverity, "unassigned");
  assert.ok(report.findings[1]!.gaps.includes("consequence-unknown"));
});
test("workflow findings reuse retained evidence without issuing host assignments or executing more native calls and summaries omit source", async (t) => {
  const d = await complete(t);
  const before = d.engine.status(d.id);
  const report = await d.engine.inspectFindings(
    d.id,
    JSON.stringify(d.declarations),
  );
  const summary = reviewFindingsSummarySchema.parse(
    await projectReviewFindings(report),
  );
  assert.deepEqual(d.engine.status(d.id), before);
  assert.equal(summary.sourceIncluded, false);
  const serialized = JSON.stringify(summary);
  for (const secret of [
    d.target.id,
    "subject.mjs",
    "OriginalCommonBoundary",
    d.reviewer.host.sessionId,
    "refutationRationale",
    "requestCeiling",
    "grantToken",
  ])
    assert.ok(!serialized.includes(secret), secret);
});
test("workflow findings honour cancellation and close during asynchronous inspection without releasing a report", async (t) => {
  const d = await complete(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    d.engine.inspectFindings(
      d.id,
      JSON.stringify(d.declarations),
      controller.signal,
    ),
    /cancelled|abort/i,
  );
  const pending = d.engine.inspectFindings(
    d.id,
    JSON.stringify(d.declarations),
  );
  await assert.rejects(
    d.engine.inspectFindings(d.id, JSON.stringify(d.declarations)),
    /Completed disclosed/,
  );
  d.engine.close(d.id);
  await assert.rejects(pending, /cancelled|abort/i);
  assert.equal(d.engine.status(d.id).retainedBytes, 0);
});
test("workflow findings preserve empty reviewer abstention without approving the repository", async (t) => {
  const d = await complete(t, source, true);
  const report = await d.engine.inspectFindings(
    d.id,
    JSON.stringify(d.declarations),
  );
  assert.equal(d.engine.status(d.id).disposition, "no-candidates-declared");
  assert.equal(report.candidates.selected, 0);
  assert.equal(report.status, "incomplete");
  assert.equal(report.claimsVerified, false);
});
