import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile, writeFile, rm, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { encodeReviewEvaluationArtifact } from "../src/review-evaluation-artifacts.js";
import {
  prepareReviewEvaluationJudging as prepare,
  reviewEvaluationJudgmentPacket as packet,
  sealReviewEvaluationJudgments as seal,
  inspectSealedReviewEvaluationJudgments as replay,
  reviewEvaluationSourcePacketSchema,
  reviewEvaluationReviewOutputSchema,
  reviewEvaluationJudgmentResponseSchema,
} from "../src/review-evaluation-judging.js";
import {
  judgingFixture,
  originalCitation,
} from "./review-evaluation-judging-fixture.js";
import { protocolHex } from "./review-evaluation-protocol-fixture.js";
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function arithmetic(r: ReturnType<typeof seal>) {
  const c = r.counts;
  assert.equal(c.planned, c.accepted + c.missing + c.rejected);
  assert.equal(
    c.supplied,
    c.receivedUniquePlanned + c.duplicateRecords + c.foreignRecords,
  );
  assert.equal(
    c.retainedClaims,
    c.resolvedClaimJudgments +
      c.unresolvedClaimJudgments +
      c.unavailableClaimJudgments,
  );
  assert.equal(
    c.planned,
    Object.values(c.reviewOutputs).reduce((n, v) => n + v, 0),
  );
}
async function all(f: Awaited<ReturnType<typeof judgingFixture>>) {
  return Promise.all(f.book.blindIds.map((id) => f.response(id)));
}
async function archived(store: string) {
  return JSON.parse(
    await readFile(path.join(store, "judgments.sealed.json"), "utf8"),
  );
}
async function rewrite(store: string, value: unknown) {
  const bytes = encodeReviewEvaluationArtifact(value);
  await writeFile(path.join(store, "judgments.sealed.json"), bytes);
  return digest(bytes);
}
test("independent external judging binds all three roles and repeated slots to sealed physical responses", async (t) => {
  const f = await judgingFixture(t),
    submissions = await all(f),
    r = seal(f.project, f.store, f.book.bookSha256, submissions);
  assert.equal(r.judgmentsComplete, true);
  assert.equal(r.reviewEvidenceComplete, true);
  assert.equal(r.counts.planned, 18);
  assert.equal(r.counts.accepted, 18);
  assert.equal(r.counts.retainedResponseBlobs, 18);
  assert.deepEqual(replay(f.project, f.store, r.judgmentsSha256), r);
  arithmetic(r);
});
test("independent external judging discloses one source and anonymous review without peer answers roles or probabilities", async (t) => {
  const f = await judgingFixture(t),
    id = f.book.blindIds[0]!;
  assert.throws(
    () => packet(f.project, f.store, f.book.bookSha256, id, false),
    /operator grant/,
  );
  const p = packet(f.project, f.store, f.book.bookSha256, id, true);
  assert.equal(p.reviewStatus, "completed");
  assert.equal(p.claims.length, 1);
  assert.equal(p.claims[0]!.id, "claim-" + protocolHex(1));
  assert.equal("probability" in p.claims[0]!, false);
  assert.equal("role" in p, false);
  assert.equal("caseId" in p, false);
  assert.equal("answers" in p, false);
  assert.equal("sessionId" in p, false);
  assert.equal("judgments" in p, false);
  assert.equal(p.source.files.length, 1);
  const { packetSha256, ...body } = p;
  assert.equal(digest(encodeReviewEvaluationArtifact(body)), packetSha256);
  assert.deepEqual(packet(f.project, f.store, f.book.bookSha256, id, true), p);
  for (const secret of [
    f.input.metering.slots[0]!.attempts[0]!.sessionId,
    f.input.captures[0]!.caseId,
    '"probability"',
    '"baseline"',
    '"verifier"',
    '"reference"',
  ])
    assert.equal(JSON.stringify(p).includes(secret), false, secret);
});
test("independent external judging rejects foreign packets claims and stale source citations with the exact expected inventory", async (t) => {
  for (const mode of [
    "packet",
    "claim",
    "duplicate",
    "omitted",
    "quote",
    "path",
    "range",
    "missing-citation",
  ]) {
    const f = await judgingFixture(t);
    const submissions = await all(f);
    submissions[0] = await f.response(f.book.blindIds[0]!, (v) => {
      const c = v.claims as {
        id: string;
        citations: (typeof originalCitation)[];
      }[];
      if (mode === "packet") v.packetSha256 = "f".repeat(64);
      else if (mode === "claim") c[0]!.id = "claim-" + protocolHex(999);
      else if (mode === "duplicate") c.push(structuredClone(c[0]!));
      else if (mode === "omitted") v.claims = [];
      else if (mode === "quote")
        c[0]!.citations[0]!.quote = "Original absent quotation";
      else if (mode === "path")
        c[0]!.citations[0]!.file = "src/decision.ts.extra";
      else if (mode === "range")
        c[0]!.citations[0]!.startLine = c[0]!.citations[0]!.endLine = 999;
      else c[0]!.citations = [];
    });
    const r = seal(f.project, f.store, f.book.bookSha256, submissions);
    assert.equal(r.judgmentsComplete, false, mode);
    assert.equal(r.counts.accepted, 17);
    assert.equal(r.counts.rejected, 1);
    arithmetic(r);
  }
});
test("independent external judging rejects every reused judge session including review and foreign response sessions", async (t) => {
  for (const mode of ["judges", "review", "foreign"]) {
    const f = await judgingFixture(t),
      submissions = await all(f),
      session =
        mode === "review"
          ? f.input.metering.slots.at(-1)!.attempts.at(-1)!.sessionId
          : "session-" + protocolHex(99999);
    submissions[0] = await f.response(f.book.blindIds[0]!, (v) => {
      v.sessionId = session;
    });
    if (mode === "judges")
      submissions[1] = await f.response(f.book.blindIds[1]!, (v) => {
        v.sessionId = session;
      });
    if (mode === "foreign")
      submissions.push(
        await f.response(f.book.blindIds[1]!, (v) => {
          v.sessionId = session;
        }),
      );
    if (mode === "foreign")
      submissions.at(-1)!.blindId = "judge-" + protocolHex(9876);
    const r = seal(f.project, f.store, f.book.bookSha256, submissions);
    assert.equal(r.judgmentsComplete, false);
    assert.equal(r.counts.accepted, mode === "judges" ? 16 : 17);
    assert.equal(r.counts.rejected, mode === "judges" ? 2 : 1);
    arithmetic(r);
  }
});
test("independent external judging preserves missing duplicate foreign and explicitly unrun planned denominators", async (t) => {
  const f = await judgingFixture(t),
    submissions = await all(f);
  submissions.shift();
  submissions.push({ ...submissions[0]! });
  const foreign = await f.response(f.book.blindIds[2]!);
  submissions.push({ ...foreign, blindId: "judge-" + protocolHex(99999) });
  const r = seal(f.project, f.store, f.book.bookSha256, submissions);
  assert.equal(r.counts.planned, 18);
  assert.equal(r.counts.missing, 1);
  assert.equal(r.counts.rejected, 1);
  assert.equal(r.counts.accepted, 16);
  assert.equal(r.counts.duplicateRecords, 1);
  assert.equal(r.counts.foreignRecords, 1);
  assert.equal(r.judgmentsComplete, false);
  arithmetic(r);
  const g = await judgingFixture(t),
    none = g.book.blindIds.map((blindId) => ({
      blindId,
      responseSha256: null,
    }));
  const empty = seal(g.project, g.store, g.book.bookSha256, none);
  assert.equal(empty.counts.missing, 18);
  assert.equal(empty.counts.planned, 18);
  assert.equal(empty.counts.accepted, 0);
  assert.equal(empty.counts.retainedResponseBlobs, 0);
  arithmetic(empty);
});
test("independent external judging binds source bytes protocol commitments and immutable books before disclosing", async (t) => {
  const f = await judgingFixture(t),
    book = JSON.parse(
      await readFile(path.join(f.store, "judging.book.json"), "utf8"),
    ),
    original = Buffer.from(encodeReviewEvaluationArtifact(book));
  assert.throws(
    () => packet(f.project, f.store, "f".repeat(64), f.book.blindIds[0]!, true),
    /identity/,
  );
  for (const mode of ["source", "slot", "procedure", "protocol"]) {
    const b = structuredClone(book);
    if (mode === "source") {
      const changed = JSON.parse(
        Buffer.from(b.sources[0].base64, "base64").toString(),
      );
      changed.files[0].content +=
        "\n// Original source identity change with the same valid citation";
      b.sources[0].base64 =
        encodeReviewEvaluationArtifact(changed).toString("base64");
    } else if (mode === "slot")
      b.slots[0].role =
        b.slots[0].role === "baseline" ? "reference" : "baseline";
    else if (mode === "procedure") b.procedureSha256 = "f".repeat(64);
    else b.protocolSha256 = "f".repeat(64);
    const bytes = encodeReviewEvaluationArtifact(b);
    await writeFile(path.join(f.store, "judging.book.json"), bytes);
    assert.throws(
      () =>
        packet(f.project, f.store, digest(bytes), f.book.blindIds[0]!, true),
      /disagree/,
      mode,
    );
  }
  await writeFile(path.join(f.store, "judging.book.json"), original);
  const before = await readFile(path.join(f.store, "judging.book.json"));
  assert.throws(() =>
    prepare(f.project, f.store, f.captured.archiveSha256, f.sources),
  );
  assert.deepEqual(
    await readFile(path.join(f.store, "judging.book.json")),
    before,
  );
});
test("independent external judging retains refused cancelled unavailable unfinished and unresolved judgments", async (t) => {
  for (const status of [
    "unavailable",
    "refused",
    "cancelled",
    "timed-out",
    "error",
    "incomplete",
  ]) {
    const f = await judgingFixture(t),
      submissions = await all(f);
    submissions[0] = await f.response(f.book.blindIds[0]!, (v) => {
      v.status = status;
    });
    const r = seal(f.project, f.store, f.book.bookSha256, submissions);
    assert.equal(r.judgmentsComplete, false, status);
    assert.equal(r.counts.rejected, 1);
    arithmetic(r);
  }
  const f = await judgingFixture(t),
    submissions = await all(f);
  submissions[0] = await f.response(f.book.blindIds[0]!, (v) => {
    (v.claims as { judgement: string; citations: unknown[] }[])[0]!.judgement =
      "unresolved";
    (v.claims as { citations: unknown[] }[])[0]!.citations = [];
  });
  const r = seal(f.project, f.store, f.book.bookSha256, submissions);
  assert.equal(r.counts.accepted, 18);
  assert.equal(r.judgmentsComplete, true);
  assert.equal(r.qualityAssessed, false);
  assert.equal(r.judgmentsResolved, false);
  assert.equal(r.counts.unresolvedClaimJudgments, 1);
  assert.equal(r.counts.resolvedClaimJudgments, 17);

  arithmetic(r);
});
test("independent external judging keeps malformed stale and incomplete reviewer outputs distinct from valid abstentions", async (t) => {
  for (const review of [
    "Original plain prose",
    {
      schemaVersion: 1,
      profile: "independent-review-output-v1",
      claims: [
        {
          id: "claim-" + protocolHex(1),
          family: "types-numeric-semantics",
          statement: "Original stale claim",
          probability: null,
          citations: [{ ...originalCitation, quote: "Original absent code" }],
        },
      ],
    },
  ]) {
    const f = await judgingFixture(t, { review });
    for (const id of f.book.blindIds)
      assert.equal(
        packet(f.project, f.store, f.book.bookSha256, id, true).reviewStatus,
        "invalid",
      );
    const r = seal(f.project, f.store, f.book.bookSha256, await all(f));
    assert.equal(r.counts.rejected, 18);
    assert.equal(r.judgmentsComplete, false);
  }
  const f = await judgingFixture(t, {
    review: {
      schemaVersion: 1,
      profile: "independent-review-output-v1",
      claims: [],
    },
  });
  const r = seal(f.project, f.store, f.book.bookSha256, await all(f));
  assert.equal(r.judgmentsComplete, true);
  assert.equal(r.counts.accepted, 18);
  assert.equal(r.qualityAssessed, false);
  const missing = await judgingFixture(t, {
    beforeSeal: async (f, store) => {
      await rm(
        path.join(
          store,
          "blobs",
          f.input.metering.slots[0]!.attempts[0]!.recordSha256 + ".blob",
        ),
      );
    },
  });
  const incomplete = seal(
    missing.project,
    missing.store,
    missing.book.bookSha256,
    await all(missing),
  );
  assert.equal(incomplete.counts.accepted, 18);
  assert.equal(incomplete.reviewEvidenceComplete, false);
  assert.equal(incomplete.judgmentsComplete, false);
});
test("independent external judging validates every source and packet target before writing any book", async (t) => {
  const f = await judgingFixture(t),
    original = await readFile(path.join(f.store, "judging.book.json"));
  await rm(path.join(f.store, "judging.book.json"));
  for (const sources of [
    [],
    [...f.sources, f.sources[0]!],
    f.sources.slice(1),
    f.sources.map((s, i) =>
      i ? s : { ...s, caseId: "case-" + protocolHex(999) },
    ),
  ]) {
    assert.throws(() =>
      prepare(f.project, f.store, f.captured.archiveSha256, sources),
    );
    assert.equal((await readdir(f.store)).includes("judging.book.json"), false);
  }
  assert.equal(
    reviewEvaluationSourcePacketSchema.safeParse({
      schemaVersion: 1,
      profile: "independent-review-source-packet-v1",
      files: [{ file: "../escape", content: "Original" }],
    }).success,
    false,
  );
  assert.equal(
    reviewEvaluationSourcePacketSchema.safeParse({
      schemaVersion: 1,
      profile: "independent-review-source-packet-v1",
      files: [{ file: "src/decision.ts", content: "Original" }],
      answer: "defect",
    }).success,
    false,
  );
  const p = JSON.parse(Buffer.from(f.sources[0]!.base64, "base64").toString());
  p.files.push(p.files[0]);
  assert.equal(reviewEvaluationSourcePacketSchema.safeParse(p).success, false);
  await writeFile(path.join(f.store, "judging.book.json"), original, {
    mode: 0o600,
  });
  let largeStore = "";
  await assert.rejects(
    judgingFixture(t, {
      sourcePadding: 4 * 1048576 - 250,
      beforePrepare: (store) => {
        largeStore = store;
      },
    }),
    /disclosure bound/,
  );
  assert.notEqual(largeStore, "");
  assert.equal(
    (await readdir(largeStore)).includes("judging.book.json"),
    false,
  );
});
test("independent external judging retains malformed physical responses and refuses changed bytes before sealing", async (t) => {
  const f = await judgingFixture(t),
    submissions = await all(f),
    bytes = Buffer.from("{ Original malformed response"),
    id = digest(bytes);
  await writeFile(path.join(f.store, "blobs", id + ".blob"), bytes, {
    mode: 0o600,
  });
  submissions[0] = { blindId: f.book.blindIds[0]!, responseSha256: id };
  const r = seal(f.project, f.store, f.book.bookSha256, submissions);
  assert.equal(r.counts.rejected, 1);
  assert.equal(r.counts.retainedResponseBlobs, 18);
  assert.deepEqual(replay(f.project, f.store, r.judgmentsSha256), r);
  const g = await judgingFixture(t),
    next = await all(g);
  await writeFile(
    path.join(g.store, "blobs", next[0]!.responseSha256 + ".blob"),
    "Original changed physical bytes",
  );
  assert.throws(
    () => seal(g.project, g.store, g.book.bookSha256, next),
    /identity/,
  );
  assert.equal(
    (await readdir(g.store)).includes("judgments.sealed.json"),
    false,
  );
});
test("independent external judging replays retained responses and refuses stale duplicate missing unused or rewritten sealed inventories", async (t) => {
  const f = await judgingFixture(t),
    r = seal(f.project, f.store, f.book.bookSha256, await all(f)),
    original = await archived(f.store);
  await rm(path.join(f.store, "blobs"), { recursive: true });
  assert.deepEqual(replay(f.project, f.store, r.judgmentsSha256), r);
  assert.throws(() => replay(f.project, f.store, "f".repeat(64)), /identity/);
  for (const mode of ["duplicate", "omitted", "missing", "unused", "bytes"]) {
    const a = structuredClone(original);
    if (mode === "duplicate") a.responses.push(a.responses[0]);
    else if (mode === "omitted") a.responses.pop();
    else if (mode === "missing") a.missing.push(a.responses[0].sha256);
    else if (mode === "unused") {
      const b = Buffer.from("Original unused");
      a.responses.push({ sha256: digest(b), base64: b.toString("base64") });
    } else
      a.responses[0].base64 =
        Buffer.from("Original altered").toString("base64");
    const id = await rewrite(f.store, a);
    assert.throws(() => replay(f.project, f.store, id), /Sealed/, mode);
  }
  await rewrite(f.store, original);
  await mkdir(path.join(f.store, "blobs"), { mode: 0o700 });
  const before = await readFile(path.join(f.store, "judgments.sealed.json"));
  assert.throws(() => seal(f.project, f.store, f.book.bookSha256, []));
  assert.deepEqual(
    await readFile(path.join(f.store, "judgments.sealed.json")),
    before,
  );
  assert.deepEqual(replay(f.project, f.store, r.judgmentsSha256), r);
});
test("independent external judging never invokes inference or verifies authority and keeps private content out of summaries", async (t) => {
  const f = await judgingFixture(t),
    submissions = await all(f),
    original = structuredClone(submissions),
    fetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      throw Error("No model access permitted");
    };
    const r = seal(f.project, f.store, f.book.bookSha256, submissions);
    assert.equal(calls, 0);
    assert.deepEqual(submissions, original);
    for (const k of [
      "sourceIncluded",
      "privateIdentitiesIncluded",
      "actualAttemptsComplete",
      "hostIndependenceVerified",
      "judgeAuthorityVerified",
      "qualityAssessed",
      "gateAClosed",
      "inferenceInvoked",
    ] as const)
      assert.equal(r[k], false, k);
    for (const secret of [
      f.book.blindIds[0]!,
      f.input.captures[0]!.caseId,
      originalCitation.quote,
      '"role"',
    ])
      assert.equal(JSON.stringify(r).includes(secret), false);
  } finally {
    globalThis.fetch = fetch;
  }
  assert.throws(
    () => seal(f.project, f.store, f.book.bookSha256, Array(1537).fill(null)),
    /submission count bound/,
  );
  assert.throws(
    () =>
      prepare(
        f.project,
        f.store,
        f.captured.archiveSha256,
        Array(257).fill(null),
      ),
    /source count bound/,
  );
  assert.equal(
    reviewEvaluationJudgmentResponseSchema.safeParse({
      authorization: "OriginalPrivateCredentialCanary",
    }).success,
    false,
  );
  assert.equal(
    reviewEvaluationReviewOutputSchema.safeParse({
      schemaVersion: 1,
      profile: "independent-review-output-v1",
      claims: [],
      answer: "valid",
    }).success,
    false,
  );
});

test("independent external judging CLI requires an explicit source grant and retains private sealed accounting", async (t) => {
  const f = await judgingFixture(t),
    cli = fileURLToPath(
      new URL("../../scripts/evaluation-judgments.mjs", import.meta.url),
    );
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, [cli, ...args], {
      input,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 65536,
    });
  const args = [f.project, f.store, f.book.bookSha256, f.book.blindIds[0]!];
  const denied = run(["packet", ...args]);
  assert.equal(denied.status, 1);
  assert.equal(denied.stdout, "");
  assert.equal(
    denied.stderr,
    "Independent judging input or artifacts invalid or unavailable\n",
  );
  const allowed = run(["packet", ...args, "--allow-source"]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.deepEqual(
    JSON.parse(allowed.stdout),
    packet(f.project, f.store, f.book.bookSha256, f.book.blindIds[0]!, true),
  );
  const sealed = run(
    ["seal", f.project, f.store, f.book.bookSha256],
    JSON.stringify(await all(f)),
  );
  assert.equal(sealed.status, 0, sealed.stderr);
  const r = JSON.parse(sealed.stdout);
  assert.equal(r.counts.accepted, 18);
  assert.equal(r.judgmentsResolved, true);
  const inspected = run(["inspect", f.project, f.store, r.judgmentsSha256]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(JSON.parse(inspected.stdout), r);
  assert.equal(inspected.stdout.includes(originalCitation.quote), false);
  assert.equal(inspected.stdout.includes(f.input.captures[0]!.caseId), false);
  const invalid = run(
    ["seal", f.project, f.store, f.book.bookSha256],
    "OriginalPrivateJudgingInputCanary",
  );
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(
    invalid.stderr.includes("OriginalPrivateJudgingInputCanary"),
    false,
  );
  const g = await judgingFixture(t),
    incomplete = run(["seal", g.project, g.store, g.book.bookSha256], "[]");
  assert.equal(incomplete.status, 2);
  assert.equal(JSON.parse(incomplete.stdout).counts.missing, 18);
});
test(
  "independent external judging repeats anonymous packet and physical response controls through a fresh offline installation",
  { timeout: 120000 },
  async () => {
    if (process.env.CHECKTRAIL_EVALUATION_PROTOCOL_INSTALLED === "1") {
      const actual = await realpath(
        fileURLToPath(
          new URL("../src/review-evaluation-judging.js", import.meta.url),
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
    const p = spawnSync(process.execPath, [script, "--judging"], {
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
    assert.equal(proof.profileEvidence.required, 14);
    assert.equal(proof.profileEvidence.passed, 14);
    assert.equal(proof.profileEvidence.complete, true);
  },
);
