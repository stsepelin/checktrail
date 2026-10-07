import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  fitReviewCalibration,
  applyReviewCalibration,
  projectReviewCalibration,
  projectReviewCalibrationApplication,
  reviewCalibrationInputSchema,
  reviewCalibrationApplicationInputSchema,
} from "../src/review-calibration.js";
import { fixture } from "./helpers.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const packet = () =>
  reviewCalibrationInputSchema.parse({
    schemaVersion: 1,
    profile: "declared-family-isotonic-v1",
    model: {
      client: "OriginalCalibrationClientCanary",
      clientVersion: "fixture-1",
      provider: "OriginalCalibrationProviderCanary",
      model: "OriginalCalibrationModelCanary",
    },
    training: {
      protocol: {
        schemaVersion: 1,
        profile: "declared-claim-probability-v1",
        purpose: "development",
        confidenceThresholds: [0.5, 0.9],
        trials: ["A", "B", "C", "D"].map((id, index) => ({
          id: "OriginalTrainingCanary_" + id,
          clusterId: "OriginalTrainingGroupCanary_" + index,
          family: "identifiers-allowlists",
        })),
      },
      observations: [0.1, 0.2, 0.2, 0.8].map((p, index) => ({
        id: "OriginalTrainingCanary_" + ["A", "B", "C", "D"][index],
        status: "completed",
        decision: "finding",
        probability: p,
        label: "defect",
        judgement: index === 0 || index === 3 ? "supported" : "wrong-mechanism",
      })),
    },
    reservedEvaluation: {
      schemaVersion: 1,
      profile: "declared-claim-probability-v1",
      purpose: "held-out",
      confidenceThresholds: [0.5, 0.9],
      trials: Array.from({ length: 8 }, (_, i) => ({
        id: "OriginalReservedCanary_" + i,
        clusterId: "OriginalReservedGroupCanary_" + i,
        family: i === 6 ? "types-numeric-semantics" : "identifiers-allowlists",
      })),
    },
  });
const application = () => {
  const source = packet();
  return reviewCalibrationApplicationInputSchema.parse({
    schemaVersion: 1,
    profile: "declared-family-isotonic-application-v1",
    model: source.model,
    fit: fitReviewCalibration(source),
    evaluation: {
      protocol: source.reservedEvaluation,
      observations: [0.1, 0.5, 0.8, 0.05, 0.95, null, 0.5].map((p, i) => ({
        id: source.reservedEvaluation.trials[i]!.id,
        status: "completed",
        decision: p === null ? "abstain" : "finding",
        probability: p,
        label: i === 0 || i === 3 ? "defect" : i === 4 ? "unresolved" : "valid",
        judgement:
          p === null
            ? "none"
            : i === 0 || i === 3
              ? "supported"
              : i === 4
                ? "unresolved"
                : "refuted",
      })),
    },
  });
};
const near = (actual: number | null, expected: number) => {
  assert.notEqual(actual, null);
  assert.ok(
    Math.abs(actual! - expected) < 1e-14,
    `${actual} versus ${expected}`,
  );
};
test("calibration pools exact ties with row weights and merges every adjacent violation against hand-computed controls", () => {
  const report = fitReviewCalibration(packet()),
    curve = report.curves[0]!;
  assert.equal(report.state, "available");
  assert.equal(curve.state, "available");
  assert.deepEqual(curve.points, [
    { score: 0.1, count: 1, positives: 1, fittedProbability: 1 / 3 },
    { score: 0.2, count: 2, positives: 0, fittedProbability: 1 / 3 },
    { score: 0.8, count: 1, positives: 1, fittedProbability: 1 },
  ]);
  assert.equal(curve.distinctDeclaredClusters, 4);
  near(report.trainingRaw.aggregate.properScores.brier, 0.2325);
  near(report.trainingMapped.aggregate.properScores.brier, 1 / 6);
  assert.deepEqual(report.accounting, {
    selected: 4,
    eligible: 4,
    missing: 0,
    incomplete: 0,
    abstained: 0,
    unknownJudgement: 0,
    unknownProbability: 0,
  });
  const chain = packet();
  chain.training.protocol.trials = Array.from({ length: 5 }, (_, i) => ({
    ...chain.training.protocol.trials[0]!,
    id: "Chain_" + i,
    clusterId: "ChainCluster_" + i,
  }));
  chain.training.observations = [1, 1, 0, 0, 1].map((y, i) => ({
    ...chain.training.observations[0]!,
    id: "Chain_" + i,
    probability: (i + 1) / 10,
    judgement: y ? "supported" : "refuted",
  }));
  assert.deepEqual(
    fitReviewCalibration(chain).curves[0]!.points!.map(
      (p) => p.fittedProbability,
    ),
    [0.5, 0.5, 0.5, 0.5, 1],
  );
});
test("calibration keeps one-class sparse and constant predictors unavailable separately for every declared family", () => {
  const sparse = packet();
  sparse.training.observations = sparse.training.observations.slice(0, 1);
  assert.equal(
    fitReviewCalibration(sparse).curves[0]!.state,
    "insufficient-training",
  );
  const one = packet();
  one.training.observations = one.training.observations.map((o) => ({
    ...o,
    judgement: "supported",
  }));
  assert.equal(fitReviewCalibration(one).curves[0]!.state, "one-class");
  const constant = packet();
  constant.training.observations = constant.training.observations.map((o) => ({
    ...o,
    probability: 0.4,
  }));
  assert.equal(
    fitReviewCalibration(constant).curves[0]!.state,
    "constant-predictor",
  );
  const separate = packet();
  separate.training.protocol.trials[0]!.family = "authorization-tenancy";
  separate.training.protocol.trials[3]!.family = "authorization-tenancy";
  const families = fitReviewCalibration(separate);
  assert.equal(families.state, "unavailable");
  assert.deepEqual(
    families.curves.map((c) => c.state),
    ["one-class", "one-class"],
  );
  assert.ok(families.curves.every((c) => c.points === null));
  const partial = packet();
  partial.training.protocol.trials[2]!.family = "types-numeric-semantics";
  assert.equal(fitReviewCalibration(partial).state, "partial");
});
test("calibration accounting partitions every selected missing incomplete abstained unknown and eligible claim without training on unresolved outcomes", () => {
  const input = packet();
  for (let i = 0; i < 5; i++)
    input.training.protocol.trials.push({
      ...input.training.protocol.trials[0]!,
      id: "OriginalUnscored_" + i,
      clusterId: "OriginalUnscoredCluster_" + i,
    });
  const base = input.training.observations[0]!;
  input.training.observations.push(
    {
      ...base,
      id: "OriginalUnscored_1",
      status: "budget-exhausted",
      decision: "abstain",
      probability: null,
      judgement: "none",
    },
    {
      ...base,
      id: "OriginalUnscored_2",
      decision: "abstain",
      probability: null,
      judgement: "none",
    },
    {
      ...base,
      id: "OriginalUnscored_3",
      judgement: "unresolved",
      probability: 0.95,
    },
    { ...base, id: "OriginalUnscored_4", probability: null },
  );
  const report = fitReviewCalibration(input);
  assert.deepEqual(report.accounting, {
    selected: 9,
    eligible: 4,
    missing: 1,
    incomplete: 1,
    abstained: 1,
    unknownJudgement: 1,
    unknownProbability: 1,
  });
  assert.equal(
    Object.entries(report.accounting)
      .filter(([key]) => key !== "selected")
      .reduce((n, [, v]) => n + v, 0),
    report.accounting.selected,
  );
  assert.deepEqual(
    report.curves[0]!.points,
    fitReviewCalibration(packet()).curves[0]!.points,
  );
  assert.equal(report.trainingRaw.aggregate.selected, 9);
  assert.equal(report.trainingRaw.aggregate.properScores.scored, 4);
  assert.equal(report.trainingRaw.aggregate.properScores.unscoredFindings, 2);
  assert.equal(report.trainingMapped.aggregate.selected, 9);
  assert.equal(report.trainingMapped.aggregate.findings, 6);
});
test("calibration application preserves findings missing slots certainty errors and exact support boundaries without extrapolation or cross-family transfer", () => {
  const input = application(),
    report = applyReviewCalibration(input);
  assert.deepEqual(report.mappings, {
    observed: 7,
    available: 3,
    notAFinding: 1,
    unknownProbability: 0,
    unseenFamily: 1,
    fitUnavailable: 0,
    outsideTrainingSupport: 2,
  });
  near(report.rows[0]!.mappedProbability, 1 / 3);
  near(report.rows[1]!.mappedProbability, 2 / 3);
  assert.equal(report.rows[2]!.mappedProbability, 1);
  assert.equal(report.rows[3]!.state, "outside-training-support");
  assert.equal(report.rows[4]!.state, "outside-training-support");
  assert.equal(report.rows[6]!.state, "unseen-family");
  for (const index of [3, 4, 6])
    assert.equal(report.rows[index]!.mappedProbability, null);
  assert.equal(report.raw.aggregate.selected, 8);
  assert.equal(report.mapped.aggregate.selected, 8);
  assert.equal(report.raw.aggregate.findings, 6);
  assert.equal(report.mapped.aggregate.findings, 6);
  assert.equal(report.mapped.aggregate.missingObservations, 1);
  assert.equal(report.mapped.aggregate.properScores.scored, 3);
  assert.equal(report.mapped.aggregate.properScores.infiniteLogLoss, 1);
  assert.equal(
    report.mapped.aggregate.properScores.negativeLogLikelihood,
    null,
  );
  assert.equal(report.mapped.aggregate.precision.value, 1 / 3);
  assert.deepEqual(report.mapped.aggregate.falseAlarmRate, {
    numerator: 3,
    denominator: 4,
    value: 0.75,
  });
  assert.deepEqual(
    report.mapped.aggregate.falseAlarmRate,
    report.raw.aggregate.falseAlarmRate,
  );
  const boundary = application();
  boundary.evaluation.observations[0]!.probability = 0.1 - Number.EPSILON;
  boundary.evaluation.observations[2]!.probability = 0.8 + Number.EPSILON;
  const outside = applyReviewCalibration(boundary);
  assert.equal(outside.rows[0]!.mappedProbability, null);
  assert.equal(outside.rows[2]!.mappedProbability, null);
  const unavailable = application();
  unavailable.fit.input.training.observations =
    unavailable.fit.input.training.observations.map((o) => ({
      ...o,
      judgement: "supported",
    }));
  unavailable.fit = fitReviewCalibration(unavailable.fit.input);
  assert.equal(applyReviewCalibration(unavailable).mappings.fitUnavailable, 5);
  const unknown = application();
  unknown.evaluation.observations[0]!.probability = null;
  assert.equal(applyReviewCalibration(unknown).mappings.unknownProbability, 1);
});
test("calibration refuses overlapping trial and cluster splits held-out training changed model protocols duplicates and unbounded inputs", () => {
  const sharedTrial = packet();
  sharedTrial.reservedEvaluation.trials[0]!.id =
    sharedTrial.training.protocol.trials[0]!.id;
  assert.throws(() => fitReviewCalibration(sharedTrial), /overlap/);
  const sharedGroup = packet();
  sharedGroup.reservedEvaluation.trials[0]!.clusterId =
    sharedGroup.training.protocol.trials[0]!.clusterId;
  assert.throws(() => fitReviewCalibration(sharedGroup), /overlap/);
  const held = packet();
  held.training.protocol.purpose = "held-out";
  assert.throws(() => fitReviewCalibration(held), /development/);
  const wrong = application();
  wrong.model.model = "ForeignModel";
  assert.throws(() => applyReviewCalibration(wrong), /model or reserved/);
  const protocol = application();
  protocol.evaluation.protocol.confidenceThresholds = [0.1];
  assert.throws(() => applyReviewCalibration(protocol), /model or reserved/);
  const duplicate = packet();
  duplicate.training.observations.push(duplicate.training.observations[0]!);
  assert.throws(() => fitReviewCalibration(duplicate), /identities/);
  const thresholds = packet();
  thresholds.training.protocol.confidenceThresholds = [0.9, 0.5];
  assert.throws(() => fitReviewCalibration(thresholds), /thresholds/);
  assert.throws(() =>
    fitReviewCalibration({ ...packet(), trustProject: true }),
  );
  const maximum = packet();
  maximum.training.protocol.trials = Array.from({ length: 512 }, (_, i) => ({
    ...maximum.training.protocol.trials[0]!,
    id: "Bound_" + i,
    clusterId: "BoundCluster_" + i,
  }));
  maximum.training.observations = maximum.training.protocol.trials.map(
    (t, i) => ({
      ...maximum.training.observations[0]!,
      id: t.id,
      probability: i / 511,
      judgement: i % 2 ? "supported" : "refuted",
    }),
  );
  const fitted = fitReviewCalibration(maximum);
  assert.equal(fitted.accounting.eligible, 512);
  assert.equal(fitted.curves[0]!.points!.length, 512);
  maximum.training.protocol.trials.push({
    ...maximum.training.protocol.trials[0]!,
    id: "OverLimit",
  });
  assert.throws(() => fitReviewCalibration(maximum));
  const nearMiss = packet();
  nearMiss.reservedEvaluation.trials[0]!.clusterId =
    nearMiss.training.protocol.trials[0]!.clusterId + "Suffix";
  assert.equal(fitReviewCalibration(nearMiss).state, "available");
});
test("calibration canonical identities and recomputed projections reject forged knots accounting application metrics and retained mappings", () => {
  const input = packet(),
    fit = fitReviewCalibration(input);
  input.training.protocol.trials.reverse();
  input.training.observations.reverse();
  input.reservedEvaluation.trials.reverse();
  assert.deepEqual(fitReviewCalibration(input), fit);
  const forged = structuredClone(fit);
  forged.curves[0]!.points![0]!.fittedProbability = 0.9;
  assert.throws(
    () => projectReviewCalibration(forged, false),
    /do not reconcile/,
  );
  const attempt = application();
  attempt.fit = forged;
  assert.throws(() => applyReviewCalibration(attempt), /do not reconcile/);
  const counts = structuredClone(fit);
  counts.accounting.eligible = 0;
  assert.throws(
    () => projectReviewCalibration(counts, true),
    /do not reconcile/,
  );
  const result = applyReviewCalibration(application());
  const changed = structuredClone(result);
  changed.mapped.aggregate.supported = 0;
  assert.throws(
    () => projectReviewCalibrationApplication(changed, false),
    /do not reconcile/,
  );
  const mapping = structuredClone(result);
  mapping.rows[0]!.mappedProbability = 0;
  assert.throws(
    () => projectReviewCalibrationApplication(mapping, true),
    /do not reconcile/,
  );
  for (const summary of [
    projectReviewCalibration(fit, false),
    projectReviewCalibrationApplication(result, false),
  ]) {
    assert.equal(JSON.stringify(summary).includes("Canary"), false);
    assert.equal(summary.calibratedConfidence, false);
    assert.equal(summary.splitIsolationVerified, false);
    assert.equal(summary.qualityGate, "not-assessed");
    assert.ok("sourceIncluded" in summary);
    assert.equal(summary.sourceIncluded, false);
  }
  assert.deepEqual(projectReviewCalibration(fit, true), fit);
  assert.deepEqual(projectReviewCalibrationApplication(result, true), result);
});
test("calibration CLI and MCP share bounded read-only fitting and application without source execution trust or model inference", async (t) => {
  const fitInput = packet(),
    applyInput = application(),
    root = await fixture(t, {
      ".checktrail/fit.json": JSON.stringify(fitInput),
      ".checktrail/apply.json": JSON.stringify(applyInput),
      "never-load.mjs":
        "throw new Error('Original calibration must not evaluate project source');\n",
    });
  for (const detailed of [false, true]) {
    const client = new Client({
      name: "original-calibration-client",
      version: "1",
    });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            cli,
            "serve",
            "--root",
            root,
            ...(detailed ? ["--detailed"] : []),
          ],
          stderr: "pipe",
        }),
      );
      for (const [mode, input, expected] of [
        [
          "fit",
          ".checktrail/fit.json",
          projectReviewCalibration(fitReviewCalibration(fitInput), detailed),
        ],
        [
          "apply",
          ".checktrail/apply.json",
          projectReviewCalibrationApplication(
            applyReviewCalibration(applyInput),
            detailed,
          ),
        ],
      ] as const) {
        const result = spawnSync(
          process.execPath,
          [
            cli,
            "review-calibration-" + mode,
            "--root",
            root,
            "--input",
            input,
            ...(detailed ? ["--detailed"] : []),
          ],
          { encoding: "utf8", maxBuffer: 1048576 },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), expected);
        const reply = await client.callTool({
          name: "review_calibration_" + mode,
          arguments: { input },
        });
        assert.equal(reply.isError, undefined);
        assert.deepEqual(reply.structuredContent, expected);
        assert.equal(expected.inferenceInvoked, false);
        assert.equal(expected.nativeExecution, false);
        const denied = await client.callTool({
          name: "review_calibration_" + mode,
          arguments: { input, trustProject: true },
        });
        assert.equal(denied.isError, true);
        const escaped = await client.callTool({
          name: "review_calibration_" + mode,
          arguments: { input: "../private-calibration.json" },
        });
        assert.equal(escaped.isError, true);
      }
    } finally {
      await client.close();
    }
  }
  await writeFile(
    path.join(root, ".checktrail/fit.json"),
    JSON.stringify({
      ...fitInput,
      training: {
        ...fitInput.training,
        protocol: { ...fitInput.training.protocol, purpose: "held-out" },
      },
    }),
  );
  const refused = spawnSync(
    process.execPath,
    [
      cli,
      "review-calibration-fit",
      "--root",
      root,
      "--input",
      ".checktrail/fit.json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /development training/);
});
