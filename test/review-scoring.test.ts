import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  scoreReviewTrials,
  projectReviewScoring,
  reviewBinomialLower95,
  reviewScoringInputSchema,
} from "../src/review-scoring.js";
import { fixture } from "./helpers.js";
const packet = () =>
  reviewScoringInputSchema.parse({
    protocol: {
      schemaVersion: 1,
      profile: "declared-claim-probability-v1",
      purpose: "development",
      confidenceThresholds: [0.5, 0.9, 0.95, 1],
      trials: ["A", "B", "C", "D", "E", "Missing"].map((id) => ({
        id: "Original_" + id,
        clusterId: "Cluster_" + id,
        family: "identifiers-allowlists",
      })),
    },
    observations: [
      {
        id: "Original_A",
        status: "completed",
        decision: "finding",
        probability: 0.9,
        label: "defect",
        judgement: "supported",
      },
      {
        id: "Original_B",
        status: "completed",
        decision: "finding",
        probability: 0.8,
        label: "defect",
        judgement: "wrong-mechanism",
      },
      {
        id: "Original_C",
        status: "completed",
        decision: "abstain",
        probability: null,
        label: "valid",
        judgement: "none",
      },
      {
        id: "Original_D",
        status: "unsupported",
        decision: "abstain",
        probability: null,
        label: "valid",
        judgement: "none",
      },
      {
        id: "Original_E",
        status: "completed",
        decision: "finding",
        probability: 0.95,
        label: "near-miss",
        judgement: "refuted",
      },
    ],
  });
const close = (actual: number | null, expected: number) => {
  assert.ok(actual !== null);
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} !== ${expected}`);
};

test("review scoring separates actionable correctness proper probability losses reliability and risk from complete selected-case accounting", () => {
  const report = scoreReviewTrials(packet());
  const m = report.aggregate;
  assert.equal(m.selected, 6);
  assert.equal(
    Object.values(m.statuses).reduce((a, b) => a + b, 0),
    6,
  );
  assert.equal(
    Object.values(m.labels).reduce((a, b) => a + b, 0),
    6,
  );
  assert.equal(m.statuses.completed, 4);
  assert.equal(m.statuses.unsupported, 1);
  assert.equal(m.statuses.unreviewed, 1);
  assert.equal(m.missingObservations, 1);
  assert.deepEqual(m.precision, { numerator: 1, denominator: 3, value: 1 / 3 });
  assert.deepEqual(m.materialDefectRecall, {
    numerator: 1,
    denominator: 2,
    value: 0.5,
  });
  assert.deepEqual(m.completedCoverage, {
    numerator: 4,
    denominator: 6,
    value: 4 / 6,
  });
  assert.deepEqual(m.falseAlarmRate, {
    numerator: 0,
    denominator: 1,
    value: 0,
  });
  assert.deepEqual(m.nearMissFalseAlarmRate, {
    numerator: 1,
    denominator: 1,
    value: 1,
  });
  close(m.properScores.brier, 0.5175);
  close(
    m.properScores.negativeLogLikelihood,
    (-Math.log(0.9) - Math.log(0.2) - Math.log(0.05)) / 3,
  );
  assert.equal(m.properScores.scored, 3);
  assert.equal(m.properScores.unscoredFindings, 0);
  assert.equal(m.properScores.infiniteLogLoss, 0);
  close(m.reliability[9]!.meanProbability, 0.925);
  close(m.reliability[9]!.supportedFraction, 0.5);
  assert.equal(m.reliability[8]!.scored, 1);
  close(m.reliability[8]!.supportedFraction, 0);
  assert.deepEqual(
    m.riskCoverage.map((row) => row.findings),
    [3, 2, 1, 0],
  );
  assert.deepEqual(
    m.riskCoverage.map((row) => row.conservativeRisk.value),
    [2 / 3, 0.5, 1, null],
  );
  assert.deepEqual(
    m.riskCoverage.map((row) => row.coverage.value),
    [0.5, 2 / 6, 1 / 6, 0],
  );
  assert.deepEqual(report.families[0]!.metrics, m);
  assert.equal(report.qualityGate, "not-assessed");
  assert.equal(report.calibratedConfidence, false);
  assert.equal(report.independenceVerified, false);
  assert.equal(report.claimsVerified, false);
  assert.equal(report.nativeExecution, false);
});

test("scoring retains unresolved findings missing probabilities endpoint infinite loss and absence of any review without reporting a clean cohort", () => {
  const input = packet();
  input.observations[0]!.probability = null;
  input.observations[1]!.label = "unresolved";
  input.observations[1]!.judgement = "unresolved";
  input.observations[1]!.probability = 0.99;
  input.observations[4]!.probability = 1;
  const report = scoreReviewTrials(input);
  const m = report.aggregate;
  assert.equal(m.precision.denominator, 3);
  assert.equal(m.precision.numerator, 1);
  assert.equal(m.unresolvedFindings, 1);
  assert.equal(m.unknownProbabilities, 1);
  assert.equal(m.properScores.scored, 1);
  assert.equal(m.properScores.unscoredFindings, 2);
  assert.equal(m.properScores.brier, 1);
  assert.equal(m.properScores.negativeLogLikelihood, null);
  assert.equal(m.properScores.infiniteLogLoss, 1);
  assert.equal(m.reliability[9]!.unscored, 1);
  const absent = scoreReviewTrials({ ...input, observations: [] });
  assert.equal(absent.aggregate.statuses.unreviewed, 6);
  assert.equal(absent.aggregate.missingObservations, 6);
  assert.equal(absent.aggregate.completedCoverage.value, 0);
  for (const rate of [
    absent.aggregate.precision,
    absent.aggregate.materialDefectRecall,
    absent.aggregate.falseAlarmRate,
    absent.aggregate.nearMissFalseAlarmRate,
  ])
    assert.equal(rate.value, null);
  assert.equal(absent.aggregate.properScores.brier, null);
  assert.equal(absent.aggregate.properScores.negativeLogLikelihood, null);
  assert.equal(absent.aggregate.oneSided95.precisionLower, null);
  assert.equal(absent.qualityGate, "not-assessed");
});

test("one-sided exact binomial limits need sufficient independent evidence and repeated clusters cannot inherit a finding-level interval", () => {
  assert.equal(reviewBinomialLower95(0, 0), null);
  assert.equal(reviewBinomialLower95(0, 1), 0);
  close(reviewBinomialLower95(1, 1), 0.05);
  close(reviewBinomialLower95(1, 2), 1 - Math.sqrt(0.95));
  close(reviewBinomialLower95(2, 2), Math.sqrt(0.05));
  assert.ok(reviewBinomialLower95(58, 58)! < 0.95);
  assert.ok(reviewBinomialLower95(59, 59)! >= 0.95);
  assert.ok(1 - reviewBinomialLower95(298, 298)! > 0.01);
  assert.ok(1 - reviewBinomialLower95(299, 299)! <= 0.01);
  for (const args of [
    [-1, 1],
    [2, 1],
    [0, -1],
    [1.5, 2],
    [513, 513],
  ])
    assert.throws(() => reviewBinomialLower95(args[0]!, args[1]!));
  const input = packet();
  input.protocol.trials[1]!.clusterId = input.protocol.trials[0]!.clusterId;
  const m = scoreReviewTrials(input).aggregate;
  assert.equal(m.oneSided95.eligible, false);
  assert.equal(m.oneSided95.precisionLower, null);
  assert.equal(m.oneSided95.falseAlarmUpper, null);
  assert.equal(m.oneSided95.nearMissFalseAlarmUpper, null);
  assert.equal(m.precision.value, 1 / 3);
});

test("scoring rejects empty or duplicate assignments out-of-cohort observations contradictory terminal labels and unfrozen thresholds", () => {
  for (const edit of [
    (v: ReturnType<typeof packet>) => {
      v.protocol.trials = [];
    },
    (v: ReturnType<typeof packet>) => {
      v.protocol.trials.push(v.protocol.trials[0]!);
    },
    (v: ReturnType<typeof packet>) => {
      v.observations.push(v.observations[0]!);
    },
    (v: ReturnType<typeof packet>) => {
      v.observations[0]!.id = "NotAssigned";
    },
    (v: ReturnType<typeof packet>) => {
      v.protocol.confidenceThresholds = [0.95, 0.9];
    },
    (v: ReturnType<typeof packet>) => {
      v.protocol.confidenceThresholds = [0.9, 0.9];
    },
    (v: ReturnType<typeof packet>) => {
      v.observations[0]!.status = "budget-exhausted";
    },
    (v: ReturnType<typeof packet>) => {
      v.observations[0]!.label = "valid";
    },
    (v: ReturnType<typeof packet>) => {
      v.observations[0]!.judgement = "none";
    },
    (v: ReturnType<typeof packet>) => {
      v.observations[2]!.probability = 0.99;
    },
    (v: ReturnType<typeof packet>) => {
      v.observations[0]!.probability = 1.01;
    },
  ]) {
    const input = packet();
    edit(input);
    assert.throws(() => scoreReviewTrials(input));
  }
  const input = packet();
  input.observations[1]!.label = "unresolved";
  input.observations[1]!.judgement = "wrong-address";
  assert.equal(
    scoreReviewTrials(input).aggregate.errors,
    2,
    "A wrong claim stays wrong when other defects in its snapshot are unclassified",
  );
});

test("retained scoring projections reconstruct every numerator denominator family bin and confidence bound and hide trial identifiers", () => {
  const run = scoreReviewTrials(packet());
  for (const edit of [
    (v: typeof run) => {
      v.aggregate.precision.numerator = 3;
    },
    (v: typeof run) => {
      v.aggregate.oneSided95.precisionLower = 0.99;
    },
    (v: typeof run) => {
      v.aggregate.statuses.unreviewed = 0;
    },
    (v: typeof run) => {
      v.aggregate.properScores.brier = 0;
    },
    (v: typeof run) => {
      v.aggregate.reliability[9]!.supportedFraction = 1;
    },
    (v: typeof run) => {
      v.aggregate.riskCoverage[0]!.conservativeRisk.value = 0;
    },
    (v: typeof run) => {
      v.families[0]!.metrics.selected = 0;
    },
    (v: typeof run) => {
      v.protocolDigest = "0".repeat(64);
    },
  ]) {
    const bad = structuredClone(run);
    edit(bad);
    assert.throws(() => projectReviewScoring(bad, false));
  }
  const summary = projectReviewScoring(run, false);
  assert.equal(summary.sourceIncluded, false);
  assert.ok(!JSON.stringify(summary).includes("Original_"));
  assert.ok(!JSON.stringify(summary).includes("Cluster_"));
  assert.deepEqual(projectReviewScoring(run, true), run);
});

test("review scoring CLI and MCP return the shared truthful report without inference source grants or project execution", async (t) => {
  const root = await fixture(t, {
    ".checktrail/scoring.json": JSON.stringify(packet()),
    "never-load.mjs": "throw new Error('project code must not execute');\n",
  });
  const binary = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const expected = projectReviewScoring(scoreReviewTrials(packet()), false);
  const cli = spawnSync(
    process.execPath,
    [
      binary,
      "review-score",
      "--root",
      root,
      "--input",
      ".checktrail/scoring.json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), expected);
  const client = new Client(
    { name: "original-synthetic-confidence", version: "1" },
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
  const result = await client.callTool({
    name: "review_score",
    arguments: { input: ".checktrail/scoring.json" },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, expected);
  assert.ok(!JSON.stringify(result).includes(root));
  for (const extra of [
    { allowInference: true },
    { calibratedConfidence: true },
    { qualityGate: "passed" },
    { trusted: true },
  ])
    assert.equal(
      (
        await client.callTool({
          name: "review_score",
          arguments: { input: ".checktrail/scoring.json", ...extra },
        })
      ).isError,
      true,
    );
  await writeFile(
    path.join(root, ".checktrail/scoring.json"),
    JSON.stringify({ protocol: packet().protocol, observations: [] }),
  );
  const missing = await client.callTool({
    name: "review_score",
    arguments: { input: ".checktrail/scoring.json" },
  });
  assert.equal(
    (missing.structuredContent as Record<string, unknown>).qualityGate,
    "not-assessed",
  );
});
