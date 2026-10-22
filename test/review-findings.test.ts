import { fixtureGit, syntheticCommit } from "./git-fixture.js";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  inspectReviewFindings,
  projectReviewFindings,
  type ReviewFindingsInput,
} from "../src/review-findings.js";
import { observeFindingParameters } from "../src/review-finding-parameters.js";
import { createReviewContext } from "../src/review.js";
import { runReviewProbe } from "../src/review-probe.js";
import { findingsFixture, findingsHash } from "./review-findings-fixture.js";
import { pin, source } from "./review-workflow-fixture.js";
import { fixture } from "./helpers.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const inspect = (root: string, input: unknown) =>
  inspectReviewFindings(root, JSON.stringify(input));
function flags(r: Awaited<ReturnType<typeof inspectReviewFindings>>) {
  for (const k of [
    "claimsVerified",
    "severityVerified",
    "independenceVerified",
    "commonCauseVerified",
    "repairCorrectnessVerified",
    "nativeExecution",
    "deterministicOutcomeChanged",
  ] as const)
    assert.equal(r[k], false, k);
  assert.equal(r.qualityGate, "not-assessed");
}
async function second(t: TestContext) {
  const d = await findingsFixture(t);
  fixtureGit(d.root, ["init", "--quiet"]);
  const baseCommit = await syntheticCommit(d.root, {
    "subject.mjs": source + "// Original prior comment\n",
  });
  d.context = await createReviewContext(d.root, {
    schemaVersion: 5,
    track: "diff",
    baseCommit,
    currentSource: "working-tree",
    files: ["subject.mjs"],
    supportFiles: [],
    topics: [],
  });
  d.input.provenance.context = d.context;
  d.input.provenance.assessment.contextDigest = d.context.contextDigest;
  const firstRun = await runReviewProbe(d.root, d.context, d.target, {
    trusted: true,
    recipe: pin(),
    timeoutMs: 12000,
  });
  d.input.provenance.native[0]!.run = firstRun;
  d.input.decisions[0]!.contextDigest = d.context.contextDigest;
  d.input.decisions[0]!.nativeRunDigest = findingsHash(firstRun);

  const c = structuredClone(d.input.provenance.candidates[0]!);
  c.id = "OriginalSecondClaim";
  c.claim = "A second declared consequence of the same synthetic predicate.";
  c.attribution = "pre-existing";
  c.fixScope = "follow-up";
  d.input.provenance.candidates.push(c);
  const a = d.input.provenance.assessment;
  if (a.schemaVersion !== 2) throw Error("Revision assessment required");
  a.observations.push({
    id: c.id,
    severity: c.severity,
    claim: c.claim,
    citations: c.citations,
    attribution: c.attribution,
    fixScope: c.fixScope,
  });
  const run = await runReviewProbe(d.root, d.context, c, {
    trusted: true,
    recipe: pin(),
    timeoutMs: 12000,
  });
  d.input.provenance.native.push({ candidateId: c.id, run });
  const declaration = structuredClone(d.input.decisions[0]!);
  declaration.candidateId = c.id;
  declaration.candidateDigest = findingsHash(c);
  declaration.nativeRunDigest = findingsHash(run);
  declaration.adjudication.judgment!.repair!.scope = "follow-up";
  declaration.refutation.sessionId = "OriginalSecondRefuter";
  declaration.adjudication.sessionId = "OriginalSecondAdjudicator";
  d.input.decisions.push(declaration);
  d.input.commonDefects[0]!.candidateIds.push(c.id);
  return d;
}
test("finding resolution retains native disagreement and a reachable declared repair without verifying truth", async (t) => {
  const d = await findingsFixture(t),
    r = await inspect(d.root, d.input);
  assert.equal(r.status, "completed");
  assert.equal(r.candidates["declared-supported"], 1);
  assert.equal(r.findings[0]!.rootFunctionId, d.fn.id);
  assert.deepEqual(r.findings[0]!.gaps, []);
  assert.deepEqual(r.findings[0]!.repairParameters, {
    state: "observed",
    available: ["name"],
    missing: [],
  });
  assert.equal(r.findings[0]!.declaredSeverity, "moderate");
  assert.equal(r.commonDefects.reconciled, 1);
  flags(r);
});
test("finding resolution keeps a satisfied predicate unresolved until a distinct refutation is declared", async (t) => {
  const d = await findingsFixture(
    t,
    "export function decision(name){return name==='grant:read';}\n",
  );
  const r = await inspect(d.root, d.input);
  assert.equal(r.status, "incomplete");
  assert.ok(r.findings[0]!.gaps.includes("native-predicate-not-violated"));
  d.input.decisions[0]!.adjudication.judgment!.disposition = "refuted";
  d.input.decisions[0]!.adjudication.judgment!.repair = null;
  d.input.commonDefects = [];
  const refuted = await inspect(d.root, d.input);
  assert.equal(refuted.status, "completed");
  assert.equal(refuted.candidates["declared-refuted"], 1);
  flags(refuted);
});
test("finding resolution does not promote missing native evidence empty selections or labels", async (t) => {
  const d = await findingsFixture(t, source, false);
  const r = await inspect(d.root, d.input);
  assert.equal(r.status, "incomplete");
  assert.ok(r.findings[0]!.gaps.includes("native-unavailable"));
  const empty = structuredClone(d.input);
  empty.provenance.candidates = [];
  empty.provenance.assessment.observations = [];
  empty.decisions = [];
  empty.commonDefects = [];
  const e = await inspect(d.root, empty);
  assert.equal(e.status, "incomplete");
  assert.equal(e.candidates.selected, 0);
  const historicalSnapshot = structuredClone(d.input);
  historicalSnapshot.provenance.candidates[0]!.attribution = "pre-existing";
  if (historicalSnapshot.provenance.assessment.schemaVersion !== 2)
    throw Error("Revision assessment required");
  historicalSnapshot.provenance.assessment.observations[0]!.attribution =
    "pre-existing";
  await assert.rejects(
    inspect(d.root, historicalSnapshot),
    /Snapshot context cannot support historical attribution/,
  );
  const labels = structuredClone(d.input) as unknown as {
    provenance: { scoring: unknown };
  };
  labels.provenance.scoring = { answer: "OriginalAnswerCanary" };
  await assert.rejects(inspect(d.root, labels));
});
test("finding resolution reconciles the entire candidate context native digest and ordered case cohort", async (t) => {
  const d = await findingsFixture(t);
  for (const mutate of [
    (x: ReviewFindingsInput) => {
      x.decisions[0]!.contextDigest = "0".repeat(64);
    },
    (x: ReviewFindingsInput) => {
      x.decisions[0]!.candidateDigest = "0".repeat(64);
    },
    (x: ReviewFindingsInput) => {
      x.decisions[0]!.nativeRunDigest = "0".repeat(64);
    },
    (x: ReviewFindingsInput) => {
      x.decisions[0]!.nativeCaseIds.pop();
    },
    (x: ReviewFindingsInput) => {
      x.decisions[0]!.nativeCaseIds.reverse();
    },
  ]) {
    const x = structuredClone(d.input);
    mutate(x);
    const r = await inspect(d.root, x);
    assert.equal(r.status, "incomplete");
    assert.ok(r.findings[0]!.gaps.includes("binding-differs"));
  }
  const foreign = structuredClone(d.input);
  foreign.decisions[0]!.candidateId = "ForeignClaim";
  await assert.rejects(inspect(d.root, foreign), /Unique selected decision/);
  const duplicate = structuredClone(d.input);
  duplicate.decisions.push(duplicate.decisions[0]!);
  await assert.rejects(inspect(d.root, duplicate), /Unique selected decision/);
});
test("finding resolution degrades every candidate affected by refuter adjudicator or reviewer session reuse", async (t) => {
  const d = await second(t);
  const valid = await inspect(d.root, d.input);
  assert.equal(valid.candidates["declared-supported"], 2);
  for (const role of ["refutation", "adjudication"] as const) {
    const x = structuredClone(d.input);
    x.decisions[1]![role].sessionId = x.decisions[0]![role].sessionId;
    const r = await inspect(d.root, x);
    assert.equal(r.candidates.unresolved, 2);
    assert.ok(r.findings.every((f) => f.gaps.includes("reused-session")));
  }
  const x = structuredClone(d.input);
  x.decisions[0]!.refutation.sessionId = x.reviewerSessionId;
  const r = await inspect(d.root, x);
  assert.equal(r.candidates.unresolved, 2);
  assert.ok(r.findings.every((f) => f.gaps.includes("reused-session")));
});
test("finding resolution keeps incomplete stages and missing decisions in the selected denominator", async (t) => {
  const d = await findingsFixture(t);
  for (const state of [
    "incomplete",
    "cancelled",
    "budget-exhausted",
  ] as const) {
    const x = structuredClone(d.input);
    x.decisions[0]!.refutation.state = state;
    const r = await inspect(d.root, x);
    assert.equal(r.candidates.selected, 1);
    assert.equal(r.candidates.unresolved, 1);
    assert.ok(r.findings[0]!.gaps.includes("incomplete-stages"));
  }
  const x = structuredClone(d.input);
  x.decisions = [];
  const r = await inspect(d.root, x);
  assert.ok(r.findings[0]!.gaps.includes("missing-decision"));
  assert.equal(r.candidates.unresolved, 1);
  for (const role of ["refutation", "adjudication"] as const) {
    for (const field of ["sessionId", "rationale"] as const) {
      const invalidStage = structuredClone(d.input);
      invalidStage.decisions[0]![role][field] = null;
      await assert.rejects(inspect(d.root, invalidStage), /Completed stages/);
    }
  }
  const absentJudgment = structuredClone(d.input);
  absentJudgment.decisions[0]!.adjudication.judgment = null;
  await assert.rejects(
    inspect(d.root, absentJudgment),
    /Completed adjudication/,
  );
  const invalid = structuredClone(d.input);
  invalid.decisions[0]!.refutation.sessionId = null;
  await assert.rejects(inspect(d.root, invalid), /Completed stages/);
});
test("finding resolution verifies a proposed repair uses only parameters available at its exact captured function", async (t) => {
  const d = await findingsFixture(t);
  d.input.decisions[0]!.adjudication.judgment!.repair!.requiredParameters = [
    "name",
    "callerCeiling",
  ];
  const r = await inspect(d.root, d.input);
  assert.equal(r.candidates.unresolved, 1);
  assert.ok(r.findings[0]!.gaps.includes("repair-parameter-missing"));
  assert.deepEqual(r.findings[0]!.repairParameters.missing, ["callerCeiling"]);
  const x = structuredClone(d.input);
  x.decisions[0]!.adjudication.judgment!.repair!.requiredParameters = ["name"];
  x.decisions[0]!.adjudication.judgment!.repair!.functionId = "0".repeat(64);
  for (const [mutate, gap] of [
    [
      (input: ReviewFindingsInput) => {
        input.decisions[0]!.adjudication.judgment!.functionId = "0".repeat(64);
      },
      "source-address-differs",
    ],
    [
      (input: ReviewFindingsInput) => {
        input.decisions[0]!.adjudication.judgment!.citationIndex = 31;
      },
      "source-address-differs",
    ],
    [
      (input: ReviewFindingsInput) => {
        input.decisions[0]!.adjudication.judgment!.repair = null;
      },
      "repair-missing",
    ],
    [
      (input: ReviewFindingsInput) => {
        input.decisions[0]!.adjudication.judgment!.repair!.scope = "unknown";
      },
      "repair-scope-unknown",
    ],
    [
      (input: ReviewFindingsInput) => {
        input.decisions[0]!.adjudication.judgment!.repair!.citationIndex = 31;
      },
      "repair-address-differs",
    ],
  ] as const) {
    const changed = structuredClone(d.input);
    changed.decisions[0]!.adjudication.judgment!.repair!.requiredParameters = [
      "name",
    ];
    mutate(changed);
    const incomplete = await inspect(d.root, changed);
    assert.equal(incomplete.candidates.unresolved, 1);
    assert.ok(incomplete.findings[0]!.gaps.includes(gap), gap);
  }
  const bad = await inspect(d.root, x);
  assert.ok(bad.findings[0]!.gaps.includes("repair-address-differs"));
  assert.ok(bad.findings[0]!.gaps.includes("repair-parameters-unavailable"));
});
test("finding parameter parsing handles destructuring aliases rest Unicode and excludes nested defaults locals and globals", async (t) => {
  const root = await fixture(t, {
    "params.TS":
      "const globalName=1; export function decision({source: alias, nested:{value}}, [first,...tail], callback=(inner)=>inner, \u03b4=1){const localName=2;function nestedFn(hidden){return hidden}return alias;}\n",
  });
  const context = await createReviewContext(root, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["params.TS"],
    supportFiles: [],
    topics: [],
  });
  if (!("analysis" in context)) throw Error("analysis");
  const fn = context.analysis.functions.find((f) => f.name === "decision")!;
  const observed = (await observeFindingParameters(context, [fn.id])).get(
    fn.id,
  )!;
  assert.equal(observed.state, "observed");
  assert.deepEqual(
    observed.names,
    ["alias", "callback", "first", "tail", "value", "δ"].sort(),
  );
  for (const name of [
    "source",
    "inner",
    "hidden",
    "localName",
    "globalName",
    "nested",
  ])
    assert.ok(!observed.names.includes(name), name);
  const shifted = structuredClone(context);
  if (!("analysis" in shifted)) throw Error("analysis");
  shifted.analysis.functions.find((f) => f.id === fn.id)!.start++;
  assert.equal(
    (await observeFindingParameters(shifted, [fn.id])).get(fn.id)!.state,
    "unavailable",
  );
  const malformed = structuredClone(context);
  malformed.files[0]!.content = "export function decision({";
  assert.equal(
    (await observeFindingParameters(malformed, [fn.id])).get(fn.id)!.state,
    "unavailable",
  );
  let checkpoints = 0;
  await assert.rejects(
    observeFindingParameters(context, [fn.id], () => {
      if (++checkpoints === 3) throw Error("OriginalParserInterruption");
    }),
    /OriginalParserInterruption/,
  );
});
test("finding resolution refuses to choose between identical native function bytes in different captured files", async (t) => {
  const d = await findingsFixture(t);
  await writeFile(path.join(d.root, "copy.mjs"), source);
  const context = await createReviewContext(d.root, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.mjs"],
    supportFiles: ["copy.mjs"],
    topics: [],
  });
  d.input.provenance.context = context;
  d.input.provenance.assessment.contextDigest = context.contextDigest;
  const run = await runReviewProbe(d.root, context, d.target, {
    trusted: true,
    recipe: pin(),
    timeoutMs: 12000,
  });
  d.input.provenance.native = [{ candidateId: d.target.id, run }];
  d.input.decisions[0]!.contextDigest = context.contextDigest;
  d.input.decisions[0]!.nativeRunDigest = findingsHash(run);
  const r = await inspect(d.root, d.input);
  assert.equal(r.candidates.unresolved, 1);
  assert.ok(r.findings[0]!.gaps.includes("ambiguous-native-address"));
  assert.equal(r.findings[0]!.rootFunctionId, null);
});
test("finding resolution derives severity only from complete declared consequence descriptors", async (t) => {
  const d = await findingsFixture(t);
  const j = d.input.decisions[0]!.adjudication.judgment!;
  for (const [category, extent, access, recovery, expected] of [
    ["maintainability", "systemwide", "unprivileged", "irreversible", "low"],
    ["wrong-result", "single", "unprivileged", "reversible", "moderate"],
    ["wrong-result", "single", "unprivileged", "irreversible", "high"],
    ["security-boundary", "single", "privileged", "reversible", "moderate"],
    ["security-boundary", "single", "authenticated", "reversible", "high"],
    ["data-loss", "single", "privileged", "irreversible", "high"],
    ["availability", "systemwide", "privileged", "reversible", "high"],
    ["availability", "single", "privileged", "reversible", "moderate"],
    ["data-loss", "single", "unprivileged", "reversible", "moderate"],
    ["data-loss", "systemwide", "privileged", "reversible", "high"],
    ["wrong-result", "systemwide", "unprivileged", "reversible", "moderate"],
  ] as const) {
    const x = structuredClone(d.input);
    x.decisions[0]!.adjudication.judgment!.consequence = {
      category,
      extent,
      access,
      recovery,
      statement: "Original declared outcome",
    };
    const r = await inspect(d.root, x);
    assert.equal(r.findings[0]!.declaredSeverity, expected);
    assert.equal(r.severityVerified, false);
  }
  for (const key of ["category", "extent", "access", "recovery"] as const) {
    const x = structuredClone(d.input);
    x.decisions[0]!.adjudication.judgment!.consequence![key] = "unknown";
    const r = await inspect(d.root, x);
    assert.equal(r.findings[0]!.declaredSeverity, "unassigned");
    assert.ok(r.findings[0]!.gaps.includes("consequence-unknown"));
  }
  for (const field of [
    "mechanism",
    "reachableCallers",
    "defaultsChecked",
  ] as const) {
    const changed = structuredClone(d.input);
    changed.decisions[0]!.adjudication.judgment![field] = null;
    const incomplete = await inspect(d.root, changed);
    assert.equal(incomplete.candidates.unresolved, 1);
    assert.ok(incomplete.findings[0]!.gaps.includes("incomplete-reasoning"));
  }
  j.mechanism = null;
  const r = await inspect(d.root, d.input);
  assert.ok(r.findings[0]!.gaps.includes("incomplete-reasoning"));
});
test("finding common-defect mappings preserve all attributions and fix scopes and never silently discard invalid groups", async (t) => {
  const d = await second(t);
  const r = await inspect(d.root, d.input);
  assert.equal(r.commonDefects.reconciled, 1);
  assert.equal(r.commonDefects.mappedSupported, 2);
  assert.equal(r.findings.length, 2);
  assert.equal(r.commonCauseVerified, false);
  assert.deepEqual(
    r.input.provenance.candidates.map((c) => c.attribution),
    ["unknown", "pre-existing"],
  );
  assert.deepEqual(
    r.input.provenance.candidates.map((c) => c.fixScope),
    ["unknown", "follow-up"],
  );
  assert.deepEqual(
    r.input.decisions.map((d) => d.adjudication.judgment!.repair!.scope),
    ["this-change", "follow-up"],
  );

  const x = structuredClone(d.input);
  x.commonDefects[0]!.rootFunctionId = "0".repeat(64);
  const bad = await inspect(d.root, x);
  assert.equal(bad.findings.length, 2);
  assert.equal(bad.candidates["declared-supported"], 2);
  assert.equal(bad.commonDefects.unmappedSupported, 2);
  assert.equal(bad.status, "incomplete");
  assert.equal(bad.groups[0]!.reason, "root-function-differs");
  for (const mutate of [
    (y: ReviewFindingsInput) => {
      y.commonDefects[0]!.candidateIds.push(
        y.commonDefects[0]!.candidateIds[0]!,
      );
    },
    (y: ReviewFindingsInput) => {
      y.commonDefects.push(y.commonDefects[0]!);
    },
    (y: ReviewFindingsInput) => {
      y.commonDefects[0]!.candidateIds = ["ForeignClaim"];
    },
  ]) {
    const y = structuredClone(d.input);
    mutate(y);
    await assert.rejects(inspect(d.root, y), /Unique selected common-defect/);
  }
  const unmapped = structuredClone(d.input);
  unmapped.commonDefects = [];
  assert.equal(
    (await inspect(d.root, unmapped)).commonDefects.unmappedSupported,
    2,
  );
});
test("finding resolution reports stale and unmatched source rather than retaining supported conclusions", async (t) => {
  const d = await findingsFixture(t);
  await writeFile(path.join(d.root, "subject.mjs"), source + "// changed\n");
  const stale = await inspect(d.root, d.input);
  assert.equal(stale.status, "stale");
  assert.equal(stale.candidates.unresolved, 1);
  assert.ok(stale.findings[0]!.gaps.includes("stale-source"));
  await writeFile(path.join(d.root, "subject.mjs"), source);
  const x = structuredClone(d.input);
  x.provenance.candidates[0]!.citations[0]!.quote = "OriginalWrongQuote";
  x.provenance.assessment.observations[0]!.citations =
    x.provenance.candidates[0]!.citations;
  x.provenance.native = [];
  x.decisions[0]!.nativeRunDigest = null;
  x.decisions[0]!.nativeCaseIds = [];
  const r = await inspect(d.root, x);
  assert.ok(r.findings[0]!.gaps.includes("unmatched-source"));
  assert.equal(r.candidates.unresolved, 1);
});
test("finding projection rederives every result and refuses forged states severities groups and parameter names", async (t) => {
  const d = await findingsFixture(t),
    r = await inspect(d.root, d.input);
  for (const mutate of [
    (x: typeof r) => {
      x.findings[0]!.state = "declared-refuted";
    },
    (x: typeof r) => {
      x.findings[0]!.declaredSeverity = "high";
    },
    (x: typeof r) => {
      x.findings[0]!.repairParameters.available.push("callerCeiling");
    },
    (x: typeof r) => {
      x.groups[0]!.reason = "root-function-differs";
    },
    (x: typeof r) => {
      x.commonDefects.reconciled = 0;
    },
  ]) {
    const x = structuredClone(r);
    mutate(x);
    await assert.rejects(projectReviewFindings(x), /derived evidence/);
  }
  assert.deepEqual(await projectReviewFindings(r, true), r);
});
async function client(t: TestContext, root: string, granted = false) {
  const c = new Client({ name: "original-findings-control", version: "1" });
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
test("finding CLI and MCP protect source judgments parameter names and execution trust", async (t) => {
  const d = await findingsFixture(
    t,
    source + "// OriginalFindingSourceCanary\n",
  );
  const input = ".checktrail/findings.json";
  await writeFile(path.join(d.root, input), JSON.stringify(d.input));
  const r = await inspect(d.root, d.input),
    summary = await projectReviewFindings(r);
  for (const token of [
    d.root,
    d.target.id,
    d.fn.id,
    "OriginalFindingSourceCanary",
    "OriginalReviewerSession",
    "Original declared",
  ]) {
    assert.ok(!JSON.stringify(summary).includes(token), token);
  }
  for (const args of [[], ["--detailed"]]) {
    const c = spawnSync(
      process.execPath,
      [cli, "review-findings", "--root", d.root, "--input", input, ...args],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(c.status, 0, c.stderr);
    assert.deepEqual(JSON.parse(c.stdout), summary);
  }
  const full = spawnSync(
    process.execPath,
    [
      cli,
      "review-findings",
      "--root",
      d.root,
      "--input",
      input,
      "--detailed",
      "--allow-review-source",
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(JSON.parse(full.stdout), r);
  const c = await client(t, d.root);
  const response = await c.callTool({
    name: "review_findings",
    arguments: { input },
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent, summary);
  const denied = await c.callTool({
    name: "review_findings",
    arguments: { input, allowExecution: true, allowReviewSource: true },
  });
  assert.equal(denied.isError, true);
  const detail = await client(t, d.root, true);
  assert.deepEqual(
    (await detail.callTool({ name: "review_findings", arguments: { input } }))
      .structuredContent,
    r,
  );
  for (const value of ["../outside.json", ".checktrail/missing.json"]) {
    const failure = await c.callTool({
      name: "review_findings",
      arguments: { input: value },
    });
    assert.equal(failure.isError, true);
    assert.ok(!JSON.stringify(failure).includes(d.root));
  }
  const executionFlag = spawnSync(
    process.execPath,
    [
      cli,
      "review-findings",
      "--root",
      d.root,
      "--input",
      input,
      "--trust-project",
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.notEqual(executionFlag.status, 0);
  assert.match(executionFlag.stderr, /does not apply to review-findings/);
  const privateInvalid = JSON.stringify({
    OriginalPrivateInputCanary: "OriginalPrivateValueCanary",
  });
  await writeFile(path.join(d.root, input), privateInvalid);
  const invalid = spawnSync(
    process.execPath,
    [cli, "review-findings", "--root", d.root, "--input", input],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.notEqual(invalid.status, 0);
  assert.ok(!invalid.stderr.includes("OriginalPrivate"));
});
test("finding inspection accepts serialized bounded input and respects cancellation without executing project source", async (t) => {
  const d = await findingsFixture(t, source, false);
  const marker = path.join(d.root, "would-execute");
  const content =
    source +
    "process.getBuiltinModule('node:fs').writeFileSync(" +
    JSON.stringify(marker) +
    ",'bad');\n";
  await writeFile(path.join(d.root, "subject.mjs"), content);
  const context = await createReviewContext(d.root, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.mjs"],
    supportFiles: [],
    topics: [],
  });
  d.input.provenance.context = context;
  d.input.provenance.assessment.contextDigest = context.contextDigest;
  const c = d.input.provenance.candidates[0]!;
  c.citations[0] = {
    file: "subject.mjs",
    revision: "current",
    sourceDigest: context.files[0]!.sha256,
    startLine: 1,
    endLine: content.trimEnd().split("\n").length,
    quote: content.trimEnd(),
  };
  d.input.provenance.assessment.observations[0]!.citations = c.citations;
  d.input.decisions[0]!.contextDigest = context.contextDigest;
  d.input.decisions[0]!.candidateDigest = findingsHash(c);
  const noExecution = await inspect(d.root, d.input);
  assert.equal(noExecution.status, "incomplete");
  assert.equal(noExecution.freshness, "current");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  const late = new AbortController();
  const pending = inspectReviewFindings(d.root, JSON.stringify(d.input), {
    signal: late.signal,
  });
  queueMicrotask(() => late.abort());
  await assert.rejects(pending, /cancelled/);
  let reads = 0;
  const clock = t.mock.method(performance, "now", () =>
    ++reads > 4 ? 1000 : 0,
  );
  try {
    await assert.rejects(
      inspectReviewFindings(d.root, JSON.stringify(d.input), { wallMs: 100 }),
      /timed out/,
    );
  } finally {
    clock.mock.restore();
  }
  const now = performance.now.bind(performance);
  let changedDuringParameters = false;
  const sourceRace = t.mock.method(performance, "now", () => {
    if (
      !changedDuringParameters &&
      new Error().stack?.includes("observeFindingParameters")
    ) {
      changedDuringParameters = true;
      writeFileSync(
        path.join(d.root, "subject.mjs"),
        content + "// OriginalLateSourceChange\n",
      );
    }
    return now();
  });
  try {
    const changed = await inspect(d.root, d.input);
    assert.equal(changedDuringParameters, true);
    assert.equal(changed.status, "stale");
    assert.ok(changed.findings[0]!.gaps.includes("stale-source"));
  } finally {
    sourceRace.mock.restore();
    await writeFile(path.join(d.root, "subject.mjs"), content);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    inspectReviewFindings(d.root, JSON.stringify(d.input), {
      signal: controller.signal,
    }),
    /cancelled/,
  );
  const serialized = JSON.stringify(d.input);
  const exactLimit =
    serialized + " ".repeat(1048576 - Buffer.byteLength(serialized));
  assert.equal(Buffer.byteLength(exactLimit), 1048576);
  assert.equal(
    (await inspectReviewFindings(d.root, exactLimit)).status,
    "incomplete",
  );
  await assert.rejects(
    inspectReviewFindings(d.root, " ".repeat(1048577)),
    /Bounded serialized/,
  );
  const payload = {
    toJSON() {
      throw Error("Must never run");
    },
  };
  await assert.rejects(
    inspectReviewFindings(d.root, payload as unknown as string),
    /Bounded serialized/,
  );
});
test(
  "finding resolution installed cohort uses a fresh offline production package",
  { timeout: 180000 },
  async () => {
    if (process.env.CHECKTRAIL_FINDINGS_INSTALLED === "1") {
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
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "finding-resolution",
    };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env,
      timeout: 175000,
      maxBuffer: 1048576,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.offlineProductionInstall, true);
    assert.equal(packet.lifecycleScriptsExecuted, false);
    assert.equal(packet.profile.required, 16);
    assert.equal(packet.profile.passed, 16);
    assert.equal(packet.profile.complete, true);
    if (process.env.CHECKTRAIL_FINDINGS_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_FINDINGS_INSTALL_RECEIPT,
        JSON.stringify(packet) + "\n",
      );
  },
);
