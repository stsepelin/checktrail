import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  writeFile,
  readFile,
  mkdir,
  readdir,
  realpath,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import {
  ReviewWorkflowEngine,
  type ReviewWorkflowOptions,
} from "../src/review-workflow.js";
import {
  reviewWorkflowAssignmentSchema,
  reviewWorkflowAllSummarySchema,
} from "../src/review-workflow-schema.js";
import { reviewWorkflowFindingsResultSchema } from "../src/review-workflow-findings.js";
import {
  complete,
  channel,
  options,
} from "./review-workflow-findings-fixture.js";
import {
  setup,
  source,
  recipe,
  pin,
  response,
} from "./review-workflow-fixture.js";
import type { ReviewWorkflowNativeReceipt } from "../src/review-workflow-schema.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const empty = { decisions: [], commonDefects: [] };
async function begin(
  t: TestContext,
  content = source,
  extra: Partial<ReviewWorkflowOptions> = {},
) {
  const d = await setup(t, content);
  const engine = new ReviewWorkflowEngine(d.root, { ...options, ...extra });
  t.after(() => engine.dispose());
  const id = (await engine.open(d.context)).workflowId;
  const reviewed = await engine.submit(
    id,
    response(reviewWorkflowAssignmentSchema.parse(await engine.next(id)), [
      d.target,
      { ...d.target, id: "OriginalOtherSymptom" },
    ]),
  );
  return {
    ...d,
    engine,
    id,
    state: reviewWorkflowAllSummarySchema.parse(reviewed),
  };
}
function unknown(
  report: Awaited<ReturnType<ReviewWorkflowEngine["inspectFindings"]>>,
) {
  for (const field of [
    "claimsVerified",
    "independenceVerified",
    "commonCauseVerified",
    "repairCorrectnessVerified",
    "severityVerified",
    "nativeExecution",
    "deterministicOutcomeChanged",
  ] as const)
    assert.equal(report[field], false, field);
  assert.equal(report.qualityGate, "not-assessed");
}
test("multi-candidate-workflow broken acceptance", async (t) => {
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
  assert.deepEqual(
    report.groups[0]!.candidateIds,
    report.input.provenance.candidates.map((c) => c.id),
  );
  for (const native of report.input.provenance.native) {
    assert.equal(native.run.behavior, "violated");
    assert.equal(native.run.sourceDigest, d.context.files[0]!.sha256);
    assert.deepEqual(
      native.run.trials.map((t) => t.id),
      ["Baseline", "Trigger", "NearMiss"],
    );
    assert.equal(native.run.counts.observed, 3);
  }
  assert.equal(d.engine.status(d.id).assignments.length, 5);
  assert.ok(
    report.findings.every(
      (f) =>
        f.declaredSeverity === "moderate" &&
        f.repairParameters.available.includes("name"),
    ),
  );
  unknown(report);
});
test("multi-candidate-workflow fixed acceptance", async (t) => {
  const d = await complete(
    t,
    "export function decision(name){return name === 'grant:read';}\n",
  );
  const report = await d.engine.inspectFindings(
    d.id,
    JSON.stringify(d.declarations),
  );
  assert.equal(report.candidates["declared-supported"], 0);
  assert.equal(report.candidates.unresolved, 2);
  assert.ok(
    report.input.provenance.native.every(
      (n) => n.run.behavior === "satisfied" && n.run.counts.observed === 3,
    ),
  );
  assert.ok(
    report.findings.every((f) =>
      f.gaps.includes("native-predicate-not-violated"),
    ),
  );
  unknown(report);
});
test("multi-candidate-workflow near-miss acceptance", async (t) => {
  const d = await complete(
    t,
    "export function decision(name){return name === 'grant' || name.startsWith('grant:');}\n",
  );
  d.declarations.decisions[0]!.judgment.disposition = "refuted";
  d.declarations.decisions[1]!.judgment.repair!.requiredParameters = [
    "nameFromCaller",
  ];
  const report = await d.engine.inspectFindings(
    d.id,
    JSON.stringify(d.declarations),
  );
  assert.equal(report.candidates["declared-refuted"], 1);
  assert.equal(report.candidates.unresolved, 1);
  assert.equal(report.findings[0]!.state, "declared-refuted");
  assert.ok(report.findings[1]!.gaps.includes("repair-parameter-missing"));
  assert.equal(report.groups[0]!.state, "unresolved");
  assert.ok(
    report.input.provenance.native.every((n) => n.run.behavior === "satisfied"),
  );
  unknown(report);
});
test("multi-candidate-workflow prerequisite acceptance", async (t) => {
  const d = await begin(t, source, { trusted: false });
  await d.engine.submit(
    d.id,
    response(
      reviewWorkflowAssignmentSchema.parse(
        await d.engine.next(d.id, d.state.candidateHandles[0]),
      ),
    ),
  );
  await assert.rejects(
    d.engine.probe(d.id, recipe.id),
    /Native trust and registered probe/,
  );
  await assert.rejects(
    d.engine.probe(d.id, "UnknownPinnedProbe"),
    /Native trust and registered probe/,
  );
  const result = await d.engine.inspectFindings(d.id, JSON.stringify(empty));
  assert.equal(result.candidates.unresolved, 2);
  assert.equal(result.input.provenance.native.length, 0);
  assert.equal(d.engine.status(d.id).native.status, "not-started");
  const corrupted = pin();
  corrupted.sha256 = "0".repeat(64);
  assert.throws(
    () => new ReviewWorkflowEngine(d.root, { ...options, probes: [corrupted] }),
    /digest|hash|match/i,
  );
  unknown(result);
});
test("multi-candidate-workflow stale acceptance", async (t) => {
  const d = await complete(t);
  await writeFile(
    path.join(d.root, "subject.mjs"),
    "export function decision(name){return false;}\n",
  );
  const report = await d.engine.inspectFindings(
    d.id,
    JSON.stringify(d.declarations),
  );
  assert.equal(report.freshness, "stale");
  assert.equal(report.status, "stale");
  assert.equal(report.candidates.unresolved, 2);
  assert.ok(report.findings.every((f) => f.gaps.includes("stale-source")));
  assert.equal(report.input.provenance.native.length, 2);
  unknown(report);
});
test("multi-candidate-workflow empty acceptance", async (t) => {
  const d = await begin(t);
  const before = d.engine.status(d.id);
  const report = await d.engine.inspectFindings(d.id, JSON.stringify(empty));
  assert.equal(report.status, "incomplete");
  assert.equal(report.candidates.unresolved, 2);
  assert.ok(report.findings.every((f) => f.gaps.includes("missing-decision")));
  assert.deepEqual(d.engine.status(d.id), before);
  await assert.rejects(
    d.engine.inspectFindings(
      d.id,
      '{"decisions":[],"commonDefects":[],"trusted":true}',
    ),
  );
  await assert.rejects(d.engine.inspectFindings(d.id, "{"));
  const abstention = await complete(t, source, true);
  const absent = await abstention.engine.inspectFindings(
    abstention.id,
    JSON.stringify(abstention.declarations),
  );
  assert.equal(absent.status, "incomplete");
  assert.equal(absent.candidates.selected, 0);
  assert.equal(
    abstention.engine.status(abstention.id).disposition,
    "no-candidates-declared",
  );
  unknown(absent);
});
test("multi-candidate-workflow privacy acceptance", async (t) => {
  for (const mode of ["cli", "mcp"] as const) {
    let connected: Awaited<ReturnType<typeof channel>> | undefined;
    try {
      const d = await complete(t, source, false, async (root) => {
        connected = await channel(mode, root);
        return connected.call;
      });
      const report = reviewWorkflowFindingsResultSchema.parse(
        await d.call({
          operation: "findings",
          workflowId: d.id,
          declarations: d.declarations,
        }),
      );
      assert.equal(report.candidates["declared-supported"], 2);
      const encoded = JSON.stringify(report);
      for (const hidden of [
        source.trim(),
        d.root,
        d.target.claim,
        d.reviewer.host.sessionId,
        "refutationRationale",
        "stdoutBase64",
      ])
        assert.equal(encoded.includes(hidden), false, mode + ":" + hidden);
      assert.equal("input" in report, false);
      assert.equal("receipt" in report, false);
      await d.call({ operation: "close", workflowId: d.id });
      await connected!.finish();
    } finally {
      await connected?.close();
    }
  }
  const d = await setup(t);
  const denied = new ReviewWorkflowEngine(d.root, {
    ...options,
    allowReviewSource: false,
  });
  try {
    const id = (await denied.open(d.context)).workflowId;
    await assert.rejects(denied.next(id), /source|disclos/i);
  } finally {
    denied.dispose();
  }
});
const lifecycleSource =
  "export async function decision(name,target,mode){const child=process.getBuiltinModule('node:child_process').spawn(process.execPath,['-e',\"process.stdout.write(String(process.pid));setInterval(()=>{},1000);\"],{stdio:['ignore','pipe','ignore']});const pid=await new Promise(resolve=>child.stdout.once('data',bytes=>resolve(Number(String(bytes)))));const fs=process.getBuiltinModule('node:fs');fs.writeFileSync(target+'.pending',JSON.stringify({pid:process.pid,child:pid}));fs.renameSync(target+'.pending',target);if(mode==='output'){process.stdout.write('x'.repeat(20000));return true;}await new Promise(()=>setInterval(()=>{},1000));return true;}\n";
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw e;
  }
}
test(
  "multi-candidate-workflow lifecycle acceptance",
  { timeout: 60000 },
  async (t) => {
    const previous = Object.fromEntries(
      ["TMPDIR", "TMP", "TEMP"].map((n) => [n, process.env[n]]),
    );
    try {
      for (const mode of ["cancel", "timeout", "output"] as const) {
        const initial = await setup(t, lifecycleSource);
        const marker = path.join(initial.root, ".checktrail/entered");
        const temporary = path.join(initial.root, ".checktrail/native-scratch");
        await mkdir(temporary);
        const selected = structuredClone(recipe);
        for (const c of selected.cases) c.args = ["grant:read", marker, mode];
        const contents = JSON.stringify(selected);
        const d = await begin(t, lifecycleSource, {
          probes: [{ contents, sha256: hash(contents) }],
          nativeWallMs: mode === "timeout" ? 4000 : 12000,
          maxNativeOutputBytes: mode === "output" ? 128 : 65536,
        });
        for (const name of Object.keys(previous)) process.env[name] = temporary;
        await d.engine.submit(
          d.id,
          response(
            reviewWorkflowAssignmentSchema.parse(
              await d.engine.next(d.id, d.state.candidateHandles[0]),
            ),
          ),
        );
        const controller = new AbortController();
        const receipts: ReviewWorkflowNativeReceipt[] = [];
        const pending = d.engine.probe(
          d.id,
          recipe.id,
          controller.signal,
          (r) => receipts.push(r),
        );
        try {
          const deadline = Date.now() + 8000;
          let ids: { pid: number; child: number } | undefined;
          while (!ids) {
            try {
              ids = JSON.parse(await readFile(marker, "utf8"));
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            }
            assert.ok(
              Date.now() < deadline,
              "Actual native body and child must be reached",
            );
            if (!ids) await delay(10);
          }
          if (mode === "cancel") controller.abort();
          const stopped = reviewWorkflowAllSummarySchema.parse(await pending);
          assert.equal(
            stopped.status,
            mode === "cancel"
              ? "cancelled"
              : mode === "timeout"
                ? "timed-out"
                : "incomplete",
          );
          assert.equal(stopped.retainedBytes, 0);
          assert.equal(stopped.unverifiedCandidates, 2);
          assert.equal(stopped.completedTargets.length, 0);
          assert.equal(stopped.resolution, "unresolved");
          assert.equal(receipts.length, 1);
          const run = receipts[0]!.run;
          assert.equal(run.temporaryArtifacts, "removed");
          if (run.schemaVersion !== 3)
            throw Error("Physical native receipt required");
          assert.equal(run.nativeBudget.calls, 1);
          assert.equal(run.counts.notRun, 2);
          assert.equal(stopped.native.calls, run.nativeBudget.calls);
          if (mode === "output")
            assert.equal(run.trials[0]!.execution!.truncated, true);
          const until = Date.now() + 5000;
          while ((alive(ids.pid) || alive(ids.child)) && Date.now() < until)
            await delay(20);
          assert.equal(alive(ids.pid), false);
          assert.equal(alive(ids.child), false);
          assert.deepEqual(await readdir(temporary), []);
          await assert.rejects(
            d.engine.inspectFindings(d.id, JSON.stringify(empty)),
            /Quiescent disclosed/,
          );
        } finally {
          controller.abort();
          await pending;
          d.engine.dispose();
          for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
        }
      }
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);
test(
  "multi-candidate-workflow installed acceptance",
  { timeout: 180000 },
  async () => {
    if (process.env.CHECKTRAIL_MULTI_WORKFLOW_INSTALLED === "1") {
      const actual = await realpath(
        fileURLToPath(new URL("../src/index.js", import.meta.url)),
      );
      assert.ok(
        actual.includes(path.join("node_modules", "@stsepelin", "checktrail")),
      );
      return;
    }
    const runtimeSlot = process.env.CHECKTRAIL_REVIEW_RUNTIME_SLOT;
    const script = fileURLToPath(
      new URL(
        runtimeSlot === undefined
          ? "../../scripts/verify-import-context-package.mjs"
          : "../../scripts/verify-review-runtime-package.mjs",
        import.meta.url,
      ),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "multi-candidate-workflow",
    };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [script, ...(runtimeSlot === undefined ? [] : [runtimeSlot])],
      {
        env,
        encoding: "utf8",
        timeout: 175000,
        maxBuffer: 1048576,
      },
    );
    assert.equal(
      result.status,
      0,
      result.stdout.slice(0, 4096) + result.stderr.slice(0, 4096),
    );
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.offlineProductionInstall, true);
    assert.equal(proof.lifecycleScriptsExecuted, false);
    assert.equal(proof.profile.required, 9);
    assert.equal(proof.profile.passed, 9);
    assert.equal(proof.profile.complete, true);
    if (process.env.CHECKTRAIL_MULTI_WORKFLOW_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_MULTI_WORKFLOW_INSTALL_RECEIPT,
        JSON.stringify(proof) + "\n",
      );
  },
);
