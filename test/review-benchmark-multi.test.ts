import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import path from "node:path";

import { test, type TestContext } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { freezeReviewBenchmark } from "../src/review-benchmark.js";
import {
  reviewBenchmarkMultiScoreReportSchema,
  reviewBenchmarkMultiScoreSummarySchema,
  reviewBenchmarkMatchingPacketSchema,
  reviewBenchmarkMatchingResponseSchema,
  reviewBenchmarkMappingArchiveSchema,
  reviewBenchmarkMatchingWorkerSummarySchema,
} from "../src/review-benchmark-schema.js";

import {
  cli,
  prepare,
  runTrial,
  noPrivate,
  privateJson,
  judgmentResponse,
  putJudgment,
  judgmentArchive,
  privateCase,
  privateGroup,
  type Prepared,
} from "./review-benchmark-fixture.js";
async function prepareMulti(
  t: TestContext,
  count = 1,
  repetitions = 1,
  omitLast = false,
  incompleteLast = false,
  dispositions?: NonNullable<
    import("../src/review-benchmark-schema.js").ReviewBenchmarkJudgmentResponse["output"]
  >["claims"][number]["judgement"][],
  candidateCount = 3,
) {
  const f = await prepare(
    t,
    count,
    repetitions,
    true,
    true,
    false,
    "identifiers-allowlists",
    true,
  );
  for (let i = 0; i < f.manifest.trials.length; i++) {
    if (omitLast && i === f.manifest.trials.length - 1) continue;
    await runTrial(
      t,
      f,
      i,
      candidateCount ? "native" : "empty",
      `fresh-multi-review-${i}`,
      undefined,
      undefined,
      candidateCount,
      {
        profile: "declared-claim-support-probability-v1",
        event: "supported-in-scope-actionable",
        probability: 0.8,
        calibratedConfidence: false,
      },
    );
    if (incompleteLast && i === f.manifest.trials.length - 1) {
      const file = f.benchmark.trialSetup(f.manifest.trials[i]!.trialId).audit
        .file;
      const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
      // Remove the final seal only: retained successful reviewer submissions remain a reached prefix.
      await writeFile(file, lines.slice(0, -1).join("\n") + "\n", {
        mode: 0o600,
      });
    }
  }
  f.benchmark.collect();
  f.benchmark.prepareJudging();
  for (const trial of f.manifest.trials) {
    const value = judgmentResponse(f, trial.blindId);
    value.output!.label =
      trial.caseIndex === 0
        ? "defect"
        : trial.caseIndex === 1
          ? "valid"
          : "near-miss";
    if (trial.caseIndex > 0)
      for (const c of value.output!.claims) c.judgement = "refuted";
    if (dispositions)
      value.output!.claims.forEach((claim, i) => {
        claim.judgement = dispositions[trial.armIndex * 3 + i]!;
      });
    await putJudgment(f, trial.blindId, value);
  }
  f.benchmark.sealJudgments();
  f.benchmark.prepareMatching();
  return f;
}
function matchingResponse(f: Prepared, matchingId: string) {
  const packet = reviewBenchmarkMatchingPacketSchema.parse(
    f.benchmark.matcherWorkerCommand({ operation: "packet" }, true, matchingId),
  );
  return reviewBenchmarkMatchingResponseSchema.parse({
    schemaVersion: 1,
    matchingId,
    assignmentDigest: packet.assignmentDigest,
    host: {
      ...f.plan.multiScoring!.matching.host,
      sessionId: randomUUID(),
      isolation: "fresh",
    },
    status: "completed",
    usage: {
      inputTokens: null,
      outputTokens: null,
      durationMs: null,
      costUSD: null,
    },
    output: packet.claims.map((c, i) => ({
      claimId: c.claimId,
      match: packet.defects.length ? "defect" : "none",
      defectId: packet.defects.length
        ? packet.defects[i === 2 ? 1 : 0]!.id
        : null,
      rationale: "Original source-bound synthetic curation declaration.",
      citations: c.candidate.citations.map((c) => structuredClone(c)),
    })),
  });
}
async function putMapping(f: Prepared, matchingId: string, value: unknown) {
  await privateJson(f.benchmark.matcherSetup(matchingId).file, value);
}
async function mapAll(f: Prepared) {
  for (const trial of f.manifest.trials)
    await putMapping(
      f,
      trial.matchingId!,
      matchingResponse(f, trial.matchingId!),
    );
  f.benchmark.sealMappings();
}
async function mappingArchive(f: Prepared) {
  return reviewBenchmarkMappingArchiveSchema.parse(
    JSON.parse(
      await readFile(
        path.join(f.reference.directory, "mappings-sealed.json"),
        "utf8",
      ),
    ),
  );
}

test("benchmark multi-claim freeze rejects incomplete foreign duplicate or contradictory common inventories before writing and keeps single-claim intake", async (t) => {
  const f = await prepare(
      t,
      3,
      1,
      true,
      true,
      false,
      "identifiers-allowlists",
      true,
    ),
    settings = f.plan.multiScoring!;
  assert.throws(() => f.benchmark.prepareMatching(), /sealed/);
  assert.throws(() => f.benchmark.scoreMulti(), /sealed/);
  for (const change of [
    { judging: undefined },
    {
      scoring: {
        profile: "sealed-single-claim-paired-synthetic-v1",
        seed: "b".repeat(64),
        resamples: 128,
        confidenceLevel: 0.95,
        cases: f.plan.cases.map((c) => ({
          id: c.id,
          family: "identifiers-allowlists",
        })),
      },
    },
    { multiScoring: { ...settings, cases: settings.cases.slice(1) } },
    {
      multiScoring: {
        ...settings,
        cases: [settings.cases[0], settings.cases[0], settings.cases[2]],
      },
    },
    {
      multiScoring: {
        ...settings,
        cases: settings.cases.map((c, i) =>
          i ? c : { ...c, defects: [c.defects[0], c.defects[0]] },
        ),
      },
    },
    {
      multiScoring: {
        ...settings,
        cases: settings.cases.map((c, i) =>
          i
            ? c
            : {
                ...c,
                defects: [
                  { ...c.defects[0], id: "ForeignCommonDefect" },
                  c.defects[1],
                ],
              },
        ),
      },
    },
    {
      cases: f.plan.cases.map((c, i) =>
        i === 1
          ? {
              ...c,
              labels: {
                ...c.labels,
                expectedDefects: [
                  {
                    id: "ForeignValidDefect",
                    claim: "Invalid positive inventory.",
                  },
                ],
              },
            }
          : c,
      ),
    },
    { multiScoring: { ...settings, seed: "unknown" } },
  ]) {
    const target = path.join(f.operator, randomUUID());
    assert.throws(() =>
      freezeReviewBenchmark(f.cases[0]!.root, { ...f.plan, ...change }, target),
    );
    await assert.rejects(stat(target), { code: "ENOENT" });
  }
  const legacy = await prepare(t);
  assert.throws(() => legacy.benchmark.scoreMulti(), /frozen/);
  const ids = f.manifest.trials.flatMap((r) => [
    r.trialId,
    r.blindId,
    r.matchingId!,
  ]);
  assert.equal(new Set(ids).size, ids.length);
});

test("benchmark matching waits for sealed judgments and exposes common inventory without previous verdicts probabilities severity or sibling answers", async (t) => {
  const f = await prepareMulti(t, 3, 2);
  for (const trial of f.manifest.trials) {
    assert.throws(
      () =>
        f.benchmark.matcherWorkerCommand(
          { operation: "packet" },
          false,
          trial.matchingId!,
        ),
      /startup authorization/,
    );
    const packet = reviewBenchmarkMatchingPacketSchema.parse(
      f.benchmark.matcherWorkerCommand(
        { operation: "packet" },
        true,
        trial.matchingId!,
      ),
    );
    const text = JSON.stringify(packet);
    assert.equal(packet.priorVerdictsIncluded, false);
    assert.equal(packet.expectedInventoryIncluded, true);
    for (const token of [
      '"judgement"',
      '"severity"',
      '"confidence"',
      '"probability"',
      '"label"',
      privateGroup,
      privateCase,
      "fictional-independent-judge",
      "original-review-session",
      trial.blindId,
      trial.trialId,
    ])
      assert.equal(text.includes(token), false, token);
    assert.equal(packet.claims.length, 3);
    assert.equal(packet.defects.length, trial.caseIndex === 0 ? 2 : 0);
    const setup = f.benchmark.matcherSetup(trial.matchingId!);
    assert.equal(setup.binding.assignmentDigest, packet.assignmentDigest);
    const status = reviewBenchmarkMatchingWorkerSummarySchema.parse(
      f.benchmark.matcherWorkerCommand(
        { operation: "status" },
        false,
        trial.matchingId!,
      ),
    );
    noPrivate(JSON.stringify(status), f);
  }
});

test("benchmark sealed multi-claim scoring retains duplicates common material denominators paired repetitions and sealed reviewer probabilities", async (t) => {
  const f = await prepareMulti(t, 3, 2);
  await mapAll(f);
  const report = reviewBenchmarkMultiScoreReportSchema.parse(
    f.benchmark.scoreMulti(true),
  );
  assert.equal(report.scoringReady, true);
  assert.equal(report.accounting.plannedTrials, 12);
  assert.equal(report.accounting.retainedClaims, 36);
  assert.equal(report.multi.aggregate.selected, 6);
  assert.equal(report.multi.aggregate.clusters, 1);
  assert.equal(report.multi.aggregate.repeatedClusters, 1);
  for (const arm of [
    report.multi.aggregate.arms.a,
    report.multi.aggregate.arms.b,
  ]) {
    assert.equal(arm.supportedClaims, 6);
    assert.equal(arm.uniqueSupportedDefects, 4);
    assert.equal(arm.duplicateSupportedClaims, 2);
    assert.deepEqual(arm.materialDefectRecall, {
      numerator: 4,
      denominator: 4,
      value: 1,
    });
    assert.deepEqual(arm.uniqueDefectPrecision, {
      numerator: 4,
      denominator: 18,
      value: 4 / 18,
    });
    assert.deepEqual(arm.falseAlarmRate, {
      numerator: 2,
      denominator: 2,
      value: 1,
    });
    assert.deepEqual(arm.nearMissFalseAlarmRate, {
      numerator: 2,
      denominator: 2,
      value: 1,
    });
    assert.equal(arm.properScores.scored, 18);
    assert.ok(
      Math.abs(arm.properScores.brier! - (6 * 0.04 + 12 * 0.64) / 18) < 1e-12,
    );
  }
  for (const arm of [
    report.multi.input.observations.a,
    report.multi.input.observations.b,
  ])
    for (const row of arm)
      for (const claim of row.claims) assert.equal(claim.probability, 0.8);
  const summary = reviewBenchmarkMultiScoreSummarySchema.parse(
    f.benchmark.scoreMulti(),
  );
  noPrivate(JSON.stringify(summary), f);
  assert.equal(
    JSON.stringify(summary).includes(report.multi.input.protocol.trials[0]!.id),
    false,
  );
  assert.equal(report.labelsVerified, false);
  assert.equal(report.hostIsolationVerified, false);
  assert.equal(report.calibratedConfidence, false);
  assert.deepEqual(f.benchmark.scoreMulti(true), report);
});

test("benchmark matching rejects wrong addresses digests quotes families hosts IDs and missing or duplicate claims while retaining every raw response", async (t) => {
  const f = await prepareMulti(t, 4, 2);
  const changes = [
    (v: ReturnType<typeof matchingResponse>) => {
      v.output![0]!.citations[0]!.sourceDigest = "0".repeat(64);
    },
    (v: ReturnType<typeof matchingResponse>) => {
      const trial = f.manifest.trials.find(
        (r) => r.matchingId === v.matchingId,
      )!;
      const packet = reviewBenchmarkMatchingPacketSchema.parse(
        f.benchmark.matcherWorkerCommand(
          { operation: "packet" },
          true,
          trial.matchingId!,
        ),
      );
      assert.equal(packet.defects.length, 2);
      v.output![0]!.defectId = packet.defects[1]!.id;
    },
    (v: ReturnType<typeof matchingResponse>) => {
      v.output![0]!.citations[0]!.quote = "OriginalMissingQuoteCanary";
    },
    (v: ReturnType<typeof matchingResponse>) => {
      v.output![0]!.citations = [];
    },
    (v: ReturnType<typeof matchingResponse>) => {
      v.assignmentDigest = "0".repeat(64);
    },
    (v: ReturnType<typeof matchingResponse>) => {
      v.host.model = "foreign-matcher";
    },
    (v: ReturnType<typeof matchingResponse>) => {
      v.matchingId = randomUUID();
    },
    (v: ReturnType<typeof matchingResponse>) => {
      v.output!.pop();
    },
    (v: ReturnType<typeof matchingResponse>) => {
      v.output![1] = structuredClone(v.output![0]!);
    },
    (v: ReturnType<typeof matchingResponse>) => {
      v.output![0]!.defectId = "0".repeat(64);
      v.output![0]!.match = "defect";
    },
  ];
  for (let i = 0; i < f.manifest.trials.length; i++) {
    const trial = f.manifest.trials[i]!,
      value = matchingResponse(f, trial.matchingId!);
    if (i < changes.length) changes[i]!(value);
    await putMapping(f, trial.matchingId!, value);
  }
  f.benchmark.sealMappings();
  const rows = (await mappingArchive(f)).mappings;
  for (let i = 0; i < f.manifest.trials.length; i++) {
    const row = rows.find(
      (m) => m.matchingId === f.manifest.trials[i]!.matchingId,
    )!;
    assert.equal(
      row.status,
      i < changes.length
        ? [4, 5, 6].includes(i)
          ? "foreign"
          : "invalid"
        : "accepted",
    );
    assert.match(row.responseDigest!, /^[a-f0-9]{64}$/);
    assert.ok(row.responseBase64);
  }
  assert.equal(f.benchmark.scoreMulti().scoringReady, false);
});

test("benchmark matching rejects curator reviewer judge and malformed sibling session reuse without claiming host isolation", async (t) => {
  const f = await prepareMulti(t, 3, 2),
    judgeRows = (await judgmentArchive(f)).judgments;
  const judgeSession = JSON.parse(
    Buffer.from(judgeRows[0]!.responseBase64!, "base64").toString(),
  ).host.sessionId;
  const forbidden = [
    f.plan.curatorSessionId,
    "fresh-multi-review-1",
    judgeSession,
    "OriginalMalformedSharedMatcher",
    "OriginalMalformedSharedMatcher",
  ];
  for (let i = 0; i < f.manifest.trials.length; i++) {
    const trial = f.manifest.trials[i]!,
      value = matchingResponse(f, trial.matchingId!);
    if (i < forbidden.length) value.host.sessionId = forbidden[i]!;
    await putMapping(
      f,
      trial.matchingId!,
      i === 3 ? { ...value, unknownMalformedKey: true } : value,
    );
  }
  f.benchmark.sealMappings();
  const rows = (await mappingArchive(f)).mappings;
  for (let i = 0; i < f.manifest.trials.length; i++)
    assert.equal(
      rows.find((m) => m.matchingId === f.manifest.trials[i]!.matchingId)!
        .status,
      i < 5 ? "foreign" : "accepted",
    );
  assert.equal(f.benchmark.scoreMulti().hostIsolationVerified, false);
});

test("benchmark multi-claim scoring preserves missing incomplete unresolved invalid and late mapping slots and rejects changed sealed artifacts", async (t) => {
  const f = await prepareMulti(t, 1, 2, true, true);
  const trials = f.manifest.trials;
  for (let i = 0; i < trials.length - 1; i++) {
    const value = matchingResponse(f, trials[i]!.matchingId!);
    if (i === 0) {
      value.output![0]!.match = "unresolved";
      value.output![0]!.defectId = null;
      value.output![0]!.citations = [];
    }
    if (i === 1) {
      value.output = null;
      value.status = "cancelled";
    }
    await putMapping(f, trials[i]!.matchingId!, value);
  }
  f.benchmark.sealMappings();
  const report = reviewBenchmarkMultiScoreReportSchema.parse(
    f.benchmark.scoreMulti(true),
  );
  assert.equal(report.scoringReady, false);
  assert.equal(report.accounting.missingMappings, 1);
  assert.ok(report.accounting.unresolvedClaims > 0);
  assert.equal(report.multi.aggregate.knownMaterialDefects, 4);
  assert.equal(
    report.multi.aggregate.arms.a.materialDefectRecall.denominator,
    4,
  );
  assert.equal(
    report.multi.aggregate.arms.b.materialDefectRecall.denominator,
    4,
  );
  assert.equal(report.accounting.completedTrials, 3);
  assert.equal(report.multi.aggregate.completePairs, 1);
  const id = trials.at(-1)!.matchingId!;
  assert.throws(() => f.benchmark.matcherSetup(id), /closed/);
  assert.throws(
    () => f.benchmark.matcherWorkerCommand({ operation: "packet" }, true, id),
    /closed/,
  );
  const file = path.join(f.reference.directory, "mappings", `${id}.json`);
  await privateJson(file, { schemaVersion: 1 });
  assert.throws(() => f.benchmark.scoreMulti(), /responses changed/);
  await rm(file);
  const sealedFile = path.join(f.reference.directory, "mappings-sealed.json"),
    bytes = await readFile(sealedFile);
  const archive = JSON.parse(bytes.toString());
  archive.mappings.find(
    (m: { matchingId: string }) => m.matchingId === trials[1]!.matchingId,
  ).status = "accepted";
  await privateJson(sealedFile, archive);
  assert.throws(() => f.benchmark.scoreMulti(), /responses changed/);
  await writeFile(sealedFile, bytes, { mode: 0o600 });
  const matcherFile = path.join(f.reference.directory, "matching.json"),
    matcherBytes = await readFile(matcherFile),
    matcher = JSON.parse(matcherBytes.toString());
  await writeFile(
    matcherFile,
    Buffer.concat([matcherBytes, Buffer.from(" ")]),
    { mode: 0o600 },
  );
  assert.throws(() => f.benchmark.scoreMulti(), /responses changed/);
  await writeFile(matcherFile, matcherBytes, { mode: 0o600 });
  matcher.slots[0].assignmentDigest = "0".repeat(64);
  await privateJson(matcherFile, matcher);
  assert.throws(() => f.benchmark.scoreMulti(), /matching artifact disagrees/);
  await writeFile(matcherFile, matcherBytes, { mode: 0o600 });
  assert.deepEqual(f.benchmark.scoreMulti(true), report);
  const incomplete = await prepareMulti(t, 1, 1, false, true);
  await mapAll(incomplete);
  const prefix = reviewBenchmarkMultiScoreReportSchema.parse(
    incomplete.benchmark.scoreMulti(true),
  );
  assert.ok(prefix.accounting.unscoredClaims > 0);
  assert.equal(prefix.scoringReady, false);
  assert.equal(prefix.accounting.retainedClaims, 6);
});

test("benchmark matching CLI and MCP share one startup pinned read-only slot and operator multi-score keeps incomplete exit and privacy", async (t) => {
  const f = await prepareMulti(t),
    id = f.manifest.trials[0]!.matchingId!,
    reference = f.reference.directory + "#sha256=" + f.reference.sha256;
  const invoke = (command: string, args: string[] = []) =>
    spawnSync(
      process.execPath,
      [
        cli,
        command,
        "--root",
        f.cases[0]!.root,
        "--benchmark",
        reference,
        ...args,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
  assert.equal(
    invoke("review-benchmark-matcher-packet", ["--matcher", id]).status,
    2,
  );
  const packet = invoke("review-benchmark-matcher-packet", [
    "--matcher",
    id,
    "--detailed",
    "--allow-review-source",
  ]);
  assert.equal(packet.status, 0, packet.stderr);
  assert.equal(
    reviewBenchmarkMatchingPacketSchema.parse(JSON.parse(packet.stdout))
      .matchingId,
    id,
  );
  assert.equal(
    invoke("serve", ["--matcher", id, "--trial", f.manifest.trials[0]!.trialId])
      .status,
    2,
  );
  const client = new Client({
    name: "original-matching-wire-control",
    version: "fixture-1",
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        cli,
        "serve",
        "--root",
        f.cases[0]!.root,
        "--benchmark",
        reference,
        "--matcher",
        id,
        "--detailed",
        "--allow-review-source",
      ],
    }),
  );
  try {
    const wire = await client.callTool({
      name: "review_benchmark",
      arguments: { operation: "packet" },
    });
    assert.equal(wire.isError, undefined);
    assert.deepEqual(
      reviewBenchmarkMatchingPacketSchema.parse(wire.structuredContent),
      JSON.parse(packet.stdout),
    );
    for (const arguments_ of [
      { operation: "score" },
      { operation: "seal" },
      { operation: "packet", matchingId: f.manifest.trials[1]!.matchingId },
      { operation: "packet", allowSource: true },
    ]) {
      const result = await client.callTool({
        name: "review_benchmark",
        arguments: arguments_,
      });
      assert.equal(result.isError, true);
    }
    f.benchmark.sealMappings();
    const closed = await client.callTool({
      name: "review_benchmark",
      arguments: { operation: "packet" },
    });
    assert.equal(closed.isError, true);
    const status = await client.callTool({
      name: "review_benchmark",
      arguments: { operation: "status" },
    });
    assert.equal(
      reviewBenchmarkMatchingWorkerSummarySchema.parse(status.structuredContent)
        .status,
      "missing",
    );
    noPrivate(JSON.stringify(status.structuredContent), f);
  } finally {
    await client.close();
  }
  const scored = invoke("review-benchmark-multi-score");
  assert.equal(scored.status, 2, scored.stderr);
  const summary = reviewBenchmarkMultiScoreSummarySchema.parse(
    JSON.parse(scored.stdout),
  );
  assert.deepEqual(summary, f.benchmark.scoreMulti());
  noPrivate(scored.stdout, f);
});

test("benchmark matching byte and private-file bounds preserve missing unavailable invalid cancelled and exact-limit controls", async (t) => {
  const f = await prepareMulti(t, 4, 1);
  const expected = [
    "missing",
    "unavailable",
    "unavailable",
    "unavailable",
    "invalid",
    "incomplete",
    "incomplete",
    "accepted",
  ];
  for (let i = 1; i < f.manifest.trials.length; i++) {
    const id = f.manifest.trials[i]!.matchingId!,
      file = f.benchmark.matcherSetup(id).file,
      value = matchingResponse(f, id);
    if (i === 1) {
      await privateJson(file, value);
      await chmod(file, 0o644);
    } else if (i === 2) {
      const other = path.join(f.operator, "linked-mapping.json");
      await privateJson(other, value);
      await symlink(other, file);
    } else if (i === 3) {
      await writeFile(file, Buffer.alloc(262145, 0x20), { mode: 0o600 });
    } else if (i === 4) {
      await writeFile(file, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    } else if (i === 5) {
      value.status = "refused";
      value.output = null;
      await privateJson(file, value);
    } else if (i === 6) {
      value.host.isolation = "unknown";
      await privateJson(file, value);
    } else {
      const bytes = Buffer.from(JSON.stringify(value));
      assert.ok(bytes.length < 262144);
      await writeFile(
        file,
        Buffer.concat([bytes, Buffer.alloc(262144 - bytes.length, 0x20)]),
        { mode: 0o600 },
      );
    }
  }
  f.benchmark.sealMappings();
  const archive = await mappingArchive(f);
  for (let i = 0; i < f.manifest.trials.length; i++) {
    const row = archive.mappings.find(
      (m) => m.matchingId === f.manifest.trials[i]!.matchingId,
    )!;
    assert.equal(row.status, expected[i]);
    if (i < 4) {
      assert.equal(row.responseDigest, null);
      assert.equal(row.responseBase64, null);
    } else {
      assert.ok(row.responseDigest);
      assert.ok(row.responseBase64);
    }
  }
  const report = f.benchmark.scoreMulti();
  assert.equal(report.scoringReady, false);
  assert.equal(report.accounting.missingMappings, 1);
  assert.equal(report.accounting.rejectedMappings, 6);
});

test("benchmark common positive matches never override independent wrong mechanism address remedy scope refutation or unresolved verdicts", async (t) => {
  const f = await prepareMulti(t, 1, 1, false, false, [
    "wrong-mechanism",
    "wrong-address",
    "unreachable-fix",
    "out-of-scope",
    "refuted",
    "unresolved",
  ]);
  await mapAll(f);
  const report = reviewBenchmarkMultiScoreReportSchema.parse(
    f.benchmark.scoreMulti(true),
  );
  assert.equal(report.accounting.unresolvedClaims, 1);
  assert.equal(report.scoringReady, false);
  const a = report.multi.aggregate.arms.a,
    b = report.multi.aggregate.arms.b;
  assert.equal(a.supportedClaims, 0);
  assert.equal(b.supportedClaims, 0);
  assert.equal(a.resolvedErrors, 3);
  assert.equal(b.resolvedErrors, 2);
  assert.deepEqual(a.materialDefectRecall, {
    numerator: 0,
    denominator: 2,
    value: 0,
  });
  assert.deepEqual(b.materialDefectRecall, {
    numerator: 0,
    denominator: 2,
    value: 0,
  });
  assert.equal(a.properScores.scored, 3);
  assert.equal(b.properScores.scored, 2);
  assert.ok(Math.abs(a.properScores.brier! - 0.64) < 1e-12);
  for (const arm of [
    report.multi.input.observations.a,
    report.multi.input.observations.b,
  ])
    for (const claim of arm[0]!.claims) assert.equal(claim.defectId, null);
});

test("benchmark sealed multi-claim empty reviews and mappings remain completed controls without erasing missed common defects or inventing probabilities", async (t) => {
  const f = await prepareMulti(t, 3, 1, false, false, undefined, 0);
  await mapAll(f);
  const report = reviewBenchmarkMultiScoreReportSchema.parse(
    f.benchmark.scoreMulti(true),
  );
  assert.equal(report.scoringReady, true);
  assert.equal(report.accounting.retainedClaims, 0);
  assert.equal(report.accounting.completedTrials, 6);
  for (const arm of [
    report.multi.aggregate.arms.a,
    report.multi.aggregate.arms.b,
  ]) {
    assert.equal(arm.completed, 3);
    assert.equal(arm.completedClaims, 0);
    assert.equal(arm.supportedClaimPrecision.value, null);
    assert.deepEqual(arm.materialDefectRecall, {
      numerator: 0,
      denominator: 2,
      value: 0,
    });
    assert.deepEqual(arm.falseAlarmRate, {
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    assert.deepEqual(arm.nearMissFalseAlarmRate, {
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    assert.equal(arm.properScores.scored, 0);
    assert.equal(arm.properScores.brier, null);
  }
  assert.equal(report.qualityAssessed, false);
});
