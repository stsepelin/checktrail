import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  realpath,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  inspectReviewProvenance,
  projectReviewProvenance,
} from "../src/review-provenance.js";
import { runReviewProbe } from "../src/review-probe.js";
import { createReviewContext } from "../src/review.js";
import { provenanceFixture } from "./confidence-provenance-fixture.js";
import { recipe, source } from "./review-workflow-fixture.js";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url)),
  inspect = (root: string, input: unknown) =>
    inspectReviewProvenance(root, JSON.stringify(input)),
  hash = (s: string) => createHash("sha256").update(s).digest("hex");
function unknownQuality(
  report: Awaited<ReturnType<typeof inspectReviewProvenance>>,
) {
  for (const k of [
    "claimsVerified",
    "confidenceVerified",
    "calibratedConfidence",
    "independenceVerified",
    "nativeExecution",
    "importedNativeExecutionAttested",
    "deterministicOutcomeChanged",
  ] as const)
    assert.equal(report[k], false, k);
  assert.equal(report.qualityGate, "not-assessed");
}
test("confidence-provenance broken acceptance", async (t) => {
  const d = await provenanceFixture(t),
    report = await inspect(d.root, d.input);
  assert.equal(d.input.native[0]!.run.behavior, "violated");
  assert.equal(d.input.native[0]!.run.counts.triggerMismatches, 1);
  assert.equal(report.status, "completed");
  assert.equal(report.candidateEvidence[0]!.tier, "native-receipt-reconciled");
  assert.equal(report.candidateEvidence[0]!.sourceAddressesVerified, true);
  assert.equal(report.candidateEvidence[0]!.confidence.probability, 0.95);
  assert.equal(
    report.candidateEvidence[0]!.confidence.provenance,
    "host-declared-unverified",
  );
  assert.equal(report.candidateEvidence[0]!.native.executionAttested, false);
  assert.equal(report.labelProvenance, "operator-declared-unverified");
  assert.equal(report.scoring!.aggregate.properScores.scored, 1);
  unknownQuality(report);
  const foreign = structuredClone(d.input);
  foreign.native[0]!.run.candidateDigest = "0".repeat(64);
  await assert.rejects(
    inspect(d.root, foreign),
    /Native source\/context\/claim/,
  );
});
test("confidence-provenance fixed acceptance", async (t) => {
  const d = await provenanceFixture(
    t,
    "export function decision(name){return name==='grant:read';}\n",
  );
  d.input.scoring!.observations[0]!.label = "valid";
  d.input.scoring!.observations[0]!.judgement = "refuted";
  const report = await inspect(d.root, d.input);
  assert.equal(d.input.native[0]!.run.behavior, "satisfied");
  assert.equal(d.input.native[0]!.run.counts.observed, 3);
  assert.equal(report.candidateEvidence[0]!.native.behavior, "satisfied");
  assert.ok(
    report.scoring!.aggregate.properScores.brier! > 0.9,
    "A confident refuted host claim remains a poor descriptive prediction",
  );
  assert.equal(report.candidates.selected, 1);
  unknownQuality(report);
});
test("confidence-provenance near-miss acceptance", async (t) => {
  const d = await provenanceFixture(t, source, false),
    report = await inspect(d.root, d.input);
  assert.equal(report.candidateEvidence[0]!.tier, "source-bound-host-claim");
  assert.deepEqual(report.decisions, {
    selected: 4,
    finding: 1,
    abstained: 1,
    unsupported: 1,
    unreviewed: 1,
    incomplete: 0,
    "budget-exhausted": 0,
    stale: 0,
    cancelled: 0,
  });
  assert.equal(report.scoring!.aggregate.missingObservations, 1);
  for (const probability of [0, null]) {
    const input = structuredClone(d.input);
    input.candidates[0]!.confidence!.probability = probability;
    input.scoring!.observations[0]!.probability = probability;
    const r = await inspect(d.root, input);
    assert.equal(r.candidateEvidence[0]!.confidence.probability, probability);
    assert.equal(
      r.candidates.unknownProbabilities,
      probability === null ? 1 : 0,
    );
  }
  // Two independent host claims must remain separate even in the same physical source.
  const multiple = structuredClone(d.input),
    second = structuredClone(multiple.candidates[0]!);
  second.id = "OriginalSecondCandidate";
  second.claim = "A second original claim still needs its own adjudication.";
  second.confidence!.probability = null;
  multiple.candidates.push(second);
  if (multiple.assessment.schemaVersion !== 2)
    throw Error("Revision assessment");
  multiple.assessment.observations.push({
    id: second.id,
    severity: second.severity,
    claim: second.claim,
    citations: second.citations,
    attribution: second.attribution,
    fixScope: second.fixScope,
  });
  multiple.scoring!.protocol.trials.push({
    id: second.id,
    clusterId: second.id,
    family: second.family,
  });
  multiple.scoring!.bindings.push({
    ...multiple.scoring!.bindings[0]!,
    trialId: second.id,
    candidateId: second.id,
  });
  multiple.scoring!.observations.push({
    id: second.id,
    status: "completed",
    decision: "finding",
    probability: null,
    label: "unresolved",
    judgement: "unresolved",
  });
  const two = await inspect(d.root, multiple);
  assert.equal(two.candidates.selected, 2);
  assert.equal(two.candidates["source-bound-host-claim"], 2);
  assert.equal(two.candidates.hostDeclaredProbabilities, 1);
  assert.equal(two.candidates.unknownProbabilities, 1);
  assert.equal(two.decisions.selected, 5);
  assert.equal(two.decisions.finding, 2);
  assert.equal(two.scoring!.aggregate.unresolvedFindings, 1);
  assert.equal(two.scoring!.aggregate.properScores.scored, 1);
  assert.deepEqual(
    two.candidateEvidence.map((e) => [e.id, e.confidence.probability]),
    [
      [d.target.id, 0.95],
      [second.id, null],
    ],
  );
  const collapsed = structuredClone(multiple);
  collapsed.scoring!.bindings.at(-1)!.candidateId = d.target.id;
  await assert.rejects(inspect(d.root, collapsed), /one exact trial binding/);
  const omitted = structuredClone(multiple);
  omitted.assessment.observations.pop();
  await assert.rejects(inspect(d.root, omitted), /one candidate/);
  const duplicate = structuredClone(multiple);
  duplicate.candidates[1]!.id = duplicate.candidates[0]!.id;
  await assert.rejects(inspect(d.root, duplicate));
  unknownQuality(two);
  const bad = structuredClone(d.input);
  bad.scoring!.observations[0]!.probability = 0.1;
  await assert.rejects(inspect(d.root, bad), /probability is not/);
  const unreviewed = structuredClone(d.input);
  unreviewed.assessment.files[0]!.disposition = "not-reviewed";
  const partial = await inspect(d.root, unreviewed);
  assert.equal(partial.status, "incomplete");
  assert.equal(partial.coverage.declaredNotReviewed, 1);
  unknownQuality(partial);
});
test("confidence-provenance prerequisite acceptance", async (t) => {
  const d = await provenanceFixture(t),
    faults = [
      (p: typeof d.input) => {
        p.candidates[0]!.claim += " altered";
        p.native = [];
      },
      (p: typeof d.input) => {
        p.native[0]!.run.contextDigest = "0".repeat(64);
      },
      (p: typeof d.input) => {
        p.native[0]!.run.sourceDigest = "0".repeat(64);
      },
      (p: typeof d.input) => {
        p.native[0]!.run.functionRange.end++;
      },
      (p: typeof d.input) => {
        p.scoring!.bindings[1]!.sourceDigest = "0".repeat(64);
      },
      (p: typeof d.input) => {
        p.scoring!.bindings[0]!.candidateId = "OriginalUnknown";
      },
      (p: typeof d.input) => {
        p.scoring!.bindings.push({ ...p.scoring!.bindings[1]! });
      },
    ];
  for (const change of faults) {
    const input = structuredClone(d.input);
    change(input);
    await assert.rejects(inspect(d.root, input));
  }
  await assert.rejects(inspect(d.root, { ...d.input, claimsVerified: true }));
  const old = {
    ...d.input,
    native: [
      {
        candidateId: d.target.id,
        run: { ...d.input.native[0]!.run, schemaVersion: 1 },
      },
    ],
  };
  await assert.rejects(inspect(d.root, old));
});
test("confidence-provenance stale acceptance", async (t) => {
  const d = await provenanceFixture(t),
    file = path.join(d.root, "subject.mjs"),
    before = await readFile(file);
  try {
    await writeFile(file, source + "// Original changed source\n");
    const currentAbstention = structuredClone(d.input);
    for (const row of currentAbstention.scoring!.observations) {
      row.decision = "abstain";
      row.probability = null;
      row.judgement = "none";
    }
    await assert.rejects(
      inspect(d.root, currentAbstention),
      /Stale source cannot retain current scoring/,
    );
    await assert.rejects(
      inspect(d.root, d.input),
      /Stale source cannot retain current scoring/,
    );
    const stale = await inspect(d.root, { ...d.input, scoring: null });
    assert.equal(stale.status, "stale");
    assert.equal(stale.candidateEvidence[0]!.tier, "stale-source");
    assert.equal(stale.candidateEvidence[0]!.sourceAddressesVerified, false);
    unknownQuality(stale);
  } finally {
    await writeFile(file, before);
  }
  assert.equal((await inspect(d.root, d.input)).status, "completed");
  const changed = structuredClone(d.input);
  changed.candidates[0]!.confidence!.probability = 0.5;
  changed.scoring!.observations[0]!.probability = 0.5;
  await assert.rejects(
    inspect(d.root, changed),
    /Native source\/context\/claim/,
  );
});
test("confidence-provenance empty acceptance", async (t) => {
  const d = await provenanceFixture(t, source, false);
  await assert.rejects(inspectReviewProvenance(d.root, ""));
  await assert.rejects(
    inspectReviewProvenance(
      d.root,
      " ".repeat(1048577) + JSON.stringify(d.input),
    ),
    /Bounded/,
  );
  let evaluated = false;
  const executable = {
    toJSON() {
      evaluated = true;
      return d.input;
    },
    toString() {
      evaluated = true;
      return JSON.stringify(d.input);
    },
  };
  await assert.rejects(
    inspectReviewProvenance(d.root, executable as unknown as string),
    /serialized/,
  );
  assert.equal(evaluated, false);
  const noObservations = structuredClone(d.input);
  noObservations.scoring!.observations = [];
  const empty = await inspect(d.root, noObservations);
  assert.equal(empty.decisions.unreviewed, 4);
  assert.equal(empty.labelProvenance, "not-supplied");
  assert.equal(empty.scoring!.aggregate.properScores.scored, 0);
  assert.equal(empty.scoring!.aggregate.properScores.brier, null);
  unknownQuality(empty);
  const noClaims = structuredClone(d.input);
  noClaims.candidates = [];
  noClaims.assessment.observations = [];
  noClaims.native = [];
  noClaims.scoring = null;
  const abstained = await inspect(d.root, noClaims);
  assert.equal(abstained.candidates.selected, 0);
  assert.equal(abstained.claimsVerified, false);
  const malformed = structuredClone(d.input);
  malformed.candidates[0]!.citations[0]!.quote = "OriginalUnmatchedQuote";
  if (malformed.assessment.schemaVersion !== 2)
    throw Error("Revision assessment");
  malformed.assessment.observations[0]!.citations[0]!.quote =
    "OriginalUnmatchedQuote";
  malformed.scoring = null;
  const unmatched = await inspect(d.root, malformed);
  assert.equal(unmatched.status, "incomplete");
  assert.equal(unmatched.candidates["unmatched-source"], 1);
  const forged = structuredClone(unmatched);
  forged.candidateEvidence[0]!.tier = "source-bound-host-claim";
  assert.throws(() => projectReviewProvenance(forged), /derived evidence/);
});
async function client(t: TestContext, root: string, granted = false) {
  const c = new Client({ name: "original-provenance-control", version: "1" });
  t.after(() => c.close());
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        cli,
        "serve",
        "--root",
        root,
        ...(granted ? ["--detailed", "--allow-review-source"] : []),
      ],
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    }),
  );
  return c;
}
test("confidence-provenance privacy acceptance", async (t) => {
  const d = await provenanceFixture(
      t,
      source + "// OriginalConfidenceSourceCanary\n",
      false,
    ),
    input = ".checktrail/provenance.json";
  const marker = path.join(d.root, ".checktrail/would-execute"),
    physical = path.join(d.root, "subject.mjs"),
    text =
      (await readFile(physical, "utf8")) +
      "process.getBuiltinModule('node:fs').writeFileSync(" +
      JSON.stringify(marker) +
      ",'unexpected execution');\n";
  await writeFile(physical, text);
  const context = await createReviewContext(d.root, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.mjs"],
    supportFiles: [],
    topics: [],
  });
  d.input.context = context;
  d.input.assessment.contextDigest = context.contextDigest;
  d.input.candidates[0]!.citations = [
    {
      file: "subject.mjs",
      revision: "current",
      sourceDigest: context.files[0]!.sha256,
      startLine: 1,
      endLine: text.trimEnd().split("\n").length,
      quote: text.trimEnd(),
    },
  ];
  if (d.input.assessment.schemaVersion !== 2)
    throw Error("Revision assessment");
  d.input.assessment.observations[0]!.citations =
    d.input.candidates[0]!.citations;
  for (const b of d.input.scoring!.bindings)
    b.sourceDigest = context.files[0]!.sha256;
  d.input.candidates[0]!.claim += " OriginalConfidenceClaimCanary";
  if (d.input.assessment.schemaVersion !== 2)
    throw Error("Revision assessment");
  d.input.assessment.observations[0]!.claim = d.input.candidates[0]!.claim;
  await writeFile(path.join(d.root, input), JSON.stringify(d.input));
  const report = await inspect(d.root, d.input),
    summary = projectReviewProvenance(report);
  for (const token of [
    "OriginalConfidenceSourceCanary",
    "OriginalConfidenceClaimCanary",
    d.target.id,
    d.root,
  ])
    assert.ok(!JSON.stringify(summary).includes(token), token);
  assert.equal((summary as { sourceIncluded: boolean }).sourceIncluded, false);
  for (const args of [[], ["--detailed"]]) {
    const c = spawnSync(
      process.execPath,
      [cli, "review-provenance", "--root", d.root, "--input", input, ...args],
      {
        encoding: "utf8",
        timeout: 15000,
        env: { PATH: process.env.PATH ?? "" },
      },
    );
    assert.equal(c.status, 0, c.stderr);
    assert.deepEqual(JSON.parse(c.stdout), summary);
  }
  const detailed = spawnSync(
    process.execPath,
    [
      cli,
      "review-provenance",
      "--root",
      d.root,
      "--input",
      input,
      "--detailed",
      "--allow-review-source",
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.deepEqual(JSON.parse(detailed.stdout), report);
  const c = await client(t, d.root),
    r = await c.callTool({ name: "review_provenance", arguments: { input } });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.structuredContent, summary);
  const invalid = await c.callTool({
    name: "review_provenance",
    arguments: { input, allowReviewSource: true, allowExecution: true },
  });
  assert.equal(invalid.isError, true);
  const detailedClient = await client(t, d.root, true),
    full = await detailedClient.callTool({
      name: "review_provenance",
      arguments: { input },
    });
  assert.equal(full.isError, undefined);
  assert.deepEqual(full.structuredContent, report);
  const denied = await c.callTool({
    name: "review_provenance",
    arguments: { input: "../outside.json" },
  });
  assert.equal(denied.isError, true);
  assert.ok(!JSON.stringify(denied).includes(d.root));
  const partialInput = structuredClone(d.input);
  partialInput.scoring = null;
  partialInput.candidates[0]!.citations[0]!.quote =
    "OriginalUnmatchedPhysicalSource";
  if (partialInput.assessment.schemaVersion !== 2)
    throw Error("Revision assessment");
  partialInput.assessment.observations[0]!.citations =
    partialInput.candidates[0]!.citations;
  await writeFile(path.join(d.root, input), JSON.stringify(partialInput));
  const partialReport = await inspect(d.root, partialInput),
    partialSummary = projectReviewProvenance(partialReport);
  assert.equal(partialReport.status, "incomplete");
  const partialCli = spawnSync(
    process.execPath,
    [cli, "review-provenance", "--root", d.root, "--input", input],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(partialCli.status, 2, partialCli.stderr);
  assert.deepEqual(JSON.parse(partialCli.stdout), partialSummary);
  const partialMcp = await c.callTool({
    name: "review_provenance",
    arguments: { input },
  });
  assert.equal(partialMcp.isError, undefined);
  assert.deepEqual(partialMcp.structuredContent, partialSummary);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
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
  "confidence-provenance lifecycle acceptance",
  { timeout: 60000 },
  async (t) => {
    const previous = Object.fromEntries(
      ["TMPDIR", "TMP", "TEMP"].map((n) => [n, process.env[n]]),
    );
    try {
      for (const mode of ["cancel", "timeout", "output"]) {
        const d = await provenanceFixture(t, lifecycleSource, false),
          marker = path.join(d.root, ".checktrail/entered"),
          selected = structuredClone(recipe);
        const temporary = path.join(d.root, ".checktrail/native-scratch");
        await mkdir(temporary);
        for (const name of Object.keys(previous)) process.env[name] = temporary;
        for (const c of selected.cases) c.args = ["grant:read", marker, mode];
        const contents = JSON.stringify(selected),
          controller = new AbortController(),
          pending = runReviewProbe(
            d.root,
            d.input.context,
            d.input.candidates[0],
            {
              trusted: true,
              recipe: { contents, sha256: hash(contents) },
              timeoutMs: mode === "timeout" ? 4000 : 12000,
              maxOutputBytes: mode === "output" ? 128 : 65536,
              signal: controller.signal,
            },
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
          assert.ok(Number.isInteger(ids.pid) && Number.isInteger(ids.child));
          if (mode === "cancel") controller.abort();
          const run = await pending;
          assert.equal(
            run.status,
            mode === "cancel"
              ? "cancelled"
              : mode === "timeout"
                ? "timed-out"
                : "incomplete",
          );
          assert.equal(run.nativeExecution, true);
          assert.equal(run.temporaryArtifacts, "removed");
          if (run.schemaVersion !== 3)
            throw Error("Raw-output native receipt required");
          assert.equal(run.nativeBudget.calls, 1);
          assert.equal(run.counts.notRun, 2);
          assert.equal(run.trials[1]!.execution, null);
          assert.equal(run.trials[2]!.execution, null);
          if (mode === "output")
            assert.equal(run.trials[0]!.execution!.truncated, true);
          const stoppedBy = Date.now() + 5000;
          while ((alive(ids.pid) || alive(ids.child)) && Date.now() < stoppedBy)
            await delay(20);
          assert.equal(alive(ids.pid), false);
          assert.equal(alive(ids.child), false);
          assert.deepEqual(
            await readdir(temporary),
            [],
            "Owned native workspace released",
          );
          d.input.native = [{ candidateId: d.target.id, run }];
          d.input.scoring = null;
          const inspected = await inspect(d.root, d.input);
          assert.equal(inspected.status, "incomplete");
          assert.equal(
            inspected.candidateEvidence[0]!.tier,
            "source-bound-host-claim",
          );
          assert.equal(
            inspected.candidateEvidence[0]!.native.status,
            run.status,
          );
          unknownQuality(inspected);
        } finally {
          controller.abort();
          await pending;
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
    const d = await provenanceFixture(t, source, false),
      controller = new AbortController(),
      pending = inspectReviewProvenance(d.root, JSON.stringify(d.input), {
        signal: controller.signal,
      });
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    await assert.rejects(
      inspectReviewProvenance(d.root, JSON.stringify(d.input), { wallMs: 0 }),
    );
    let clockReads = 0;
    const clock = t.mock.method(performance, "now", () =>
      ++clockReads <= 3 ? 0 : 11,
    );
    try {
      await assert.rejects(
        inspectReviewProvenance(d.root, JSON.stringify(d.input), {
          wallMs: 10,
        }),
        /timed out/,
      );
      assert.ok(
        clockReads >= 4,
        "Deadline rechecked after asynchronous source inspection",
      );
    } finally {
      clock.mock.restore();
    }
  },
);
test(
  "confidence-provenance installed acceptance",
  { timeout: 120000 },
  async () => {
    if (process.env.CHECKTRAIL_CONFIDENCE_PROVENANCE_INSTALLED === "1") {
      assert.ok(
        (
          await realpath(
            fileURLToPath(new URL("../src/index.js", import.meta.url)),
          )
        ).includes("/node_modules/@stsepelin/checktrail/"),
      );
      return;
    }
    const script = fileURLToPath(
        new URL(
          "../../scripts/verify-import-context-package.mjs",
          import.meta.url,
        ),
      ),
      env: NodeJS.ProcessEnv = {
        ...process.env,
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "confidence-provenance",
      };
    // The external acceptance controller starts a fresh test runner, not a recursive node:test run.
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [script], {
      env,
      encoding: "utf8",
      timeout: 115000,
      maxBuffer: 1048576,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.offlineProductionInstall, true);
    assert.equal(result.lifecycleScriptsExecuted, false);
    assert.equal(result.installedCliEvaluated, true);
    assert.equal(result.profile.required, 9);
    assert.equal(result.profile.passed, 9);
    assert.equal(result.profile.complete, true);
    if (process.env.CHECKTRAIL_CONFIDENCE_PROVENANCE_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_CONFIDENCE_PROVENANCE_INSTALL_RECEIPT,
        JSON.stringify(result) + "\n",
      );
  },
);
