import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  scorePairedReviewTrials,
  projectPairedReviewScoring,
  reviewPairedInputSchema,
} from "../src/review-paired-scoring.js";
import { fixture } from "./helpers.js";
const packet = () =>
  reviewPairedInputSchema.parse({
    protocol: {
      schemaVersion: 1,
      profile: "declared-paired-cluster-v1",
      purpose: "development",
      seed: "a".repeat(64),
      resamples: 256,
      confidenceLevel: 0.95,
      trials: ["A", "B", "C", "D"].map((id, index) => ({
        id: "Original_" + id,
        clusterId: "Incident_" + (index % 2),
        family: "identifiers-allowlists",
      })),
    },
    labels: [
      { id: "Original_A", label: "defect" },
      { id: "Original_B", label: "defect" },
      { id: "Original_C", label: "valid" },
      { id: "Original_D", label: "near-miss" },
    ],
    observations: {
      a: [
        {
          id: "Original_A",
          status: "completed",
          decision: "finding",
          probability: 0.9,
          judgement: "supported",
        },
        {
          id: "Original_B",
          status: "incomplete",
          decision: "abstain",
          probability: null,
          judgement: "none",
        },
        {
          id: "Original_C",
          status: "completed",
          decision: "finding",
          probability: 0.7,
          judgement: "refuted",
        },
        {
          id: "Original_D",
          status: "completed",
          decision: "abstain",
          probability: null,
          judgement: "none",
        },
      ],
      b: [
        {
          id: "Original_A",
          status: "completed",
          decision: "abstain",
          probability: null,
          judgement: "none",
        },
        {
          id: "Original_B",
          status: "completed",
          decision: "finding",
          probability: 0.8,
          judgement: "supported",
        },
        {
          id: "Original_C",
          status: "completed",
          decision: "abstain",
          probability: null,
          judgement: "none",
        },
        {
          id: "Original_D",
          status: "completed",
          decision: "finding",
          probability: 0.8,
          judgement: "wrong-address",
        },
      ],
    },
  });
const metric = (
  report: ReturnType<typeof scorePairedReviewTrials>,
  name: string,
) => report.aggregate.differences.find((row) => row.metric === name)!;
const clusterPacket = () => {
  const input = packet();
  input.protocol.trials = input.protocol.trials.map((row, index) => ({
    ...row,
    clusterId: index === 0 ? "One_case" : "Three_cases",
  }));
  input.labels = input.labels.map((row) => ({ ...row, label: "defect" }));
  const abstain = (id: string, status: "completed" | "unsupported") => ({
    id,
    status,
    decision: "abstain" as const,
    probability: null,
    judgement: "none" as const,
  });
  input.observations.a = input.protocol.trials.map((row, index) =>
    abstain(row.id, index === 0 ? "completed" : "unsupported"),
  );
  input.observations.b = input.protocol.trials.map((row, index) =>
    abstain(row.id, index === 0 ? "unsupported" : "completed"),
  );
  return input;
};

test("paired review scoring preserves selected labels missing slots and directional denominators", () => {
  const input = packet(),
    report = scorePairedReviewTrials(input),
    m = report.aggregate;
  assert.equal(m.selected, 4);
  assert.equal(m.clusters, 2);
  assert.equal(m.repeatedClusters, 2);
  assert.equal(m.completePairs, 3);
  assert.equal(m.incompletePairs, 1);
  assert.equal(m.allSlotsComplete, false);
  assert.deepEqual(m.missingObservations, { a: 0, b: 0 });
  assert.equal(m.unresolvedLabels, 0);
  for (const arm of [m.arms.a, m.arms.b]) {
    assert.equal(
      Object.values(arm.statuses).reduce((a, b) => a + b, 0),
      4,
    );
    assert.equal(
      Object.values(arm.labels).reduce((a, b) => a + b, 0),
      4,
    );
    assert.deepEqual(arm.precision, {
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
    assert.deepEqual(arm.materialDefectRecall, {
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
  }
  assert.equal(metric(report, "completedCoverage").differenceBMinusA, 0.25);
  assert.equal(metric(report, "falseAlarmRate").differenceBMinusA, -1);
  assert.equal(metric(report, "falseAlarmRate").direction, "lower-is-better");
  assert.equal(metric(report, "nearMissFalseAlarmRate").differenceBMinusA, 1);
  const missing = packet();
  missing.observations.b = missing.observations.b.filter(
    (row) => row.id !== "Original_B",
  );
  const absent = scorePairedReviewTrials(missing).aggregate;
  assert.equal(absent.selected, 4);
  assert.equal(absent.missingObservations.b, 1);
  assert.equal(absent.arms.b.missingObservations, 1);
  assert.equal(absent.arms.b.statuses.unreviewed, 1);
  assert.deepEqual(absent.arms.b.materialDefectRecall, {
    numerator: 0,
    denominator: 2,
    value: 0,
  });
  const unknown = packet();
  unknown.labels = unknown.labels.filter((row) => row.id !== "Original_C");
  const unresolved = scorePairedReviewTrials(unknown).aggregate;
  assert.equal(unresolved.missingLabels, 1);
  assert.equal(unresolved.unresolvedLabels, 1);
  assert.equal(unresolved.arms.a.falseAlarmRate.value, null);
  assert.equal(report.qualityGate, "not-assessed");
  assert.equal(report.independenceVerified, false);
  assert.equal(report.pairingVerified, false);
  assert.equal(report.calibratedConfidence, false);
  assert.equal(
    report.properScoreComparison,
    "not-computed-different-submitted-claims",
  );
});

test("paired review scoring resamples whole unequal clusters and preserves both arms together", () => {
  const input = clusterPacket(),
    report = scorePairedReviewTrials(input),
    completion = metric(report, "completedCoverage");
  // Whole-cluster draws give -1, +1/2 or +1: the three-case cluster is indivisible.
  assert.equal(completion.differenceBMinusA, 0.5);
  assert.equal(completion.bootstrap.state, "available");
  assert.deepEqual(completion.bootstrap.interval, { lower: -1, upper: 1 });
  assert.equal(completion.bootstrap.validResamples, input.protocol.resamples);
  assert.equal(completion.bootstrap.undefinedResamples, 0);
  const identical = clusterPacket();
  identical.observations.b = structuredClone(identical.observations.a);
  const equal = metric(scorePairedReviewTrials(identical), "completedCoverage");
  assert.equal(equal.differenceBMinusA, 0);
  assert.equal(equal.bootstrap.state, "degenerate");
  assert.equal(equal.bootstrap.interval, null);
  assert.equal(equal.bootstrap.validResamples, identical.protocol.resamples);
});

test("paired review scoring refuses undefined partial or degenerate interval evidence", () => {
  const single = packet();
  single.protocol.trials = single.protocol.trials.map((row) => ({
    ...row,
    clusterId: "Only_cluster",
  }));
  const insufficient = metric(
    scorePairedReviewTrials(single),
    "completedCoverage",
  );
  assert.equal(insufficient.bootstrap.state, "insufficient-clusters");
  assert.equal(insufficient.bootstrap.validResamples, 0);
  assert.equal(insufficient.bootstrap.interval, null);
  const empty = clusterPacket();
  const noClaims = metric(scorePairedReviewTrials(empty), "precision");
  assert.equal(noClaims.differenceBMinusA, null);
  assert.equal(noClaims.bootstrap.state, "undefined-point");
  assert.equal(noClaims.bootstrap.interval, null);
  const partial = clusterPacket();
  for (const arm of ["a", "b"] as const)
    partial.observations[arm] = partial.observations[arm].map((row, index) => ({
      ...row,
      status: "completed",
      decision: index === 0 ? "finding" : "abstain",
      judgement: index === 0 ? "supported" : "none",
      probability: index === 0 ? 0.8 : null,
    }));
  const unknown = metric(scorePairedReviewTrials(partial), "precision");
  assert.equal(unknown.differenceBMinusA, 0);
  assert.equal(unknown.bootstrap.state, "undefined-resamples");
  assert.ok(unknown.bootstrap.undefinedResamples > 0);
  assert.ok(unknown.bootstrap.validResamples > 0);
  assert.equal(
    unknown.bootstrap.validResamples + unknown.bootstrap.undefinedResamples,
    partial.protocol.resamples,
  );
  assert.equal(unknown.bootstrap.interval, null);
});

test("paired review scoring rejects foreign duplicate contradictory and unbounded declared inputs", () => {
  const cases: (() => unknown)[] = [
    () => ({
      ...packet(),
      protocol: {
        ...packet().protocol,
        trials: [...packet().protocol.trials, packet().protocol.trials[0]],
      },
    }),
    () => ({ ...packet(), labels: [...packet().labels, packet().labels[0]] }),
    () => ({ ...packet(), labels: [{ id: "Foreign", label: "valid" }] }),
    () => ({
      ...packet(),
      observations: {
        ...packet().observations,
        a: [...packet().observations.a, packet().observations.a[0]],
      },
    }),
    () => ({
      ...packet(),
      observations: {
        ...packet().observations,
        b: [{ ...packet().observations.b[0], id: "Foreign" }],
      },
    }),
  ];
  for (const make of cases)
    assert.throws(
      () => scorePairedReviewTrials(make()),
      /Duplicate paired trial identity|do not reconcile/,
    );
  for (const change of [
    { resamples: 127 },
    { resamples: 4097 },
    { confidenceLevel: 0.79 },
    { confidenceLevel: 1 },
    { seed: "invalid" },
    { unexpected: true },
  ])
    assert.throws(() =>
      scorePairedReviewTrials({
        ...packet(),
        protocol: { ...packet().protocol, ...change },
      }),
    );
  const contradictions = packet();
  contradictions.labels[0]!.label = "valid";
  assert.throws(() => scorePairedReviewTrials(contradictions), /contradict/);
  const absentTruth = packet();
  absentTruth.labels = absentTruth.labels.filter(
    (row) => row.id !== "Original_A",
  );
  assert.throws(() => scorePairedReviewTrials(absentTruth), /contradict/);
  const incomplete = packet();
  incomplete.observations.a[0]!.status = "stale";
  assert.throws(() => scorePairedReviewTrials(incomplete), /contradict/);
  const bound = packet();
  bound.protocol.resamples = 4096;
  bound.protocol.confidenceLevel = 0.99;
  assert.equal(scorePairedReviewTrials(bound).resamples, 4096);
});

test("paired review scoring binds canonical retained evidence and refuses forged derived metrics", () => {
  const input = packet(),
    report = scorePairedReviewTrials(input);
  assert.deepEqual(scorePairedReviewTrials(input), report);
  const reordered = packet();
  reordered.protocol.trials.reverse();
  reordered.labels.reverse();
  reordered.observations.a.reverse();
  reordered.observations.b.reverse();
  assert.deepEqual(scorePairedReviewTrials(reordered), report);
  const shifted = packet();
  shifted.protocol.seed = "b".repeat(64);
  assert.notEqual(
    scorePairedReviewTrials(shifted).protocolDigest,
    report.protocolDigest,
  );
  const forged = structuredClone(report);
  forged.aggregate.differences[2]!.differenceBMinusA = 0;
  assert.throws(
    () => projectPairedReviewScoring(forged, false),
    /do not reconcile/,
  );
  const hidden = projectPairedReviewScoring(report, false);
  assert.ok(!JSON.stringify(hidden).includes("Original_"));
  assert.ok(!JSON.stringify(hidden).includes("Incident_"));
  assert.equal(hidden.sourceIncluded, false);
  assert.deepEqual(projectPairedReviewScoring(report, true), report);
  const heldOut = packet();
  heldOut.protocol.purpose = "held-out";
  assert.equal(scorePairedReviewTrials(heldOut).qualityGate, "not-assessed");
});

test("paired review scoring CLI and MCP use the shared numerical engine without executing project code", async (t) => {
  const input = packet(),
    root = await fixture(t, {
      ".checktrail/paired.json": JSON.stringify(input),
      "never-load.mjs":
        "throw new Error('project source must never be evaluated');\n",
    });
  const binary = fileURLToPath(new URL("../src/cli.js", import.meta.url)),
    expected = projectPairedReviewScoring(
      scorePairedReviewTrials(input),
      false,
    );
  const cli = spawnSync(
    process.execPath,
    [
      binary,
      "review-paired-score",
      "--root",
      root,
      "--input",
      ".checktrail/paired.json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), expected);
  const client = new Client(
    { name: "original-paired-scoring", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [binary, "serve", "--root", root],
      stderr: "pipe",
    }),
  );
  const tools = await client.listTools();
  assert.equal(
    tools.tools.find((tool) => tool.name === "review_paired_score")!.annotations
      ?.readOnlyHint,
    true,
  );
  const result = await client.callTool({
    name: "review_paired_score",
    arguments: { input: ".checktrail/paired.json" },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, expected);
  assert.ok(!JSON.stringify(result).includes(root));
  for (const extra of [
    { trusted: true },
    { allowInference: true },
    { qualityGate: "passed" },
    { independenceVerified: true },
  ])
    assert.equal(
      (
        await client.callTool({
          name: "review_paired_score",
          arguments: { input: ".checktrail/paired.json", ...extra },
        })
      ).isError,
      true,
    );
  await writeFile(
    path.join(root, ".checktrail/paired.json"),
    JSON.stringify({ ...input, observations: { a: [], b: [] } }),
  );
  const missing = await client.callTool({
    name: "review_paired_score",
    arguments: { input: ".checktrail/paired.json" },
  });
  assert.equal(missing.isError, undefined);
  assert.equal(
    (missing.structuredContent as Record<string, unknown>).qualityGate,
    "not-assessed",
  );
  assert.equal(
    (
      (missing.structuredContent as Record<string, unknown>).aggregate as {
        incompletePairs: number;
      }
    ).incompletePairs,
    4,
  );
  assert.equal(
    (await client.callTool({ name: "validation_run", arguments: {} })).isError,
    true,
  );
});
