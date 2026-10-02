import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { test } from "node:test";
import { createReviewContext } from "../src/review.js";
import {
  runReviewProbe,
  projectReviewProbe,
  parseReviewProbe,
  type PinnedReviewProbe,
} from "../src/review-probe.js";
import type { ReviewProbeRecipe } from "../src/review-probe-schema.js";
import type { ReviewCandidate } from "../src/review-provider-schema.js";
import { fixture } from "./helpers.js";
const pin = (recipe: unknown): PinnedReviewProbe => {
  const contents = JSON.stringify(recipe);
  return {
    contents,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
};
async function assignment(
  t: Parameters<typeof fixture>[0],
  source: string,
  family: ReviewCandidate["family"] = "identifiers-allowlists",
) {
  const root = await fixture(t, {
    "subject.mjs": source,
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.mjs"],
    supportFiles: [],
    topics: [],
  });
  const file = context.files[0]!;
  const candidate: ReviewCandidate = {
    id: "original-synthetic-claim",
    family,
    severity: "concern",
    claim:
      "The declared triggering input violates the operator's expected Boolean decision.",
    trigger: "Apply the operator-pinned trigger case.",
    consequence: "The decision differs from the declared contract.",
    evidenceGaps: ["Production caller and policy remain unverified."],
    attribution: "unknown",
    fixScope: "unknown",
    citations: [
      {
        file: file.path,
        revision: "current",
        sourceDigest: file.sha256,
        startLine: 1,
        endLine: 1,
        quote: source.split("\n")[0]!,
      },
    ],
  };
  return { root, context, candidate };
}
const recipe: ReviewProbeRecipe = {
  schemaVersion: 1,
  profile: "node-export-boolean-v1",
  id: "OriginalBoundary",
  family: "identifiers-allowlists",
  file: "subject.mjs",
  exportName: "decision",
  minimumTriggerScale: 1,
  guard: null,
  cases: [
    { id: "Baseline", role: "baseline", args: ["scope:read"], expected: true },
    { id: "Trigger", role: "trigger", args: ["scopeToken"], expected: false },
    { id: "NearMiss", role: "near-miss", args: ["unrelated"], expected: false },
  ],
};
const runOptions = { trusted: true, timeoutMs: 10_000 };

test("native source-bound probes distinguish broken fixed and near-miss Boolean behavior with executed current functions", async (t) => {
  const variants = [
    [
      "export function decision(name){return name.startsWith('scope');}\n",
      "violated",
    ],
    [
      "export function decision(name){return name==='scope' || name.startsWith('scope:');}\n",
      "satisfied",
    ],
    [
      "export function decision(name){return ['scope:read','scope:write'].includes(name);}\n",
      "satisfied",
    ],
  ] as const;
  for (const [source, behavior] of variants) {
    const { root, context, candidate } = await assignment(t, source);
    const run = await runReviewProbe(root, context, candidate, {
      ...runOptions,
      recipe: pin(recipe),
    });
    assert.equal(run.status, "completed", JSON.stringify(run));
    assert.equal(run.behavior, behavior);
    assert.equal(run.nativeExecution, true);
    assert.equal(
      run.workerDigest,
      createHash("sha256")
        .update(
          await readFile(
            fileURLToPath(
              new URL("../src/review-probe-worker.js", import.meta.url),
            ),
          ),
        )
        .digest("hex"),
    );
    assert.equal(run.executionSandboxed, false);
    assert.equal(run.claimsVerified, false);
    assert.equal(run.mechanismVerified, false);
    assert.equal(run.fixVerified, false);
    assert.equal(run.callerReachability, "not-established");
    assert.equal(run.requirementProvenance, "operator-pinned-expectations");
    assert.equal(run.counts.observed, 3);
    assert.equal(run.counts.controlMismatches, 0);
    assert.equal(run.counts.triggerMismatches, behavior === "violated" ? 1 : 0);
    assert.equal(run.temporaryArtifacts, "removed");
    for (const trial of run.trials) {
      assert.equal(trial.functionExecuted, true);
      assert.ok(trial.ranges[0]!.count > 0);
      assert.equal(trial.guardCoverage, "not-requested");
    }
    const summary = projectReviewProbe(run, false);
    for (const hidden of [
      root,
      "subject.mjs",
      "scopeToken",
      "Trigger",
      "Production caller",
      source.trim(),
    ])
      assert.ok(
        !JSON.stringify(summary).includes(JSON.stringify(hidden)),
        hidden,
      );
    assert.deepEqual(projectReviewProbe(run, true), run);
  }
});

test("native probe requirements stay unresolved when controls fail a function throws or the return type is not Boolean", async (t) => {
  for (const [source, reason, controlMismatches] of [
    ["export function decision(){return true;}\n", "boolean-observed", 1],
    [
      "export function decision(){throw new Error('synthetic error with confidential prose');}\n",
      "runtime-error",
      0,
    ],
    ["export function decision(){return 'true';}\n", "runtime-error", 0],
  ] as const) {
    const { root, context, candidate } = await assignment(t, source);
    const run = await runReviewProbe(root, context, candidate, {
      ...runOptions,
      recipe: pin(recipe),
    });
    assert.equal(run.behavior, "unresolved");
    assert.equal(run.counts.controlMismatches, controlMismatches);
    assert.ok(run.trials.every((trial) => trial.reason === reason));
    assert.ok(!JSON.stringify(run).includes("confidential prose"));
    assert.equal(run.temporaryArtifacts, "removed");
  }
});

test("native scale guards require measured branch coverage and cannot count an inert N=1 trigger as exercised", async (t) => {
  const source =
    "export function decision(items){if(items.length>1){return false;}return true;}\n";
  const { root, context, candidate } = await assignment(
    t,
    source,
    "concurrency-resources",
  );
  const scaled: ReviewProbeRecipe = {
    ...recipe,
    family: "concurrency-resources",
    minimumTriggerScale: 2,
    cases: [
      { id: "Baseline", role: "baseline", args: [[]], expected: true },
      { id: "Trigger", role: "trigger", args: [[1, 2]], expected: true },
      { id: "NearMiss", role: "near-miss", args: [[1]], expected: true },
    ],
  };
  const measured = await runReviewProbe(root, context, candidate, {
    ...runOptions,
    recipe: pin(scaled),
  });
  assert.equal(measured.behavior, "violated", JSON.stringify(measured));
  const branch = measured.trials[0]!.ranges.find(
    (range) =>
      range.count === 0 &&
      !measured.trials[1]!.ranges.some(
        (other) =>
          other.start === range.start &&
          other.end === range.end &&
          other.count === 0,
      ),
  );
  assert.ok(branch, "native control and trigger must differ in a real branch");
  scaled.guard = { start: branch.start, end: branch.end };
  let run = await runReviewProbe(root, context, candidate, {
    ...runOptions,
    recipe: pin(scaled),
  });
  assert.equal(run.status, "completed");
  assert.equal(run.behavior, "violated");
  assert.equal(run.trials[1]!.guardCoverage, "executed");
  assert.equal(run.trials[0]!.guardCoverage, "not-executed");
  scaled.cases[1]!.args = [[1]];
  run = await runReviewProbe(root, context, candidate, {
    ...runOptions,
    recipe: pin(scaled),
  });
  assert.equal(run.status, "incomplete");
  assert.equal(run.behavior, "unresolved");
  assert.equal(run.trials[1]!.reason, "scale-not-met");
  assert.equal(run.trials[1]!.inputScale, 1);
  scaled.minimumTriggerScale = 1;
  run = await runReviewProbe(root, context, candidate, {
    ...runOptions,
    recipe: pin(scaled),
  });
  assert.equal(run.behavior, "unresolved");
  assert.equal(run.trials[1]!.reason, "guard-not-covered");
  assert.equal(run.trials[1]!.functionExecuted, true);
  assert.equal(run.trials[1]!.guardCoverage, "not-executed");
});

test("native probe grants pins family addresses current-source digests and exact quotations fail before project execution", async (t) => {
  const { root, context, candidate } = await assignment(
    t,
    "export function decision(name){return name==='scope:read';}\n",
  );
  await assert.rejects(
    runReviewProbe(root, context, candidate, {
      ...runOptions,
      trusted: false,
      recipe: pin(recipe),
    }),
    /operator/,
  );
  await assert.rejects(
    runReviewProbe(root, context, candidate, {
      ...runOptions,
      recipe: { ...pin(recipe), sha256: "0".repeat(64) },
    }),
    /integrity/,
  );
  for (const edited of [
    { ...recipe, family: "authorization-tenancy" },
    { ...recipe, file: "../subject.mjs" },
    { ...recipe, exportName: "missing" },
    { ...recipe, guard: { start: 0, end: 9999 } },
  ])
    await assert.rejects(
      runReviewProbe(root, context, candidate, {
        ...runOptions,
        recipe: pin(edited),
      }),
    );
  for (const edit of [
    (claim: ReviewCandidate) => {
      claim.citations[0]!.quote = "fabricated quote";
    },
    (claim: ReviewCandidate) => {
      claim.citations[0]!.sourceDigest = "0".repeat(64);
    },
    (claim: ReviewCandidate) => {
      claim.citations[0]!.revision = "base";
    },
  ]) {
    const changed = structuredClone(candidate);
    edit(changed);
    await assert.rejects(
      runReviewProbe(root, context, changed, {
        ...runOptions,
        recipe: pin(recipe),
      }),
    );
  }
  const badControls = structuredClone(recipe);
  badControls.cases[2]!.role = "baseline";
  assert.throws(() => parseReviewProbe(pin(badControls)), /controls/);
  const duplicate = structuredClone(recipe);
  duplicate.cases[2]!.id = "Trigger";
  assert.throws(() => parseReviewProbe(pin(duplicate)), /distinct/);
  await writeFile(path.join(root, "subject.mjs"), "changed source\n");
  const stale = await runReviewProbe(root, context, candidate, {
    ...runOptions,
    recipe: pin(recipe),
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.behavior, "unresolved");
  assert.equal(stale.nativeExecution, false);
  assert.equal(stale.temporaryArtifacts, "not-created");
});

test("native probes reset module state and source bytes per case and preserve unsupported cancelled timeout and cleanup states", async (t) => {
  const ownedTemporary = await fixture(t, {});
  const previousTemporary = Object.fromEntries(
    ["TMPDIR", "TEMP", "TMP"].map((name) => [name, process.env[name]]),
  );
  t.after(() => {
    for (const [name, value] of Object.entries(previousTemporary)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of ["TMPDIR", "TEMP", "TMP"])
    process.env[name] = ownedTemporary;
  const prefix = async () =>
    new Set(
      (await readdir(ownedTemporary)).filter((name) =>
        name.startsWith("checktrail-probe-"),
      ),
    );
  const before = await prefix();
  const state = await assignment(
    t,
    "let calls=0;export function decision(name){calls++;return calls===1 && name==='scope:read';}\n",
  );
  let run = await runReviewProbe(state.root, state.context, state.candidate, {
    ...runOptions,
    recipe: pin(recipe),
  });
  assert.equal(run.behavior, "satisfied");
  assert.equal(run.counts.controlMismatches, 0);
  const controller = new AbortController();
  controller.abort();
  run = await runReviewProbe(state.root, state.context, state.candidate, {
    ...runOptions,
    recipe: pin(recipe),
    signal: controller.signal,
  });
  assert.equal(run.status, "cancelled");
  assert.equal(run.nativeExecution, false);
  assert.equal(run.temporaryArtifacts, "not-created");
  const slow = await assignment(
    t,
    "export async function decision(){await new Promise(resolve=>setTimeout(resolve,10000));return true;}\n",
  );
  for (const cancel of [true, false]) {
    const signal = new AbortController();
    if (cancel) setTimeout(() => signal.abort(), 100);
    run = await runReviewProbe(slow.root, slow.context, slow.candidate, {
      ...runOptions,
      timeoutMs: cancel ? 3000 : 100,
      recipe: pin(recipe),
      signal: signal.signal,
    });
    assert.equal(run.status, cancel ? "cancelled" : "timed-out");
    assert.equal(run.behavior, "unresolved");
    assert.equal(run.temporaryArtifacts, "removed");
  }
  const ts = await fixture(t, {
    "subject.ts": "export function decision(name:string){return true;}\n",
  });
  const context = await createReviewContext(ts, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.ts"],
    supportFiles: [],
    topics: [],
  });
  const claim = structuredClone(state.candidate);
  claim.citations[0] = {
    ...claim.citations[0]!,
    file: "subject.ts",
    sourceDigest: context.files[0]!.sha256,
    quote: context.files[0]!.content.trim(),
  };
  run = await runReviewProbe(ts, context, claim, {
    ...runOptions,
    recipe: pin({ ...recipe, file: "subject.ts" }),
  });
  assert.equal(run.status, "unsupported");
  assert.equal(run.nativeExecution, false);
  assert.equal(run.behavior, "unresolved");
  assert.deepEqual(
    await prefix(),
    before,
    "owned temporary probe directories must be removed",
  );
});

test("native probes give every case fresh source bytes even when a prior case rewrites its temporary module", async (t) => {
  const source =
    "export function decision(name){process.getBuiltinModule('node:fs').writeFileSync(new URL(import.meta.url), 'export function decision(){return true;}');return name==='scope:read';}\n";
  const { root, context, candidate } = await assignment(t, source);
  const run = await runReviewProbe(root, context, candidate, {
    ...runOptions,
    recipe: pin(recipe),
  });
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal(run.behavior, "satisfied");
  assert.equal(run.freshness, "current");
  assert.equal(run.counts.controlMismatches, 0);
  assert.equal(
    (await createReviewContext(root, context.selection)).contextDigest,
    context.contextDigest,
  );
  for (const edit of [
    (report: typeof run) => {
      report.behavior = "violated";
    },
    (report: typeof run) => {
      report.counts.controlMismatches = 1;
    },
    (report: typeof run) => {
      report.trials[0]!.actual = false;
    },
    (report: typeof run) => {
      report.temporaryArtifacts = "cleanup-failed";
    },
    (report: typeof run) => {
      report.nativeExecution = false;
    },
    (report: typeof run) => {
      report.trials[0]!.ranges[0]!.count = 0;
    },
    (report: typeof run) => {
      report.minimumTriggerScale = 2;
    },
    (report: typeof run) => {
      report.guard = {
        start: report.functionRange.start,
        end: report.functionRange.end,
      };
    },
  ]) {
    const bad = structuredClone(run);
    edit(bad);
    assert.throws(() => projectReviewProbe(bad, false));
  }
});

test("CLI and MCP native probes share evidence while execution trust and recipe registration stay operator controlled", async (t) => {
  const { root, context, candidate } = await assignment(
    t,
    "export function decision(name){return name.startsWith('scope');}\n",
  );
  const pinned = pin(recipe);
  await writeFile(
    path.join(root, ".checktrail/context.json"),
    JSON.stringify(context),
  );
  await writeFile(
    path.join(root, ".checktrail/candidate.json"),
    JSON.stringify(candidate),
  );
  await writeFile(path.join(root, ".checktrail/probe.json"), pinned.contents);
  const registration =
    path.join(root, ".checktrail/probe.json") + "#sha256=" + pinned.sha256;
  const binary = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const args = [
    binary,
    "review-probe",
    "--root",
    root,
    "--context",
    ".checktrail/context.json",
    "--input",
    ".checktrail/candidate.json",
    "--probe",
    registration,
  ];
  const denied = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(denied.status, 2);
  assert.ok(!denied.stdout);
  const cli = spawnSync(process.execPath, [...args, "--trust-project"], {
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
  const deniedDetail = spawnSync(
    process.execPath,
    [...args, "--trust-project", "--detailed"],
    { encoding: "utf8" },
  );
  assert.equal(deniedDetail.status, 2);
  assert.ok(!deniedDetail.stdout);
  const detailed = spawnSync(
    process.execPath,
    [...args, "--trust-project", "--detailed", "--allow-review-source"],
    { encoding: "utf8" },
  );
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.equal(JSON.parse(detailed.stdout).trials.length, 3);
  const cliRun = JSON.parse(cli.stdout);
  assert.equal(cliRun.behavior, "violated");
  assert.equal(cliRun.claimsVerified, false);
  const connect = async (flags: string[]) => {
    const client = new Client(
      { name: "synthetic-native-probe", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [binary, "serve", "--root", root, ...flags],
      stderr: "pipe",
    });
    t.after(() => client.close());
    await client.connect(transport);
    return client;
  };
  const input = {
    context: ".checktrail/context.json",
    candidate: ".checktrail/candidate.json",
    probeId: recipe.id,
  };
  for (const flags of [[], ["--probe", registration], ["--allow-execution"]]) {
    const client = await connect(flags);
    assert.equal(
      (await client.callTool({ name: "review_probe", arguments: input }))
        .isError,
      true,
    );
  }
  const client = await connect(["--allow-execution", "--probe", registration]);
  const result = await client.callTool({
    name: "review_probe",
    arguments: input,
  });
  assert.equal(result.isError, undefined);
  const mcpRun = result.structuredContent as Record<string, unknown>;
  for (const key of Object.keys(cliRun))
    assert.deepEqual(mcpRun[key], cliRun[key], key);
  for (const hidden of [
    root,
    "subject.mjs",
    "scopeToken",
    "Trigger",
    "original-synthetic-claim",
  ])
    assert.ok(!JSON.stringify(result).includes(JSON.stringify(hidden)), hidden);
  const withoutSource = await connect([
    "--allow-execution",
    "--probe",
    registration,
    "--detailed",
  ]);
  const withoutSourceResult = await withoutSource.callTool({
    name: "review_probe",
    arguments: input,
  });
  assert.equal(
    withoutSourceResult.isError,
    undefined,
    JSON.stringify(withoutSourceResult),
  );
  assert.equal(
    (withoutSourceResult.structuredContent as Record<string, unknown>)
      .sourceIncluded,
    false,
  );
  assert.equal(
    (withoutSourceResult.structuredContent as Record<string, unknown>).trials,
    undefined,
  );
  const withSource = await connect([
    "--allow-execution",
    "--probe",
    registration,
    "--detailed",
    "--allow-review-source",
  ]);
  const withSourceResult = await withSource.callTool({
    name: "review_probe",
    arguments: input,
  });
  assert.equal(
    withSourceResult.isError,
    undefined,
    JSON.stringify(withSourceResult),
  );
  assert.equal(
    (
      (withSourceResult.structuredContent as Record<string, unknown>)
        .trials as unknown[]
    ).length,
    3,
  );
  for (const extra of [
    { trusted: true },
    { recipe: pinned },
    { allowExecution: true },
    { timeoutMs: 120000 },
  ]) {
    assert.equal(
      (
        await client.callTool({
          name: "review_probe",
          arguments: { ...input, ...extra },
        })
      ).isError,
      true,
    );
  }
  assert.equal(
    (
      await client.callTool({
        name: "review_probe",
        arguments: { ...input, probeId: "unregistered" },
      })
    ).isError,
    true,
  );
});

test("native probe compiled-source identity rejects altered debugger evidence and bounded runtime output remains unresolved", async (t) => {
  const source =
    "const NativeSession=process.getBuiltinModule('node:inspector/promises').Session;const nativePost=NativeSession.prototype.post;NativeSession.prototype.post=async function(method,...args){const result=await Reflect.apply(nativePost,this,[method,...args]);return method==='Debugger.getScriptSource'?{...result,scriptSource:result.scriptSource+'/* changed */'}:result;};export function decision(name){return name==='scope:read';}\n";
  const bound = await assignment(t, source);
  const malformed = await runReviewProbe(
    bound.root,
    bound.context,
    bound.candidate,
    { ...runOptions, recipe: pin(recipe) },
  );
  assert.equal(malformed.status, "incomplete", JSON.stringify(malformed));
  assert.equal(malformed.behavior, "unresolved");
  assert.equal(malformed.counts.observed, 0);
  assert.ok(
    malformed.trials.every((trial) => trial.reason === "malformed-evidence"),
  );
  const output = await assignment(
    t,
    "export function decision(name){process.stdout.write('x'.repeat(10000));return name==='scope:read';}\n",
  );
  const limited = await runReviewProbe(
    output.root,
    output.context,
    output.candidate,
    { ...runOptions, maxOutputBytes: 100, recipe: pin(recipe) },
  );
  assert.equal(limited.behavior, "unresolved");
  assert.equal(limited.counts.observed, 0);
  assert.ok(limited.trials.every((trial) => trial.reason === "output-limit"));
  assert.equal(limited.temporaryArtifacts, "removed");
});

test("native probe source changes during execution stay stale despite complete observed controls", async (t) => {
  const source =
    "export function decision(name,target){if(name==='scope:read')process.getBuiltinModule('node:fs').writeFileSync(target,'changed source\\n');return name==='scope:read';}\n";
  const { root, context, candidate } = await assignment(t, source);
  const changed = structuredClone(recipe);
  for (const item of changed.cases)
    item.args.push(path.join(root, "subject.mjs"));
  const run = await runReviewProbe(root, context, candidate, {
    ...runOptions,
    recipe: pin(changed),
  });
  assert.equal(run.nativeExecution, true);
  assert.equal(run.counts.observed, 3, JSON.stringify(run));
  assert.equal(run.freshness, "stale");
  assert.equal(run.status, "stale");
  assert.equal(run.behavior, "unresolved");
  assert.equal(run.temporaryArtifacts, "removed");
  assert.equal(projectReviewProbe(run, false).behavior, "unresolved");
});
