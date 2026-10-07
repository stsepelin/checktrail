import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reviewCandidateSchema,
  reviewClaimProbabilitySchema,
  reviewProviderConfigSchema,
  projectReviewCandidateForIndependentStage,
} from "../src/review-provider-schema.js";
import {
  createRefutationPacket,
  runProviderReview,
} from "../src/review-provider.js";
import {
  createAdjudicationPacket,
  projectReviewNativeObservations,
} from "../src/review-adjudication.js";
import { runReviewProbe } from "../src/review-probe.js";
import { setup, pin, recipe } from "./review-workflow-fixture.js";

const confidence = (probability: number | null) => ({
  profile: "declared-claim-support-probability-v1" as const,
  event: "supported-in-scope-actionable" as const,
  probability,
  calibratedConfidence: false as const,
});
test("claim probability accepts exact endpoints unknown and legacy declarations without turning severity into calibrated confidence", async (t) => {
  const f = await setup(t);
  assert.equal(reviewCandidateSchema.parse(f.target).confidence, undefined);
  for (const p of [0, 1, 0.731234, null]) {
    const candidate = reviewCandidateSchema.parse({
      ...f.target,
      confidence: confidence(p),
    });
    assert.deepEqual(candidate.confidence, confidence(p));
    assert.equal(candidate.severity, "concern");
  }
  assert.equal(
    reviewCandidateSchema.parse({ ...f.target, confidence: null }).confidence,
    null,
  );
  for (const p of [
    -Number.EPSILON,
    1 + Number.EPSILON,
    NaN,
    Infinity,
    -Infinity,
    "0.9",
  ]) {
    assert.throws(() =>
      reviewClaimProbabilitySchema.parse({
        ...confidence(null),
        probability: p,
      }),
    );
  }
  for (const changed of [
    { calibratedConfidence: true },
    { event: "snapshot-has-a-defect" },
    { profile: "verbal-certainty" },
    { severity: "high" },
  ]) {
    assert.throws(() =>
      reviewCandidateSchema.parse({
        ...f.target,
        confidence: { ...confidence(0.9), ...changed },
      }),
    );
  }
  assert.throws(() =>
    reviewCandidateSchema.parse({ ...f.target, probability: 0.9 }),
  );
});
test("independent refuter and adjudicator packets whitelist hypotheses and withhold every prior candidate identity severity confidence attribution and scope", async (t) => {
  const f = await setup(t);
  const target = { ...f.target, confidence: confidence(0.731234) };
  const hypothesis = projectReviewCandidateForIndependentStage(target);
  assert.deepEqual(Object.keys(hypothesis), [
    "family",
    "claim",
    "trigger",
    "consequence",
    "evidenceGaps",
    "citations",
  ]);
  const refuter = createRefutationPacket(f.context, target);
  assert.equal(refuter, createRefutationPacket(f.context, f.target));
  const run = await runReviewProbe(f.root, f.context, target, {
    trusted: true,
    timeoutMs: 10000,
    recipe: pin(),
  });
  assert.equal(run.status, "completed");
  assert.equal(run.counts.triggerMismatches, 1);
  for (const change of [
    { id: "ForeignNativeCase" },
    { role: "near-miss" as const },
    { expected: false },
  ]) {
    const changed = structuredClone(run);
    Object.assign(changed.trials[0]!, change);
    assert.throws(
      () => projectReviewNativeObservations(recipe, changed),
      /native case identities disagree/,
    );
  }
  const omitted = structuredClone(run);
  omitted.trials.pop();
  assert.throws(
    () => projectReviewNativeObservations(recipe, omitted),
    /native case identities disagree/,
  );

  const adjudicator = createAdjudicationPacket(f.context, {
    target,
    counterclaims: [target],
    recipe,
    probe: run,
  });
  const parsed = JSON.parse(adjudicator);
  assert.deepEqual(parsed.unverifiedTarget, hypothesis);
  assert.deepEqual(parsed.unverifiedCounterclaims, [hypothesis]);
  assert.equal(parsed.nativeObservations.cases.length, 3);
  for (const packet of [refuter, adjudicator]) {
    for (const key of [
      "id",
      "severity",
      "confidence",
      "attribution",
      "fixScope",
    ]) {
      const item =
        packet === refuter
          ? JSON.parse(packet).refutationTarget
          : parsed.unverifiedTarget;
      assert.equal(Object.hasOwn(item, key), false, key);
    }
    assert.equal(packet.includes("0.731234"), false);
    assert.equal(packet.includes(target.id), false);
  }
});

test("claim probability transport schemas require nullable confidence on strict provider wires while original legacy null and numerical responses remain valid without remote inference", async (t) => {
  const f = await setup(t);
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const item = value as Record<string, unknown>;
    if (item.type === "object") {
      const properties = item.properties as Record<string, unknown>;
      assert.equal(item.additionalProperties, false);
      assert.deepEqual(item.required, Object.keys(properties));
    }
    Object.values(item).forEach(walk);
  };
  for (const kind of ["openai-responses", "anthropic-messages"] as const) {
    for (const declaration of [undefined, null, confidence(0)]) {
      const config = reviewProviderConfigSchema.parse({
        schemaVersion: 1,
        kind,
        model: "original-declared-probability-model",
        credentialEnv: "ORIGINAL_PROBABILITY_TEST_TOKEN",
        limits: {
          wallMs: 10000,
          maxAttempts: 1,
          retryDelayMs: 0,
          maxRequestBytes: 1048576,
          maxResponseBytes: 131072,
          maxOutputTokens: 4096,
        },
        pricing: null,
      });
      let calls = 0;
      const candidate = reviewCandidateSchema.parse({
        ...f.target,
        ...(declaration === undefined ? {} : { confidence: declaration }),
      });
      const run = await runProviderReview(f.root, f.context, {
        config,
        environment: {
          ORIGINAL_PROBABILITY_TEST_TOKEN: "synthetic-not-a-real-credential",
        },
        allowInference: true,
        allowSourceDisclosure: true,
        fetch: async (_url, options) => {
          calls++;
          const request = JSON.parse(String(options?.body));
          const schema =
            kind === "openai-responses"
              ? request.text.format.schema
              : request.output_config.format.schema;
          assert.equal(schema.type, "object");
          walk(schema);
          const fields = schema.properties.candidates.items;
          assert.ok(fields.required.includes("confidence"));
          assert.ok(
            fields.properties.confidence.anyOf.some(
              (part: { type: string }) => part.type === "null",
            ),
          );
          const output = {
            files: [
              {
                path: "subject.mjs",
                disposition: "reviewed",
                note: "Original assigned scope",
              },
            ],
            candidates: [candidate],
          };
          return Response.json(
            kind === "openai-responses"
              ? {
                  model: config.model,
                  status: "completed",
                  usage: { input_tokens: 1, output_tokens: 1 },
                  output: [
                    {
                      type: "message",
                      role: "assistant",
                      status: "completed",
                      content: [
                        { type: "output_text", text: JSON.stringify(output) },
                      ],
                    },
                  ],
                }
              : {
                  model: config.model,
                  type: "message",
                  role: "assistant",
                  stop_reason: "end_turn",
                  usage: { input_tokens: 1, output_tokens: 1 },
                  content: [{ type: "text", text: JSON.stringify(output) }],
                },
          );
        },
      });
      assert.equal(calls, 1);
      assert.equal(run.status, "completed");
      assert.deepEqual(run.candidates, [candidate]);
    }
  }
});
