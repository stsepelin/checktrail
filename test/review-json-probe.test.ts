import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  runReviewProbe,
  parseReviewProbeRun,
  parseReviewProbe,
  projectReviewProbe,
} from "../src/review-probe.js";
import { reviewFamilySchema } from "../src/review-hypotheses.js";
import { projectReviewNativeObservations } from "../src/review-adjudication.js";
import { ReviewWorkflowSession } from "../src/review-workflow-session.js";
import { inspectReviewWorkflowAudit } from "../src/review-workflow-audit.js";
import {
  reviewWorkflowSummarySchema,
  reviewWorkflowAssignmentSchema,
} from "../src/review-workflow-schema.js";
import type {
  ReviewProbeRecipe,
  ReviewProbeRun,
} from "../src/review-probe-schema.js";
import { setup, response } from "./review-workflow-fixture.js";
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const pin = (value: unknown) => {
  const contents = JSON.stringify(value);
  return { contents, sha256: digest(contents) };
};
const recipe = (
  values: [unknown, unknown][],
  family: ReviewProbeRecipe["family"] = "identifiers-allowlists",
  minimumTriggerScale = 1,
): ReviewProbeRecipe =>
  parseReviewProbe(
    pin({
      schemaVersion: 2,
      profile: "node-export-json-v1",
      id: "OriginalJson",
      family,
      file: "subject.mjs",
      exportName: "decision",
      guard: null,
      minimumTriggerScale,
      cases: values.map(([arg, expected], i) => ({
        id: ["Baseline", "Trigger", "NearMiss"][i],
        role: ["baseline", "trigger", "near-miss"][i],
        args: [arg],
        expected,
      })),
    }),
  );
const options = { trusted: true, timeoutMs: 10000 };
const literalExpression = (value: unknown): string =>
  typeof value === "string"
    ? JSON.stringify(value[0]) + ".repeat(" + value.length + ")"
    : Array.isArray(value) && value.length > 16
      ? "Array(" + value.length + ").fill(0)"
      : JSON.stringify(value);
const jsonRun = (run: ReviewProbeRun) => {
  assert.equal(run.schemaVersion, 4);
  if (run.schemaVersion !== 4) throw new Error("Missing JSON physical receipt");
  return run;
};
async function execute(
  t: Parameters<typeof setup>[0],
  source: string,
  spec: ReviewProbeRecipe,
) {
  const { root, context, target } = await setup(t, source);
  target.family = spec.family;
  return {
    root,
    context,
    target,
    run: jsonRun(
      await runReviewProbe(root, context, target, {
        ...options,
        recipe: pin(spec),
      }),
    ),
  };
}

test("structured native probes retain arrays objects null and exact comparative results with physical replay", async (t) => {
  const spec = recipe([
    ["grant:read", { allowed: ["grant:read"], count: 1 }],
    ["grantToken", { allowed: [], count: 0 }],
    ["other", null],
  ]);
  for (const [matcher, behavior] of [
    ["name.startsWith('grant')", "violated"],
    ["name==='grant:read'", "satisfied"],
  ] as const) {
    const source = `export function decision(name){if(name==='other')return null;const allowed=${matcher}?[name]:[];return {count:allowed.length,allowed};}\n`;
    const { run } = await execute(t, source, spec);
    assert.equal(run.status, "completed");
    assert.equal(run.behavior, behavior);
    assert.equal(run.claimsVerified, false);
    assert.equal(run.mechanismVerified, false);
    assert.equal(run.callerReachability, "not-established");
    assert.equal(run.trials[2]!.actual, null);
    assert.equal(run.trials[2]!.functionExecuted, true);
    assert.equal(run.trials[2]!.reason, "json-observed");
    assert.equal(run.trials[2]!.matchesExpectation, true);
    assert.equal(
      run.workerDigest,
      digest(
        await readFile(
          fileURLToPath(
            new URL("../src/review-json-probe-worker.js", import.meta.url),
          ),
        ),
      ),
    );
    for (const trial of run.trials) {
      const out = trial.execution!.artifact.output!;
      const wire = JSON.parse(
        Buffer.from(out.stdout.base64, "base64").toString("utf8"),
      );
      assert.deepEqual(wire.actual, trial.actual);
      assert.equal(wire.profile, spec.profile);
      assert.equal(wire.requestDigest, trial.execution!.artifact.requestDigest);
      assert.equal(wire.sourceDigest, run.sourceDigest);
      assert.equal(out.stderr.bytes, 0);
    }
    const summary = JSON.stringify(projectReviewProbe(run, false));
    assert.equal(summary.includes("allowed"), false);
    assert.equal(summary.includes("base64"), false);
    assert.equal(summary.includes("json-observed"), false);
    const projected = projectReviewNativeObservations(
      spec,
      structuredClone(run),
    );
    assert.deepEqual(projected.cases[1]!.actual, run.trials[1]!.actual);
    assert.equal(JSON.stringify(projected).includes("base64"), false);
    assert.equal(JSON.stringify(projected).includes("violated"), false);
  }
  const shared = await execute(
    t,
    "export function decision(){const value={count:2};return [value,value];}\n",
    recipe([
      [0, [{ count: 2 }, { count: 2 }]],
      [1, [{ count: 2 }, { count: 2 }]],
      [2, [{ count: 2 }, { count: 2 }]],
    ]),
  );
  assert.equal(shared.run.behavior, "satisfied");
  const booleanValues = recipe([
    [0, true],
    [1, false],
    [2, true],
  ]);
  const boolState = await execute(
    t,
    "export function decision(value){return value!==1;}\n",
    booleanValues,
  );
  assert.equal(boolState.run.behavior, "satisfied");
  const wrongProfile = parseReviewProbe(
    pin({
      ...booleanValues,
      schemaVersion: 1,
      profile: "node-export-boolean-v1",
    }),
  );
  assert.throws(
    () => projectReviewNativeObservations(wrongProfile, boolState.run),
    /identities/,
  );
});

test("structured native worker rejects lossy values getters and toJSON while retaining every reached failed attempt", async (t) => {
  const expressions = [
    "undefined",
    "NaN",
    "Infinity",
    "-0",
    "1n",
    "new Date(0)",
    "new Uint8Array([1])",
    "[,1]",
    "[1,,]",
    "Object.assign([1],{extra:2})",
    'Object.defineProperty({},"hidden",{value:1})',
    '({get value(){process.stdout.write("OriginalGetterRan");return 1;}})',
    '({toJSON(){process.stdout.write("OriginalToJsonRan");return {};}})',
    'Object.assign({}, {[Symbol("private")]:1})',
    "(()=>{const value={};value.self=value;return value;})()",
  ];
  const spec = recipe([
    [0, null],
    [1, null],
    [2, null],
  ]);
  for (const expression of expressions) {
    const { run } = await execute(
      t,
      `export function decision(){return ${expression};}\n`,
      spec,
    );
    assert.equal(run.status, "incomplete", expression);
    assert.equal(run.behavior, "unresolved");
    assert.equal(run.counts.observed, 0);
    assert.equal(run.nativeBudget.calls, 3);
    for (const trial of run.trials) {
      assert.equal(trial.functionExecuted, false);
      assert.equal(trial.reason, "runtime-error");
      assert.equal(trial.execution!.artifact.exitCode, 2);
      const physical = Buffer.from(
        trial.execution!.artifact.output!.stdout.base64,
        "base64",
      ).toString("utf8");
      assert.deepEqual(JSON.parse(physical), {
        failure: "probe-runtime-error",
      });
      assert.equal(physical.includes("OriginalGetterRan"), false);
      assert.equal(physical.includes("OriginalToJsonRan"), false);
    }
  }
  const { run } = await execute(
    t,
    "export function decision(){return Object.assign(Object.create(null),{value:0});}\n",
    recipe([
      [0, { value: 0 }],
      [1, { value: 0 }],
      [2, { value: 0 }],
    ]),
  );
  assert.equal(run.behavior, "satisfied");
});

test("structured native values enforce exact physical byte depth and node boundaries before admission and during execution", async (t) => {
  const strings = ["x".repeat(16382), "é".repeat(8191)];
  for (const value of strings) {
    const spec = recipe([
      [0, value],
      [1, value],
      [2, value],
    ]);
    const { run } = await execute(
      t,
      `export function decision(){return ${literalExpression(value)};}\n`,
      spec,
    );
    assert.equal(run.status, "completed");
    assert.equal(run.behavior, "satisfied");
  }
  let exact: unknown = 0;
  for (let i = 0; i < 16; i++) exact = [exact];
  const nodes = Array.from({ length: 1023 }, () => 0);
  for (const value of [exact, nodes]) {
    const spec = recipe([
      [0, value],
      [1, value],
      [2, value],
    ]);
    const { run } = await execute(
      t,
      `export function decision(){return ${literalExpression(value)};}\n`,
      spec,
    );
    assert.equal(run.behavior, "satisfied");
  }
  for (const value of ["x".repeat(16383), [exact], [...nodes, 0]]) {
    assert.throws(
      () =>
        recipe([
          [0, value],
          [1, value],
          [2, value],
        ]),
      /limit/,
    );
    const { run } = await execute(
      t,
      `export function decision(){return ${literalExpression(value)};}\n`,
      recipe([
        [0, null],
        [1, null],
        [2, null],
      ]),
    );
    assert.equal(run.status, "incomplete");
    assert.equal(run.counts.observed, 0);
    assert.equal(run.trials[1]!.execution!.artifact.exitCode, 2);
  }
  const text = JSON.stringify(
    recipe([
      [0, 0],
      [1, 0],
      [2, 0],
    ]),
  ).replace('"expected":0', '"expected":-0');
  assert.throws(
    () => parseReviewProbe({ contents: text, sha256: digest(text) }),
    /lossless/,
  );
  const state = await setup(
    t,
    'export function decision(){process.stdout.write("OriginalUnexpectedExecution");return {};}\n',
  );
  await assert.rejects(
    runReviewProbe(state.root, state.context, state.target, {
      ...options,
      trusted: false,
      recipe: pin(
        recipe([
          [0, {}],
          [1, {}],
          [2, {}],
        ]),
      ),
    }),
    /trust/,
  );
  const aborted = await runReviewProbe(
    state.root,
    state.context,
    state.target,
    {
      ...options,
      signal: AbortSignal.abort(),
      recipe: pin(
        recipe([
          [0, {}],
          [1, {}],
          [2, {}],
        ]),
      ),
    },
  );
  assert.equal(aborted.nativeExecution, false);
  assert.equal(aborted.temporaryArtifacts, "not-created");
  assert.equal(aborted.counts.notRun, 3);
});

test("structured native retained output rejects rehashed value swaps wrong worker profile missing bytes and invented observed null states", async (t) => {
  const spec = recipe([
    [0, { value: 0 }],
    [1, { value: 1 }],
    [2, null],
  ]);
  const { run } = await execute(
    t,
    "export function decision(value){return value===2?null:{value};}\n",
    spec,
  );
  for (const edit of [
    (v: typeof run) => {
      v.trials[0]!.actual = { value: 9 };
    },
    (v: typeof run) => {
      v.trials[0]!.matchesExpectation = false;
    },
    (v: typeof run) => {
      v.trials[2]!.functionExecuted = false;
    },
    (v: typeof run) => {
      v.trials[0]!.execution!.artifact.output = null;
    },
    (v: typeof run) => {
      v.trials[0]!.execution!.artifact.requestDigest = "0".repeat(64);
    },
  ]) {
    const changed = structuredClone(run);
    edit(changed);
    assert.throws(() => parseReviewProbeRun(changed));
  }
  for (const replacement of [
    { profile: "node-export-boolean-v1" },
    { actual: { value: 9 } },
  ]) {
    const changed = structuredClone(run),
      execution = changed.trials[0]!.execution!,
      out = execution.artifact.output!.stdout;
    const wire = JSON.parse(Buffer.from(out.base64, "base64").toString("utf8"));
    Object.assign(wire, replacement);
    const bytes = Buffer.from(JSON.stringify(wire));
    const delta = bytes.length - execution.outputBytes;
    Object.assign(out, {
      base64: bytes.toString("base64"),
      bytes: bytes.length,
      sha256: digest(bytes),
    });
    execution.outputBytes = bytes.length;
    execution.artifact.output!.observedBytes = bytes.length;
    changed.nativeBudget.outputBytes += delta;
    let spent = 0;
    for (const trial of changed.trials) {
      trial.execution!.outputLimitBytes = Math.min(
        changed.nativeBudget.limits.maxCallOutputBytes,
        changed.nativeBudget.limits.maxOutputBytes - spent,
      );
      spent += trial.execution!.outputBytes;
    }
    assert.throws(() => parseReviewProbeRun(changed));
  }
  assert.equal(parseReviewProbeRun(run).schemaVersion, 4);
});

test("structured native probes exercise broken repaired and valid near miss consequences for every declared hypothesis family", async (t) => {
  const cases: {
    family: ReviewProbeRecipe["family"];
    broken: string;
    fixed: string;
    values: [unknown, unknown][];
    scale?: number;
  }[] = [
    {
      family: "authorization-tenancy",
      broken: "return {role:input.role,tenant:input.tenant};",
      fixed:
        "return {role:input.guest?'reader':input.role,tenant:input.tenant};",
      values: [
        [
          { role: "writer", tenant: "t1", guest: false },
          { role: "writer", tenant: "t1" },
        ],
        [
          { role: "admin", tenant: "t1", guest: true },
          { role: "reader", tenant: "t1" },
        ],
        [
          { role: "reader", tenant: "t2", guest: true },
          { role: "reader", tenant: "t2" },
        ],
      ],
    },
    {
      family: "identifiers-allowlists",
      broken:
        "return input.filter(name=>name.toLowerCase().startsWith('grant'));",
      fixed:
        "return input.filter(name=>name.toLowerCase()==='grant'||name.toLowerCase().startsWith('grant:'));",
      values: [
        [["GRANT:read"], ["GRANT:read"]],
        [["grantToken", "grant:read"], ["grant:read"]],
        [["gr-ant", "gran"], []],
      ],
      scale: 2,
    },
    {
      family: "types-numeric-semantics",
      broken: "return {present:true,value:Number(input)};",
      fixed:
        "return input===null?{present:false}:{present:true,value:Number(input)};",
      values: [
        ["12.5", { present: true, value: 12.5 }],
        [null, { present: false }],
        [0, { present: true, value: 0 }],
      ],
    },
    {
      family: "lifecycle-ordering",
      broken:
        "let entity=null;return input.map(value=>{if(value!==null)entity=value;return {entity};});",
      fixed: "return input.map(entity=>({entity}));",
      values: [
        [["alpha"], [{ entity: "alpha" }]],
        [
          ["alpha", null],
          [{ entity: "alpha" }, { entity: null }],
        ],
        [
          ["alpha", "beta"],
          [{ entity: "alpha" }, { entity: "beta" }],
        ],
      ],
      scale: 2,
    },
    {
      family: "assembly-wiring",
      broken:
        "const listeners=['welcome'];for(const p of input)listeners.push(p==='events'?'welcome':p);return listeners;",
      fixed:
        "const listeners=['welcome'];for(const p of input){const listener=p==='events'?'welcome':p;if(!listeners.includes(listener))listeners.push(listener);}return listeners;",
      values: [
        [[], ["welcome"]],
        [["events"], ["welcome"]],
        [["audit"], ["welcome", "audit"]],
      ],
    },
    {
      family: "concurrency-resources",
      broken:
        "return {armed:input.length>1,accepted:input.slice(0,3),capacity:2};",
      fixed:
        "return {armed:input.length>1,accepted:input.slice(0,2),capacity:2};",
      values: [
        [["a"], { armed: false, accepted: ["a"], capacity: 2 }],
        [["a", "b", "c"], { armed: true, accepted: ["a", "b"], capacity: 2 }],
        [["a", "b"], { armed: true, accepted: ["a", "b"], capacity: 2 }],
      ],
      scale: 3,
    },
    {
      family: "atomic-artifacts",
      broken:
        "const fs=process.getBuiltinModule('node:fs');const file=new URL('./generated.txt',import.meta.url);if(input!=='already')fs.writeFileSync(file,'original');return {status:input==='blocked'?'cannot-complete':input==='already'?'already-done':'created',artifact:fs.existsSync(file)};",
      fixed:
        "const fs=process.getBuiltinModule('node:fs');const file=new URL('./generated.txt',import.meta.url);if(input==='ready')fs.writeFileSync(file,'original');return {status:input==='blocked'?'cannot-complete':input==='already'?'already-done':'created',artifact:fs.existsSync(file)};",
      values: [
        ["ready", { status: "created", artifact: true }],
        ["blocked", { status: "cannot-complete", artifact: false }],
        ["already", { status: "already-done", artifact: false }],
      ],
    },
    {
      family: "dependencies-builds",
      broken:
        "return {manager:input==='swap'?'next':'current',core:input==='swap'?'1.1.0':'1.0.0',helper:'1.2.0'};",
      fixed:
        "return {manager:input==='swap'?'next':'current',core:'1.0.0',helper:'1.2.0'};",
      values: [
        ["keep", { manager: "current", core: "1.0.0", helper: "1.2.0" }],
        ["swap", { manager: "next", core: "1.0.0", helper: "1.2.0" }],
        ["refresh", { manager: "current", core: "1.0.0", helper: "1.2.0" }],
      ],
    },
    {
      family: "test-adequacy",
      broken: "return input.filter(file=>file.endsWith('.test.js'));",
      fixed:
        "return input.filter(file=>file.endsWith('.test.js')||file.endsWith('.spec.js'));",
      values: [
        [["one.test.js"], ["one.test.js"]],
        [
          ["one.test.js", "two.spec.js"],
          ["one.test.js", "two.spec.js"],
        ],
        [["one.test.js", "fixture.js"], ["one.test.js"]],
      ],
      scale: 2,
    },
  ];
  assert.deepEqual(
    [...new Set(cases.map((c) => c.family))].sort(),
    [...reviewFamilySchema.options].sort(),
  );
  assert.equal(cases.length, reviewFamilySchema.options.length);
  for (const entry of cases) {
    for (const [body, behavior] of [
      [entry.broken, "violated"],
      [entry.fixed, "satisfied"],
    ] as const) {
      const spec = recipe(entry.values, entry.family, entry.scale ?? 1);
      const { run } = await execute(
        t,
        `export function decision(input){${body}}\n`,
        spec,
      );
      assert.equal(run.status, "completed", entry.family + JSON.stringify(run));
      assert.equal(run.behavior, behavior, entry.family);
      assert.equal(run.counts.controlMismatches, 0, entry.family);
      assert.equal(
        run.counts.triggerMismatches,
        behavior === "violated" ? 1 : 0,
      );
      assert.deepEqual(
        run.trials.map((c) => c.functionExecuted),
        [true, true, true],
      );
      assert.ok(run.trials[1]!.inputScale >= spec.minimumTriggerScale);
    }
  }
});

test("structured native CLI and MCP share actual JSON evidence while summaries and tool arguments cannot grant disclosure or execution", async (t) => {
  const spec = recipe([
      [0, { value: 0 }],
      [1, { value: 1 }],
      [2, null],
    ]),
    { root, target } = await setup(
      t,
      "export function decision(value){return value===2?null:{value};}\n",
    );
  const pinned = pin(spec);
  await writeFile(path.join(root, ".checktrail/recipe.json"), pinned.contents);
  await writeFile(
    path.join(root, ".checktrail/candidate.json"),
    JSON.stringify(target),
  );
  const registration =
      path.join(root, ".checktrail/recipe.json") + "#sha256=" + pinned.sha256,
    binary = fileURLToPath(new URL("../src/cli.js", import.meta.url));
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
  for (const flags of [[], ["--trust-project", "--detailed"]]) {
    const result = spawnSync(process.execPath, [...args, ...flags], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
  }
  const summary = spawnSync(process.execPath, [...args, "--trust-project"], {
    encoding: "utf8",
  });
  assert.equal(summary.status, 0, summary.stderr);
  assert.equal(JSON.parse(summary.stdout).schemaVersion, 4);
  assert.equal(summary.stdout.includes("base64"), false);
  const detailed = spawnSync(
    process.execPath,
    [...args, "--trust-project", "--detailed", "--allow-review-source"],
    { encoding: "utf8" },
  );
  assert.equal(detailed.status, 0, detailed.stderr);
  const cli = jsonRun(parseReviewProbeRun(JSON.parse(detailed.stdout)));
  assert.deepEqual(
    cli.trials.map((c) => c.actual),
    [{ value: 0 }, { value: 1 }, null],
  );
  for (const flags of [
    [],
    ["--allow-execution", "--probe", registration],
    [
      "--allow-execution",
      "--probe",
      registration,
      "--detailed",
      "--allow-review-source",
    ],
  ]) {
    const client = new Client(
      { name: "original-json-probe", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [binary, "serve", "--root", root, ...flags],
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const input = {
        context: ".checktrail/context.json",
        candidate: ".checktrail/candidate.json",
        probeId: spec.id,
      };
      assert.equal(
        (
          await client.callTool({
            name: "review_probe",
            arguments: { ...input, trusted: true },
          })
        ).isError,
        true,
      );
      const result = await client.callTool({
        name: "review_probe",
        arguments: input,
      });
      if (!flags.length) {
        assert.equal(result.isError, true);
        continue;
      }
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const report = result.structuredContent as Record<string, unknown>;
      assert.equal(report.schemaVersion, 4);
      if (flags.includes("--detailed")) {
        const actual = jsonRun(parseReviewProbeRun(report));
        assert.deepEqual(
          actual.trials.map((c) => c.actual),
          cli.trials.map((c) => c.actual),
        );
      } else {
        assert.equal(JSON.stringify(report).includes("base64"), false);
        assert.equal(JSON.stringify(report).includes('"value"'), false);
      }
    } finally {
      await client.close();
    }
  }
});

test("structured native neutral workflow journals retain exact JSON attempts and fresh projections without leaking previous verdicts", async (t) => {
  const spec = recipe([
      [0, { value: 0 }],
      [1, { value: 1 }],
      [2, null],
    ]),
    { root, target } = await setup(
      t,
      "export function decision(value){return value===2?null:{value};}\n",
    );
  const folder = await mkdtemp(
    path.join(tmpdir(), "checktrail-original-json-audit-"),
  );
  t.after(() => rm(folder, { recursive: true, force: true }));
  await chmod(folder, 0o700);
  const file = path.join(folder, "epoch.jsonl");
  const session = new ReviewWorkflowSession(root, {
    allowReviewSource: true,
    trusted: true,
    probes: [pin(spec)],
    audit: { file },
  });
  try {
    const opened = reviewWorkflowSummarySchema.parse(
        await session.command({
          operation: "open",
          context: ".checktrail/context.json",
        }),
      ),
      id = opened.workflowId;
    const reviewer = reviewWorkflowAssignmentSchema.parse(
      await session.command({ operation: "next", workflowId: id }),
    );
    const reviewed = reviewWorkflowSummarySchema.parse(
      await session.command({
        operation: "submit",
        workflowId: id,
        response: response(reviewer, [target]),
      }),
    );
    const refuter = reviewWorkflowAssignmentSchema.parse(
      await session.command({
        operation: "next",
        workflowId: id,
        target: reviewed.candidateHandles[0],
      }),
    );
    assert.equal(refuter.packet.includes(target.id), false);
    assert.equal(
      JSON.parse(refuter.packet).refutationTarget.severity,
      undefined,
    );
    await session.command({
      operation: "submit",
      workflowId: id,
      response: response(refuter),
    });
    const native = reviewWorkflowSummarySchema.parse(
      await session.command({
        operation: "probe",
        workflowId: id,
        probeId: spec.id,
      }),
    );
    assert.equal(native.native.status, "completed");
    assert.equal(native.nextStage, "adjudicator");
    const adjudicator = reviewWorkflowAssignmentSchema.parse(
      await session.command({ operation: "next", workflowId: id }),
    );
    const packet = JSON.parse(adjudicator.packet);
    assert.deepEqual(
      packet.nativeObservations.cases.map((c: { actual: unknown }) => c.actual),
      [{ value: 0 }, { value: 1 }, null],
    );
    assert.equal(adjudicator.packet.includes("base64"), false);
    assert.equal(adjudicator.packet.includes("satisfied"), false);
    assert.equal(packet.unverifiedTarget.severity, undefined);
    const done = reviewWorkflowSummarySchema.parse(
      await session.command({
        operation: "submit",
        workflowId: id,
        response: response(adjudicator),
      }),
    );
    assert.equal(done.disposition, "advisory-stages-completed");
    assert.equal(done.claimsVerified, false);
  } finally {
    session.dispose();
  }
  const audit = inspectReviewWorkflowAudit(file);
  assert.equal(audit.journalStatus, "sealed");
  assert.equal(audit.nativeReceipts.complete, true);
  assert.equal(audit.hostIsolationVerified, false);
  const events = (await readFile(file, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const retained = events.find((e) => e.body.nativeReceipt)!.body.nativeReceipt
    .run;
  assert.equal(retained.schemaVersion, 4);
  assert.deepEqual(retained.trials[1].actual, { value: 1 });
  assert.equal(parseReviewProbeRun(retained).schemaVersion, 4);
});
