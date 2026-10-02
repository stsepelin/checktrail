import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createReviewContext } from "../src/review.js";
import {
  runReviewVerification,
  parseReviewVerification,
  projectReviewVerification,
  type ReviewVerificationOptions,
} from "../src/review-verification.js";
import type {
  ReviewCandidate,
  ReviewProviderConfig,
} from "../src/review-provider-schema.js";
import type { ReviewProbeRecipe } from "../src/review-probe-schema.js";
import { fixture } from "./helpers.js";
const hash = (input: unknown): string =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
const pin = (input: unknown) => {
  const contents = JSON.stringify(input);
  return {
    contents,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
};
const config: ReviewProviderConfig = {
  schemaVersion: 1,
  kind: "openai-responses",
  model: "exact-original-adjudicator",
  credentialEnv: "ORIGINAL_VERIFICATION_TEST_KEY",
  pricing: null,
  limits: {
    wallMs: 10000,
    maxAttempts: 1,
    retryDelayMs: 0,
    maxRequestBytes: 1048576,
    maxResponseBytes: 131072,
    maxOutputTokens: 4096,
  },
};
const recipe: ReviewProbeRecipe = {
  schemaVersion: 1,
  profile: "node-export-boolean-v1",
  id: "OriginalVerification",
  family: "identifiers-allowlists",
  file: "subject.mjs",
  exportName: "decision",
  minimumTriggerScale: 1,
  guard: null,
  cases: [
    {
      id: "OriginalBaseline",
      role: "baseline",
      args: ["scope:read"],
      expected: true,
    },
    {
      id: "OriginalTrigger",
      role: "trigger",
      args: ["scopeToken"],
      expected: false,
    },
    {
      id: "OriginalNearMiss",
      role: "near-miss",
      args: ["unrelated"],
      expected: false,
    },
  ],
};
const broken =
  "export function decision(name){return name.startsWith('scope');}\n";
async function assignment(t: Parameters<typeof fixture>[0], source = broken) {
  const root = await fixture(t, {
    "subject.mjs": source,
    "unassigned.mjs": "// original reserved sibling/future fix\n",
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
  const target: ReviewCandidate = {
    id: "withheld-original-candidate-label",
    family: "identifiers-allowlists",
    severity: "concern",
    claim:
      "The triggering identifier grants production administrator permissions.",
    trigger: "Pass scopeToken.",
    consequence: "A production administrator session is created.",
    evidenceGaps: ["Production policy, caller and consequence unknown."],
    attribution: "unknown",
    fixScope: "this-change",
    citations: [
      {
        file: "subject.mjs",
        revision: "current",
        sourceDigest: context.files[0]!.sha256,
        startLine: 1,
        endLine: 1,
        quote: source.trim(),
      },
    ],
  };
  return { root, context, target };
}
function envelope(
  kind: ReviewProviderConfig["kind"],
  candidates: ReviewCandidate[] = [],
) {
  const text = JSON.stringify({
    files: [
      {
        path: "subject.mjs",
        disposition: "reviewed",
        note: "Original independent synthetic assignment",
      },
    ],
    candidates,
  });
  return kind === "openai-responses"
    ? {
        model: config.model,
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 20 },
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text }],
          },
        ],
      }
    : {
        type: "message",
        role: "assistant",
        model: config.model,
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [{ type: "text", text }],
      };
}
const options = (
  fetch: typeof globalThis.fetch,
  kind: ReviewProviderConfig["kind"] = "openai-responses",
): ReviewVerificationOptions => ({
  trusted: true,
  recipe: pin(recipe),
  wallMs: 10000,
  provider: {
    config: { ...structuredClone(config), kind },
    allowInference: true,
    allowSourceDisclosure: true,
    environment: {
      ORIGINAL_VERIFICATION_TEST_KEY: "opaque-original-verification-key",
    },
    fetch,
  },
});
function packet(request: Record<string, unknown>): Record<string, unknown> {
  const messages = (request.input ?? request.messages) as {
    content: { text: string }[];
  }[];
  return JSON.parse(messages[0]!.content[0]!.text);
}

test("verification uses fresh blind refutation and raw-evidence adjudication without promoting native mismatches into production claims", async (t) => {
  for (const kind of ["openai-responses", "anthropic-messages"] as const) {
    const { root, context, target } = await assignment(t);
    const requests: Record<string, unknown>[] = [];
    const counterclaim = {
      ...target,
      id: "withheld-counterclaim-label",
      severity: "suggestion" as const,
      claim: "Production callers are absent from the assignment.",
      trigger: "Inspect captured callers.",
      consequence: "Production impact cannot be established.",
    };
    const run = await runReviewVerification(
      root,
      context,
      target,
      options(async (_url, init) => {
        requests.push(JSON.parse(String(init!.body)));
        return Response.json(
          envelope(kind, requests.length === 1 ? [counterclaim] : []),
        );
      }, kind),
    );
    assert.equal(requests.length, 2);
    assert.equal(run.status, "completed");
    assert.equal(run.evidenceTier, "native-expectation-mismatch");
    assert.equal(run.probe!.counts.triggerMismatches, 1);
    assert.equal(run.probe!.counts.controlMismatches, 0);
    assert.equal(run.probe!.temporaryArtifacts, "removed");
    assert.equal(run.resolution, "unresolved");
    assert.equal(run.claimsVerified, false);
    assert.equal(run.severity, "unassigned");
    assert.equal(run.consequence, "not-established");
    assert.notEqual(run.refutation.verifier.runId, run.adjudication!.runId);
    assert.notEqual(
      run.refutation.verifier.attempts[0]!.id,
      run.adjudication!.attempts[0]!.id,
    );
    const first = packet(requests[0]!);
    const second = packet(requests[1]!);
    assert.ok("refutationTarget" in first);
    assert.ok(!("nativeObservations" in first));
    assert.ok(!JSON.stringify(first).includes(counterclaim.id));
    assert.ok("nativeObservations" in second);
    assert.ok(!("refutationTarget" in second));
    for (const request of requests) {
      assert.deepEqual(request.tools, []);
      assert.ok(!("previous_response_id" in request));
      assert.ok(!("conversation" in request));
      const encoded = JSON.stringify(packet(request));
      for (const hidden of [
        target.id,
        counterclaim.id,
        "opaque-original-verification-key",
        "reserved sibling/future fix",
        "severity",
        "matchesExpectation",
        "requestedModel",
        "runId",
      ])
        assert.ok(!encoded.includes(hidden), hidden);
    }
    for (const hypothesis of [
      first.refutationTarget,
      second.unverifiedTarget,
      ...(second.unverifiedCounterclaims as unknown[]),
    ]) {
      assert.deepEqual(Object.keys(hypothesis as object), [
        "family",
        "claim",
        "trigger",
        "consequence",
        "evidenceGaps",
        "citations",
      ]);
    }
    assert.ok(!("resolution" in second));
    assert.ok(!("behavior" in (second.nativeObservations as object)));
    const observations = second.nativeObservations as {
      cases: {
        role: string;
        args: unknown[];
        expected: boolean;
        actual: boolean;
      }[];
    };
    assert.deepEqual(
      observations.cases.map((item) => ({
        role: item.role,
        args: item.args,
        expected: item.expected,
        actual: item.actual,
      })),
      [
        {
          role: "baseline",
          args: ["scope:read"],
          expected: true,
          actual: true,
        },
        {
          role: "trigger",
          args: ["scopeToken"],
          expected: false,
          actual: true,
        },
        {
          role: "near-miss",
          args: ["unrelated"],
          expected: false,
          actual: false,
        },
      ],
    );
    assert.ok(
      String(requests[1]!.instructions ?? requests[1]!.system).includes(
        "Independently adjudicate",
      ),
    );
    assert.equal(run.adjudication!.candidates.length, 0);
    assert.deepEqual(parseReviewVerification(run), run);
  }
});

test("verification preserves agreeing controls and failed controls without claiming refutation or adjudicating incomplete native evidence", async (t) => {
  for (const [source, tier, calls, status] of [
    [
      "export function decision(name){return name==='scope' || name.startsWith('scope:');}\n",
      "native-controls-observed",
      2,
      "completed",
    ],
    [
      "export function decision(){return true;}\n",
      "no-current-native-evidence",
      1,
      "incomplete",
    ],
    [
      "export function decision(){return 'true';}\n",
      "no-current-native-evidence",
      1,
      "incomplete",
    ],
  ] as const) {
    const { root, context, target } = await assignment(t, source);
    let observedCalls = 0;
    const run = await runReviewVerification(
      root,
      context,
      target,
      options(async () => {
        observedCalls++;
        return Response.json(envelope(config.kind));
      }),
    );
    assert.equal(observedCalls, calls);
    assert.equal(run.status, status);
    assert.equal(run.evidenceTier, tier);
    assert.equal(run.resolution, "unresolved");
    if (calls === 1) {
      assert.equal(run.adjudication, null);
      assert.equal(run.stopReason, "probe-incomplete");
    }
    assert.equal(run.probe!.temporaryArtifacts, "removed");
  }
});

test("verification validates all operator grants recipe bindings quotations and argument scale before disclosure or native execution", async (t) => {
  const { root, context, target } = await assignment(t);
  let calls = 0;
  const opts = options(async () => {
    calls++;
    return Response.json(envelope(config.kind));
  });
  for (const changed of [
    { ...opts, trusted: false },
    { ...opts, provider: { ...opts.provider, allowInference: false } },
    { ...opts, provider: { ...opts.provider, allowSourceDisclosure: false } },
    { ...opts, wallMs: 0 },
    { ...opts, recipe: { ...opts.recipe, sha256: "0".repeat(64) } },
    { ...opts, recipe: pin({ ...recipe, family: "scale-guards" }) },
    { ...opts, recipe: pin({ ...recipe, exportName: "missing" }) },
  ])
    await assert.rejects(runReviewVerification(root, context, target, changed));
  await assert.rejects(
    runReviewVerification(
      root,
      context,
      {
        ...target,
        citations: [
          { ...target.citations[0], quote: "forged original quotation" },
        ],
      },
      opts,
    ),
  );
  let nested: unknown = "leaf";
  for (let index = 0; index < 19; index++) nested = [nested];
  await assert.rejects(
    runReviewVerification(root, context, target, {
      ...opts,
      recipe: pin({
        ...recipe,
        cases: recipe.cases.map((item) => ({ ...item, args: [nested] })),
      }),
    }),
    /depth/,
  );
  assert.equal(calls, 0);
});

test("verification retains refused capacity malformed and unfunded refutation attempts without running project code", async (t) => {
  for (const terminal of [
    "refusal",
    "capacity",
    "malformed",
    "budget",
  ] as const) {
    const marker = path.join(await fixture(t, {}), "native-marker");
    const source = `import {writeFileSync} from 'node:fs';export function decision(name){writeFileSync(${JSON.stringify(marker)},'ran');return name.startsWith('scope');}\n`;
    const { root, context, target } = await assignment(t, source);
    let calls = 0;
    const opts = options(async () => {
      calls++;
      if (terminal === "capacity") return new Response("{}", { status: 503 });
      if (terminal === "malformed")
        return Response.json({ model: config.model, status: "completed" });
      const response = envelope(config.kind);
      if ("output" in response)
        response.output[0]!.content = [
          { type: "refusal", text: "Original synthetic refusal" },
        ];
      return Response.json(response);
    });
    if (terminal === "budget")
      opts.provider.config.limits.admissionBudget = {
        inputTokenAllowance: 100,
        maxTotalTokens: 0,
        maxEstimatedCostMicrousd: null,
      };
    const run = await runReviewVerification(root, context, target, opts);
    assert.equal(run.status, "incomplete");
    assert.equal(run.stopReason, "refutation-incomplete");
    assert.equal(run.probe, null);
    assert.equal(run.adjudication, null);
    assert.equal(calls, terminal === "budget" ? 0 : 1);
    assert.equal(
      run.refutation.verifier.attempts.length,
      terminal === "budget" ? 0 : 1,
    );
    await assert.rejects(access(marker));
  }
});

test("verification source changes during adjudication invalidate native corroboration and stop fresh capacity retries", async (t) => {
  for (const terminal of ["completed", "capacity"] as const) {
    const { root, context, target } = await assignment(t);
    let calls = 0;
    const opts = options(async () => {
      calls++;
      if (calls === 2) {
        await writeFile(
          path.join(root, "subject.mjs"),
          "changed original source\n",
        );
        if (terminal === "capacity") return new Response("{}", { status: 503 });
      }
      return Response.json(envelope(config.kind));
    });
    opts.provider.config.limits.maxAttempts = 2;
    const run = await runReviewVerification(root, context, target, opts);
    assert.equal(calls, 2);
    assert.equal(run.status, "stale");
    assert.equal(run.freshness, "stale");
    assert.equal(run.evidenceTier, "no-current-native-evidence");
    assert.equal(run.probe!.behavior, "violated");
    assert.equal(run.adjudication!.attempts.length, 1);
    assert.equal(run.adjudication!.freshness, "stale");
  }
});

test("verification cancellation wall budgets and late provider failures retain every reached stage and stop further disclosure", async (t) => {
  for (const phase of [
    "before",
    "refuter",
    "adjudicator",
    "timeout",
    "capacity",
  ] as const) {
    const { root, context, target } = await assignment(t);
    let calls = 0;
    const controller = new AbortController();
    if (phase === "before") controller.abort();
    const opts = options(async (_url, init) => {
      calls++;
      if (phase === "refuter") controller.abort();
      if (calls === 2 && phase === "adjudicator") controller.abort();
      if (calls === 2 && phase === "capacity")
        return new Response("{}", { status: 503 });
      if (phase === "timeout")
        await new Promise<void>((resolve) => {
          init!.signal!.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      return Response.json(envelope(config.kind));
    });
    opts.signal = controller.signal;
    if (phase === "timeout") opts.wallMs = 1000;
    const run = await runReviewVerification(root, context, target, opts);
    assert.equal(
      calls,
      phase === "before"
        ? 0
        : phase === "refuter" || phase === "timeout"
          ? 1
          : 2,
    );
    assert.equal(
      run.status,
      phase === "timeout"
        ? "timed-out"
        : phase === "capacity"
          ? "incomplete"
          : "cancelled",
    );
    assert.equal(
      run.stopReason,
      phase === "capacity" ? "adjudication-incomplete" : run.status,
    );
    assert.equal(
      run.probe === null,
      phase === "before" || phase === "refuter" || phase === "timeout",
    );
    if (run.probe) assert.equal(run.probe.temporaryArtifacts, "removed");
    assert.equal(run.resolution, "unresolved");
  }
});

test("verification retained packets reject detached recipe expectations function sources stage identities and manufactured completion", async (t) => {
  const { root, context, target } = await assignment(t);
  const run = await runReviewVerification(
    root,
    context,
    target,
    options(async () => Response.json(envelope(config.kind))),
  );
  const changes = [
    (copy: typeof run) => {
      copy.target.claim = "different claim";
      copy.targetDigest = hash(copy.target);
    },
    (copy: typeof run) => {
      copy.probe!.trials[0]!.expected = false;
      copy.probeDigest = hash(copy.probe);
    },
    (copy: typeof run) => {
      copy.probe!.functionRange.end++;
      copy.probeDigest = hash(copy.probe);
    },
    (copy: typeof run) => {
      copy.probe!.sourceDigest = "0".repeat(64);
      copy.probeDigest = hash(copy.probe);
    },
    (copy: typeof run) => {
      copy.adjudication!.packetDigest = "0".repeat(64);
      copy.adjudicationDigest = hash(copy.adjudication);
    },
    (copy: typeof run) => {
      copy.adjudication!.runId = copy.refutation.verifier.runId;
      copy.adjudicationDigest = hash(copy.adjudication);
    },
    (copy: typeof run) => {
      copy.adjudication!.attempts[0]!.id =
        copy.refutation.verifier.attempts[0]!.id;
      copy.adjudicationDigest = hash(copy.adjudication);
    },
    (copy: typeof run) => {
      copy.evidenceTier = "native-controls-observed";
    },
    (copy: typeof run) => {
      copy.adjudication = null;
      copy.adjudicationDigest = null;
    },
    (copy: typeof run) => {
      copy.recipe = pin({
        ...recipe,
        cases: recipe.cases.map((item) => ({ ...item, args: ["different"] })),
      });
      copy.recipeDigest = copy.recipe.sha256;
    },
  ];
  for (const change of changes) {
    const copy = structuredClone(run);
    change(copy);
    assert.throws(() => parseReviewVerification(copy));
  }
  const summary = projectReviewVerification(run, true, false);
  for (const hidden of [
    root,
    target.id,
    target.claim,
    target.citations[0]!.quote,
    "subject.mjs",
    "scopeToken",
    "OriginalTrigger",
    recipe.id,
  ])
    assert.ok(!JSON.stringify(summary).includes(hidden), hidden);
  assert.equal(summary.sourceIncluded, false);
  assert.deepEqual(projectReviewVerification(run, true, true), run);
});

test("verification freezes caller supplied recipe config and source inputs across independent stages", async (t) => {
  const { root, context, target } = await assignment(t);
  let calls = 0;
  const opts = options(async () => {
    calls++;
    if (calls === 1) {
      opts.recipe.contents = "{}";
      opts.recipe.sha256 = "0".repeat(64);
      opts.provider.config.model = "mutated model";
      target.claim = "mutated target";
      context.files[0]!.content = "mutated source";
    }
    return Response.json(envelope(config.kind));
  });
  const run = await runReviewVerification(root, context, target, opts);
  assert.equal(run.status, "completed");
  assert.equal(calls, 2);
  assert.equal(run.adjudication!.requestedModel, config.model);
  assert.equal(run.target.claim.includes("administrator"), true);
  assert.equal(run.context.files[0]!.content, broken);
  assert.equal(run.recipe.contents, pin(recipe).contents);
});

test("verification CLI and MCP agree on native evidence and enforce startup-only recipe trust inference and disclosure", async (t) => {
  const { root, context, target } = await assignment(t);
  const operator = await fixture(t, {
    "provider.json": JSON.stringify(
      budgetOptions(async () => Response.json(envelope(config.kind))).provider
        .config,
    ),
    "probe.json": pin(recipe).contents,
    "transport.mjs": `globalThis.fetch=async()=>Response.json(${JSON.stringify(envelope(config.kind))});\n`,
  });
  await writeFile(
    path.join(root, ".checktrail/context.json"),
    JSON.stringify(context),
  );
  await writeFile(
    path.join(root, ".checktrail/target.json"),
    JSON.stringify(target),
  );
  const binary = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const env = {
    PATH: process.env.PATH!,
    ORIGINAL_VERIFICATION_TEST_KEY: "opaque-original-verification-key",
  };
  const flags = [
    "--provider-config",
    path.join(operator, "provider.json"),
    "--probe",
    path.join(operator, "probe.json") + "#sha256=" + pin(recipe).sha256,
    "--allow-inference",
    "--allow-provider-source",
  ];
  const base = [
    "--import",
    path.join(operator, "transport.mjs"),
    binary,
    "review-verify",
    "--root",
    root,
    "--context",
    ".checktrail/context.json",
    "--input",
    ".checktrail/target.json",
  ];
  const denied = spawnSync(process.execPath, [...base, ...flags], {
    encoding: "utf8",
    env,
  });
  assert.equal(denied.status, 2);
  assert.equal(denied.stdout, "");
  const cli = spawnSync(
    process.execPath,
    [...base, ...flags, "--trust-project"],
    { encoding: "utf8", env },
  );
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const summary = JSON.parse(cli.stdout);
  assert.equal(summary.evidenceTier, "native-expectation-mismatch");
  assert.equal(summary.budgetScope, "verification-run");
  assert.equal(summary.adjudication.aggregateBudget.observedTokens, 240);
  const connect = async (startup: string[]) => {
    const client = new Client(
      { name: "original-verification-control", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    t.after(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          path.join(operator, "transport.mjs"),
          binary,
          "serve",
          "--root",
          root,
          ...startup,
        ],
        env,
        stderr: "pipe",
      }),
    );
    return client;
  };
  const input = {
    context: ".checktrail/context.json",
    candidate: ".checktrail/target.json",
    probeId: recipe.id,
  };
  for (const startup of [[], flags, ["--allow-execution"]]) {
    const disabled = await connect(startup);
    assert.equal(
      (await disabled.callTool({ name: "review_verify", arguments: input }))
        .isError,
      true,
    );
    await disabled.close();
  }
  const client = await connect([...flags, "--allow-execution"]);
  const result = await client.callTool({
    name: "review_verify",
    arguments: input,
  });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const mcp = result.structuredContent as Record<string, unknown>;
  for (const key of [
    "contextDigest",
    "targetDigest",
    "recipeDigest",
    "evidenceTier",
    "status",
    "resolution",
    "severity",
    "independence",
  ])
    assert.deepEqual(mcp[key], summary[key]);
  assert.equal((mcp.probe as Record<string, unknown>).nativeExecution, true);
  for (const extra of [
    { trusted: true },
    { allowInference: true },
    { recipe },
    { model: "other" },
    { nativeEvidence: [] },
    { wallMs: 1 },
    { aggregateBudget: { maxCalls: 99 } },
  ])
    assert.equal(
      (
        await client.callTool({
          name: "review_verify",
          arguments: { ...input, ...extra },
        })
      ).isError,
      true,
    );
  assert.equal(
    (
      await client.callTool({
        name: "review_verify",
        arguments: { ...input, probeId: "unregistered" },
      })
    ).isError,
    true,
  );
  for (const value of [summary, mcp])
    assert.ok(!JSON.stringify(value).includes(target.claim));
  const detail = spawnSync(
    process.execPath,
    [
      ...base,
      ...flags,
      "--trust-project",
      "--detailed",
      "--allow-review-source",
    ],
    { encoding: "utf8", env },
  );
  assert.equal(detail.status, 0, detail.stdout + detail.stderr);
  assert.equal(JSON.parse(detail.stdout).probe.trials[1].actual, true);
  const detailClient = await connect([
    ...flags,
    "--allow-execution",
    "--detailed",
    "--allow-review-source",
  ]);
  const detailed = await detailClient.callTool({
    name: "review_verify",
    arguments: input,
  });
  assert.equal(detailed.isError, undefined, JSON.stringify(detailed));
  assert.equal(
    (detailed.structuredContent as { probe: { trials: { actual: boolean }[] } })
      .probe.trials[1]!.actual,
    true,
  );
  assert.equal(await readFile(path.join(root, "subject.mjs"), "utf8"), broken);
});

test(
  "MCP verification reserves both execution slots and releases them after cancellation",
  { timeout: 15000 },
  async (t) => {
    const { root, context, target } = await assignment(t);
    const operator = await fixture(t, {
      "provider.json": JSON.stringify(config),
      "probe.json": pin(recipe).contents,
    });
    const marker = path.join(operator, "provider-ready");
    await writeFile(
      path.join(operator, "transport.mjs"),
      `import {writeFileSync} from 'node:fs';let requests=0;globalThis.fetch=async(_url,init)=>{requests++;if(requests===1){writeFileSync(${JSON.stringify(marker)},'ready');await new Promise(resolve=>{if(init.signal.aborted)resolve();else init.signal.addEventListener('abort',resolve,{once:true});});}return Response.json(${JSON.stringify(envelope(config.kind))});};\n`,
    );
    await writeFile(
      path.join(root, ".checktrail/context.json"),
      JSON.stringify(context),
    );
    await writeFile(
      path.join(root, ".checktrail/target.json"),
      JSON.stringify(target),
    );
    const client = new Client(
      { name: "original-verification-cancellation", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    t.after(() => client.close());
    const binary = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          path.join(operator, "transport.mjs"),
          binary,
          "serve",
          "--root",
          root,
          "--allow-execution",
          "--provider-config",
          path.join(operator, "provider.json"),
          "--allow-inference",
          "--allow-provider-source",
          "--probe",
          path.join(operator, "probe.json") + "#sha256=" + pin(recipe).sha256,
        ],
        env: {
          PATH: process.env.PATH!,
          ORIGINAL_VERIFICATION_TEST_KEY: "opaque-original-verification-key",
        },
        stderr: "pipe",
      }),
    );
    const input = {
      context: ".checktrail/context.json",
      candidate: ".checktrail/target.json",
      probeId: recipe.id,
    };
    const controller = new AbortController();
    t.after(() => controller.abort());
    const active = client.callTool(
      { name: "review_verify", arguments: input },
      { signal: controller.signal },
    );
    const cancelled = assert.rejects(active, /abort|cancel/i);
    let ready = false;
    for (let index = 0; index < 200; index++) {
      try {
        ready = (await readFile(marker, "utf8")) === "ready";
        break;
      } catch {
        await delay(25);
      }
    }
    assert.equal(ready, true);
    for (const [name, args] of [
      ["review_verify", input],
      ["review_probe", input],
      ["review_refute", { context: input.context, candidate: input.candidate }],
      ["review_run", { context: input.context }],
      ["validation_run", {}],
    ] as const) {
      const overlap = await client.callTool({ name, arguments: args });
      assert.equal(overlap.isError, true);
      assert.match(JSON.stringify(overlap.content), /already running/);
    }
    controller.abort();
    await cancelled;
    for (let index = 0; index < 100; index++) {
      const next = await client.callTool({
        name: "review_verify",
        arguments: input,
      });
      if (!next.isError) {
        assert.equal(
          (next.structuredContent as { status: string }).status,
          "completed",
        );
        return;
      }
      assert.match(JSON.stringify(next.content), /already running/);
      await delay(25);
    }
    assert.fail("Verification slots remained busy after cancellation");
  },
);

function runBudget(
  overrides: Partial<
    NonNullable<ReviewProviderConfig["limits"]["aggregateBudget"]>
  > = {},
) {
  return {
    inputTokenAllowance: 100,
    maxTotalTokens: 240,
    maxEstimatedCostMicrousd: null,
    maxCalls: 2,
    maxRequestBodyBytes: 2097152,
    maxResponseBodyBytes: 2048,
    ...overrides,
  };
}
function budgetOptions(
  fetch: typeof globalThis.fetch,
  kind: ReviewProviderConfig["kind"] = "openai-responses",
) {
  const value = options(fetch, kind);
  value.provider.config.limits.maxOutputTokens = 20;
  value.provider.config.limits.maxResponseBytes = 1024;
  value.provider.config.limits.aggregateBudget = runBudget();
  return value;
}

test("verification aggregate budgets admit exact shared call token and monetary boundaries across both fresh assignments", async (t) => {
  const { root, context, target } = await assignment(t);
  for (const kind of ["openai-responses", "anthropic-messages"] as const) {
    for (const [overrides, funded, reason] of [
      [{ maxCalls: 1 }, false, "call-limit-exceeded"],
      [{ maxTotalTokens: 239 }, false, "reservation-does-not-fit"],
      [{ maxEstimatedCostMicrousd: 27 }, false, "reservation-does-not-fit"],
      [{ maxEstimatedCostMicrousd: 28 }, true, "within-budget"],
      [{}, true, "within-budget"],
    ] as const) {
      let calls = 0;
      const opts = budgetOptions(async (_url, init) => {
        calls++;
        const wire = JSON.parse(init!.body as string);
        const packet =
          kind === "openai-responses"
            ? wire.input[0].content[0].text
            : wire.messages[0].content[0].text;
        assert.ok(!packet.includes("priorAttempts"));
        assert.ok(!packet.includes("reported-usage-run-admission-v1"));
        assert.ok(
          !packet.includes("Original independent synthetic assignment"),
        );
        return Response.json(envelope(kind));
      }, kind);
      opts.provider.config.pricing = {
        inputUSDPerMillion: 0.1,
        outputUSDPerMillion: 0.2,
        reference: "original synthetic rates",
      };
      opts.provider.config.limits.aggregateBudget = runBudget(overrides);
      const run = await runReviewVerification(root, context, target, opts);
      assert.equal(calls, funded ? 2 : 1);
      assert.equal(run.status, funded ? "completed" : "incomplete");
      assert.equal(run.budgetScope, "verification-run");
      assert.equal(run.probe?.nativeExecution, true);
      assert.equal(
        run.refutation.verifier.aggregateBudget?.observedTokens,
        120,
      );
      const budget = run.adjudication!.aggregateBudget!;
      assert.equal(budget.decision, reason);
      assert.equal(budget.observedCalls, funded ? 2 : 1);
      assert.equal(budget.observedTokens, funded ? 240 : 120);
      assert.equal(budget.observedMicrousd, funded ? 28 : 14);
      assert.equal(budget.reservationMicrousd, 14);
      assert.equal(budget.id, run.refutation.verifier.aggregateBudget?.id);
      assert.deepEqual(budget.priorAttempts, run.refutation.verifier.attempts);
      assert.equal(budget.billingCeilingGuaranteed, false);
      assert.equal(budget.inputAllowanceVerified, false);
      assert.equal(budget.transportByteCeilingGuaranteed, false);
      const projected = projectReviewVerification(run, false, false);
      assert.ok(!JSON.stringify(projected).includes(target.claim));
      assert.ok(
        !JSON.stringify(projected).includes("opaque-original-verification-key"),
      );
    }
  }
});

test("verification aggregate transport budgets reserve each response and charge actual request bodies before another disclosure", async (t) => {
  const { root, context, target } = await assignment(t);
  let calls = 0;
  const opts = budgetOptions(async () => {
    calls++;
    return Response.json(envelope(config.kind));
  });
  const pilot = await runReviewVerification(root, context, target, opts);
  assert.equal(pilot.status, "completed");
  const requests =
    pilot.adjudication!.aggregateBudget!.observedRequestBodyBytes;
  const firstResponse = pilot.refutation.verifier.attempts[0]!.responseBytes;
  for (const [overrides, funded, reason] of [
    [
      { maxRequestBodyBytes: requests - 1 },
      false,
      "request-byte-limit-exceeded",
    ],
    [{ maxRequestBodyBytes: requests }, true, "within-budget"],
    [
      { maxResponseBodyBytes: firstResponse + 1023 },
      false,
      "response-reservation-does-not-fit",
    ],
    [{ maxResponseBodyBytes: firstResponse + 1024 }, true, "within-budget"],
  ] as const) {
    calls = 0;
    opts.provider.config.limits.aggregateBudget = runBudget(overrides);
    const run = await runReviewVerification(root, context, target, opts);
    assert.equal(calls, funded ? 2 : 1);
    assert.equal(run.adjudication!.aggregateBudget!.decision, reason);
    assert.equal(
      run.adjudication!.aggregateBudget!.observedRequestBodyBytes,
      funded ? requests : pilot.refutation.verifier.attempts[0]!.requestBytes,
    );
    assert.equal(
      run.adjudication!.aggregateBudget!.observedResponseBodyBytes,
      firstResponse * (funded ? 2 : 1),
    );
  }
});

test("verification aggregate budgets retain capacity retries unknown usage and input overruns without resetting at adjudication", async (t) => {
  const { root, context, target } = await assignment(t);
  for (const kind of ["openai-responses", "anthropic-messages"] as const) {
    for (const funded of [false, true]) {
      let calls = 0;
      const opts = budgetOptions(async () => {
        calls++;
        return calls === 1
          ? Response.json(
              { usage: { input_tokens: 5, output_tokens: 1 } },
              { status: 503 },
            )
          : Response.json(envelope(kind));
      }, kind);
      opts.provider.config.limits.maxAttempts = 2;
      opts.provider.config.limits.aggregateBudget = runBudget({
        maxCalls: funded ? 3 : 2,
        maxTotalTokens: 246,
        maxResponseBodyBytes: 3072,
      });
      const run = await runReviewVerification(root, context, target, opts);
      assert.equal(calls, funded ? 3 : 2);
      assert.equal(run.refutation.verifier.attempts.length, 2);
      assert.equal(run.refutation.verifier.attempts[0]!.status, "capacity");
      assert.equal(
        run.refutation.verifier.aggregateBudget?.observedTokens,
        126,
      );
      assert.equal(
        run.adjudication!.aggregateBudget!.observedTokens,
        funded ? 246 : 126,
      );
      assert.equal(
        run.adjudication!.aggregateBudget!.decision,
        funded ? "within-budget" : "call-limit-exceeded",
      );
    }
    for (const mode of ["unknown", "overrun"] as const) {
      let calls = 0;
      const opts = budgetOptions(async () => {
        calls++;
        const value = envelope(kind);
        if (mode === "unknown") Object.assign(value, { usage: {} });
        else
          Object.assign(value, {
            usage:
              kind === "anthropic-messages"
                ? {
                    input_tokens: 100,
                    output_tokens: 20,
                    cache_read_input_tokens: 1,
                  }
                : { input_tokens: 101, output_tokens: 20 },
          });
        return Response.json(value);
      }, kind);
      const run = await runReviewVerification(root, context, target, opts);
      assert.equal(calls, 1);
      assert.equal(run.refutation.verifier.status, "budget-exhausted");
      assert.equal(
        run.refutation.verifier.aggregateBudget?.decision,
        mode === "unknown" ? "usage-unknown" : "input-allowance-exceeded",
      );
      assert.equal(run.probe, null);
      assert.equal(run.adjudication, null);
      if (mode === "unknown")
        assert.equal(
          run.refutation.verifier.aggregateBudget?.observedTokens,
          null,
        );
    }
  }
});

test("verification aggregate budget receipts reject erased limits forged totals omitted prior attempts and reset session identities", async (t) => {
  const { root, context, target } = await assignment(t);
  const run = await runReviewVerification(
    root,
    context,
    target,
    budgetOptions(async () => Response.json(envelope(config.kind))),
  );
  for (const mutate of [
    (value: typeof run) => {
      delete value.adjudication!.aggregateBudget;
    },
    (value: typeof run) => {
      delete value.adjudication!.limits.aggregateBudget;
    },
    (value: typeof run) => {
      value.adjudication!.aggregateBudget!.observedTokens = 0;
    },
    (value: typeof run) => {
      value.adjudication!.aggregateBudget!.priorAttempts = [];
    },
    (value: typeof run) => {
      value.adjudication!.aggregateBudget!.id =
        "22222222-2222-4222-8222-222222222222";
    },
    (value: typeof run) => {
      delete value.adjudication!.attempts[0]!.requestBytes;
    },
    (value: typeof run) => {
      value.budgetScope = "per-provider-assignment";
    },
    (value: typeof run) => {
      value.adjudication!.limits.aggregateBudget!.maxTotalTokens = 120;
    },
  ]) {
    const value = structuredClone(run);
    mutate(value);
    value.adjudicationDigest = hash(value.adjudication);
    assert.throws(
      () => parseReviewVerification(value),
      /aggregate|budget|reconcile/i,
    );
  }
});

test("verification aggregate budget state is fresh for each run and operator zero ceilings never disclose or execute", async (t) => {
  const { root, context, target } = await assignment(t);
  let calls = 0;
  const opts = budgetOptions(async () => {
    calls++;
    return Response.json(envelope(config.kind));
  });
  const first = await runReviewVerification(root, context, target, opts);
  const second = await runReviewVerification(root, context, target, opts);
  assert.equal(calls, 4);
  assert.notEqual(
    first.refutation.verifier.aggregateBudget!.id,
    second.refutation.verifier.aggregateBudget!.id,
  );
  assert.equal(first.adjudication!.aggregateBudget!.observedTokens, 240);
  assert.equal(second.adjudication!.aggregateBudget!.observedTokens, 240);
  for (const overrides of [
    { maxCalls: 0 },
    { maxTotalTokens: 0 },
    { maxRequestBodyBytes: 0 },
    { maxResponseBodyBytes: 0 },
    { maxEstimatedCostMicrousd: 0 },
  ]) {
    calls = 0;
    opts.provider.config.limits.aggregateBudget = runBudget(overrides);
    const run = await runReviewVerification(root, context, target, opts);
    assert.equal(calls, 0);
    assert.equal(run.refutation.verifier.status, "budget-exhausted");
    assert.equal(run.refutation.verifier.attempts.length, 0);
    assert.equal(run.probe, null);
    assert.equal(run.adjudication, null);
  }
});
