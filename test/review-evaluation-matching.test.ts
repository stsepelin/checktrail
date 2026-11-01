import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { fixture } from "./helpers.js";
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { encodeReviewEvaluationArtifact } from "../src/review-evaluation-artifacts.js";
import {
  freezeReviewEvaluationCommonDefects as freeze,
  prepareReviewEvaluationMatching as prepare,
  reviewEvaluationMatchingPacket as packet,
  sealReviewEvaluationMappings as seal,
  inspectSealedReviewEvaluationMappings as replay,
  scoreReviewEvaluationArtifacts as score,
  reviewEvaluationCommonDefectsSchema,
  reviewEvaluationMappingResponseSchema,
} from "../src/review-evaluation-matching.js";
import { reviewEvaluationJudgmentPacket } from "../src/review-evaluation-judging.js";
import { matchingFixture } from "./review-evaluation-matching-fixture.js";
import { originalCitation } from "./review-evaluation-judging-fixture.js";
import { protocolHex } from "./review-evaluation-protocol-fixture.js";
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
async function all(f: Awaited<ReturnType<typeof matchingFixture>>) {
  return Promise.all(f.matching.blindIds.map((id) => f.mappingResponse(id)));
}
function arithmetic(r: ReturnType<typeof seal>) {
  const c = r.counts;
  assert.equal(c.planned, c.accepted + c.missing + c.rejected);
  assert.equal(
    c.supplied,
    c.receivedUniquePlanned + c.duplicateRecords + c.foreignRecords,
  );
  assert.equal(
    c.retainedClaims,
    c.mappedClaims + c.unmappedClaims + c.unavailableClaimMappings,
  );
}
function aggregate(
  s: ReturnType<typeof score>,
  which: "baseline" | "reference",
) {
  return s.comparisons[which].aggregate as {
    selected: number;
    clusters: number;
    arms: {
      a: {
        supportedClaims: number;
        retainedClaims: number;
        uniqueSupportedDefects: number;
        duplicateSupportedClaims: number;
        materialDefectRecall: { value: number | null };
        supportedClaimPrecision: { value: number | null };
        completedCoverage: { value: number | null };
        properScores: { scored: number; brier: number };
      };
      b: {
        supportedClaims: number;
        retainedClaims: number;
        uniqueSupportedDefects: number;
        duplicateSupportedClaims: number;
        materialDefectRecall: { value: number | null };
        supportedClaimPrecision: { value: number | null };
        completedCoverage: { value: number | null };
        properScores: { scored: number; brier: number };
      };
    };
    differences: { metric: string; differenceBMinusA: number | null }[];
  };
}
async function rewrite(store: string, value: unknown) {
  const bytes = encodeReviewEvaluationArtifact(value);
  await writeFile(path.join(store, "mappings.sealed.json"), bytes);
  return digest(bytes);
}
test("independent common matching connects all retained three-role claims to frozen defects and paired incident clusters", async (t) => {
  const f = await matchingFixture(t),
    r = seal(f.project, f.store, f.matching.bookSha256, await all(f));
  assert.equal(r.mappingsComplete, true);
  assert.equal(r.counts.planned, 3);
  assert.equal(r.counts.accepted, 3);
  assert.equal(r.counts.retainedClaims, 18);
  assert.equal(r.counts.mappedClaims, 18);
  assert.deepEqual(replay(f.project, f.store, r.mappingsSha256), r);
  arithmetic(r);
  const s = score(f.project, f.store, r.mappingsSha256);
  assert.equal(s.scoringBindingsComplete, true);
  for (const which of ["baseline", "reference"] as const) {
    const a = aggregate(s, which);
    assert.equal(a.selected, 6);
    assert.equal(a.clusters, 3);
    assert.equal(a.arms.a.supportedClaims, 6);
    assert.equal(a.arms.b.supportedClaims, 6);
    assert.equal(a.arms.b.materialDefectRecall.value, 1);
    assert.equal(a.arms.b.supportedClaimPrecision.value, 1);
    assert.equal(
      a.differences.find((d) => d.metric === "materialDefectRecall")!
        .differenceBMinusA,
      0,
    );
  }
  assert.equal(s.qualityAssessed, false);
});
test("independent common matching freezes answers before collection and keeps them out of earlier judge packets", async (t) => {
  const f = await matchingFixture(t),
    inventoryBytes = await readFile(
      path.join(f.store, "common-defects.frozen.json"),
    ),
    inventory = JSON.parse(inventoryBytes.toString());
  await rm(path.join(f.store, "common-defects.frozen.json"));
  assert.throws(
    () =>
      freeze(
        f.project,
        f.store,
        f.input.declaration,
        f.input.expectedProtocolSha256,
        inventory,
      ),
    /precede/,
  );
  assert.equal(
    (await readdir(f.store)).includes("common-defects.frozen.json"),
    false,
  );
  await writeFile(
    path.join(f.store, "common-defects.frozen.json"),
    inventoryBytes,
    { mode: 0o600, flag: "wx" },
  );
  const earlier = reviewEvaluationJudgmentPacket(
    f.project,
    f.store,
    f.book.bookSha256,
    f.book.blindIds[0]!,
    true,
  );
  assert.equal(
    JSON.stringify(earlier).includes("OriginalCommonDefectAnswerCanary"),
    false,
  );
  assert.equal("label" in earlier, false);
  assert.throws(
    () =>
      packet(
        f.project,
        f.store,
        f.matching.bookSha256,
        f.matching.blindIds[0]!,
        false,
      ),
    /operator grant/,
  );
  const p = packet(
    f.project,
    f.store,
    f.matching.bookSha256,
    f.matching.blindIds[0]!,
    true,
  );
  assert.ok(JSON.stringify(p).includes("OriginalCommonDefectAnswerCanary"));
  assert.equal(p.reviews.length, 6);
  for (const review of p.reviews) {
    assert.equal("role" in review, false);
    assert.equal("judgments" in review, false);
    for (const claim of review.claims) {
      assert.equal("probability" in claim, false);
      assert.equal("judgement" in claim, false);
    }
  }
  for (const id of f.input.metering.slots.flatMap((s) =>
    s.attempts.map((a) => a.sessionId),
  ))
    assert.equal(JSON.stringify(p).includes(id), false);
});
test("independent common matching rejects wrong packets omitted duplicate foreign and adjacent defect identities", async (t) => {
  for (const mode of [
    "packet",
    "omitted",
    "duplicate",
    "foreign-review",
    "foreign-claim",
    "defect",
    "family",
  ]) {
    const options =
      mode === "family"
        ? {
            review: {
              schemaVersion: 1,
              profile: "independent-review-output-v1",
              claims: [
                {
                  id: "claim-" + protocolHex(1),
                  family: "identifiers-allowlists",
                  statement: "Original mismatching family claim",
                  citations: [structuredClone(originalCitation)],
                  probability: null,
                },
              ],
            },
          }
        : {};
    const f = await matchingFixture(t, options),
      submissions = await all(f);
    submissions[0] = await f.mappingResponse(f.matching.blindIds[0]!, (v) => {
      const m = v.mappings as {
        reviewId: string;
        claimId: string;
        defectId: string | null;
      }[];
      if (mode === "packet") v.packetSha256 = "f".repeat(64);
      else if (mode === "omitted") m.pop();
      else if (mode === "duplicate") m[1] = structuredClone(m[0]!);
      else if (mode === "foreign-review")
        m[0]!.reviewId = "judge-" + protocolHex(999);
      else if (mode === "foreign-claim")
        m[0]!.claimId = "claim-" + protocolHex(999);
      else if (mode === "family")
        m[0]!.defectId = packet(
          f.project,
          f.store,
          f.matching.bookSha256,
          f.matching.blindIds[0]!,
          true,
        ).defects[0]!.id;
      else m[0]!.defectId = "defect-" + protocolHex(999);
    });
    const r = seal(f.project, f.store, f.matching.bookSha256, submissions);
    assert.equal(r.mappingsComplete, false, mode);
    assert.equal(r.counts.accepted, 2);
    assert.equal(r.counts.rejected, 1);
    assert.equal(r.counts.unavailableClaimMappings, 6);
    arithmetic(r);
    assert.equal(
      score(f.project, f.store, r.mappingsSha256).scoringBindingsComplete,
      false,
    );
  }
});
test("independent common matching rejects every reused curator session including prior review and judge attempts", async (t) => {
  for (const mode of ["matching", "review", "judge"]) {
    const f = await matchingFixture(t),
      submissions = await all(f);
    let session = "session-" + protocolHex(99999);
    if (mode === "review")
      session = f.input.metering.slots.at(-1)!.attempts.at(-1)!.sessionId;
    else if (mode === "judge") {
      const j = JSON.parse(
        await readFile(path.join(f.store, "judgments.sealed.json"), "utf8"),
      );
      session = JSON.parse(
        Buffer.from(j.responses[0].base64, "base64").toString(),
      ).sessionId;
    }
    submissions[0] = await f.mappingResponse(f.matching.blindIds[0]!, (v) => {
      v.sessionId = session;
    });
    if (mode === "matching")
      submissions[1] = await f.mappingResponse(f.matching.blindIds[1]!, (v) => {
        v.sessionId = session;
      });
    const r = seal(f.project, f.store, f.matching.bookSha256, submissions);
    assert.equal(r.mappingsComplete, false);
    assert.equal(r.counts.rejected, mode === "matching" ? 2 : 1);
    arithmetic(r);
  }
});
test("independent common matching preserves missing duplicate foreign and exhausted mappings without shrinking trials", async (t) => {
  const f = await matchingFixture(t),
    submissions = await all(f);
  submissions.shift();
  submissions.push({ ...submissions[0]! });
  const foreign = await f.mappingResponse(f.matching.blindIds[2]!);
  submissions.push({ ...foreign, blindId: "matching-" + protocolHex(999) });
  const r = seal(f.project, f.store, f.matching.bookSha256, submissions);
  assert.equal(r.counts.planned, 3);
  assert.equal(r.counts.missing, 1);
  assert.equal(r.counts.rejected, 1);
  assert.equal(r.counts.accepted, 1);
  assert.equal(r.counts.duplicateRecords, 1);
  assert.equal(r.counts.foreignRecords, 1);
  arithmetic(r);
  const s = score(f.project, f.store, r.mappingsSha256);
  assert.equal(s.scoringBindingsComplete, false);
  assert.equal(aggregate(s, "baseline").selected, 6);
  assert.equal(aggregate(s, "baseline").arms.b.retainedClaims, 6);
  for (const status of [
    "unavailable",
    "refused",
    "cancelled",
    "timed-out",
    "error",
    "incomplete",
  ]) {
    const g = await matchingFixture(t),
      rows = await all(g);
    rows[0] = await g.mappingResponse(g.matching.blindIds[0]!, (v) => {
      v.status = status;
    });
    const r = seal(g.project, g.store, g.matching.bookSha256, rows);
    assert.equal(r.counts.rejected, 1, status);
    assert.equal(r.mappingsComplete, false);
    arithmetic(r);
  }
});
test("independent common matching deduplicates common defects while preserving every sealed reviewer probability", async (t) => {
  const claims = [0.8, 0.2].map((probability, i) => ({
    id: "claim-" + protocolHex(i + 1),
    family: "types-numeric-semantics",
    statement: "Original same root defect statement " + i,
    citations: [structuredClone(originalCitation)],
    probability,
  }));
  const f = await matchingFixture(t, {
      review: {
        schemaVersion: 1,
        profile: "independent-review-output-v1",
        claims,
      },
    }),
    r = seal(f.project, f.store, f.matching.bookSha256, await all(f)),
    s = score(f.project, f.store, r.mappingsSha256);
  assert.equal(r.counts.retainedClaims, 36);
  const b = aggregate(s, "baseline").arms.b;
  assert.equal(b.retainedClaims, 12);
  assert.equal(b.supportedClaims, 12);
  assert.equal(b.uniqueSupportedDefects, 6);
  assert.equal(b.duplicateSupportedClaims, 6);
  assert.equal(b.materialDefectRecall.value, 1);
  assert.equal(b.properScores.scored, 12);
  assert.ok(Math.abs(b.properScores.brier - 0.34) < 1e-12);
  assert.equal(s.probabilitySource, "sealed-reviewer-declared-uncalibrated");
  assert.equal(s.claimTruthVerified, false);
  arithmetic(r);
});
test("independent common matching uses separate judgments and paired roles rather than curator agreement as claim support", async (t) => {
  const f = await matchingFixture(t, {
      judge: (slot, v) => {
        if (slot.role === "baseline" && slot.caseId.endsWith("1"))
          for (const c of v.claims as { judgement: string }[])
            c.judgement = "refuted";
      },
    }),
    r = seal(f.project, f.store, f.matching.bookSha256, await all(f)),
    s = score(f.project, f.store, r.mappingsSha256),
    baseline = aggregate(s, "baseline"),
    reference = aggregate(s, "reference");
  assert.equal(baseline.arms.a.supportedClaims, 4);
  assert.equal(baseline.arms.b.supportedClaims, 6);
  assert.equal(reference.arms.a.supportedClaims, 6);
  assert.equal(reference.arms.b.supportedClaims, 6);
  assert.ok(
    Math.abs(
      baseline.differences.find((d) => d.metric === "materialDefectRecall")!
        .differenceBMinusA! -
        1 / 3,
    ) < 1e-12,
  );
  assert.equal(
    reference.differences.find((d) => d.metric === "materialDefectRecall")!
      .differenceBMinusA,
    0,
  );
  const g = await matchingFixture(t, { missingJudgment: true }),
    missing = seal(g.project, g.store, g.matching.bookSha256, await all(g)),
    unresolved = score(g.project, g.store, missing.mappingsSha256);
  assert.equal(missing.mappingsComplete, true);
  assert.equal(unresolved.scoringBindingsComplete, false);
  assert.equal(unresolved.accounting.judgments.counts.missing, 1);
  assert.equal(aggregate(unresolved, "baseline").selected, 6);
});
test("independent common matching keeps invalid empty and unknown-label reviews distinct from a quality pass", async (t) => {
  const invalid = await matchingFixture(t, {
      review: "Original nonstructured review",
    }),
    r = seal(
      invalid.project,
      invalid.store,
      invalid.matching.bookSha256,
      await all(invalid),
    ),
    bad = score(invalid.project, invalid.store, r.mappingsSha256);
  assert.equal(bad.scoringBindingsComplete, false);
  assert.equal(aggregate(bad, "baseline").arms.b.completedCoverage.value, 0);
  assert.equal(
    aggregate(bad, "baseline").arms.b.supportedClaimPrecision.value,
    null,
  );
  const empty = await matchingFixture(t, {
      review: {
        schemaVersion: 1,
        profile: "independent-review-output-v1",
        claims: [],
      },
    }),
    e = seal(
      empty.project,
      empty.store,
      empty.matching.bookSha256,
      await all(empty),
    ),
    abstain = score(empty.project, empty.store, e.mappingsSha256);
  assert.equal(
    aggregate(abstain, "baseline").arms.b.materialDefectRecall.value,
    0,
  );
  assert.equal(
    aggregate(abstain, "baseline").arms.b.supportedClaimPrecision.value,
    null,
  );
  assert.equal(abstain.qualityAssessed, false);
  const unknown = await matchingFixture(t, { unresolvedLabel: true }),
    u = seal(
      unknown.project,
      unknown.store,
      unknown.matching.bookSha256,
      await all(unknown),
    );
  assert.equal(
    score(unknown.project, unknown.store, u.mappingsSha256)
      .scoringBindingsComplete,
    false,
  );
  assert.equal(u.counts.unmappedClaims, 6);
  arithmetic(u);
});
test("independent common matching binds immutable inventories source judgments and books before accepting mappings", async (t) => {
  const f = await matchingFixture(t),
    file = path.join(f.store, "common-defects.frozen.json"),
    original = await readFile(file),
    value = JSON.parse(original.toString());
  value.cases[0].defects[0].description += " Original changed";
  await writeFile(file, encodeReviewEvaluationArtifact(value));
  assert.throws(
    () =>
      packet(
        f.project,
        f.store,
        f.matching.bookSha256,
        f.matching.blindIds[0]!,
        true,
      ),
    /inventory changed/,
  );
  assert.throws(
    () =>
      prepare(
        f.project,
        f.store,
        f.sealedJudgments.judgmentsSha256,
        f.inventory.inventorySha256,
      ),
    /inventory changed/,
  );
  await writeFile(file, original);
  const before = await readFile(path.join(f.store, "matching.book.json"));
  const changed = JSON.parse(before.toString());
  changed.cases[0].blindId = "matching-" + protocolHex(99999);
  const changedBytes = encodeReviewEvaluationArtifact(changed);
  await writeFile(path.join(f.store, "matching.book.json"), changedBytes);
  assert.throws(
    () =>
      packet(
        f.project,
        f.store,
        digest(changedBytes),
        changed.cases[0].blindId,
        true,
      ),
    /bindings disagree/,
  );
  await writeFile(path.join(f.store, "matching.book.json"), before);
  assert.throws(() =>
    prepare(
      f.project,
      f.store,
      f.sealedJudgments.judgmentsSha256,
      f.inventory.inventorySha256,
    ),
  );
  assert.deepEqual(
    await readFile(path.join(f.store, "matching.book.json")),
    before,
  );
  assert.throws(
    () =>
      packet(f.project, f.store, "f".repeat(64), f.matching.blindIds[0]!, true),
    /identity/,
  );
});
test("independent common matching retains malformed and missing responses and refuses physical digest mismatches before writing", async (t) => {
  const f = await matchingFixture(t),
    rows = await all(f),
    bytes = Buffer.from("{ Original malformed matching"),
    id = digest(bytes);
  await writeFile(path.join(f.store, "blobs", id + ".blob"), bytes, {
    mode: 0o600,
  });
  rows[0] = { blindId: f.matching.blindIds[0]!, responseSha256: id };
  await rm(path.join(f.store, "blobs", rows[1]!.responseSha256 + ".blob"));
  const r = seal(f.project, f.store, f.matching.bookSha256, rows);
  assert.equal(r.mappingsComplete, false);
  assert.equal(r.counts.rejected, 2);
  assert.equal(r.counts.missingResponseBlobs, 1);
  assert.deepEqual(replay(f.project, f.store, r.mappingsSha256), r);
  arithmetic(r);
  const g = await matchingFixture(t),
    submissions = await all(g);
  await writeFile(
    path.join(g.store, "blobs", submissions[0]!.responseSha256 + ".blob"),
    "Original changed mapping bytes",
  );
  assert.throws(
    () => seal(g.project, g.store, g.matching.bookSha256, submissions),
    /identity/,
  );
  assert.equal(
    (await readdir(g.store)).includes("mappings.sealed.json"),
    false,
  );
});
test("independent common matching replays only retained bytes and rejects altered unused duplicate or omitted inventories", async (t) => {
  const f = await matchingFixture(t),
    r = seal(f.project, f.store, f.matching.bookSha256, await all(f)),
    original = JSON.parse(
      await readFile(path.join(f.store, "mappings.sealed.json"), "utf8"),
    ),
    before = score(f.project, f.store, r.mappingsSha256);
  await rm(path.join(f.store, "blobs"), { recursive: true });
  assert.deepEqual(replay(f.project, f.store, r.mappingsSha256), r);
  assert.deepEqual(score(f.project, f.store, r.mappingsSha256), before);
  for (const mode of ["duplicate", "omitted", "missing", "unused", "bytes"]) {
    const a = structuredClone(original);
    if (mode === "duplicate") a.responses.push(a.responses[0]);
    else if (mode === "omitted") a.responses.pop();
    else if (mode === "missing") a.missing.push(a.responses[0].sha256);
    else if (mode === "unused") {
      const b = Buffer.from("Original unused mapping");
      a.responses.push({ sha256: digest(b), base64: b.toString("base64") });
    } else
      a.responses[0].base64 = Buffer.from("Original altered mapping").toString(
        "base64",
      );
    const id = await rewrite(f.store, a);
    assert.throws(() => replay(f.project, f.store, id), /Sealed/, mode);
  }
  await rewrite(f.store, original);
  await mkdir(path.join(f.store, "blobs"), { mode: 0o700 });
  assert.throws(() => seal(f.project, f.store, f.matching.bookSha256, []));
  assert.deepEqual(score(f.project, f.store, r.mappingsSha256), before);
});
test("independent common matching never invokes inference verifies labels or leaks private identities in scores", async (t) => {
  const f = await matchingFixture(t),
    rows = await all(f),
    input = structuredClone(rows),
    fetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      throw Error("No model access permitted");
    };
    const r = seal(f.project, f.store, f.matching.bookSha256, rows),
      s = score(f.project, f.store, r.mappingsSha256);
    assert.equal(calls, 0);
    assert.deepEqual(rows, input);
    for (const flag of [
      "sourceIncluded",
      "privateIdentitiesIncluded",
      "claimTruthVerified",
      "labelsVerified",
      "hostIndependenceVerified",
      "actualAttemptsComplete",
      "qualityAssessed",
      "gateAClosed",
      "inferenceInvoked",
    ] as const)
      assert.equal(s[flag], false, flag);
    for (const secret of [
      "OriginalCommonDefectAnswerCanary",
      originalCitation.quote,
      f.input.captures[0]!.caseId,
      f.matching.blindIds[0]!,
      f.book.blindIds[0]!,
    ])
      assert.equal(JSON.stringify(s).includes(secret), false, secret);
    assert.throws(
      () =>
        seal(f.project, f.store, f.matching.bookSha256, Array(513).fill(null)),
      /count bound/,
    );
  } finally {
    globalThis.fetch = fetch;
  }
  assert.equal(
    reviewEvaluationCommonDefectsSchema.safeParse({
      authorization: "OriginalPrivateCanary",
    }).success,
    false,
  );
  assert.equal(
    reviewEvaluationMappingResponseSchema.safeParse({}).success,
    false,
  );
});

test("independent common matching checks exact schema admission and physical storage boundaries before publication", async (t) => {
  const f = await matchingFixture(t),
    original = JSON.parse(
      await readFile(path.join(f.store, "common-defects.frozen.json"), "utf8"),
    );
  const root = await fixture(t, {
    "project/marker": "Original common inventory admission",
  });
  let i = 0;
  for (const mode of [
    "duplicate-case",
    "foreign-case",
    "missing-case",
    "duplicate-defect",
    "valid-with-defect",
    "empty-defect",
    "foreign-protocol",
    "invalid-case-collection",
    "too-many-cases",
    "too-many-defects",
  ]) {
    const value = structuredClone(original);
    if (mode === "duplicate-case")
      value.cases[1] = structuredClone(value.cases[0]);
    else if (mode === "foreign-case")
      value.cases[0].caseId = "case-" + protocolHex(999);
    else if (mode === "missing-case") value.cases.pop();
    else if (mode === "duplicate-defect")
      value.cases[0].defects.push(value.cases[0].defects[0]);
    else if (mode === "valid-with-defect") value.cases[0].label = "valid";
    else if (mode === "empty-defect") value.cases[0].defects = [];
    else if (mode === "foreign-protocol") value.protocolSha256 = "f".repeat(64);
    else if (mode === "invalid-case-collection")
      value.cases = "Original invalid collection";
    else if (mode === "too-many-cases")
      value.cases = Array(257).fill(value.cases[0]);
    else value.cases[0].defects = Array(33).fill(value.cases[0].defects[0]);
    const store = path.join(root, "invalid-" + i++);
    await mkdir(store, { mode: 0o700 });
    assert.throws(() =>
      freeze(
        path.join(root, "project"),
        store,
        f.input.declaration,
        f.input.expectedProtocolSha256,
        value,
      ),
    );
    assert.deepEqual(await readdir(store), []);
  }
  const claims = Array.from({ length: 32 }, (_, i) => ({
      id: "claim-" + protocolHex(i + 1),
      family: "types-numeric-semantics",
      statement: "Original selected claim " + i,
      citations: [structuredClone(originalCitation)],
      probability: null,
    })),
    edge = await matchingFixture(t, {
      review: {
        schemaVersion: 1,
        profile: "independent-review-output-v1",
        claims,
      },
    }),
    rows = await all(edge);
  const first = JSON.parse(
    await readFile(
      path.join(edge.store, "blobs", rows[0]!.responseSha256 + ".blob"),
      "utf8",
    ),
  );
  assert.equal(first.mappings.length, 192);
  assert.equal(
    reviewEvaluationMappingResponseSchema.safeParse(first).success,
    true,
  );
  first.mappings.push(first.mappings[0]);
  assert.equal(
    reviewEvaluationMappingResponseSchema.safeParse(first).success,
    false,
  );
  const valid = seal(edge.project, edge.store, edge.matching.bookSha256, rows);
  assert.equal(valid.mappingsComplete, true);
  assert.equal(valid.counts.retainedClaims, 576);
  const large = await matchingFixture(t),
    submissions = await all(large),
    file = path.join(
      large.store,
      "blobs",
      submissions[0]!.responseSha256 + ".blob",
    );
  await writeFile(file, Buffer.alloc(1048577));
  assert.throws(
    () =>
      seal(large.project, large.store, large.matching.bookSha256, submissions),
    /bounded/,
  );
  assert.equal(
    (await readdir(large.store)).includes("mappings.sealed.json"),
    false,
  );
});
test("independent common matching CLI shares source grants sealed accounting and descriptive scoring", async (t) => {
  const f = await matchingFixture(t),
    cli = fileURLToPath(
      new URL("../../scripts/evaluation-matching.mjs", import.meta.url),
    );
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, [cli, ...args], {
      input,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 262144,
    });
  const args = [
    f.project,
    f.store,
    f.matching.bookSha256,
    f.matching.blindIds[0]!,
  ];
  const denied = run(["packet", ...args]);
  assert.equal(denied.status, 1);
  assert.equal(denied.stdout, "");
  assert.equal(
    denied.stderr,
    "Independent matching input or artifacts invalid or unavailable\n",
  );
  const allowed = run(["packet", ...args, "--allow-source"]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.deepEqual(
    JSON.parse(allowed.stdout),
    packet(
      f.project,
      f.store,
      f.matching.bookSha256,
      f.matching.blindIds[0]!,
      true,
    ),
  );
  const sealed = run(
    ["seal", f.project, f.store, f.matching.bookSha256],
    JSON.stringify(await all(f)),
  );
  assert.equal(sealed.status, 0, sealed.stderr);
  const r = JSON.parse(sealed.stdout),
    inspected = run(["inspect", f.project, f.store, r.mappingsSha256]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(JSON.parse(inspected.stdout), r);
  const scored = run(["score", f.project, f.store, r.mappingsSha256]);
  assert.equal(scored.status, 0, scored.stderr);
  assert.deepEqual(
    JSON.parse(scored.stdout),
    score(f.project, f.store, r.mappingsSha256),
  );
  assert.equal(
    scored.stdout.includes("OriginalCommonDefectAnswerCanary"),
    false,
  );
  assert.equal(scored.stdout.includes(f.input.captures[0]!.caseId), false);
  const invalid = run(
    ["seal", f.project, f.store, f.matching.bookSha256],
    "OriginalPrivateMatchingCanary",
  );
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr.includes("OriginalPrivateMatchingCanary"), false);
  const partial = await matchingFixture(t),
    missing = run(
      ["seal", partial.project, partial.store, partial.matching.bookSha256],
      "[]",
    );
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).counts.missing, 3);
});
test(
  "independent common matching repeats source freeze judgments mappings and paired scoring through a fresh offline installation",
  { timeout: 120000 },
  async () => {
    if (process.env.CHECKTRAIL_EVALUATION_PROTOCOL_INSTALLED === "1") {
      const actual = await realpath(
        fileURLToPath(
          new URL("../src/review-evaluation-matching.js", import.meta.url),
        ),
      );
      assert.ok(
        actual.includes(path.join("node_modules", "@stsepelin", "checktrail")),
      );
      return;
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const script = fileURLToPath(
      new URL(
        "../../scripts/verify-evaluation-protocol-package.mjs",
        import.meta.url,
      ),
    );
    const p = spawnSync(process.execPath, [script, "--matching"], {
      env,
      encoding: "utf8",
      timeout: 115000,
      maxBuffer: 4 * 1048576,
    });
    assert.equal(p.status, 0, (p.stderr + p.stdout).slice(0, 5000));
    const proof = JSON.parse(p.stdout);
    assert.equal(proof.offlineProductionInstall, true);
    assert.equal(proof.lifecycleScriptsExecuted, false);
    assert.equal(proof.harnessOutsideInstalledPackage, true);
    assert.equal(proof.profileEvidence.required, 15);
    assert.equal(proof.profileEvidence.passed, 15);
    assert.equal(proof.profileEvidence.complete, true);
  },
);
