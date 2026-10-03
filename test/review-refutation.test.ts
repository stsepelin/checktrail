import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createReviewContext } from "../src/review.js";
import {
  runProviderReview,
  type ReviewProviderOptions,
} from "../src/review-provider.js";
import {
  runProviderRefutation,
  projectProviderRefutation,
  REFUTATION_CHECKS,
} from "../src/review-refutation.js";
import type {
  ReviewCandidate,
  ReviewProviderConfig,
} from "../src/review-provider-schema.js";
import { fixture } from "./helpers.js";
const config: ReviewProviderConfig = {
  schemaVersion: 1,
  kind: "openai-responses",
  model: "exact-synthetic-refuter",
  credentialEnv: "ORIGINAL_REFUTATION_TEST_KEY",
  pricing: null,
  limits: {
    wallMs: 10000,
    maxAttempts: 2,
    retryDelayMs: 0,
    maxRequestBytes: 1048576,
    maxResponseBytes: 131072,
    maxOutputTokens: 4096,
  },
};
const source =
  "export function decision(name){return name==='scope' || name.startsWith('scope:');}\n";
const baseOptions: ReviewProviderOptions = {
  config,
  allowInference: true,
  allowSourceDisclosure: true,
  environment: { ORIGINAL_REFUTATION_TEST_KEY: "opaque-synthetic-refuter-key" },
};
async function assignment(t: Parameters<typeof fixture>[0]) {
  const root = await fixture(t, {
    "subject.mjs": source,
    "unassigned.mjs": "// reserved synthetic future fix and prior review\n",
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
    id: "withheld-original-label",
    family: "identifiers-allowlists",
    severity: "concern",
    claim: "The prefix admits scopeToken.",
    trigger: "Pass scopeToken.",
    consequence: "An unrelated identifier is admitted.",
    evidenceGaps: ["Intended policy and callers remain unknown."],
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
  const output = {
    files: [
      {
        path: "subject.mjs",
        disposition: "reviewed",
        note: "Original independent synthetic attempt",
      },
    ],
    candidates,
  };
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
            content: [{ type: "output_text", text: JSON.stringify(output) }],
          },
        ],
      }
    : {
        type: "message",
        model: config.model,
        role: "assistant",
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [{ type: "text", text: JSON.stringify(output) }],
      };
}

test("independent refutation requests disclose one unverified hypothesis without prior identity severity verdict native evidence or sibling source", async (t) => {
  const { root, context, target } = await assignment(t);
  const requests: Record<string, unknown>[] = [];
  for (const kind of ["openai-responses", "anthropic-messages"] as const) {
    const runs = [];
    for (let index = 0; index < 2; index++)
      runs.push(
        await runProviderRefutation(root, context, target, {
          ...baseOptions,
          config: { ...config, kind },
          fetch: async (_url, init) => {
            const request = JSON.parse(String(init!.body));
            requests.push(request);
            return Response.json(envelope(kind));
          },
        }),
      );
    assert.notEqual(runs[0]!.verifier.runId, runs[1]!.verifier.runId);
    assert.notEqual(
      runs[0]!.verifier.attempts[0]!.id,
      runs[1]!.verifier.attempts[0]!.id,
    );
    assert.equal(runs[0]!.assignmentDigest, runs[1]!.assignmentDigest);
    assert.equal(runs[0]!.disposition, "refutation-attempt-completed");
    assert.equal(runs[0]!.resolution, "unresolved");
    assert.equal(runs[0]!.claimsVerified, false);
    assert.ok(
      runs[0]!.checks.every((check) => check.status === "not-established"),
    );
  }
  for (const request of requests) {
    const wire = JSON.stringify(request);
    for (const hidden of [
      target.id,
      "reserved synthetic",
      "opaque-synthetic-refuter-key",
    ])
      assert.ok(!wire.includes(hidden), hidden);
    const packet = request.input
      ? JSON.parse(
          (request.input as { content: { text: string }[] }[])[0]!.content[0]!
            .text,
        )
      : JSON.parse(
          (request.messages as { content: { text: string }[] }[])[0]!
            .content[0]!.text,
        );
    assert.deepEqual(packet.refutationTarget, {
      family: target.family,
      claim: target.claim,
      trigger: target.trigger,
      consequence: target.consequence,
      evidenceGaps: target.evidenceGaps,
      citations: target.citations,
    });
    assert.deepEqual(packet.context, context);
    assert.deepEqual(request.tools, []);
    assert.ok(
      String(request.instructions ?? request.system).includes(
        "Attempt to falsify",
      ),
    );
  }
  assert.equal(requests.length, 4);
});

test("refutation target addresses and grants reject forged quotations revisions and source digests before disclosure", async (t) => {
  const { root, context, target } = await assignment(t);
  let requests = 0;
  const options = {
    ...baseOptions,
    fetch: async () => {
      requests++;
      return Response.json(envelope(config.kind));
    },
  };
  for (const edit of [
    (v: ReviewCandidate) => {
      v.citations[0]!.quote = "wrong current line";
    },
    (v: ReviewCandidate) => {
      v.citations[0]!.sourceDigest = "0".repeat(64);
    },
    (v: ReviewCandidate) => {
      v.citations[0]!.revision = "base";
    },
    (v: ReviewCandidate) => {
      v.citations[0]!.file = "unassigned.mjs";
    },
  ]) {
    const changed = structuredClone(target);
    edit(changed);
    await assert.rejects(
      runProviderRefutation(root, context, changed, options),
    );
  }
  for (const grants of [
    { allowInference: false },
    { allowSourceDisclosure: false },
  ])
    await assert.rejects(
      runProviderRefutation(root, context, target, { ...options, ...grants }),
      /grants/,
    );
  assert.equal(requests, 0);
  await writeFile(path.join(root, "subject.mjs"), "changed source\n");
  const stale = await runProviderRefutation(root, context, target, options);
  assert.equal(stale.verifier.status, "stale");
  assert.equal(stale.resolution, "unresolved");
  assert.equal(stale.disposition, "no-complete-attempt");
  assert.equal(requests, 0);
});

test("wrong mechanisms locations remedies and model agreement remain unresolved even when an independent attempt accounts for source", async (t) => {
  const { root, context, target } = await assignment(t);
  for (const claim of [
    "This function uses substring matching.",
    "The defect lives in a different unselected file.",
    "The remedy must consume a request ceiling this function never receives.",
  ]) {
    const wrong = { ...target, claim };
    for (const counterclaims of [
      [],
      [
        {
          ...target,
          id: "independent-counterclaim",
          claim:
            "The selected function already checks the identifier boundary.",
        },
      ],
    ]) {
      const run = await runProviderRefutation(root, context, wrong, {
        ...baseOptions,
        fetch: async () => Response.json(envelope(config.kind, counterclaims)),
      });
      assert.equal(run.verifier.status, "completed");
      assert.equal(run.verifier.receipt!.citations.unmatched, 0);
      assert.equal(run.resolution, "unresolved");
      assert.equal(run.claimsVerified, false);
      assert.equal(run.deterministicOutcomeChanged, false);
      assert.deepEqual(
        run.checks.map((item) => item.dimension),
        REFUTATION_CHECKS,
      );
    }
  }
});

test("retained refutation bindings cannot detach targets assignments receipts or check states and summary hides both sides of the attempt", async (t) => {
  const { root, context, target } = await assignment(t);
  const options = {
    ...baseOptions,
    fetch: async () =>
      Response.json(
        envelope(config.kind, [{ ...target, id: "independent-counterclaim" }]),
      ),
  };
  const run = await runProviderRefutation(root, context, target, options);
  const review = await runProviderReview(root, context, options);
  for (const edit of [
    (v: typeof run) => {
      v.target.claim = "detached";
    },
    (v: typeof run) => {
      v.targetDigest = "0".repeat(64);
    },
    (v: typeof run) => {
      v.contextDigest = "0".repeat(64);
    },
    (v: typeof run) => {
      v.assignmentDigest = "0".repeat(64);
    },
    (v: typeof run) => {
      v.verifier = review;
    },
    (v: typeof run) => {
      v.checks.pop();
    },
    (v: typeof run) => {
      v.checks[0] = v.checks[1]!;
    },
    (v: typeof run) => {
      v.disposition = "no-complete-attempt";
    },
  ]) {
    const bad = structuredClone(run);
    edit(bad);
    assert.throws(() => projectProviderRefutation(bad, false, false));
  }
  const summary = projectProviderRefutation(run, true, false);
  for (const hidden of [
    root,
    target.id,
    target.claim,
    "subject.mjs",
    source.trim(),
    "independent-counterclaim",
  ])
    assert.ok(
      !JSON.stringify(summary).includes(JSON.stringify(hidden)),
      hidden,
    );
  assert.equal(summary.resolution, "unresolved");
  assert.equal(summary.sourceIncluded, false);
  assert.deepEqual(projectProviderRefutation(run, true, true), run);
  const exhausted = await runProviderRefutation(root, context, target, {
    ...baseOptions,
    fetch: async () => new Response("{}", { status: 503 }),
  });
  assert.equal(exhausted.verifier.attempts.length, 2);
  assert.equal(exhausted.disposition, "no-complete-attempt");
  assert.equal(exhausted.resolution, "unresolved");
  assert.equal(exhausted.verifier.usage.inputTokens, null);
});

test("refutation CLI and MCP use shared fresh attempts and tool arguments cannot select provider grants history or budgets", async (t) => {
  const { root, context, target } = await assignment(t);
  const operator = await fixture(t, {
    "transport.mjs": `globalThis.fetch=async(_url,init)=>{const request=JSON.parse(init.body);if(!request.instructions.includes('Attempt to falsify'))throw new Error('not refutation');return Response.json(${JSON.stringify(envelope(config.kind))});};`,
    "provider.json": JSON.stringify(config),
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
    ORIGINAL_REFUTATION_TEST_KEY: "opaque-synthetic-refuter-key",
  };
  const base = [
    "--import",
    path.join(operator, "transport.mjs"),
    binary,
    "review-refute",
    "--root",
    root,
    "--context",
    ".checktrail/context.json",
    "--input",
    ".checktrail/target.json",
    "--provider-config",
    path.join(operator, "provider.json"),
  ];
  const denied = spawnSync(process.execPath, base, { encoding: "utf8", env });
  assert.equal(denied.status, 2);
  assert.ok(!denied.stdout);
  const cli = spawnSync(
    process.execPath,
    [...base, "--allow-inference", "--allow-provider-source"],
    { encoding: "utf8", env },
  );
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const summary = JSON.parse(cli.stdout);
  assert.equal(summary.resolution, "unresolved");
  assert.equal(summary.verifier.status, "completed");
  const connect = async (flags: string[]) => {
    const client = new Client(
      { name: "original-synthetic-refuter", version: "1" },
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
          ...flags,
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
  };
  const disabled = await connect([]);
  assert.equal(
    (await disabled.callTool({ name: "review_refute", arguments: input }))
      .isError,
    true,
  );
  const client = await connect([
    "--provider-config",
    path.join(operator, "provider.json"),
    "--allow-inference",
    "--allow-provider-source",
  ]);
  const result = await client.callTool({
    name: "review_refute",
    arguments: input,
  });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const mcp = result.structuredContent as Record<string, unknown>;
  assert.equal(mcp.assignmentDigest, summary.assignmentDigest);
  assert.equal(mcp.resolution, summary.resolution);
  assert.deepEqual(mcp.checks, summary.checks);
  assert.deepEqual(mcp.independence, summary.independence);
  for (const extra of [
    { config },
    { model: "other" },
    { allowInference: true },
    { history: [] },
    { nativeEvidence: [] },
    { maxAttempts: 3 },
  ])
    assert.equal(
      (
        await client.callTool({
          name: "review_refute",
          arguments: { ...input, ...extra },
        })
      ).isError,
      true,
    );
});

test("reviewer and refuter recheck source before capacity retries and after refused or cancelled attempts", async (t) => {
  for (const refute of [false, true])
    for (const terminal of ["capacity", "refusal", "cancelled"] as const) {
      const { root, context, target } = await assignment(t);
      let requests = 0;
      const controller = new AbortController();
      const options = {
        ...baseOptions,
        signal: controller.signal,
        fetch: async () => {
          requests++;
          await writeFile(path.join(root, "subject.mjs"), "changed source\n");
          if (terminal === "cancelled") controller.abort();
          if (terminal === "capacity")
            return new Response("{}", { status: 503 });
          const response = envelope(config.kind);
          if ("output" in response)
            response.output[0]!.content = [
              { type: "refusal", text: "Refused synthetic test" },
            ];
          return Response.json(response);
        },
      };
      const run = refute
        ? (await runProviderRefutation(root, context, target, options)).verifier
        : await runProviderReview(root, context, options);
      assert.equal(requests, 1, terminal);
      assert.equal(run.attempts.length, 1);
      assert.equal(run.freshness, "stale");
      assert.equal(
        run.status,
        terminal === "cancelled" ? "cancelled" : "stale",
      );
      assert.equal(run.disposition, "no-complete-review");
    }
});

test("independent refuters inherit operator admission budgets without disclosing or promoting an unfunded assignment", async (t) => {
  const { root, context, target } = await assignment(t);
  let calls = 0;
  const run = await runProviderRefutation(root, context, target, {
    ...baseOptions,
    config: {
      ...config,
      limits: {
        ...config.limits,
        admissionBudget: {
          inputTokenAllowance: 120,
          maxTotalTokens: 1,
          maxEstimatedCostMicrousd: null,
        },
      },
    },
    fetch: async () => {
      calls++;
      return Response.json(envelope(config.kind));
    },
  });
  assert.equal(calls, 0);
  assert.equal(run.verifier.status, "budget-exhausted");
  assert.equal(run.resolution, "unresolved");
  assert.equal(run.verifier.budget?.decision, "reservation-does-not-fit");
  const summary = projectProviderRefutation(run, false, false);
  assert.ok(!JSON.stringify(summary).includes(target.claim));
});
