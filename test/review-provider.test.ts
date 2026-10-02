import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { test } from "node:test";
import { createReviewContext, type ReviewContext } from "../src/review.js";
import {
  runProviderReview,
  projectProviderReview,
} from "../src/review-provider.js";
import {
  reviewProviderConfigSchema,
  reviewProviderRunSchema,
  reviewProviderSummarySchema,
  type ReviewProviderConfig,
  type ReviewModelOutput,
} from "../src/review-provider-schema.js";
import { fixture } from "./helpers.js";

const secret = "synthetic-opaque-credential-53e9a183";
const source = "export function allowed(actor,item){return actor.loggedIn;}\n";
const baseConfig: ReviewProviderConfig = {
  schemaVersion: 1,
  kind: "openai-responses",
  model: "operator-selected-model-v1",
  credentialEnv: "REVIEW_TEST_CREDENTIAL",
  limits: {
    wallMs: 10_000,
    maxAttempts: 2,
    retryDelayMs: 0,
    maxRequestBytes: 1_048_576,
    maxResponseBytes: 131_072,
    maxOutputTokens: 4096,
  },
  pricing: {
    inputUSDPerMillion: 1,
    outputUSDPerMillion: 2,
    reference: "synthetic operator rates",
  },
};
const environment = {
  REVIEW_TEST_CREDENTIAL: secret,
  OTHER_PRIVATE_VALUE: "must-never-be-sent",
};
async function packet(t: Parameters<typeof fixture>[0], contents = source) {
  const root = await fixture(t, {
    "subject.ts": contents,
    ".checktrail/keep": "",
    "sibling.ts":
      "// future fix and previous finding must never enter this assignment\n",
  });
  const context = await createReviewContext(root, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.ts"],
    supportFiles: [],
    topics: [],
  });
  return { root, context };
}
function output(context: ReviewContext): ReviewModelOutput {
  const file = context.files[0]!;
  return {
    files: [
      {
        path: file.path,
        disposition: "reviewed",
        note: "Assigned snapshot only",
      },
    ],
    candidates: [
      {
        id: "tenant-boundary",
        family: "authorization-tenancy",
        severity: "concern",
        claim: "A logged-in actor can access an item owned by another actor.",
        trigger: "Actor 1 requests an item owned by actor 2.",
        consequence:
          "Cross-owner access is possible if this guard supplies the access decision.",
        evidenceGaps: [
          "Runtime caller and intended access policy are unverified.",
        ],
        attribution: "unknown",
        fixScope: "unknown",
        citations: [
          {
            file: file.path,
            revision: "current",
            sourceDigest: file.sha256,
            startLine: 1,
            endLine: 1,
            quote: file.content.split("\n")[0]!,
          },
        ],
      },
    ],
  };
}
function envelope(kind: ReviewProviderConfig["kind"], contents: unknown) {
  return kind === "openai-responses"
    ? {
        model: baseConfig.model,
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 20 },
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: JSON.stringify(contents) }],
          },
        ],
      }
    : {
        model: baseConfig.model,
        type: "message",
        role: "assistant",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
        content: [{ type: "text", text: JSON.stringify(contents) }],
      };
}
const reply = (
  kind: ReviewProviderConfig["kind"],
  contents: unknown,
): Response => Response.json(envelope(kind, contents));

test("stateless provider transports send only the assigned packet with no tools history memory or credential retention", async (t) => {
  const { root, context } = await packet(t);
  for (const kind of ["openai-responses", "anthropic-messages"] as const) {
    const config = { ...baseConfig, kind };
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(
        url,
        kind === "openai-responses"
          ? "https://api.openai.com/v1/responses"
          : "https://api.anthropic.com/v1/messages",
      );
      assert.equal(options?.method, "POST");
      assert.equal(options?.redirect, "manual");
      const headers = new Headers(options?.headers);
      assert.equal(
        headers.get(
          kind === "openai-responses" ? "Authorization" : "x-api-key",
        ),
        kind === "openai-responses" ? `Bearer ${secret}` : secret,
      );
      const raw = String(options?.body);
      for (const hidden of [
        secret,
        "must-never-be-sent",
        "future fix and previous finding",
        root,
      ])
        assert.ok(!raw.includes(hidden), hidden);
      const request = JSON.parse(raw);
      assert.deepEqual(request.tools, []);
      assert.equal(request.stream, false);
      for (const forbidden of [
        "previous_response_id",
        "conversation",
        "metadata",
        "background",
        "session",
        "mcp_servers",
        "container",
        "cache_control",
      ])
        assert.ok(!(forbidden in request), forbidden);
      const messages =
        kind === "openai-responses" ? request.input : request.messages;
      assert.equal(messages.length, 1);
      assert.equal(messages[0].role, "user");
      const assigned = JSON.parse(messages[0].content[0].text);
      assert.equal(assigned.context.contextDigest, context.contextDigest);
      assert.deepEqual(
        assigned.context.files.map((file: { path: string }) => file.path),
        ["subject.ts"],
      );
      assert.equal(assigned.hypotheses.families.length, 9);
      assert.ok(!("baseCommit" in assigned.context.selection));
      if (kind === "openai-responses") {
        assert.equal(request.store, false);
        assert.equal(request.tool_choice, "none");
        assert.equal(request.max_output_tokens, config.limits.maxOutputTokens);
        assert.equal(request.text.format.strict, true);
        assert.equal(request.text.format.schema.additionalProperties, false);
      } else {
        assert.equal(headers.get("anthropic-version"), "2023-06-01");
        assert.equal(request.max_tokens, config.limits.maxOutputTokens);
        assert.equal(request.output_config.format.type, "json_schema");
      }
      return reply(kind, output(context));
    };
    const run = await runProviderReview(root, context, {
      config,
      environment,
      fetch,
      allowInference: true,
      allowSourceDisclosure: true,
    });
    assert.equal(calls, 1);
    assert.equal(run.status, "completed");
    assert.equal(run.disposition, "advisory-completed");
    assert.equal(run.nativeExecution, false);
    assert.equal(run.claimsVerified, false);
    assert.equal(run.deterministicOutcomeChanged, false);
    assert.equal(run.receipt?.citations.matched, 1);
    assert.equal(run.receipt?.freshness, "current");
    assert.equal(
      run.candidates[0]?.trigger,
      output(context).candidates[0]?.trigger,
    );
    assert.equal(
      run.usage.inputTokens,
      kind === "openai-responses" ? 100 : 115,
    );
    assert.equal(run.usage.outputTokens, 20);
    assert.equal(run.usage.attemptsWithUnknownUsage, 0);
    assert.equal(
      run.usage.costUSD,
      kind === "openai-responses" ? 0.00014 : 0.000155,
    );
    assert.equal(run.usage.costProvenance, "operator-rates-estimate");
    reviewProviderRunSchema.parse(run);
    const summary = projectProviderReview(run, true, false);
    reviewProviderSummarySchema.parse(summary);
    for (const hidden of [
      secret,
      "REVIEW_TEST_CREDENTIAL",
      root,
      "subject.ts",
      source.trim(),
      "logged-in actor",
      "Runtime caller",
    ])
      assert.ok(!JSON.stringify(summary).includes(hidden), hidden);
    assert.deepEqual(projectProviderReview(run, true, true), run);
    assert.ok(!JSON.stringify(run).includes(secret));
  }
});

test("every provider review and retry is a new stateless assignment without previous outputs or automatic model switching", async (t) => {
  const a = await packet(t, "export const assigned = 'case-one';\n");
  const b = await packet(t, "export const assigned = 'case-two';\n");
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (_url, options) => {
    const raw = String(options?.body);
    requests.push(raw);
    assert.equal(JSON.parse(raw).model, baseConfig.model);
    if (requests.length === 1)
      return new Response(secret + " at capacity", { status: 503 });
    return reply("openai-responses", {
      files: [
        {
          path: "subject.ts",
          disposition: "reviewed",
          note: "unshared-outcome-canary",
        },
      ],
      candidates: [],
    });
  };
  const runA = await runProviderReview(a.root, a.context, {
    config: baseConfig,
    environment,
    fetch,
    allowInference: true,
    allowSourceDisclosure: true,
  });
  const runB = await runProviderReview(b.root, b.context, {
    config: baseConfig,
    environment,
    fetch,
    allowInference: true,
    allowSourceDisclosure: true,
  });
  assert.equal(runA.status, "completed");
  assert.equal(runB.status, "completed");
  assert.notEqual(runA.runId, runB.runId);
  assert.notEqual(runA.packetDigest, runB.packetDigest);
  assert.deepEqual(
    runA.attempts.map((a) => a.status),
    ["capacity", "completed"],
  );
  assert.equal(
    new Set([...runA.attempts, ...runB.attempts].map((a) => a.id)).size,
    3,
  );
  assert.equal(requests[0], requests[1]);
  assert.ok(requests[2]!.includes("case-two"));
  assert.ok(!requests[2]!.includes("case-one"));
  assert.ok(requests.every((raw) => !raw.includes("unshared-outcome-canary")));
  assert.equal(runA.usage.inputTokens, null);
  assert.equal(runA.usage.costUSD, null);
  assert.equal(runA.usage.attemptsWithUnknownUsage, 1);
  assert.equal(runB.usage.inputTokens, 100);
  assert.ok(!JSON.stringify(runA).includes(secret));
});

test("provider completion does not hide omitted files unsupported evidence malformed citations refusals or tool requests", async (t) => {
  const { root, context } = await packet(t);
  const cases: Array<[unknown, string]> = [];
  const changed = (edit: (value: ReturnType<typeof envelope>) => void) => {
    const value = envelope("openai-responses", output(context));
    edit(value);
    return value;
  };
  cases.push([
    changed((v) => {
      v.status = "incomplete";
    }),
    "incomplete",
  ]);
  cases.push([
    changed((v) => {
      v.output = [
        { type: "function_call", name: "read_previous_findings" },
      ] as never;
    }),
    "tool-request",
  ]);
  cases.push([
    changed((v) => {
      v.output![0]!.content = [{ type: "refusal", refusal: "no" }] as never;
    }),
    "refused",
  ]);
  cases.push([
    changed((v) => {
      v.output![0]!.status = "in_progress";
    }),
    "incomplete",
  ]);
  cases.push([
    changed((v) => {
      v.model = "unexpected-fallback-model";
    }),
    "malformed",
  ]);
  cases.push([
    changed((v) => {
      v.usage.output_tokens = 5000;
    }),
    "output-limit",
  ]);
  cases.push([
    envelope("openai-responses", { files: [], candidates: [] }),
    "completed",
  ]);
  const badQuote = output(context);
  badQuote.candidates[0]!.citations[0]!.quote = "fabricated quote";
  cases.push([envelope("openai-responses", badQuote), "completed"]);
  const wrongSource = output(context);
  wrongSource.candidates[0]!.citations[0]!.file = "sibling.ts";
  cases.push([envelope("openai-responses", wrongSource), "malformed"]);
  const duplicate = output(context);
  duplicate.files.push(duplicate.files[0]!);
  cases.push([envelope("openai-responses", duplicate), "malformed"]);
  const history = output(context);
  history.candidates[0]!.attribution = "regression";
  cases.push([envelope("openai-responses", history), "malformed"]);
  cases.push([
    envelope("openai-responses", {
      files: [],
      candidates: [],
      previousFinding: "must-reject",
    }),
    "malformed",
  ]);
  for (const [value, expected] of cases) {
    const run = await runProviderReview(root, context, {
      config: baseConfig,
      environment,
      fetch: async () => Response.json(value),
      allowInference: true,
      allowSourceDisclosure: true,
    });
    assert.equal(run.status, "incomplete");
    assert.equal(run.disposition, "no-complete-review");
    assert.equal(run.attempts.length, 1);
    assert.equal(run.attempts[0]?.status, expected);
    assert.equal(run.claimsVerified, false);
    assert.equal(run.nativeExecution, false);
  }
  for (const reason of [
    "max_tokens",
    "model_context_window_exceeded",
    "refusal",
    "tool_use",
    "pause_turn",
  ] as const) {
    const value = envelope("anthropic-messages", output(context));
    value.stop_reason = reason;
    const run = await runProviderReview(root, context, {
      config: { ...baseConfig, kind: "anthropic-messages" },
      environment,
      fetch: async () => Response.json(value),
      allowInference: true,
      allowSourceDisclosure: true,
    });
    assert.equal(run.status, "incomplete");
    assert.equal(run.attempts.length, 1);
    assert.equal(
      run.attempts[0]?.status,
      reason === "refusal"
        ? "refused"
        : ["tool_use", "pause_turn"].includes(reason)
          ? "tool-request"
          : "incomplete",
    );
  }
});

test("provider grants request bounds missing credentials stale source and cancellation prevent disclosure", async (t) => {
  const { root, context } = await packet(t);
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    throw new Error(secret);
  };
  for (const [allowInference, allowSourceDisclosure] of [
    [false, false],
    [false, true],
    [true, false],
  ])
    await assert.rejects(
      runProviderReview(root, context, {
        config: baseConfig,
        environment,
        fetch,
        allowInference: Boolean(allowInference),
        allowSourceDisclosure: Boolean(allowSourceDisclosure),
      }),
      /operator/,
    );
  let run = await runProviderReview(root, context, {
    config: {
      ...baseConfig,
      limits: { ...baseConfig.limits, maxRequestBytes: 1 },
    },
    environment,
    fetch,
    allowInference: true,
    allowSourceDisclosure: true,
  });
  assert.equal(run.status, "budget-exhausted");
  assert.equal(run.attempts.length, 0);
  run = await runProviderReview(root, context, {
    config: baseConfig,
    environment: {},
    fetch,
    allowInference: true,
    allowSourceDisclosure: true,
  });
  assert.equal(run.status, "unavailable");
  assert.equal(run.attempts.length, 0);
  const controller = new AbortController();
  controller.abort();
  run = await runProviderReview(root, context, {
    config: baseConfig,
    environment,
    fetch,
    signal: controller.signal,
    allowInference: true,
    allowSourceDisclosure: true,
  });
  assert.equal(run.status, "cancelled");
  assert.equal(run.attempts.length, 0);
  await writeFile(path.join(root, "subject.ts"), "changed source\n");
  run = await runProviderReview(root, context, {
    config: baseConfig,
    environment,
    fetch,
    allowInference: true,
    allowSourceDisclosure: true,
  });
  assert.equal(run.status, "stale");
  assert.equal(run.freshness, "stale");
  assert.equal(calls, 0);
  for (const bad of [
    { ...baseConfig, kind: "remote-agent-service" },
    { ...baseConfig, endpoint: "https://unapproved.invalid" },
    { ...baseConfig, limits: { ...baseConfig.limits, maxAttempts: 4 } },
  ])
    assert.equal(reviewProviderConfigSchema.safeParse(bad).success, false);
});

test("provider retries capacity and rate limits only within operator limits and keeps unknown billed usage unknown", async (t) => {
  const { root, context } = await packet(t);
  for (const httpStatus of [429, 503, 529, 500, 401, 403, 302, 400]) {
    let calls = 0;
    const run = await runProviderReview(root, context, {
      config: baseConfig,
      environment,
      fetch: async () => {
        calls++;
        return new Response(secret, { status: httpStatus });
      },
      allowInference: true,
      allowSourceDisclosure: true,
    });
    assert.equal(run.status, "incomplete");
    assert.equal(calls, [429, 503, 529, 500].includes(httpStatus) ? 2 : 1);
    assert.equal(run.attempts.length, calls);
    assert.equal(run.usage.inputTokens, null);
    assert.equal(run.usage.outputTokens, null);
    assert.equal(run.usage.costUSD, null);
    assert.equal(run.usage.attemptsWithUnknownUsage, calls);
    assert.ok(!JSON.stringify(run).includes(secret));
  }
  const run = await runProviderReview(root, context, {
    config: baseConfig,
    environment,
    fetch: async () => {
      throw new Error(secret);
    },
    allowInference: true,
    allowSourceDisclosure: true,
  });
  assert.equal(run.attempts.length, 1);
  assert.equal(run.attempts[0]?.status, "transport-error");
  assert.ok(!JSON.stringify(run).includes(secret));
});

test("provider body truncation invalid encoding stalled streams and cancellation never become complete reviews", async (t) => {
  const { root, context } = await packet(t);
  for (const response of [
    new Response("x".repeat(101)),
    new Response("small", { headers: { "Content-Length": "101" } }),
    new Response(new Uint8Array([0xff, 0xfe])),
    new Response("{partial"),
    reply("openai-responses", {
      files: [],
      candidates: [],
      credentialEcho: secret,
    }),
  ]) {
    const run = await runProviderReview(root, context, {
      config: {
        ...baseConfig,
        limits: { ...baseConfig.limits, maxResponseBytes: 100 },
      },
      environment,
      fetch: async () => response,
      allowInference: true,
      allowSourceDisclosure: true,
    });
    assert.equal(run.status, "incomplete");
    assert.equal(run.attempts.length, 1);
    assert.ok(!JSON.stringify(run).includes(secret));
  }
  for (const cancelled of [true, false]) {
    let streamCancelled = false;
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        streamCancelled = true;
      },
    });
    const fetch: typeof globalThis.fetch = async () => {
      if (cancelled) setTimeout(() => controller.abort(), 5);
      return new Response(stream);
    };
    const run = await runProviderReview(root, context, {
      config: {
        ...budgetConfig(),
        limits: { ...budgetConfig().limits, wallMs: 1000 },
      },
      environment,
      fetch,
      signal: controller.signal,
      allowInference: true,
      allowSourceDisclosure: true,
    });
    assert.equal(run.status, cancelled ? "cancelled" : "timed-out");
    assert.equal(
      run.attempts[0]?.status,
      cancelled ? "cancelled" : "timed-out",
    );
    assert.equal(streamCancelled, true);
    assert.equal(run.receipt, null);
  }
});

test("provider freshness is checked after inference and malformed usage never becomes zero cost", async (t) => {
  const { root, context } = await packet(t);
  const value = envelope("openai-responses", output(context));
  value.usage = { input_tokens: -1, output_tokens: 20 };
  const run = await runProviderReview(root, context, {
    config: baseConfig,
    environment,
    fetch: async () => {
      await writeFile(path.join(root, "subject.ts"), "different source\n");
      return Response.json(value);
    },
    allowInference: true,
    allowSourceDisclosure: true,
  });
  assert.equal(run.status, "stale");
  assert.equal(run.receipt?.freshness, "stale");
  assert.equal(run.usage.inputTokens, null);
  assert.equal(run.usage.outputTokens, 20);
  assert.equal(run.usage.costUSD, null);
  assert.equal(run.usage.attemptsWithUnknownUsage, 1);
});

test("provider projection rejects fabricated completion accounting identities usage and detached candidates", async (t) => {
  const { root, context } = await packet(t);
  const run = await runProviderReview(root, context, {
    config: baseConfig,
    environment,
    fetch: async () => reply("openai-responses", output(context)),
    allowInference: true,
    allowSourceDisclosure: true,
  });
  for (const edit of [
    (v: typeof run) => {
      v.receipt = null;
    },
    (v: typeof run) => {
      v.unaccounted = 1;
    },
    (v: typeof run) => {
      v.usage.inputTokens = 0;
    },
    (v: typeof run) => {
      v.freshness = "stale";
    },
    (v: typeof run) => {
      v.attempts[0]!.status = "refused";
    },
    (v: typeof run) => {
      v.attempts[0]!.observedModel = "unverified-private-name";
    },
    (v: typeof run) => {
      v.candidates[0]!.claim = "detached claim";
    },
    (v: typeof run) => {
      v.attempts.push(v.attempts[0]!);
    },
    (v: typeof run) => {
      v.disposition = "no-complete-review";
    },
  ]) {
    const changed = structuredClone(run);
    edit(changed);
    assert.throws(() => projectProviderReview(changed, false, false));
  }
  const echoedOutput = output(context);
  echoedOutput.candidates[0]!.claim = secret;
  const echoed = envelope("openai-responses", echoedOutput);
  const echoRun = await runProviderReview(root, context, {
    config: baseConfig,
    environment,
    fetch: async () => Response.json(echoed),
    allowInference: true,
    allowSourceDisclosure: true,
  });
  assert.equal(echoRun.attempts[0]?.status, "malformed");
  assert.ok(!JSON.stringify(echoRun).includes(secret));
});

test("CLI and MCP provider reviews share advisory accounting and startup grants cannot be elevated by tool arguments", async (t) => {
  const { root, context } = await packet(t);
  await mkdir(path.join(root, ".checktrail"), { recursive: true });
  await writeFile(
    path.join(root, ".checktrail/context.json"),
    JSON.stringify(context),
  );
  await writeFile(
    path.join(root, ".checktrail/provider.json"),
    JSON.stringify(budgetConfig()),
  );
  const stubRoot = await fixture(t, {
    "transport.mjs": `
    globalThis.fetch = async (url, options) => {
      if (url !== "https://api.openai.com/v1/responses" || options.redirect !== "manual") throw new Error("Unexpected request");
      const request = JSON.parse(options.body);
      if (request.store !== false || request.tools.length || request.input.length !== 1 || request.previous_response_id || request.model !== "operator-selected-model-v1") throw new Error("Unsafe request");
      const packet = JSON.parse(request.input[0].content[0].text);
      const files = packet.context.selection.files.concat(packet.context.selection.supportFiles).map(path => ({ path, disposition: "reviewed", note: "synthetic transport acceptance" }));
      return Response.json({ model: request.model, status: "completed", usage: { input_tokens: 100, output_tokens: 20 }, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ files, candidates: [] }) }] }] });
    };
  `,
  });
  const prefix = [
    "--import",
    path.join(stubRoot, "transport.mjs"),
    fileURLToPath(new URL("../src/cli.js", import.meta.url)),
  ];
  const grants = [
    "--provider-config",
    path.join(root, ".checktrail/provider.json"),
    "--allow-inference",
    "--allow-provider-source",
  ];
  const env = { PATH: process.env.PATH ?? "", REVIEW_TEST_CREDENTIAL: secret };
  const cli = spawnSync(
    process.execPath,
    [
      ...prefix,
      "review-run",
      "--root",
      root,
      "--context",
      ".checktrail/context.json",
      ...grants,
    ],
    { encoding: "utf8", env },
  );
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
  const cliRun = JSON.parse(cli.stdout);
  reviewProviderSummarySchema.parse(cliRun);
  assert.equal(cliRun.status, "completed");
  assert.equal(cliRun.candidates, 0);
  assert.equal(cliRun.claimsVerified, false);
  assert.equal(cliRun.nativeExecution, false);
  assert.equal(cliRun.budget.decision, "within-budget");
  assert.equal(cliRun.budget.observedTokens, 120);
  assert.equal(cliRun.budget.billingCeilingGuaranteed, false);
  assert.ok(!cli.stdout.includes(secret));
  assert.ok(!cli.stdout.includes("subject.ts"));
  const denied = spawnSync(
    process.execPath,
    [
      ...prefix,
      "review-run",
      "--root",
      root,
      "--context",
      ".checktrail/context.json",
      "--provider-config",
      path.join(root, ".checktrail/provider.json"),
    ],
    { encoding: "utf8", env },
  );
  assert.equal(denied.status, 2);
  assert.ok(!denied.stdout);
  const connect = async (args: string[]) => {
    const client = new Client(
      { name: "synthetic-provider-client", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...prefix, "serve", "--root", root, ...args],
      env,
      stderr: "pipe",
    });
    t.after(() => client.close());
    await client.connect(transport);
    return client;
  };
  const client = await connect(grants);
  const tools = await client.listTools();
  assert.equal(
    tools.tools.find((tool) => tool.name === "review_run")?.annotations
      ?.openWorldHint,
    true,
  );
  const call = await client.callTool({
    name: "review_run",
    arguments: { context: ".checktrail/context.json" },
  });
  assert.equal(call.isError, undefined);
  const mcpRun = call.structuredContent as Record<string, unknown>;
  reviewProviderSummarySchema.parse(mcpRun);
  for (const key of [
    "contextDigest",
    "packetDigest",
    "configDigest",
    "catalogueDigest",
    "status",
    "provider",
    "requestedModel",
    "budget",
    "limits",
    "usage",
    "independence",
    "nativeExecution",
    "selectedPaths",
    "declaredReviewed",
    "unaccounted",
    "candidates",
  ])
    assert.deepEqual(mcpRun[key], cliRun[key], key);
  assert.ok(!JSON.stringify(call).includes(secret));
  assert.ok(!JSON.stringify(call).includes("subject.ts"));
  for (const extra of [
    { model: "unapproved" },
    { allowInference: true },
    { allowProviderSource: true },
    { config: baseConfig },
    { trusted: true },
    { maxAttempts: 3 },
    { admissionBudget: { maxTotalTokens: 999999 } },
    { limits: { maxTotalTokens: 999999 } },
  ]) {
    const injected = await client.callTool({
      name: "review_run",
      arguments: { context: ".checktrail/context.json", ...extra },
    });
    assert.equal(injected.isError, true);
  }
  await writeFile(
    path.join(root, ".checktrail/provider-empty.json"),
    JSON.stringify(budgetConfig({ maxTotalTokens: 0 })),
  );
  const unfundedGrants = [
    "--provider-config",
    path.join(root, ".checktrail/provider-empty.json"),
    "--allow-inference",
    "--allow-provider-source",
  ];
  const unfundedCli = spawnSync(
    process.execPath,
    [
      ...prefix,
      "review-run",
      "--root",
      root,
      "--context",
      ".checktrail/context.json",
      ...unfundedGrants,
    ],
    { encoding: "utf8", env },
  );
  assert.equal(unfundedCli.status, 2, unfundedCli.stderr);
  const stopped = JSON.parse(unfundedCli.stdout);
  assert.equal(stopped.status, "budget-exhausted");
  assert.equal(stopped.attempts.length, 0);
  assert.equal(stopped.unaccounted, 1);
  const unfundedClient = await connect(unfundedGrants);
  const unfundedCall = await unfundedClient.callTool({
    name: "review_run",
    arguments: { context: ".checktrail/context.json" },
  });
  assert.equal(unfundedCall.isError, undefined);
  const unfundedRun = unfundedCall.structuredContent as typeof stopped;
  assert.equal(unfundedRun.status, "budget-exhausted");
  assert.equal(unfundedRun.attempts.length, 0);
  assert.deepEqual(unfundedRun.budget, stopped.budget);
  const unconfigured = await connect([]);
  assert.equal(
    (
      await unconfigured.callTool({
        name: "review_run",
        arguments: { context: ".checktrail/context.json" },
      })
    ).isError,
    true,
  );
});

function budgetConfig(
  changes: Partial<
    NonNullable<ReviewProviderConfig["limits"]["admissionBudget"]>
  > = {},
): ReviewProviderConfig {
  return {
    ...baseConfig,
    limits: {
      ...baseConfig.limits,
      maxOutputTokens: 40,
      admissionBudget: {
        inputTokenAllowance: 120,
        maxTotalTokens: 400,
        maxEstimatedCostMicrousd: 600,
        ...changes,
      },
    },
  };
}

test("provider admission budgets reject unfunded requests and missing prices before disclosure", async (t) => {
  const { root, context } = await packet(t);
  const cases = [
    [budgetConfig({ maxTotalTokens: 159 }), "reservation-does-not-fit"],
    [
      budgetConfig({ maxEstimatedCostMicrousd: 199 }),
      "reservation-does-not-fit",
    ],
    [{ ...budgetConfig(), pricing: null }, "pricing-unavailable"],
  ] as const;
  for (const [config, reason] of cases) {
    let calls = 0;
    let run: Awaited<ReturnType<typeof runProviderReview>>;
    try {
      run = await runProviderReview(root, context, {
        config,
        environment,
        allowInference: true,
        allowSourceDisclosure: true,
        fetch: async () => {
          calls++;
          return reply(config.kind, output(context));
        },
      });
    } finally {
      assert.equal(calls, 0, "Unfunded assignment must never be disclosed");
    }
    assert.equal(run.attempts.length, 0);
    assert.equal(run.status, "budget-exhausted");
    assert.equal(run.budget?.decision, reason);
    assert.equal(run.usage.inputTokens, null);
    assert.equal(run.budget?.observedTokens, null);
    assert.equal(run.receipt, null);
    assert.equal(run.unaccounted, 1);
    assert.equal(run.disposition, "no-complete-review");
  }
  for (const changes of [
    { inputTokenAllowance: 0 },
    { inputTokenAllowance: 1.1 },
    { maxTotalTokens: -1 },
    { maxTotalTokens: 2_000_001 },
    { maxEstimatedCostMicrousd: 0.1 },
    { maxEstimatedCostMicrousd: -1 },
  ])
    assert.equal(
      reviewProviderConfigSchema.safeParse(budgetConfig(changes)).success,
      false,
    );
  // Old operator files retain their previous contract; zero-cost explicit prices are valid.
  assert.equal(
    reviewProviderConfigSchema.parse(baseConfig).limits.admissionBudget,
    undefined,
  );
  const zero = {
    ...budgetConfig({ maxEstimatedCostMicrousd: 0 }),
    pricing: {
      ...baseConfig.pricing!,
      inputUSDPerMillion: 0,
      outputUSDPerMillion: 0,
    },
  };
  const run = await runProviderReview(root, context, {
    config: zero,
    environment,
    allowInference: true,
    allowSourceDisclosure: true,
    fetch: async () => reply(zero.kind, output(context)),
  });
  assert.equal(run.status, "completed");
  assert.equal(run.budget?.observedMicrousd, 0);
});

test("provider admission budgets retain unknown and exceeded usage without clean completion or further retries", async (t) => {
  const { root, context } = await packet(t);
  for (const kind of ["openai-responses", "anthropic-messages"] as const) {
    for (const mode of [
      "capacity",
      "missing",
      "input-overflow",
      "output-overflow",
    ] as const) {
      const config = { ...budgetConfig(), kind };
      let calls = 0;
      const value = envelope(kind, output(context));
      const run = await runProviderReview(root, context, {
        config,
        environment,
        allowInference: true,
        allowSourceDisclosure: true,
        fetch: async () => {
          calls++;
          if (mode === "capacity") return new Response("busy", { status: 503 });
          if (mode === "missing") delete (value as { usage?: unknown }).usage;
          if (mode === "input-overflow")
            value.usage = { input_tokens: 121, output_tokens: 20 };
          if (mode === "output-overflow")
            value.usage = { input_tokens: 100, output_tokens: 1000 };
          return Response.json(value);
        },
      });
      assert.equal(calls, 1);
      assert.equal(run.attempts.length, 1);
      assert.equal(run.status, "budget-exhausted");
      assert.equal(run.disposition, "no-complete-review");
      assert.equal(
        run.budget?.decision,
        mode === "input-overflow"
          ? "input-allowance-exceeded"
          : mode === "output-overflow"
            ? "token-limit-exceeded"
            : "usage-unknown",
      );
      assert.equal(run.budget?.billingCeilingGuaranteed, false);
      if (mode === "capacity" || mode === "missing") {
        assert.equal(run.budget?.observedTokens, null);
        assert.equal(run.budget?.observedMicrousd, null);
      }
      if (mode === "missing" || mode === "input-overflow") {
        assert.equal(run.receipt?.coverage.declaredReviewed, 1);
        assert.equal(run.candidates.length, 1); // Retain complete output without promoting its outcome.
      }
    }
  }
});

test("provider admission budgets charge all retries and cache tokens against the remaining allowance", async (t) => {
  const { root, context } = await packet(t);
  for (const kind of ["openai-responses", "anthropic-messages"] as const) {
    for (const [funded, maxTotalTokens, maxEstimatedCostMicrousd] of [
      [true, 400, 600],
      [false, 200, 600],
      [false, 400, 299],
    ] as const) {
      const config = {
        ...budgetConfig({ maxTotalTokens, maxEstimatedCostMicrousd }),
        kind,
      };
      let calls = 0;
      const bodies: string[] = [];
      const run = await runProviderReview(root, context, {
        config,
        environment,
        allowInference: true,
        allowSourceDisclosure: true,
        fetch: async (_url, init) => {
          bodies.push(String(init?.body));
          calls++;
          return calls === 1
            ? Response.json(
                {
                  usage: {
                    input_tokens: 100,
                    output_tokens: 0,
                    ...(kind === "anthropic-messages"
                      ? {
                          cache_read_input_tokens: 10,
                          cache_creation_input_tokens: 5,
                        }
                      : {}),
                  },
                  error: { message: "unretained provider error prose" },
                },
                { status: 503 },
              )
            : reply(kind, output(context));
        },
      });
      const expectedInput = kind === "anthropic-messages" ? 115 : 100;
      assert.equal(calls, funded ? 2 : 1);
      assert.equal(run.attempts.length, funded ? 2 : 1);
      assert.equal(run.attempts[0]?.status, "capacity");
      assert.equal(run.status, funded ? "completed" : "budget-exhausted");
      assert.equal(run.usage.inputTokens, expectedInput * (funded ? 2 : 1));
      assert.equal(
        run.budget?.observedTokens,
        expectedInput * (funded ? 2 : 1) + (funded ? 20 : 0),
      );
      assert.equal(
        run.budget?.decision,
        funded ? "within-budget" : "reservation-does-not-fit",
      );
      if (funded) assert.equal(bodies[1], bodies[0]);
      assert.ok(
        !JSON.stringify(run).includes("unretained provider error prose"),
      );
      assert.ok(!JSON.stringify(run).includes(secret));
    }
    const cached = envelope(kind, output(context));
    cached.usage = {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 21,
      cache_creation_input_tokens: 0,
    };
    const run = await runProviderReview(root, context, {
      config: { ...budgetConfig(), kind },
      environment,
      allowInference: true,
      allowSourceDisclosure: true,
      fetch: async () => Response.json(cached),
    });
    assert.equal(
      run.status,
      kind === "anthropic-messages" ? "budget-exhausted" : "completed",
    );
    assert.equal(
      run.budget?.observedTokens,
      kind === "anthropic-messages" ? 141 : 120,
    );
  }
});

test("provider monetary admission uses upward decimal microdollars at exact boundaries", async (t) => {
  const { root, context } = await packet(t);
  for (const [rate, cap, admitted, reservation] of [
    [0.1, 16, true, 16],
    [0.1, 15, false, 16],
    [0.10000000000000002, 16, false, 17],
    [1e-9, 1, true, 1],
    [1e-9, 0, false, 1],
  ] as const) {
    const config: ReviewProviderConfig = {
      ...budgetConfig({ maxEstimatedCostMicrousd: cap }),
      pricing: {
        inputUSDPerMillion: rate,
        outputUSDPerMillion: rate,
        reference: "synthetic decimal rates",
      },
    };
    let calls = 0;
    const run = await runProviderReview(root, context, {
      config,
      environment,
      allowInference: true,
      allowSourceDisclosure: true,
      fetch: async () => {
        calls++;
        return reply(config.kind, output(context));
      },
    });
    assert.equal(calls, admitted ? 1 : 0);
    assert.equal(run.status, admitted ? "completed" : "budget-exhausted");
    assert.equal(run.budget?.reservationMicrousd, reservation);
    assert.equal(
      run.budget?.observedMicrousd,
      admitted ? Math.ceil(120 * rate) : null,
    );
  }
  const costOverflow = envelope("openai-responses", output(context));
  costOverflow.usage = { input_tokens: 100, output_tokens: 80 };
  const costRun = await runProviderReview(root, context, {
    config: budgetConfig({ maxEstimatedCostMicrousd: 200 }),
    environment,
    allowInference: true,
    allowSourceDisclosure: true,
    fetch: async () => Response.json(costOverflow),
  });
  assert.equal(costRun.status, "budget-exhausted");
  assert.equal(costRun.budget?.decision, "cost-limit-exceeded");
  assert.equal(costRun.budget?.observedMicrousd, 260);
  assert.equal(costRun.attempts[0]?.status, "output-limit");
  // Token-only admission can run without monetary rates; absence remains unknown.
  const config = {
    ...budgetConfig({ maxEstimatedCostMicrousd: null }),
    pricing: null,
  };
  const run = await runProviderReview(root, context, {
    config,
    environment,
    allowInference: true,
    allowSourceDisclosure: true,
    fetch: async () => reply(config.kind, output(context)),
  });
  assert.equal(run.status, "completed");
  assert.equal(run.budget?.observedMicrousd, null);
});

test("retained provider budgets reject erased limits impossible retry histories and forged totals", async (t) => {
  const { root, context } = await packet(t);
  const run = await runProviderReview(root, context, {
    config: budgetConfig(),
    environment,
    allowInference: true,
    allowSourceDisclosure: true,
    fetch: async () => reply("openai-responses", output(context)),
  });
  for (const edit of [
    (v: typeof run) => {
      delete v.budget;
    },
    (v: typeof run) => {
      delete v.limits.admissionBudget;
    },
    (v: typeof run) => {
      v.budget!.observedTokens = 0;
    },
    (v: typeof run) => {
      v.budget!.reservationMicrousd = 0;
    },
    (v: typeof run) => {
      v.budget!.decision = "usage-unknown";
    },
    (v: typeof run) => {
      v.budget!.operatorRates = null;
    },
    (v: typeof run) => {
      v.limits.admissionBudget!.maxTotalTokens = 1;
    },
  ]) {
    const changed = structuredClone(run);
    edit(changed);
    assert.throws(
      () => projectProviderReview(changed, false, false),
      /budget/i,
    );
  }
  const impossible = structuredClone(run);
  impossible.attempts.unshift({
    ...structuredClone(impossible.attempts[0]!),
    id: "9b2e3c24-9a14-4931-a53b-e63ddca19781",
    status: "capacity",
    usage: {
      inputTokens: null,
      outputTokens: null,
      costUSD: null,
      costProvenance: "unknown",
    },
  });
  assert.throws(
    () => projectProviderReview(impossible, false, false),
    /admitted/,
  );
  const summary = projectProviderReview(run, false, false);
  assert.deepEqual(summary.budget, run.budget);
  assert.ok(!JSON.stringify(summary).includes("synthetic operator rates"));
  assert.ok(!JSON.stringify(summary).includes("subject.ts"));
});

test("provider error responses obey the same reported output allowance as successful responses", async (t) => {
  const { root, context } = await packet(t);
  for (const kind of ["openai-responses", "anthropic-messages"] as const) {
    for (const bounded of [true, false]) {
      for (const count of [40, 41]) {
        const config = { ...budgetConfig(), kind };
        if (!bounded) delete config.limits.admissionBudget;
        let calls = 0;
        const run = await runProviderReview(root, context, {
          config,
          environment,
          allowInference: true,
          allowSourceDisclosure: true,
          fetch: async () => {
            calls++;
            return calls === 1
              ? Response.json(
                  { usage: { input_tokens: 100, output_tokens: count } },
                  { status: 503 },
                )
              : reply(kind, output(context));
          },
        });
        assert.equal(calls, count === 40 ? 2 : 1);
        assert.equal(run.attempts.length, calls);
        assert.equal(
          run.attempts[0]?.status,
          count === 40 ? "capacity" : "output-limit",
        );
        assert.equal(
          run.status,
          count === 40
            ? "completed"
            : bounded
              ? "budget-exhausted"
              : "incomplete",
        );
        assert.equal(run.usage.outputTokens, count === 40 ? 60 : 41);
        if (bounded)
          assert.equal(
            run.budget?.decision,
            count === 40 ? "within-budget" : "output-allowance-exceeded",
          );
      }
    }
  }
});
