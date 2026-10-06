import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  scoreMultiClaimReviewTrials,
  projectMultiClaimReviewScoring,
  reviewMultiInputSchema,
} from "../src/review-multi-scoring.js";
import { fixture } from "./helpers.js";
export const packet = () =>
  reviewMultiInputSchema.parse({
    protocol: {
      schemaVersion: 1,
      profile: "declared-multi-claim-paired-v1",
      purpose: "development",
      seed: "a".repeat(64),
      resamples: 128,
      confidenceLevel: 0.95,
      trials: [
        { id: "broken", clusterId: "incident-1" },
        { id: "valid", clusterId: "incident-1" },
        { id: "near", clusterId: "incident-2" },
      ],
    },
    labels: [
      {
        id: "broken",
        label: "defect",
        defects: [
          { id: "d1", family: "authorization-tenancy", material: true },
          { id: "d2", family: "types-numeric-semantics", material: true },
          { id: "d3", family: "lifecycle-ordering", material: false },
        ],
      },
      { id: "valid", label: "valid", defects: [] },
      { id: "near", label: "near-miss", defects: [] },
    ],
    observations: {
      a: [
        {
          id: "broken",
          status: "completed",
          claims: [
            {
              id: "c1",
              family: "authorization-tenancy",
              judgement: "supported",
              defectId: "d1",
              probability: 0.8,
            },
            {
              id: "c2",
              family: "authorization-tenancy",
              judgement: "supported",
              defectId: "d1",
              probability: 0.9,
            },
            {
              id: "c3",
              family: "types-numeric-semantics",
              judgement: "supported",
              defectId: "d2",
              probability: 1,
            },
            {
              id: "c4",
              family: "lifecycle-ordering",
              judgement: "supported",
              defectId: "d3",
              probability: null,
            },
            {
              id: "c5",
              family: "authorization-tenancy",
              judgement: "wrong-mechanism",
              defectId: null,
              probability: 0.2,
            },
          ],
        },
        {
          id: "valid",
          status: "completed",
          claims: [
            {
              id: "v1",
              family: "authorization-tenancy",
              judgement: "refuted",
              defectId: null,
              probability: 0.3,
            },
          ],
        },
        {
          id: "near",
          status: "completed",
          claims: [
            {
              id: "n1",
              family: "authorization-tenancy",
              judgement: "wrong-address",
              defectId: null,
              probability: 0.1,
            },
          ],
        },
      ],
      b: [
        {
          id: "broken",
          status: "completed",
          claims: [
            {
              id: "b1",
              family: "authorization-tenancy",
              judgement: "supported",
              defectId: "d1",
              probability: 0.5,
            },
          ],
        },
        { id: "valid", status: "completed", claims: [] },
        { id: "near", status: "completed", claims: [] },
      ],
    },
  });
const close = (actual: number | null, expected: number) => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < 1e-12, `${actual} != ${expected}`);
};
test("multi-claim scoring counts every disposition deduplicates common defects and preserves hand-computed precision recall and probabilities", () => {
  const report = scoreMultiClaimReviewTrials(packet()),
    { a, b } = report.aggregate.arms;
  assert.equal(report.aggregate.knownDefects, 3);
  assert.equal(report.aggregate.knownMaterialDefects, 2);
  assert.equal(a.completedClaims, 7);
  assert.equal(a.retainedClaims, 7);
  assert.equal(a.unscoredClaims, 0);
  assert.equal(a.supportedClaims, 4);
  assert.equal(a.uniqueSupportedDefects, 3);
  assert.equal(a.duplicateSupportedClaims, 1);
  assert.equal(a.dispositions["wrong-mechanism"], 1);
  assert.equal(a.dispositions["wrong-address"], 1);
  assert.equal(a.dispositions.refuted, 1);
  assert.equal(a.resolvedErrors, 3);
  assert.deepEqual(a.supportedClaimPrecision, {
    numerator: 4,
    denominator: 7,
    value: 4 / 7,
  });
  assert.deepEqual(a.uniqueDefectPrecision, {
    numerator: 3,
    denominator: 7,
    value: 3 / 7,
  });
  assert.deepEqual(a.materialDefectRecall, {
    numerator: 2,
    denominator: 2,
    value: 1,
  });
  assert.deepEqual(b.materialDefectRecall, {
    numerator: 1,
    denominator: 2,
    value: 0.5,
  });
  assert.equal(a.falseAlarmRate.value, 1);
  assert.equal(a.nearMissFalseAlarmRate.value, 1);
  assert.equal(b.falseAlarmRate.value, 0);
  assert.equal(b.nearMissFalseAlarmRate.value, 0);
  assert.equal(a.properScores.scored, 6);
  assert.equal(a.properScores.unscoredClaims, 1);
  assert.equal(a.properScores.unknownProbabilities, 1);
  close(a.properScores.brier, 0.19 / 6);
  close(
    a.properScores.negativeLogLikelihood,
    (-Math.log(0.8) -
      Math.log(0.9) -
      Math.log(1) -
      Math.log(0.8) -
      Math.log(0.7) -
      Math.log(0.9)) /
      6,
  );
  const duplicate = packet();
  duplicate.observations.a[0]!.claims.push({
    ...duplicate.observations.a[0]!.claims[0]!,
    id: "c6",
  });
  const next = scoreMultiClaimReviewTrials(duplicate).aggregate.arms.a;
  assert.equal(next.materialDefectRecall.value, a.materialDefectRecall.value);
  assert.equal(next.uniqueSupportedDefects, 3);
  assert.equal(next.duplicateSupportedClaims, 2);
  assert.equal(next.uniqueDefectPrecision.value, 3 / 8);
});
test("multi-claim scoring retains missing incomplete cancelled and unknown label slots without scoring prefixes or favorable declarations", () => {
  for (const status of [
    "incomplete",
    "unsupported",
    "budget-exhausted",
    "stale",
    "cancelled",
  ] as const) {
    const input = packet();
    input.observations.a[0]!.status = status;
    const report = scoreMultiClaimReviewTrials(input),
      a = report.aggregate.arms.a;
    assert.equal(report.aggregate.completePairs, 2, status);
    assert.equal(a.retainedClaims, 7, status);
    assert.equal(a.unscoredClaims, 5, status);
    assert.equal(a.completedClaims, 2, status);
    assert.equal(a.supportedClaims, 0, status);
    assert.equal(a.materialDefectRecall.numerator, 0, status);
    assert.equal(a.materialDefectRecall.denominator, 2, status);
    assert.equal(a.properScores.scored, 2, status);
    assert.equal(a.completedCoverage.value, 2 / 3, status);
  }
  const missing = packet();
  missing.observations.a = [];
  const a = scoreMultiClaimReviewTrials(missing).aggregate.arms.a;
  assert.equal(a.missingObservations, 3);
  assert.equal(a.completedCoverage.value, 0);
  assert.equal(a.materialDefectRecall.value, 0);
  assert.equal(a.supportedClaimPrecision.value, null);
  assert.equal(a.falseAlarmRate.value, null);
  for (const mode of ["missing", "unresolved"]) {
    const input = packet();
    if (mode === "missing") input.labels.shift();
    else input.labels[0] = { id: "broken", label: "unresolved", defects: [] };
    const report = scoreMultiClaimReviewTrials(input),
      a = report.aggregate.arms.a;
    assert.equal(a.supportedClaims, 0);
    assert.equal(a.unresolvedClaims, 5);
    assert.equal(a.completedClaims, 7);
    assert.equal(a.properScores.scored, 2);
    assert.equal(a.materialDefectRecall.value, null);
    assert.equal(report.aggregate.missingLabels, Number(mode === "missing"));
    assert.equal(
      report.aggregate.unresolvedLabels,
      Number(mode === "unresolved"),
    );
    assert.equal(report.qualityGate, "not-assessed");
  }
});
test("multi-claim scoring resamples whole unequal incident clusters together and refuses undefined or degenerate intervals", () => {
  const input = packet();
  input.observations.b[2]!.claims = [
    {
      id: "n2",
      family: "authorization-tenancy",
      judgement: "refuted",
      defectId: null,
      probability: 0.1,
    },
  ];
  const report = scoreMultiClaimReviewTrials(input);
  assert.equal(report.aggregate.clusters, 2);
  assert.equal(report.aggregate.repeatedClusters, 1);
  const precision = report.aggregate.differences.find(
    (r) => r.metric === "supportedClaimPrecision",
  )!;
  close(precision.differenceBMinusA, -1 / 14);
  assert.equal(precision.bootstrap.state, "available");
  close(precision.bootstrap.interval!.lower, -1 / 14);
  close(precision.bootstrap.interval!.upper, 1 / 3);
  assert.equal(precision.bootstrap.validResamples, 128);
  assert.equal(precision.bootstrap.undefinedResamples, 0);
  const incomplete = scoreMultiClaimReviewTrials(
    packet(),
  ).aggregate.differences.find((r) => r.metric === "supportedClaimPrecision")!;
  assert.equal(incomplete.bootstrap.state, "undefined-resamples");
  assert.ok(incomplete.bootstrap.undefinedResamples > 0);
  assert.equal(incomplete.bootstrap.interval, null);
  const coverage = report.aggregate.differences.find(
    (r) => r.metric === "completedCoverage",
  )!;
  assert.equal(coverage.bootstrap.state, "degenerate");
  assert.equal(coverage.bootstrap.interval, null);
  const single = packet();
  single.protocol.trials.forEach((r) => (r.clusterId = "one"));
  assert.ok(
    scoreMultiClaimReviewTrials(single).aggregate.differences.every(
      (r) => r.bootstrap.state === "insufficient-clusters",
    ),
  );
  const empty = packet();
  for (const arm of [empty.observations.a, empty.observations.b])
    arm.forEach((r) => (r.claims = []));
  const absent = scoreMultiClaimReviewTrials(empty).aggregate.differences.find(
    (r) => r.metric === "supportedClaimPrecision",
  )!;
  assert.equal(absent.bootstrap.state, "undefined-point");
  assert.equal(absent.bootstrap.interval, null);
});
test("multi-claim probabilities preserve exact zero one unknown and infinite loss without inventing calibration or cross-arm proper scores", () => {
  const input = packet();
  input.observations.a[0]!.claims[0]!.probability = 0;
  input.observations.a[0]!.claims[4]!.probability = 1;
  const report = scoreMultiClaimReviewTrials(input),
    a = report.aggregate.arms.a;
  assert.equal(a.properScores.infiniteLogLoss, 2);
  assert.equal(a.properScores.negativeLogLikelihood, null);
  assert.equal(a.properScores.scored, 6);
  close(a.properScores.brier, 2.11 / 6);
  assert.equal(report.calibratedConfidence, false);
  assert.equal(report.claimsVerified, false);
  assert.equal(report.labelsVerified, false);
  assert.equal(report.independenceVerified, false);
  assert.equal(report.pairingVerified, false);
  assert.equal(report.qualityGate, "not-assessed");
  assert.equal(
    report.properScoreComparison,
    "not-computed-different-submitted-claims",
  );
});
test("multi-claim scoring rejects foreign duplicate contradictory family and unmapped identities while accepting exact bounded near misses", () => {
  const changes = [
    (p: ReturnType<typeof packet>) =>
      p.protocol.trials.push(p.protocol.trials[0]!),
    (p: ReturnType<typeof packet>) => p.labels.push(p.labels[0]!),
    (p: ReturnType<typeof packet>) =>
      p.observations.a.push(p.observations.a[0]!),
    (p: ReturnType<typeof packet>) =>
      p.labels[0]!.defects.push(p.labels[0]!.defects[0]!),
    (p: ReturnType<typeof packet>) =>
      p.observations.a[0]!.claims.push(p.observations.a[0]!.claims[0]!),
    (p: ReturnType<typeof packet>) => (p.observations.a[0]!.id = "foreign"),
    (p: ReturnType<typeof packet>) =>
      (p.observations.a[0]!.claims[0]!.defectId = "d1-suffix"),
    (p: ReturnType<typeof packet>) =>
      (p.observations.a[0]!.claims[0]!.family = "atomic-artifacts"),
    (p: ReturnType<typeof packet>) =>
      (p.observations.a[0]!.claims[0]!.defectId = null),
    (p: ReturnType<typeof packet>) =>
      (p.observations.a[0]!.claims[4]!.defectId = "d1"),
    (p: ReturnType<typeof packet>) => (p.labels[0]!.label = "valid"),
    (p: ReturnType<typeof packet>) => (p.labels[0]!.defects = []),
    (p: ReturnType<typeof packet>) =>
      (p.observations.a[0]!.status = "unreviewed"),
    (p: ReturnType<typeof packet>) =>
      (p.observations.a[0]!.claims[0]!.probability = NaN),
    (p: ReturnType<typeof packet>) =>
      (p.observations.a[0]!.claims[0]!.probability = 1.001),
  ];
  for (const [i, change] of changes.entries()) {
    const input = packet();
    change(input);
    assert.throws(
      () => scoreMultiClaimReviewTrials(input),
      Error,
      `invalid input ${i}`,
    );
  }
  const valid = packet();
  valid.observations.a[0]!.claims[0]!.id = "constructor";
  valid.labels[0]!.defects[0]!.id = "constructor";
  valid.observations.a[0]!.claims[0]!.defectId = "constructor";
  valid.observations.a[0]!.claims[1]!.defectId = "constructor";
  valid.observations.b[0]!.claims[0]!.defectId = "constructor";
  assert.equal(
    scoreMultiClaimReviewTrials(valid).aggregate.arms.a.materialDefectRecall
      .value,
    1,
  );
  const bulk = packet();
  bulk.protocol.trials = [];
  bulk.labels = [];
  bulk.observations = { a: [], b: [] };
  for (let i = 0; i < 22; i++) {
    const id = `case${i}`;
    bulk.protocol.trials.push({ id, clusterId: "one" });
    bulk.labels.push({ id, label: "valid", defects: [] });
    bulk.observations.a.push({
      id,
      status: "completed",
      claims: Array.from({ length: i === 21 ? 64 : 192 }, (_, j) => ({
        id: `claim${j}`,
        family: "authorization-tenancy",
        judgement: "refuted",
        defectId: null,
        probability: null,
      })),
    });
  }
  assert.equal(
    scoreMultiClaimReviewTrials(bulk).aggregate.arms.a.completedClaims,
    4096,
  );
  bulk.observations.a.at(-1)!.claims.push({
    ...bulk.observations.a.at(-1)!.claims[0]!,
    id: "over-bound",
  });
  assert.throws(() => scoreMultiClaimReviewTrials(bulk), /budget exceeded/);
});
test("multi-claim projections bind canonical all-claim evidence reject forged metrics and withhold private identifiers", () => {
  const input = packet(),
    report = scoreMultiClaimReviewTrials(input);
  input.protocol.trials.reverse();
  input.labels.reverse();
  input.labels.forEach((l) => l.defects.reverse());
  for (const arm of [input.observations.a, input.observations.b]) {
    arm.reverse();
    arm.forEach((r) => r.claims.reverse());
  }
  assert.deepEqual(scoreMultiClaimReviewTrials(input), report);
  const forged = structuredClone(report);
  forged.aggregate.arms.a.uniqueDefectPrecision.numerator = 4;
  assert.throws(
    () => projectMultiClaimReviewScoring(forged, false),
    /do not reconcile/,
  );
  const changed = structuredClone(report);
  changed.input.observations.a[0]!.claims[0]!.probability = 0.1;
  assert.throws(
    () => projectMultiClaimReviewScoring(changed, false),
    /do not reconcile/,
  );
  const summary = projectMultiClaimReviewScoring(report, false);
  assert.equal(summary.sourceIncluded, false);
  assert.equal(Object.hasOwn(summary, "input"), false);
  assert.ok(!JSON.stringify(summary).includes('"d1"'));
  assert.deepEqual(projectMultiClaimReviewScoring(report, true), report);
});
test("multi-claim CLI and MCP share the numerical engine preserve incomplete denominators and cannot grant source execution or quality", async (t) => {
  const input = packet(),
    root = await fixture(t, {
      ".checktrail/multi.json": JSON.stringify(input),
      "never-load.mjs": "throw new Error('must never execute project code');",
    });
  const binary = fileURLToPath(new URL("../src/cli.js", import.meta.url)),
    expected = projectMultiClaimReviewScoring(
      scoreMultiClaimReviewTrials(input),
      false,
    );
  const cli = spawnSync(
    process.execPath,
    [
      binary,
      "review-multi-score",
      "--root",
      root,
      "--input",
      ".checktrail/multi.json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), expected);
  const client = new Client(
    { name: "original-multi-claim-client", version: "1" },
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
  assert.equal(
    (await client.listTools()).tools.find(
      (x) => x.name === "review_multi_score",
    )!.annotations?.readOnlyHint,
    true,
  );
  const result = await client.callTool({
    name: "review_multi_score",
    arguments: { input: ".checktrail/multi.json" },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, expected);
  assert.ok(!JSON.stringify(result).includes(root));
  for (const extra of [
    { trusted: true },
    { allowInference: true },
    { qualityGate: "passed" },
    { independenceVerified: true },
    { detailed: true },
  ])
    assert.equal(
      (
        await client.callTool({
          name: "review_multi_score",
          arguments: { input: ".checktrail/multi.json", ...extra },
        })
      ).isError,
      true,
    );
  await writeFile(
    path.join(root, ".checktrail/multi.json"),
    JSON.stringify({ ...input, observations: { a: [], b: [] } }),
  );
  const missing = await client.callTool({
    name: "review_multi_score",
    arguments: { input: ".checktrail/multi.json" },
  });
  assert.equal(missing.isError, undefined);
  assert.deepEqual(
    missing.structuredContent,
    projectMultiClaimReviewScoring(
      scoreMultiClaimReviewTrials({ ...input, observations: { a: [], b: [] } }),
      false,
    ),
  );
});
