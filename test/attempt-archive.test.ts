import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { validate } from "../src/engine.js";
import { projectReport } from "../src/output.js";
import { createReviewContext } from "../src/review.js";
import {
  runProviderReview,
  projectProviderReview,
} from "../src/review-provider.js";
import type { ReviewProviderConfig } from "../src/review-provider-schema.js";
import { fixture, nodeManifest, passingTest } from "./helpers.js";
const digest = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const key = "original-synthetic-secret-43a";
const config: ReviewProviderConfig = {
  schemaVersion: 1,
  kind: "openai-responses",
  model: "original-offline-transport-v1",
  credentialEnv: "ORIGINAL_ARCHIVE_KEY",
  pricing: null,
  limits: {
    wallMs: 10000,
    maxAttempts: 2,
    retryDelayMs: 0,
    maxRequestBytes: 1048576,
    maxResponseBytes: 131072,
    maxOutputTokens: 1000,
  },
};

test("native validation retains physical command output while summary omits every byte archive", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "sum.test.js": passingTest,
  });
  const report = await validate(root, { trusted: true, timeoutMs: 10000 });
  assert.equal(report.outcome, "passed");
  assert.equal(report.checks.length, 1);
  const result = report.checks[0]!.processes[0]!;
  assert.ok(result.capturedOutput);
  assert.equal(result.capturedOutput.completeForObservedStreams, true);
  assert.equal(
    result.capturedOutput.stdout.base64,
    Buffer.from(result.stdout).toString("base64"),
  );
  assert.equal(
    result.capturedOutput.stderr.base64,
    Buffer.from(result.stderr).toString("base64"),
  );
  assert.equal(result.capturedOutput.stdout.sha256, digest(result.stdout));
  assert.ok(result.capturedOutput.observedBytes > 0);
  for (const field of ["capturedOutput", "base64", "stdout", "stderr"])
    assert.equal(
      JSON.stringify(projectReport(report, false)).includes(field),
      false,
    );
});

test("offline API attempts retain each bounded JSON error and response with exact request/body bindings without credentials or summary disclosure", async (t) => {
  const root = await fixture(t, {
    "subject.mjs": "export const decision=true;\n",
  });
  const context = await createReviewContext(root, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.mjs"],
    supportFiles: [],
    topics: [],
  });
  for (const kind of ["openai-responses", "anthropic-messages"] as const) {
    const bodies = [
      JSON.stringify({
        error: {
          code: "original-capacity",
          message: "original error body canary",
        },
      }),
      JSON.stringify({
        model: config.model,
        status: "completed",
        usage: { input_tokens: 11, output_tokens: 3 },
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  files: [
                    {
                      path: "subject.mjs",
                      disposition: "reviewed",
                      note: "original response canary",
                    },
                  ],
                  candidates: [],
                }),
              },
            ],
          },
        ],
      }),
    ];
    if (kind === "anthropic-messages") {
      const original = JSON.parse(bodies[1]!);
      bodies[1] = JSON.stringify({
        model: config.model,
        type: "message",
        role: "assistant",
        stop_reason: "end_turn",
        usage: original.usage,
        content: [{ type: "text", text: original.output[0].content[0].text }],
      });
    }
    const requestBodies: string[] = [];
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (url, options) => {
      assert.equal(
        url,
        kind === "openai-responses"
          ? "https://api.openai.com/v1/responses"
          : "https://api.anthropic.com/v1/messages",
      );
      assert.equal(options?.method, "POST");
      const headers = new Headers(options?.headers);
      assert.equal(
        headers.get("Authorization"),
        kind === "openai-responses" ? "Bearer " + key : null,
      );
      assert.equal(
        headers.get("x-api-key"),
        kind === "anthropic-messages" ? key : null,
      );
      assert.equal(typeof options?.body, "string");
      requestBodies.push(options!.body as string);
      const i = calls++;
      return new Response(bodies[i], { status: i === 0 ? 503 : 200 });
    };
    const run = await runProviderReview(root, context, {
      allowInference: true,
      allowSourceDisclosure: true,
      environment: { ORIGINAL_ARCHIVE_KEY: key },
      config: { ...config, kind },
      fetch,
    });
    assert.equal(calls, 2);
    assert.equal(run.status, "completed");
    const records = (
      run as unknown as {
        responseArchive: Array<{
          attemptId: string;
          requestSha256: string;
          httpStatus: number;
          bodyState: string;
          bodyBase64: string;
          bodySha256: string;
          observedBodyBytes: number;
        }>;
      }
    ).responseArchive;
    assert.ok(records);
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((r) => r.attemptId),
      run.attempts.map((a) => a.id),
    );
    for (let i = 0; i < records.length; i++) {
      const r = records[i]!;
      assert.equal(r.requestSha256, digest(requestBodies[i]!));
      assert.equal(r.httpStatus, i === 0 ? 503 : 200);
      assert.equal(r.bodyState, "complete");
      assert.equal(Buffer.from(r.bodyBase64, "base64").toString(), bodies[i]);
      assert.equal(r.bodySha256, digest(bodies[i]!));
      assert.equal(r.observedBodyBytes, Buffer.byteLength(bodies[i]!));
    }
    assert.equal(JSON.stringify(run).includes(key), false);
    const summary = JSON.stringify(projectProviderReview(run, false, false));
    assert.equal(summary.includes("responseArchive"), false);
    assert.equal(summary.includes("bodyBase64"), false);
    assert.equal(summary.includes("original error body canary"), false);
    assert.equal(summary.includes("original response canary"), false);
    for (const state of [
      "withheld-uninspectable",
      "withheld-credential",
      "withheld-incomplete",
    ] as const) {
      const contradictory = structuredClone(run);
      Object.assign(contradictory.responseArchive![1]!, {
        bodyState: state,
        bodyBase64: null,
        bodySha256: null,
        retainedBodyBytes: 0,
      });
      assert.throws(
        () => projectProviderReview(contradictory, true, true),
        /Uninspected provider response archive/,
      );
      assert.throws(
        () => projectProviderReview(contradictory, false, false),
        /Uninspected provider response archive/,
      );
    }
    const changed = structuredClone(run);
    const archived = changed.responseArchive![1]!;
    const value = JSON.parse(
      Buffer.from(archived.bodyBase64!, "base64").toString(),
    );
    value.model = "x".repeat(config.model.length);
    const bytes = Buffer.from(JSON.stringify(value));
    assert.equal(bytes.length, archived.observedBodyBytes);
    archived.bodyBase64 = bytes.toString("base64");
    archived.bodySha256 = digest(bytes);
    assert.throws(() => projectProviderReview(changed, true, true), /replay/);
  }
});

test("offline API response archives refuse literal and JSON-escaped credentials while keeping a valid adjacent value", async (t) => {
  const root = await fixture(t, {
    "subject.mjs": "export const decision=true;\n",
  });
  const context = await createReviewContext(root, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.mjs"],
    supportFiles: [],
    topics: [],
  });
  const escaped = key
    .split("")
    .map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");
  const cases = [
    {
      body: JSON.stringify({ error: { message: key } }),
      state: "withheld-credential",
    },
    {
      body: '{"error":{"message":"' + escaped + '"}}',
      state: "withheld-credential",
    },
    {
      body: JSON.stringify({ [key]: "original" }),
      state: "withheld-credential",
    },
    {
      body: JSON.stringify({ error: { message: config.credentialEnv } }),
      state: "withheld-credential",
    },
    {
      body: JSON.stringify({ error: { message: "original" } }),
      state: "withheld-credential",
      credential: '"error"',
    },
    {
      body: JSON.stringify({ error: { message: key.slice(0, -1) + "b" } }),
      state: "complete",
    },
  ];
  for (const item of cases) {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      return new Response(item.body, { status: 503 });
    };
    const run = await runProviderReview(root, context, {
      allowInference: true,
      allowSourceDisclosure: true,
      environment: { ORIGINAL_ARCHIVE_KEY: item.credential ?? key },
      config: { ...config, limits: { ...config.limits, maxAttempts: 1 } },
      fetch,
    });
    assert.equal(calls, 1);
    assert.equal(run.attempts.length, 1);
    assert.equal(run.attempts[0]!.status, "capacity");
    const archived = run.responseArchive![0]!;
    assert.equal(archived.bodyState, item.state);
    assert.equal(archived.observedBodyBytes, Buffer.byteLength(item.body));
    if (item.state !== "complete") {
      assert.equal(archived.bodyBase64, null);
      assert.equal(archived.bodySha256, null);
      assert.equal(archived.retainedBodyBytes, 0);
    } else
      assert.equal(
        Buffer.from(archived.bodyBase64!, "base64").toString(),
        item.body,
      );
    assert.equal(JSON.stringify(run).includes(key), false);
  }
  for (const kind of ["openai-responses", "anthropic-messages"] as const) {
    for (const item of [
      { padding: Array(100001).fill(0), allowed: false },
      { padding: [Array(50001).fill(0), Array(50001).fill(0)], allowed: false },
      { padding: Array(99900).fill(0), allowed: true },
    ]) {
      const note = item.allowed ? key.slice(0, -1) + "b" : key;
      const text = JSON.stringify({
        files: [{ path: "subject.mjs", disposition: "reviewed", note }],
        candidates: [],
      });
      const body = JSON.stringify({
        model: config.model,
        usage: { input_tokens: 11, output_tokens: 3 },
        ...(kind === "openai-responses"
          ? {
              status: "completed",
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
              stop_reason: "end_turn",
              content: [{ type: "text", text }],
            }),
        padding: item.padding,
      }).replaceAll(key, escaped);
      assert.ok(Buffer.byteLength(body) < 1048576);
      assert.equal(body.includes(key), false);
      let calls = 0;
      const run = await runProviderReview(root, context, {
        allowInference: true,
        allowSourceDisclosure: true,
        environment: { ORIGINAL_ARCHIVE_KEY: key },
        config: {
          ...config,
          kind,
          limits: {
            ...config.limits,
            maxAttempts: 1,
            maxResponseBytes: 1048576,
          },
        },
        fetch: async () => {
          calls++;
          return new Response(body);
        },
      });
      assert.equal(calls, 1);
      assert.equal(run.attempts.length, 1);
      const archived = run.responseArchive![0]!;
      assert.equal(
        archived.bodyState,
        item.allowed ? "complete" : "withheld-uninspectable",
      );
      assert.equal(archived.observedBodyBytes, Buffer.byteLength(body));
      assert.equal(
        JSON.stringify(run).includes(key),
        false,
        "An uninspected success body must not disclose decoded credentials through review prose",
      );
      assert.equal(
        run.attempts[0]!.status,
        item.allowed ? "completed" : "malformed",
      );
      if (item.allowed) {
        assert.ok(run.receipt);
        assert.equal(run.receipt.assessment.files[0]!.note, note);
        assert.equal(
          Buffer.from(archived.bodyBase64!, "base64").toString(),
          body,
        );
      } else {
        assert.equal(run.receipt, null);
        assert.deepEqual(run.candidates, []);
        assert.equal(run.attempts[0]!.observedModel, null);
        assert.equal(run.attempts[0]!.usage.inputTokens, null);
        assert.equal(run.attempts[0]!.usage.outputTokens, null);
        assert.equal(archived.bodyBase64, null);
        assert.equal(archived.bodySha256, null);
        assert.equal(archived.retainedBodyBytes, 0);
      }
      assert.deepEqual(projectProviderReview(run, true, true), run);
    }
    // Non-success responses interpret only safe numeric usage and HTTP status.
    const body = JSON.stringify({
      error: { message: key },
      usage: { input_tokens: 11, output_tokens: 3 },
      padding: Array(100001).fill(0),
    }).replaceAll(key, escaped);
    let calls = 0;
    const run = await runProviderReview(root, context, {
      allowInference: true,
      allowSourceDisclosure: true,
      environment: { ORIGINAL_ARCHIVE_KEY: key },
      config: {
        ...config,
        kind,
        limits: { ...config.limits, maxAttempts: 1, maxResponseBytes: 1048576 },
      },
      fetch: async () => {
        calls++;
        return new Response(body, { status: 503 });
      },
    });
    assert.equal(calls, 1);
    assert.equal(run.responseArchive![0]!.bodyState, "withheld-uninspectable");
    assert.equal(run.attempts[0]!.status, "capacity");
    assert.equal(run.attempts[0]!.usage.inputTokens, 11);
    assert.equal(run.attempts[0]!.usage.outputTokens, 3);
    assert.equal(run.attempts[0]!.observedModel, null);
    assert.equal(run.receipt, null);
    assert.deepEqual(run.candidates, []);
    assert.equal(JSON.stringify(run).includes(key), false);
    assert.deepEqual(projectProviderReview(run, true, true), run);
  }
});
test("offline API partial overflow aborted and unavailable attempts account for observed bytes without retaining an unchecked body", async (t) => {
  const root = await fixture(t, {
    "subject.mjs": "export const decision=true;\n",
  });
  const context = await createReviewContext(root, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.mjs"],
    supportFiles: [],
    topics: [],
  });
  for (const kind of [
    "overflow",
    "read-error",
    "unavailable",
    "declared-overflow",
    "abort",
  ]) {
    const controller = new AbortController();
    let calls = 0;
    const delivered = Buffer.from('{"original":"' + key + '"}');
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      if (kind === "unavailable") throw new Error(key);
      if (kind === "declared-overflow")
        return new Response(delivered, {
          status: 200,
          headers: { "content-length": "99999" },
        });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(delivered);
            if (kind === "abort") controller.abort();
          },
          pull(c) {
            if (kind === "read-error") c.error(new Error(key));
            else c.close();
          },
        }),
        { status: 200 },
      );
    };
    const run = await runProviderReview(root, context, {
      allowInference: true,
      allowSourceDisclosure: true,
      environment: { ORIGINAL_ARCHIVE_KEY: key },
      config: {
        ...config,
        limits: {
          ...config.limits,
          maxAttempts: 1,
          maxResponseBytes:
            kind === "overflow" || kind === "declared-overflow" ? 8 : 131072,
        },
      },
      signal: controller.signal,
      fetch,
    });
    assert.equal(calls, 1);
    assert.equal(run.attempts.length, 1);
    const archived = run.responseArchive![0]!;
    assert.equal(archived.observedBodyBytes, run.attempts[0]!.responseBytes);
    assert.equal(archived.bodyBase64, null);
    assert.equal(archived.bodySha256, null);
    assert.equal(archived.retainedBodyBytes, 0);
    assert.equal(
      archived.bodyState,
      kind === "unavailable" || kind === "declared-overflow" || kind === "abort"
        ? "unobserved"
        : "withheld-incomplete",
    );
    assert.equal(
      run.attempts[0]!.status,
      kind === "overflow" || kind === "declared-overflow"
        ? "output-limit"
        : kind === "abort"
          ? "cancelled"
          : "transport-error",
    );
    if (archived.bodyState === "withheld-incomplete") {
      const changed = structuredClone(run);
      changed.responseArchive![0]!.observedBodyBytes++;
      assert.throws(
        () => projectProviderReview(changed, true, true),
        /archive identities and bytes/,
      );
    }
    assert.equal(JSON.stringify(run).includes(key), false);
  }
});
test("retained model response archives reject omitted foreign reordered changed and noncanonical evidence independently", async (t) => {
  const root = await fixture(t, {
    "subject.mjs": "export const decision=true;\n",
  });
  const context = await createReviewContext(root, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.mjs"],
    supportFiles: [],
    topics: [],
  });
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: { message: "original-" + calls++ } }),
      { status: 503 },
    );
  const run = await runProviderReview(root, context, {
    allowInference: true,
    allowSourceDisclosure: true,
    environment: { ORIGINAL_ARCHIVE_KEY: key },
    config,
    fetch,
  });
  assert.equal(calls, 2);
  assert.equal(run.responseArchive!.length, 2);
  const changes = [
    (r: typeof run) => {
      r.responseArchive![1]!.requestSha256 = "0".repeat(64);
    },
    (r: typeof run) => {
      r.responseArchive![0]!.httpStatus = 401;
    },
    (r: typeof run) => {
      const observed = r.responseArchive![0]!;
      const value = JSON.stringify({ usage: { input_tokens: 3 } }).padEnd(
        observed.observedBodyBytes,
        " ",
      );
      assert.equal(Buffer.byteLength(value), observed.observedBodyBytes);
      observed.bodyBase64 = Buffer.from(value).toString("base64");
      observed.bodySha256 = digest(value);
    },
    (r: typeof run) => {
      r.responseArchive!.pop();
    },
    (r: typeof run) => {
      r.responseArchive!.reverse();
    },
    (r: typeof run) => {
      r.responseArchive![0]!.attemptId = "00000000-0000-4000-8000-000000000000";
    },
    (r: typeof run) => {
      r.responseArchive![0]!.observedBodyBytes++;
    },
    (r: typeof run) => {
      r.responseArchive![0]!.bodySha256 = "0".repeat(64);
    },
    (r: typeof run) => {
      r.responseArchive![0]!.bodyBase64 = "eA==";
    },
    (r: typeof run) => {
      r.responseArchive![0]!.retainedBodyBytes++;
    },
    (r: typeof run) => {
      r.responseArchive![0]!.bodyState = "withheld-credential";
    },
  ];
  for (const mutate of changes) {
    const altered = structuredClone(run);
    mutate(altered);
    assert.throws(
      () => projectProviderReview(altered, true, true),
      /archive|body|observation|bytes/,
    );
  }
  assert.deepEqual(projectProviderReview(run, true, true), run);
});
