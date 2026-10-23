import {
  reviewWorkflowAllSummarySchema,
  reviewWorkflowAssignmentSchema,
} from "../src/review-workflow-schema.js";
import {
  complete,
  options,
  auditFile,
  channel,
  declarationsFor,
} from "./review-workflow-findings-fixture.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { ReviewWorkflowSession } from "../src/review-workflow-session.js";
import { parseReviewWorkflowAuditArtifact } from "../src/review-workflow-audit.js";
import { replayReviewFindings } from "../src/review-findings.js";
import path from "node:path";
import { test } from "node:test";
import { ReviewWorkflowEngine } from "../src/review-workflow.js";
import {
  projectReviewFindings,
  reviewFindingsSummarySchema,
} from "../src/review-findings.js";
import {
  reviewWorkflowFindingsResultSchema,
  projectWorkflowFindings,
} from "../src/review-workflow-findings.js";
import { setup, source, response } from "./review-workflow-fixture.js";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

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
  const exact = " ".repeat(262144 - Buffer.byteLength(valid)) + valid;
  assert.equal(Buffer.byteLength(exact), 262144);
  assert.equal(
    (await d.engine.inspectFindings(d.id, exact)).candidates[
      "declared-supported"
    ],
    2,
  );
  await assert.rejects(
    d.engine.inspectFindings(d.id, " " + exact),
    /Bounded workflow/,
  );
  const report = await d.engine.inspectFindings(d.id, valid);
  assert.equal(report.candidates["declared-supported"], 2);
});
test("workflow findings require accepted all candidate reviewer evidence and protected startup source disclosure", async (t) => {
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
        /Quiescent disclosed all-candidate/,
      );
    } finally {
      engine.dispose();
    }
  }
  const done = await complete(t);
  done.engine.close(done.id);
  await assert.rejects(
    done.engine.inspectFindings(done.id, JSON.stringify(done.declarations)),
    /Quiescent disclosed all-candidate/,
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
    /Quiescent disclosed/,
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

function rechain(
  events: ReturnType<typeof parseReviewWorkflowAuditArtifact>["events"],
) {
  let previous: string | null = null;
  return Buffer.from(
    events
      .map((event, i) => {
        event.sequence = i;
        event.previous = previous;
        if (
          event.body.kind === "begin" &&
          event.body.capture.kind === "complete"
        ) {
          event.body.capture.bytes = Buffer.byteLength(
            JSON.stringify(event.body.capture.value),
          );
          event.body.capture.sha256 = hash(event.body.capture.value);
        }
        const { digest, ...value } = event;
        void digest;
        event.digest = hash(value);
        previous = event.digest;
        return JSON.stringify(event);
      })
      .join("\n") + "\n",
  );
}
test("workflow findings command returns source limited candidate details with a separately retained complete receipt", async (t) => {
  const d = await complete(t);
  const before = d.engine.status(d.id);
  const receipts: unknown[] = [];
  const result = reviewWorkflowFindingsResultSchema.parse(
    await d.engine.command(
      { operation: "findings", workflowId: d.id, declarations: d.declarations },
      undefined,
      undefined,
      (receipt) => receipts.push(receipt),
    ),
  );
  assert.equal(receipts.length, 1);
  const full = replayReviewFindings(receipts[0], true);
  assert.equal(result.inputDigest, full.inputDigest);
  assert.equal(result.candidates["declared-supported"], 2);
  assert.equal(result.findings.length, 2);
  assert.equal(result.detailsIncluded, true);
  assert.deepEqual(d.engine.status(d.id), before);
  const serialized = JSON.stringify(result);
  for (const privateText of [
    source.trim(),
    d.target.claim,
    d.reviewer.host.sessionId,
    "refutationRationale",
    "rawArtifacts",
    "stdoutBase64",
  ])
    assert.ok(!serialized.includes(privateText), privateText);
  assert.equal(result.claimsVerified, false);
  assert.equal(result.commonCauseVerified, false);
});
test(
  "workflow findings audit retains current inspection evidence and rejects altered identities native runs judgments parameters and returned outcomes",
  {
    skip:
      process.platform === "win32"
        ? "Private workflow audit profile is POSIX-only"
        : false,
  },
  async (t) => {
    const file = await auditFile(t);
    let session: ReviewWorkflowSession | undefined;
    try {
      const d = await complete(t, source, false, async (root) => {
        session = new ReviewWorkflowSession(root, {
          ...options,
          audit: { file },
        });
        return (command) => session!.command(command);
      });
      const result = reviewWorkflowFindingsResultSchema.parse(
        await d.call({
          operation: "findings",
          workflowId: d.id,
          declarations: d.declarations,
        }),
      );
      session!.dispose();
      const original = parseReviewWorkflowAuditArtifact(await readFile(file));
      assert.equal(original.summary.journalVersion, 3);
      assert.equal(original.summary.journalStatus, "sealed");
      assert.equal(original.summary.nativeReceipts.retained, 2);
      const index = original.events.findIndex(
        (e) =>
          e.body.kind === "finish" &&
          e.body.result?.format === "review-workflow-findings",
      );
      assert.ok(index > 0);
      const row = original.events[index]!;
      assert.equal(row.body.kind, "finish");
      assert.deepEqual(
        row.body.kind === "finish" ? row.body.result : null,
        result,
      );
      const fixture = JSON.stringify(original.events);
      const mutable = JSON.parse(fixture);
      const variants: Array<(v: typeof mutable) => void> = [
        (v) => {
          v[index].body.findingsReceipt = null;
        },
        (v) => {
          v[index].body.findingsReceipt = {};
        },
        (v) => {
          v[index].body.result.findings[0].declaredSeverity = "high";
        },
        (v) => {
          v[
            index
          ].body.findingsReceipt.findings[0].repairParameters.available.push(
            "requestCeiling",
          );
        },
        (v) => {
          v[index].body.findingsReceipt.input.reviewerSessionId =
            "ForeignSession";
        },
        (v) => {
          v[
            index
          ].body.findingsReceipt.input.decisions[0].refutation.sessionId =
            "ForeignRefuter";
        },
        (v) => {
          v[
            index
          ].body.findingsReceipt.input.decisions[0].adjudication.sessionId =
            "ForeignJudge";
        },
        (v) => {
          v[index].body.findingsReceipt.input.provenance.native.reverse();
        },
        (v) => {
          v[
            index - 1
          ].body.capture.value.declarations.decisions[0].judgment.consequence.category =
            "unknown";
        },
        (v) => {
          v[
            index
          ].body.findingsReceipt.input.provenance.assessment.usage.inputTokens =
            71;
        },
        (v) => {
          v[index].body.findingsReceipt.input.provenance.candidates.reverse();
          v[
            index
          ].body.findingsReceipt.input.provenance.assessment.observations.reverse();
        },
        (v) => {
          v[index].body.findingsReceipt.input.provenance.native[0].run =
            v[index].body.findingsReceipt.input.provenance.native[1].run;
        },
      ];
      variants.push((v) => {
        const receipt = v[index].body.findingsReceipt;
        receipt.input.reviewerSessionId = "OriginalCoherentlyForeignSession";
        receipt.inputDigest = hash(receipt.input);
        // The standalone imported report is internally consistent. Only workflow binding can reject it.
        assert.doesNotThrow(() => projectWorkflowFindings(receipt));
        v[index].body.result = projectWorkflowFindings(receipt);
      });
      for (const [i, mutate] of variants.entries()) {
        const events = structuredClone(mutable);
        mutate(events);
        assert.throws(
          () => parseReviewWorkflowAuditArtifact(rechain(events)),
          "Original findings tamper " + i,
        );
      }
    } finally {
      session?.dispose();
    }
  },
);
test("workflow findings ignore unavailable retry metadata while binding each accepted stage and preserving every attempt", async (t) => {
  const d = await complete(t, source, false, undefined, true);
  const before = d.engine.status(d.id);
  assert.equal(before.assignments.length, 10);
  assert.equal(
    before.assignments.filter((a) => a.status === "unavailable").length,
    5,
  );
  const report = await d.engine.inspectFindings(
    d.id,
    JSON.stringify(d.declarations),
  );
  assert.equal(report.candidates["declared-supported"], 2);
  assert.deepEqual(report.input.provenance.assessment.usage, d.reviewer.usage);
  assert.equal(report.input.provenance.assessment.usage.inputTokens, null);
  assert.equal(d.engine.status(d.id).assignments.length, 10);
});
test("workflow findings synchronous historical replay rederives captured parameter bindings without attesting current source", async (t) => {
  const d = await complete(t);
  const report = await d.engine.inspectFindings(
    d.id,
    JSON.stringify(d.declarations),
  );
  await writeFile(
    path.join(d.root, "subject.mjs"),
    "export function decision(){return false;}\n",
  );
  const replayed = replayReviewFindings(report);
  assert.equal(replayed.freshness, "current");
  assert.equal(replayed.nativeExecution, false);
  const forged = structuredClone(report);
  forged.findings[0]!.repairParameters.available.push("requestCeiling");
  assert.throws(() => replayReviewFindings(forged), /does not reconcile/);
  assert.equal(
    (await d.engine.inspectFindings(d.id, JSON.stringify(d.declarations)))
      .status,
    "stale",
  );
});
test(
  "workflow findings preserve legacy all candidate journal version two and selected target invalid command accounting",
  {
    skip:
      process.platform === "win32"
        ? "Private workflow audit profile is POSIX-only"
        : false,
  },
  async (t) => {
    const file = await auditFile(t);
    let session: ReviewWorkflowSession | undefined;
    try {
      const d = await complete(t, source, false, async (root) => {
        session = new ReviewWorkflowSession(root, {
          ...options,
          audit: { file },
        });
        return (command) => session!.command(command);
      });
      session!.dispose();
      const v3 = parseReviewWorkflowAuditArtifact(await readFile(file));
      const v2 = JSON.parse(JSON.stringify(v3.events));
      for (const event of v2) {
        event.schemaVersion = 2;
        if (event.body.kind === "finish") delete event.body.findingsReceipt;
      }
      assert.equal(
        parseReviewWorkflowAuditArtifact(rechain(v2 as typeof v3.events))
          .summary.journalVersion,
        2,
      );
      const selectedFile = path.join(path.dirname(file), "selected.jsonl");
      const selected = new ReviewWorkflowSession(d.root, {
        ...options,
        candidateScope: "selected",
        audit: { file: selectedFile },
      });
      try {
        const state = await selected.command({
          operation: "open",
          context: ".checktrail/context.json",
        });
        assert.equal(state.format, "review-workflow-summary");
        if (state.format !== "review-workflow-summary")
          throw Error("Summary required");
        await assert.rejects(
          selected.command({
            operation: "findings",
            workflowId: state.workflowId,
            declarations: d.declarations,
          }),
          /Quiescent disclosed/,
        );
        assert.equal(
          (
            await selected.command({
              operation: "status",
              workflowId: state.workflowId,
            })
          ).format,
          "review-workflow-summary",
        );
      } finally {
        selected.dispose();
      }
      const legacy = parseReviewWorkflowAuditArtifact(
        await readFile(selectedFile),
      );
      assert.equal(legacy.summary.journalVersion, 2);
      assert.equal(legacy.summary.commands.rejected, 1);
    } finally {
      session?.dispose();
    }
  },
);
test(
  "workflow findings CLI and MCP retain complete audited evidence while returning bounded candidate details",
  {
    skip:
      process.platform === "win32"
        ? "Private workflow audit profile is POSIX-only"
        : false,
  },
  async (t) => {
    for (const mode of ["cli", "mcp"] as const) {
      const file = await auditFile(t);
      let connection: Awaited<ReturnType<typeof channel>> | undefined;
      try {
        const d = await complete(t, source, false, async (root) => {
          connection = await channel(mode, root, file);
          return connection.call;
        });
        const result = reviewWorkflowFindingsResultSchema.parse(
          await d.call({
            operation: "findings",
            workflowId: d.id,
            declarations: d.declarations,
          }),
        );
        assert.equal(result.candidates["declared-supported"], 2);
        assert.equal(result.groups[0]!.state, "declared-common-defect");
        assert.equal(result.claimsVerified, false);
        assert.equal(result.qualityGate, "not-assessed");
        for (const hidden of [
          source.trim(),
          d.target.claim,
          "refutationRationale",
          d.reviewer.host.sessionId,
          "stdoutBase64",
        ])
          assert.ok(
            !JSON.stringify(result).includes(hidden),
            mode + ":" + hidden,
          );
        await d.call({ operation: "close", workflowId: d.id });
        await connection!.finish();
        const audited = parseReviewWorkflowAuditArtifact(await readFile(file));
        assert.equal(audited.summary.journalVersion, 3);
        assert.equal(audited.summary.nativeReceipts.retained, 2);
        assert.equal(audited.summary.journalStatus, "sealed");
      } finally {
        await connection?.close();
      }
    }
  },
);

test("workflow findings preserve unfinished candidates and reached native evidence between accepted stages", async (t) => {
  let observed = 0;
  const d = await complete(
    t,
    source,
    false,
    undefined,
    false,
    async (stage, b) => {
      const declarations = declarationsFor(b.context, b.state.candidateHandles);
      declarations.decisions = declarations.decisions.filter((d) =>
        b.state.completedTargets.includes(d.target),
      );
      const report = reviewWorkflowFindingsResultSchema.parse(
        await b.call({ operation: "findings", workflowId: b.id, declarations }),
      );
      assert.equal(report.candidates.selected, 2);
      assert.equal(
        report.candidates["declared-supported"],
        b.state.completedTargets.length,
      );
      assert.equal(
        report.candidates.unresolved,
        2 - b.state.completedTargets.length,
      );
      assert.equal(
        report.groups[0]!.state,
        b.state.completedTargets.length === 2
          ? "declared-common-defect"
          : "unresolved",
      );
      assert.deepEqual(
        await b.call({ operation: "status", workflowId: b.id }),
        b.state,
      );
      if (stage === "native") {
        const forged = declarationsFor(b.context, b.state.candidateHandles);
        await assert.rejects(
          b.call({
            operation: "findings",
            workflowId: b.id,
            declarations: forged,
          }),
          /Unknown workflow findings target/,
        );
      }
      observed++;
    },
  );
  assert.equal(observed, 5);
  assert.equal(
    reviewWorkflowAllSummarySchema.parse(d.engine.status(d.id)).completedTargets
      .length,
    2,
  );
});
test(
  "workflow findings audit binds unfinished reached native receipts before adjudication",
  {
    skip:
      process.platform === "win32"
        ? "Private workflow audit profile is POSIX-only"
        : false,
  },
  async (t) => {
    const file = await auditFile(t);
    let session: ReviewWorkflowSession | undefined;
    try {
      await complete(
        t,
        source,
        false,
        async (root) => {
          session = new ReviewWorkflowSession(root, {
            ...options,
            audit: { file },
          });
          return (command) => session!.command(command);
        },
        false,
        async (_stage, b) => {
          const declarations = declarationsFor(
            b.context,
            b.state.candidateHandles,
          );
          declarations.decisions = declarations.decisions.filter((d) =>
            b.state.completedTargets.includes(d.target),
          );
          await b.call({
            operation: "findings",
            workflowId: b.id,
            declarations,
          });
        },
      );
    } finally {
      session?.dispose();
    }
    const parsed = parseReviewWorkflowAuditArtifact(await readFile(file));
    const receipts = parsed.events.flatMap((e) =>
      e.body.kind === "finish" &&
      "findingsReceipt" in e.body &&
      e.body.findingsReceipt
        ? [
            e.body.findingsReceipt as {
              input: { provenance: { native: unknown[] } };
            },
          ]
        : [],
    );
    assert.deepEqual(
      receipts.map((r) => r.input.provenance.native.length),
      [0, 1, 1, 2, 2],
    );
    assert.equal(parsed.summary.nativeReceipts.retained, 2);
    assert.equal(parsed.summary.journalStatus, "sealed");
  },
);

test("workflow findings refuse awaiting host stages without consuming the outstanding assignment", async (t) => {
  const d = await setup(t);
  const engine = new ReviewWorkflowEngine(d.root, options);
  try {
    const id = (await engine.open(d.context)).workflowId;
    const reviewed = await engine.submit(
      id,
      response(reviewWorkflowAssignmentSchema.parse(await engine.next(id)), [
        d.target,
      ]),
    );
    const assignment = reviewWorkflowAssignmentSchema.parse(
      await engine.next(id, reviewed.candidateHandles[0]),
    );
    const before = engine.status(id);
    await assert.rejects(
      engine.inspectFindings(
        id,
        JSON.stringify({ decisions: [], commonDefects: [] }),
      ),
      /Quiescent disclosed/,
    );
    assert.deepEqual(engine.status(id), before);
    const accepted = await engine.submit(id, response(assignment));
    assert.equal(accepted.nextStage, "probe");
    const report = await engine.inspectFindings(
      id,
      JSON.stringify({ decisions: [], commonDefects: [] }),
    );
    assert.equal(report.candidates.unresolved, 1);
    assert.equal(engine.status(id).assignments.length, 2);
  } finally {
    engine.dispose();
  }
});
