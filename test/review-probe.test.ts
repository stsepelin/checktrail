import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
import { rm } from "node:fs/promises";
import { createReviewContext } from "../src/review.js";
import {
  runReviewProbe,
  projectReviewProbe,
  parseReviewProbe,
  parseReviewProbeRun,
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
  for (const [flag, value] of [
    ["--native-max-calls", "2"],
    ["--native-max-output-bytes", "0"],
  ]) {
    const bounded = spawnSync(
      process.execPath,
      [...args, "--trust-project", flag!, value!],
      { encoding: "utf8" },
    );
    assert.equal(bounded.status, 2, bounded.stderr);
    const result = JSON.parse(bounded.stdout);
    assert.equal(result.status, "incomplete");
    assert.equal(
      result.nativeBudget.calls,
      flag === "--native-max-calls" ? 2 : 0,
    );
    assert.equal(result.counts.notRun, flag === "--native-max-calls" ? 1 : 3);
  }
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
  for (const [flag, value] of [
    ["--native-max-calls", "2"],
    ["--native-max-output-bytes", "0"],
  ]) {
    const bounded = await connect([
      "--allow-execution",
      "--probe",
      registration,
      flag!,
      value!,
    ]);
    const result = await bounded.callTool({
      name: "review_probe",
      arguments: input,
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const run = result.structuredContent as Record<string, unknown>;
    assert.equal(run.status, "incomplete");
    assert.equal(
      (run.nativeBudget as Record<string, unknown>).calls,
      flag === "--native-max-calls" ? 2 : 0,
    );
    await bounded.close();
  }
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
    { nativeBudget: { maxCalls: 16, maxOutputBytes: 65536 } },
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
  assert.equal(limited.trials[0]!.reason, "output-limit");
  assert.deepEqual(
    limited.trials.slice(1).map((trial) => trial.status),
    ["not-run", "not-run"],
  );
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

test("native probe run budgets admit exact call and output boundaries without resetting between cases", async (t) => {
  const { root, context, candidate } = await assignment(
    t,
    "export function decision(name){return name==='scope:read';}\n",
  );
  const opts = { ...runOptions, recipe: pin(recipe) };
  const first = await runReviewProbe(root, context, candidate, opts);
  assert.equal(first.schemaVersion, 3);
  if (first.schemaVersion !== 3)
    throw new Error("Missing native budget version");
  assert.equal(first.nativeBudget.calls, 3);
  const outputBytes = first.trials.reduce(
    (n, trial) => n + trial.execution!.outputBytes,
    0,
  );
  assert.equal(first.nativeBudget.outputBytes, outputBytes);
  assert.ok(outputBytes > 0);
  for (const [maxCalls, maxOutputBytes, expected] of [
    [3, outputBytes, "completed"],
    [2, outputBytes, "incomplete"],
    [3, outputBytes - 1, "incomplete"],
  ] as const) {
    const run = await runReviewProbe(root, context, candidate, {
      ...opts,
      nativeBudget: { maxCalls, maxOutputBytes },
    });
    assert.equal(run.status, expected, JSON.stringify(run));
    if (run.schemaVersion !== 3)
      throw new Error("Missing native budget version");
    assert.equal(run.nativeBudget.calls, maxCalls);
    if (maxCalls === 2) {
      assert.equal(run.counts.observed, 2);
      assert.equal(run.counts.notRun, 1);
      assert.equal(run.trials[2]!.reason, "call-limit");
      assert.equal(run.trials[2]!.execution, null);
      assert.equal(run.nativeBudget.stopReason, "call-limit");
    } else if (expected === "incomplete") {
      assert.equal(run.counts.observed, 2);
      assert.equal(run.counts.unresolved, 1);
      assert.equal(
        run.trials[2]!.execution!.outputLimitBytes,
        first.trials[2]!.execution!.outputBytes - 1,
      );
      assert.equal(run.nativeBudget.stopReason, "output-limit");
    } else {
      assert.equal(run.nativeBudget.outputBytes, outputBytes);
      assert.equal(run.nativeBudget.stopReason, "none");
    }
    assert.equal(run.temporaryArtifacts, "removed");
    assert.equal(projectReviewProbe(run, false).sourceIncluded, false);
  }
  // An exact byte ceiling permits the current case; the next one cannot start.
  const exhausted = await runReviewProbe(root, context, candidate, {
    ...opts,
    nativeBudget: {
      maxCalls: 3,
      maxOutputBytes: first.trials[0]!.execution!.outputBytes,
    },
  });
  assert.equal(exhausted.counts.observed, 1);
  assert.equal(exhausted.counts.notRun, 2);
  assert.equal(exhausted.trials[1]!.reason, "output-budget");
  assert.equal(exhausted.behavior, "unresolved");
});

test("native probe zero and invalid run budgets prevent all project execution and temporary case creation", async (t) => {
  const { root, context, candidate } = await assignment(
    t,
    "export function decision(name,target){process.getBuiltinModule('node:fs').appendFileSync(target,'executed\\n');return name==='scope:read';}\n",
  );
  const marker = path.join(root, ".checktrail/native-marker");
  const selected = structuredClone(recipe);
  for (const item of selected.cases) item.args.push(marker);
  const opts = { ...runOptions, recipe: pin(selected) };
  for (const limits of [
    { maxCalls: 0, maxOutputBytes: 65536 },
    { maxCalls: 3, maxOutputBytes: 0 },
  ]) {
    const run = await runReviewProbe(root, context, candidate, {
      ...opts,
      nativeBudget: limits,
    });
    assert.equal(run.status, "incomplete");
    assert.equal(run.nativeExecution, false);
    assert.equal(run.counts.notRun, 3);
    assert.equal(run.temporaryArtifacts, "not-created");
    assert.equal(
      run.trials[0]!.reason,
      limits.maxCalls === 0 ? "call-limit" : "output-budget",
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    parseReviewProbeRun(run);
  }
  for (const limits of [
    { maxCalls: -1, maxOutputBytes: 100 },
    { maxCalls: 17, maxOutputBytes: 100 },
    { maxCalls: 1.5, maxOutputBytes: 100 },
    { maxCalls: 1, maxOutputBytes: -1 },
    { maxCalls: 1, maxOutputBytes: 16777217 },
    { maxCalls: 1, maxOutputBytes: 1.5 },
    { maxCalls: 1, maxOutputBytes: 100, extra: true },
  ])
    await assert.rejects(
      runReviewProbe(root, context, candidate, {
        ...opts,
        nativeBudget: limits,
      }),
    );
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("native probe output overrun counts delivered stdout and stderr and stops every later case", async (t) => {
  const { root, context, candidate } = await assignment(
    t,
    "export function decision(name,target){process.getBuiltinModule('node:fs').appendFileSync(target,'executed\\n');process.stdout.write('x'.repeat(4096));process.stderr.write('y'.repeat(4096));return true;}\n",
  );
  const marker = path.join(root, ".checktrail/native-marker");
  const selected = structuredClone(recipe);
  for (const item of selected.cases) item.args.push(marker);
  const run = await runReviewProbe(root, context, candidate, {
    ...runOptions,
    maxOutputBytes: 100,
    recipe: pin(selected),
    nativeBudget: { maxCalls: 3, maxOutputBytes: 20000 },
  });
  if (run.schemaVersion !== 3) throw new Error("Missing native budget version");
  assert.equal(run.status, "incomplete");
  assert.equal(run.nativeBudget.calls, 1);
  assert.ok(run.nativeBudget.outputBytes >= 4096);
  assert.equal(
    run.nativeBudget.outputBytes,
    run.trials[0]!.execution!.outputBytes,
  );
  assert.equal(run.nativeBudget.outputByteCeilingGuaranteed, false);
  assert.equal(run.nativeBudget.stopReason, "output-limit");
  assert.equal(run.trials[0]!.execution!.truncated, true);
  assert.equal(run.trials[0]!.execution!.outputLimitBytes, 100);
  assert.equal(run.counts.notRun, 2);
  assert.equal(await readFile(marker, "utf8"), "executed\n");
  assert.equal(run.temporaryArtifacts, "removed");
  parseReviewProbeRun(run);
});

test("retained native probe budgets reject erased accounting forged totals reordered calls and unfunded observations", async (t) => {
  const { root, context, candidate } = await assignment(
    t,
    "export function decision(name){return name==='scope:read';}\n",
  );
  const run = await runReviewProbe(root, context, candidate, {
    ...runOptions,
    recipe: pin(recipe),
  });
  if (run.schemaVersion !== 3) throw new Error("Missing native budget version");
  type Run = typeof run;
  for (const edit of [
    (v: Run) => {
      Reflect.deleteProperty(v, "nativeBudget");
    },
    (v: Run) => {
      Reflect.deleteProperty(v.trials[0]!, "execution");
    },
    (v: Run) => {
      v.nativeBudget.calls--;
    },
    (v: Run) => {
      v.nativeBudget.outputBytes++;
    },
    (v: Run) => {
      v.nativeBudget.limits.maxCalls = 2;
    },
    (v: Run) => {
      v.nativeBudget.limits.maxOutputBytes = 1;
    },
    (v: Run) => {
      v.trials[1]!.execution!.call = 1;
    },
    (v: Run) => {
      v.trials[1]!.execution!.outputLimitBytes--;
    },
    (v: Run) => {
      v.trials[1]!.execution!.truncated = true;
    },
    (v: Run) => {
      v.trials[1]!.execution = null;
    },
    (v: Run) => {
      v.nativeBudget.stopReason = "call-limit";
    },
  ]) {
    const changed = structuredClone(run);
    edit(changed);
    assert.throws(() => parseReviewProbeRun(changed));
  }
  const budgetLegacy: Record<string, unknown> = structuredClone(run);
  budgetLegacy.schemaVersion = 2;
  for (const t of budgetLegacy.trials as {
    execution: Record<string, unknown> | null;
  }[])
    if (t.execution) delete t.execution.artifact;
  assert.equal(parseReviewProbeRun(budgetLegacy).schemaVersion, 2);
  const legacy: Record<string, unknown> = structuredClone(run);
  legacy.schemaVersion = 1;
  delete legacy.nativeBudget;
  for (const trial of legacy.trials as Record<string, unknown>[])
    delete trial.execution;
  assert.equal(parseReviewProbeRun(legacy).schemaVersion, 1);
  assert.equal(
    projectReviewProbe(parseReviewProbeRun(legacy), false).nativeBudget,
    undefined,
  );
});

test("native run budgets retain partial cancelled bytes and spend one wall allowance across fresh cases", async (t) => {
  const waiting = await assignment(
    t,
    "export async function decision(name,target){process.stdout.write('é');process.stderr.write('😀');const fs=process.getBuiltinModule('node:fs');fs.writeFileSync(target+'.prepared','ready');fs.renameSync(target+'.prepared',target);await new Promise(()=>{setInterval(()=>{},1000)});return true;}\n",
  );
  const marker = path.join(waiting.root, ".checktrail/native-ready");
  const selected = structuredClone(recipe);
  for (const item of selected.cases) item.args.push(marker);
  const controller = new AbortController();
  const pending = runReviewProbe(
    waiting.root,
    waiting.context,
    waiting.candidate,
    { ...runOptions, recipe: pin(selected), signal: controller.signal },
  );
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        assert.equal(await readFile(marker, "utf8"), "ready");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        assert.ok(
          Date.now() < deadline,
          "Original native fixture did not start",
        );
        await delay(10);
      }
    }
    controller.abort();
    const run = await pending;
    assert.equal(run.status, "cancelled");
    if (run.schemaVersion !== 3)
      throw new Error("Missing native budget version");
    assert.equal(run.nativeBudget.calls, 1);
    assert.equal(run.nativeBudget.outputBytes, 6);
    assert.equal(run.trials[0]!.execution!.outputBytes, 6);
    assert.equal(run.counts.notRun, 2);
    assert.equal(run.temporaryArtifacts, "removed");
    parseReviewProbeRun(run);
  } finally {
    controller.abort();
    await pending;
  }
  const slow = await assignment(
    t,
    "export async function decision(name){await new Promise(resolve=>setTimeout(resolve,400));return name==='scope:read';}\n",
  );
  const opts = {
    ...runOptions,
    recipe: pin(recipe),
    nativeBudget: { maxCalls: 3, maxOutputBytes: 65536 },
  };
  const timed = await runReviewProbe(slow.root, slow.context, slow.candidate, {
    ...opts,
    timeoutMs: 1000,
  });
  assert.equal(timed.status, "timed-out");
  assert.ok(timed.counts.observed < 3);
  assert.equal(timed.temporaryArtifacts, "removed");
  parseReviewProbeRun(timed);
  // A cancelled/expired invocation cannot debit an independent new run.
  const fresh = await runReviewProbe(
    slow.root,
    slow.context,
    slow.candidate,
    opts,
  );
  assert.equal(fresh.status, "completed", JSON.stringify(fresh));
  if (fresh.schemaVersion !== 3)
    throw new Error("Missing native budget version");
  assert.equal(fresh.nativeBudget.calls, 3);
});

test("native cleanup failures retain spent budgets and stop later cases without losing reached observations", async (t) => {
  const { root, context, candidate } = await assignment(
    t,
    "export function decision(name){return name==='scope:read';}\n",
  );
  const fs = process.getBuiltinModule(
    "node:fs/promises",
  ) as typeof import("node:fs/promises");
  const original = fs.rm;
  for (const [failCase, maxOutputBytes] of [
    [true, 65536],
    [false, 65536],
    [true, 1],
  ] as const) {
    let failures = 0;
    let parent: string | undefined;
    const injected: typeof original = async (target, options) => {
      if (typeof target === "string") {
        const caseDirectory =
          path.basename(target) === "case-0" &&
          path.basename(path.dirname(target)).startsWith("checktrail-probe-");
        const parentDirectory = path
          .basename(target)
          .startsWith("checktrail-probe-");
        if ((failCase ? caseDirectory : parentDirectory) && failures === 0) {
          parent = failCase ? path.dirname(target) : target;
          failures++;
          throw Object.assign(new Error("Original synthetic cleanup failure"), {
            code: "EACCES",
          });
        }
      }
      return original(target, options);
    };
    assert.equal(Reflect.set(fs, "rm", injected), true);
    syncBuiltinESMExports();
    try {
      const run = await runReviewProbe(root, context, candidate, {
        ...runOptions,
        recipe: pin(recipe),
        maxOutputBytes,
        nativeBudget: { maxCalls: failCase ? 1 : 3, maxOutputBytes: 65536 },
      });
      assert.equal(failures, 1);
      assert.equal(run.status, "incomplete");
      assert.equal(run.behavior, "unresolved");
      assert.equal(
        run.temporaryArtifacts,
        failCase ? "removed" : "cleanup-failed",
      );
      if (run.schemaVersion !== 3)
        throw new Error("Missing native budget version");
      assert.equal(run.nativeBudget.calls, failCase ? 1 : 3);
      assert.equal(run.counts.unresolved, failCase ? 1 : 0);
      assert.equal(run.counts.observed, failCase ? 0 : 3);
      assert.equal(run.counts.notRun, failCase ? 2 : 0);
      if (failCase) assert.equal(run.trials[0]!.reason, "cleanup-failed");
      assert.ok(run.nativeBudget.outputBytes > 0);
      parseReviewProbeRun(run);
    } finally {
      Reflect.set(fs, "rm", original);
      syncBuiltinESMExports();
      if (parent) await rm(parent, { recursive: true, force: true });
    }
  }
});

test("native probe preparation that spends the wall allowance cannot start a project process", async (t) => {
  const { root, context, candidate } = await assignment(
    t,
    "export function decision(name,target){process.getBuiltinModule('node:fs').appendFileSync(target,'executed\\n');return name==='scope:read';}\n",
  );
  const selected = structuredClone(recipe);
  const marker = path.join(root, ".checktrail/native-marker");
  for (const item of selected.cases) item.args.push(marker);
  const fs = process.getBuiltinModule(
    "node:fs/promises",
  ) as typeof import("node:fs/promises");
  const original = fs.writeFile;
  let delayed = 0;
  const injected: typeof original = async (target, data, options) => {
    await original(target, data, options);
    if (
      typeof target === "string" &&
      path.basename(target) === "request.json" &&
      path.basename(path.dirname(target)) === "case-0" &&
      path
        .basename(path.dirname(path.dirname(target)))
        .startsWith("checktrail-probe-")
    ) {
      delayed++;
      await delay(1200);
    }
  };
  Reflect.set(fs, "writeFile", injected);
  syncBuiltinESMExports();
  try {
    const run = await runReviewProbe(root, context, candidate, {
      ...runOptions,
      timeoutMs: 1000,
      recipe: pin(selected),
    });
    assert.equal(
      delayed,
      1,
      "Fixture must reach case preparation before exhausting the allowance",
    );
    assert.equal(run.status, "timed-out");
    assert.equal(run.nativeExecution, false);
    assert.equal(run.counts.notRun, 3);
    assert.equal(run.trials[0]!.reason, "timeout");
    assert.equal(run.temporaryArtifacts, "removed");
    if (run.schemaVersion !== 3)
      throw new Error("Missing native budget version");
    assert.equal(run.nativeBudget.calls, 0);
    assert.equal(run.nativeBudget.outputBytes, 0);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    parseReviewProbeRun(run);
  } finally {
    Reflect.set(fs, "writeFile", original);
    syncBuiltinESMExports();
  }
});

test("native probe version 3 retains every reached physical attempt replays observations and withholds raw output from summaries", async (t) => {
  const { root, context, candidate } = await assignment(
    t,
    "export function decision(name){return name.startsWith('scope');}\n",
  );
  const run = await runReviewProbe(root, context, candidate, {
    ...runOptions,
    recipe: pin(recipe),
  });
  assert.equal(run.schemaVersion, 3);
  if (run.schemaVersion !== 3)
    throw new Error("Missing retained native attempt version");
  assert.equal(run.status, "completed");
  assert.equal(run.trials.length, 3);
  for (const trial of run.trials) {
    const execution = trial.execution!;
    assert.equal(execution.artifact.exitCode, 0);
    assert.equal(execution.artifact.output!.completeForObservedStreams, true);
    const wire = JSON.parse(
      Buffer.from(execution.artifact.output!.stdout.base64, "base64").toString(
        "utf8",
      ),
    );
    assert.equal(wire.actual, trial.actual);
    assert.deepEqual(wire.ranges, trial.ranges);
    assert.equal(wire.sourceDigest, run.sourceDigest);
    assert.equal(wire.requestDigest, execution.artifact.requestDigest);
    assert.equal(
      execution.artifact.output!.observedBytes,
      execution.outputBytes,
    );
  }
  const summary = projectReviewProbe(run, false);
  assert.equal(JSON.stringify(summary).includes("base64"), false);
  assert.equal(JSON.stringify(summary).includes("artifact"), false);
  for (const edit of [
    (v: typeof run) => {
      v.trials[0]!.execution!.artifact.exitCode = 1;
    },
    (v: typeof run) => {
      v.trials[0]!.execution!.artifact.output = null;
    },
    (v: typeof run) => {
      v.trials[0]!.execution!.artifact.requestDigest = "0".repeat(64);
    },
    (v: typeof run) => {
      v.trials[0]!.execution!.artifact.output!.completeForObservedStreams = false;
    },
  ]) {
    const changed = structuredClone(run);
    edit(changed);
    assert.throws(() => parseReviewProbeRun(changed));
  }
  const changed = structuredClone(run),
    out = changed.trials[0]!.execution!.artifact.output!.stdout;
  const altered = JSON.parse(
    Buffer.from(out.base64, "base64").toString("utf8"),
  );
  altered.actual = !altered.actual;
  const buffer = Buffer.from(JSON.stringify(altered));
  out.base64 = buffer.toString("base64");
  out.bytes = buffer.length;
  out.sha256 = createHash("sha256").update(buffer).digest("hex");
  const execution = changed.trials[0]!.execution!;
  const delta = buffer.length - execution.outputBytes;
  execution.outputBytes = buffer.length;
  execution.artifact.output!.observedBytes = buffer.length;
  changed.nativeBudget.outputBytes += delta;
  let spent = 0;
  for (const trial of changed.trials) {
    if (trial.execution) {
      trial.execution.outputLimitBytes = Math.min(
        changed.nativeBudget.limits.maxCallOutputBytes,
        changed.nativeBudget.limits.maxOutputBytes - spent,
      );
      spent += trial.execution.outputBytes;
    }
  }
  assert.equal(spent, changed.nativeBudget.outputBytes);
  assert.throws(() => parseReviewProbeRun(changed), /parsed observation/);
});
test("native probe retains malformed binary stdout stderr and output overruns without crediting a claim", async (t) => {
  for (const source of [
    "export function decision(){process.stdout.write(Buffer.from([255,0]));return true;}\n",
    "export function decision(){process.stderr.write(Buffer.from([255,0]));return true;}\n",
  ]) {
    const { root, context, candidate } = await assignment(t, source);
    const run = await runReviewProbe(root, context, candidate, {
      ...runOptions,
      recipe: pin(recipe),
    });
    assert.equal(run.schemaVersion, 3);
    if (run.schemaVersion !== 3) throw new Error("Missing native artifacts");
    assert.equal(run.status, "incomplete");
    assert.equal(run.counts.observed, 0);
    for (const trial of run.trials) {
      assert.ok(trial.execution!.artifact.output);
      assert.equal(
        trial.execution!.artifact.output!.completeForObservedStreams,
        true,
      );
    }
    const first = run.trials[0]!.execution!.artifact.output!;
    const stream = source.includes("stderr") ? first.stderr : first.stdout;
    assert.deepEqual(
      Buffer.from(stream.base64, "base64").subarray(0, 2),
      Buffer.from([255, 0]),
    );
    parseReviewProbeRun(run);
  }
  const { root, context, candidate } = await assignment(
    t,
    "export function decision(){process.stdout.write('x'.repeat(8192));return true;}\n",
  );
  const run = await runReviewProbe(root, context, candidate, {
    ...runOptions,
    recipe: pin(recipe),
    maxOutputBytes: 1,
    nativeBudget: { maxCalls: 3, maxOutputBytes: 65536 },
  });
  assert.equal(run.schemaVersion, 3);
  if (run.schemaVersion !== 3) throw new Error("Missing native artifacts");
  assert.equal(run.counts.notRun, 2);
  assert.equal(run.trials[0]!.execution!.artifact.output!.stdout.bytes, 1);
  assert.equal(
    run.trials[0]!.execution!.artifact.output!.completeForObservedStreams,
    false,
  );
  assert.equal(run.trials[1]!.execution, null);
  assert.equal(run.status, "incomplete");
  parseReviewProbeRun(run);
});

test("native probe cancellation retains the reached attempt and never creates evidence for later cases", async (t) => {
  const { root, context, candidate } = await assignment(
    t,
    "export function decision(target){process.getBuiltinModule('node:fs').writeFileSync(target,'original entered');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return true;}\n",
  );
  const marker = path.join(root, ".checktrail/entered"),
    selected = structuredClone(recipe);
  for (const item of selected.cases) item.args = [marker];
  const controller = new AbortController();
  const pending = runReviewProbe(root, context, candidate, {
    ...runOptions,
    recipe: pin(selected),
    signal: controller.signal,
  });
  try {
    let entered = false;
    for (let i = 0; i < 200; i++) {
      try {
        // Another process can observe the file between creation and its write.
        if ((await readFile(marker, "utf8")) === "original entered") {
          entered = true;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(10);
    }
    assert.equal(
      entered,
      true,
      "The source body must start before cancellation",
    );
    controller.abort();
    const run = await pending;
    assert.equal(run.schemaVersion, 3);
    if (run.schemaVersion !== 3) throw new Error("Missing native artifacts");
    assert.equal(run.status, "cancelled");
    assert.equal(run.counts.observed, 0);
    assert.equal(run.counts.notRun, 2);
    assert.equal(run.nativeBudget.calls, 1);
    assert.equal(run.trials[0]!.execution!.artifact.cancelled, true);
    assert.ok(run.trials[0]!.execution!.artifact.output);
    assert.equal(run.trials[1]!.execution, null);
    assert.equal(run.trials[2]!.execution, null);
    parseReviewProbeRun(run);
  } finally {
    controller.abort();
    await pending;
  }
});
