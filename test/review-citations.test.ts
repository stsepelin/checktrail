import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createReviewContext,
  receiveReview,
  projectReviewReceipt,
  reviewReceiptSchema,
  reviewReceiptSummarySchema,
  type ReviewContext,
} from "../src/review.js";
import { fixture } from "./helpers.js";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";
import { reviewChanges } from "../src/review-diff.js";
import { collectReviewBehavior } from "../src/review-behavior.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const base = {
  "subject.ts": "// stable label\nexport const threshold = 3;\n",
  "deleted.ts": "export const removed = 'synthetic';\n",
  "stable.ts": "export const stable = true;\n",
  ".checktrail/keep": "",
};
async function assignment(t: TestContext) {
  const root = await fixture(t, base);
  fixtureGit(root, ["init", "--quiet"]);
  const baseCommit = await syntheticCommit(root, base);
  await writeFile(
    path.join(root, "subject.ts"),
    base["subject.ts"].replace("3", "2"),
  );
  await rm(path.join(root, "deleted.ts"));
  await writeFile(path.join(root, "added.ts"), "export const added = true;\n");
  const context = await createReviewContext(root, {
    schemaVersion: 4,
    track: "diff",
    baseCommit,
    files: ["subject.ts", "deleted.ts", "added.ts"],
    supportFiles: ["stable.ts"],
    topics: [],
  });
  return { root, context };
}
function citation(
  context: ReviewContext,
  revision: "base" | "current",
  file: string,
  startLine = 1,
  endLine = startLine,
) {
  const files =
    revision === "base" &&
    context.schemaVersion !== 1 &&
    context.evidence.track === "diff"
      ? context.evidence.baseFiles
      : context.files;
  const source = files.find((source) => source.path === file)!;
  return {
    revision,
    file,
    sourceDigest: source.sha256,
    startLine,
    endLine,
    quote: source.content
      .split("\n")
      .slice(startLine - 1, endLine)
      .join("\n"),
  };
}
function assessment(context: ReviewContext) {
  return {
    schemaVersion: 2 as const,
    contextDigest: context.contextDigest,
    reviewer: {
      kind: "human" as const,
      name: "Synthetic independent reviewer label",
    },
    createdAt: "2026-09-30T00:00:00Z",
    usage: {
      inputTokens: null,
      outputTokens: null,
      elapsedMs: null,
      costUSD: null,
    },
    files: [
      ...context.selection.files,
      ...("supportFiles" in context.selection
        ? context.selection.supportFiles
        : []),
    ].map((path) => ({
      path,
      disposition: "reviewed" as const,
      note: "Declared only",
    })),
    observations: [
      {
        id: "claim",
        severity: "concern" as const,
        claim: "A synthetic unverified claim.",
        attribution: "regression" as "regression" | "pre-existing" | "unknown",
        fixScope: "this-change" as "this-change" | "follow-up" | "unknown",
        citations: [
          context.schemaVersion !== 1 &&
          context.evidence.track === "diff" &&
          context.evidence.baseFiles.length > 0
            ? citation(
                context,
                "base",
                context.evidence.baseFiles.find(
                  (file) => file.path === "deleted.ts",
                )?.path ?? context.evidence.baseFiles[0]!.path,
              )
            : citation(context, "current", context.files[0]!.path),
        ],
      },
    ],
  };
}

test("revision receipts anchor deleted base source and expose attribution without verifying claims", async (t) => {
  const { root, context } = await assignment(t);
  assert.equal(context.schemaVersion, 4);
  assert.match(context.instructions, /assessment version 2/);
  assert.doesNotMatch(
    context.instructions,
    /Citations address current files only/,
  );
  const input = assessment(context);
  input.observations.push({
    ...input.observations[0]!,
    id: "prior",
    attribution: "pre-existing",
    fixScope: "follow-up",
    citations: [
      citation(context, "base", "stable.ts"),
      citation(context, "current", "stable.ts"),
    ],
  });
  input.observations.push({
    ...input.observations[0]!,
    id: "added",
    attribution: "unknown",
    fixScope: "unknown",
    citations: [citation(context, "current", "added.ts")],
  });
  const receipt = await receiveReview(root, context, input);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.freshness, "current");
  assert.deepEqual(receipt.citations, {
    matched: 4,
    unmatched: 0,
    base: 2,
    current: 2,
  });
  assert.deepEqual(receipt.citationChecks, [
    {
      observationId: "claim",
      citation: 0,
      revision: "base",
      sourceDigestMatches: true,
      quoteMatches: true,
      matchesContext: true,
      changeOverlap: "replacement-range",
    },
    {
      observationId: "prior",
      citation: 0,
      revision: "base",
      sourceDigestMatches: true,
      quoteMatches: true,
      matchesContext: true,
      changeOverlap: "outside-replacement-range",
    },
    {
      observationId: "prior",
      citation: 1,
      revision: "current",
      sourceDigestMatches: true,
      quoteMatches: true,
      matchesContext: true,
      changeOverlap: "outside-replacement-range",
    },
    {
      observationId: "added",
      citation: 0,
      revision: "current",
      sourceDigestMatches: true,
      quoteMatches: true,
      matchesContext: true,
      changeOverlap: "replacement-range",
    },
  ]);
  const summary = projectReviewReceipt(receipt, false);
  assert.deepEqual(summary.attribution, {
    provenance: "reviewer-declared",
    verified: false,
    regression: 1,
    preExisting: 1,
    unknown: 1,
  });
  assert.deepEqual(summary.fixScope, {
    provenance: "reviewer-declared",
    verified: false,
    thisChange: 1,
    followUp: 1,
    unknown: 1,
  });
  assert.equal(receipt.claimsVerified, false);
  assert.equal(receipt.automatedCoverage, false);
  assert.equal(receipt.deterministicOutcomeChanged, false);
  assert.ok(!("outcome" in receipt));
  assert.ok(!("findings" in receipt));
  for (const value of [
    "deleted.ts",
    "removed",
    "unverified claim",
    "Synthetic independent",
    context.evidence.track === "diff"
      ? context.evidence.baseCommit
      : "unexpected",
  ])
    assert.ok(!JSON.stringify(summary).includes(value), value);
  assert.deepEqual(projectReviewReceipt(receipt, true), receipt);
  // Matching unchanged source cannot establish a regression, even when declared.
  input.observations = [
    {
      ...input.observations[0]!,
      citations: [citation(context, "current", "stable.ts")],
    },
  ];
  const unchanged = await receiveReview(root, context, input);
  assert.equal(unchanged.claimsVerified, false);
  assert.deepEqual(unchanged.citationChecks, [
    {
      observationId: "claim",
      citation: 0,
      revision: "current",
      sourceDigestMatches: true,
      quoteMatches: true,
      matchesContext: true,
      changeOverlap: "outside-replacement-range",
    },
  ]);
});

test("revision citations reject digest swaps even when the complete quote occurs in both revisions", async (t) => {
  const { root, context } = await assignment(t);
  const input = assessment(context);
  const current = citation(context, "current", "subject.ts");
  const previous = citation(context, "base", "subject.ts");
  assert.equal(current.quote, previous.quote);
  assert.notEqual(current.sourceDigest, previous.sourceDigest);
  input.observations[0]!.citations = [
    current,
    previous,
    { ...current, sourceDigest: previous.sourceDigest },
    { ...previous, revision: "current" },
    { ...current, quote: "wrong quote" },
    { ...current, startLine: 100, endLine: 100 },
  ];
  const receipt = await receiveReview(root, context, input);
  assert.deepEqual(receipt.citations, {
    matched: 2,
    unmatched: 4,
    base: 1,
    current: 5,
  });
  assert.deepEqual(
    receipt.citationChecks.map((check) => check.matchesContext),
    [true, true, false, false, false, false],
  );
  assert.deepEqual(receipt.citationChecks[2], {
    observationId: "claim",
    citation: 2,
    revision: "current",
    sourceDigestMatches: false,
    quoteMatches: true,
    matchesContext: false,
    changeOverlap: "not-available",
  });
  input.observations[0]!.citations = [
    citation(context, "current", "subject.ts", 2),
    citation(context, "base", "subject.ts", 2),
  ];
  assert.equal(
    (await receiveReview(root, context, input)).citations.unmatched,
    0,
  );
});

test("revision citation scope never substitutes an absent revision and remains strict", async (t) => {
  const { root, context } = await assignment(t);
  const original = assessment(context);
  for (const bad of [
    { ...original.observations[0]!.citations[0]!, revision: "current" },
    { ...citation(context, "current", "added.ts"), revision: "base" },
    { ...citation(context, "current", "stable.ts"), file: "unselected.ts" },
    { ...citation(context, "current", "stable.ts"), startLine: 2, endLine: 1 },
    { ...citation(context, "current", "stable.ts"), revision: "HEAD" },
    { ...citation(context, "current", "stable.ts"), sourceDigest: undefined },
  ]) {
    const input = structuredClone(original);
    input.observations[0]!.citations = [
      bad as (typeof input.observations)[0]["citations"][number],
    ];
    await assert.rejects(receiveReview(root, context, input));
  }
  const duplicate = structuredClone(original);
  duplicate.observations.push(duplicate.observations[0]!);
  await assert.rejects(receiveReview(root, context, duplicate), /unique/);
});

test("snapshot attribution cannot claim observed history and legacy exchange contracts stay separate", async (t) => {
  const root = await fixture(t, {
    "subject.ts": "export const ready = true;\n",
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, {
    schemaVersion: 4,
    track: "snapshot",
    files: ["subject.ts"],
    supportFiles: [],
    topics: [],
  });
  const input = assessment(context);
  input.observations[0]!.attribution = "unknown";
  input.observations[0]!.fixScope = "follow-up";
  input.observations[0]!.citations = [
    citation(context, "current", "subject.ts"),
  ];
  const receipt = await receiveReview(root, context, input);
  assert.equal(receipt.freshness, "current");
  assert.deepEqual(receipt.citationChecks, [
    {
      observationId: "claim",
      citation: 0,
      revision: "current",
      sourceDigestMatches: true,
      quoteMatches: true,
      matchesContext: true,
      changeOverlap: "not-available",
    },
  ]);
  for (const attribution of ["regression", "pre-existing"] as const) {
    input.observations[0]!.attribution = attribution;
    await assert.rejects(
      receiveReview(root, context, input),
      /historical attribution/,
    );
  }
  input.observations[0]!.attribution = "unknown";
  input.observations[0]!.citations[0]!.revision = "base";
  await assert.rejects(receiveReview(root, context, input), /selected scope/);
  for (const schemaVersion of [1, 2, 3] as const) {
    const older = await createReviewContext(root, {
      schemaVersion,
      files: ["subject.ts"],
      topics: [],
      ...(schemaVersion !== 1 ? { track: "snapshot" } : {}),
      ...(schemaVersion === 3 ? { supportFiles: [] } : {}),
    });
    const legacy = {
      ...assessment(older),
      schemaVersion: 1,
      observations: [
        {
          id: "legacy",
          severity: "concern",
          claim: "Original current citation protocol",
          citations: [
            {
              file: "subject.ts",
              startLine: 1,
              endLine: 1,
              quote: "export const ready = true;",
            },
          ],
        },
      ],
    };
    const legacyReceipt = await receiveReview(root, older, legacy);
    assert.equal(legacyReceipt.schemaVersion, 1);
    assert.deepEqual(legacyReceipt.citations, { matched: 1, unmatched: 0 });
    assert.deepEqual(legacyReceipt.citationChecks, [
      { observationId: "legacy", citation: 0, matchesContext: true },
    ]);
    await assert.rejects(
      receiveReview(root, context, {
        ...legacy,
        contextDigest: context.contextDigest,
      }),
      /version/,
    );
    await assert.rejects(
      receiveReview(root, older, {
        ...input,
        contextDigest: older.contextDigest,
      }),
      /version/,
    );
  }
});

test("revision quotes preserve UTF-8 and CRLF bytes and do not accept partial lines", async (t) => {
  const root = await fixture(t, {
    "subject.ts": "// λ🦉\r\nexport const ready = true;\r\n",
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, {
    schemaVersion: 4,
    track: "snapshot",
    files: ["subject.ts"],
    supportFiles: [],
    topics: [],
  });
  const input = assessment(context);
  input.observations[0]!.attribution = "unknown";
  const valid = citation(context, "current", "subject.ts", 1, 2);
  input.observations[0]!.citations = [
    valid,
    { ...valid, quote: valid.quote.replaceAll("\r", "") },
    { ...valid, quote: "λ🦉" },
  ];
  assert.deepEqual((await receiveReview(root, context, input)).citations, {
    matched: 1,
    unmatched: 2,
    base: 0,
    current: 3,
  });
});

test("revision receipt freshness reconstructs base evidence and distinguishes stale anchors", async (t) => {
  const { root, context } = await assignment(t);
  const original = assessment(context);
  const forged = structuredClone(context);
  if (
    forged.schemaVersion === 1 ||
    forged.evidence.track !== "diff" ||
    !("analysis" in forged)
  )
    throw new Error("Wrong context");
  forged.evidence.baseFiles[0]!.content += "// invented historical line\n";
  forged.evidence.baseFiles[0]!.sha256 = hash(
    forged.evidence.baseFiles[0]!.content,
  );
  forged.evidence.changes = reviewChanges(
    forged.evidence.baseFiles,
    forged.files,
    [
      ...forged.selection.files,
      ...("supportFiles" in forged.selection
        ? forged.selection.supportFiles
        : []),
    ].sort(),
  );
  forged.analysis = await collectReviewBehavior(
    forged.files,
    forged.evidence.baseFiles,
    forged.selection.files,
    true,
  );
  const { contextDigest, ...body } = forged;
  void contextDigest;
  forged.contextDigest = hash(JSON.stringify(body));
  const forgedInput = assessment(forged);
  const forgedReceipt = await receiveReview(root, forged, forgedInput);
  assert.equal(forgedReceipt.freshness, "stale");
  assert.equal(forgedReceipt.citations.matched, 1);
  await writeFile(path.join(root, "deleted.ts"), base["deleted.ts"]);
  const readded = await receiveReview(root, context, original);
  assert.equal(readded.freshness, "stale");
  assert.equal(readded.citations.matched, 1);
  await rm(path.join(root, "deleted.ts"));
  assert.equal(
    (await receiveReview(root, context, original)).freshness,
    "current",
  );
  fixtureGit(root, [
    "update-index",
    "--cacheinfo",
    `100644,${fixtureGit(root, ["rev-parse", "HEAD:stable.ts"]).trim()},subject.ts`,
  ]);
  assert.equal(
    (await receiveReview(root, context, original)).freshness,
    "stale",
  );
});

test("revision CLI and MCP receipts share anchors and keep source and attribution prose behind the operator gate", async (t) => {
  const { root, context } = await assignment(t);
  const input = assessment(context);
  await writeFile(
    path.join(root, ".checktrail/context.json"),
    JSON.stringify(context),
  );
  await writeFile(
    path.join(root, ".checktrail/assessment.json"),
    JSON.stringify(input),
  );
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const args = [
    cli,
    "review-receipt",
    "--root",
    root,
    "--context",
    ".checktrail/context.json",
    "--input",
    ".checktrail/assessment.json",
  ];
  const expected = await receiveReview(root, context, input);
  for (const enabled of [false, true]) {
    const flags = enabled
      ? ["--detailed", "--allow-review-source"]
      : ["--detailed"];
    const result = spawnSync(process.execPath, [...args, ...flags], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      projectReviewReceipt(expected, enabled),
    );
    const client = new Client(
      { name: "synthetic-revision-client", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cli, "serve", "--root", root, ...flags],
          stderr: "pipe",
        }),
      );
      const response = await client.callTool({
        name: "review_receipt",
        arguments: {
          context: ".checktrail/context.json",
          input: ".checktrail/assessment.json",
        },
      });
      assert.equal(response.isError, undefined);
      (enabled ? reviewReceiptSchema : reviewReceiptSummarySchema).parse(
        response.structuredContent,
      );
      assert.deepEqual(
        response.structuredContent,
        projectReviewReceipt(expected, enabled),
      );
      assert.equal(
        JSON.stringify(response).includes("removed = 'synthetic'"),
        enabled,
      );
      assert.equal(
        (
          await client.callTool({
            name: "review_receipt",
            arguments: {
              context: ".checktrail/context.json",
              input: ".checktrail/assessment.json",
              allowReviewSource: true,
            },
          })
        ).isError,
        true,
      );
      const prepared = await client.callTool({
        name: "review_context",
        arguments: context.selection,
      });
      assert.equal(prepared.isError, undefined);
      if (enabled) assert.deepEqual(prepared.structuredContent, context);
      else
        assert.ok(!JSON.stringify(prepared).includes("removed = 'synthetic'"));
    } finally {
      await client.close();
    }
  }
  input.observations[0]!.citations[0]!.sourceDigest = "0".repeat(64);
  await writeFile(
    path.join(root, ".checktrail/assessment.json"),
    JSON.stringify(input),
  );
  const bad = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(bad.status, 2, bad.stderr);
  assert.equal(JSON.parse(bad.stdout).citations.unmatched, 1);
});

test("deleted-only receipts keep base accounting and replacement overlap remains conservative", async (t) => {
  const root = await fixture(t, {
    "deleted.ts": base["deleted.ts"],
    ".checktrail/keep": "",
  });
  fixtureGit(root, ["init", "--quiet"]);
  const baseCommit = await syntheticCommit(root, {
    "deleted.ts": base["deleted.ts"],
  });
  await rm(path.join(root, "deleted.ts"));
  const context = await createReviewContext(root, {
    schemaVersion: 4,
    track: "diff",
    baseCommit,
    files: ["deleted.ts"],
    supportFiles: [],
    topics: [],
  });
  assert.deepEqual(context.files, []);
  const input = assessment(context);
  const receipt = await receiveReview(root, context, input);
  assert.deepEqual(receipt.coverage, {
    selected: 1,
    declaredReviewed: 1,
    declaredNotReviewed: 0,
    unaccounted: 0,
  });
  assert.deepEqual(receipt.citations, {
    matched: 1,
    unmatched: 0,
    base: 1,
    current: 0,
  });
  assert.equal(receipt.freshness, "current");
  input.files = [];
  input.observations = [];
  const empty = await receiveReview(root, context, input);
  assert.deepEqual(empty.coverage, {
    selected: 1,
    declaredReviewed: 0,
    declaredNotReviewed: 0,
    unaccounted: 1,
  });
  assert.deepEqual(empty.citations, {
    matched: 0,
    unmatched: 0,
    base: 0,
    current: 0,
  });
  assert.equal(empty.claimsVerified, false);

  const middleRoot = await fixture(t, {
    "subject.ts":
      "// prefix\nexport const first = 1;\nexport const stable = true;\nexport const last = 1;\n// suffix\n",
    ".checktrail/keep": "",
  });
  fixtureGit(middleRoot, ["init", "--quiet"]);
  const before = await syntheticCommit(middleRoot, {
    "subject.ts":
      "// prefix\nexport const first = 1;\nexport const stable = true;\nexport const last = 1;\n// suffix\n",
  });
  await writeFile(
    path.join(middleRoot, "subject.ts"),
    "// prefix\nexport const first = 2;\nexport const stable = true;\nexport const last = 2;\n// suffix\n",
  );
  const middle = await createReviewContext(middleRoot, {
    schemaVersion: 4,
    track: "diff",
    baseCommit: before,
    files: ["subject.ts"],
    supportFiles: [],
    topics: [],
  });
  const review = {
    ...assessment(middle),
    observations: [
      {
        id: "range-only",
        severity: "concern",
        claim: "Unverified range overlap",
        attribution: "unknown",
        fixScope: "unknown",
        citations: [1, 2, 3, 4, 5].map((line) =>
          citation(middle, "current", "subject.ts", line),
        ),
      },
    ],
  };
  const result = await receiveReview(middleRoot, middle, review);
  assert.deepEqual(
    result.citationChecks.map((check) =>
      "changeOverlap" in check ? check.changeOverlap : undefined,
    ),
    [
      "outside-replacement-range",
      "replacement-range",
      "replacement-range",
      "replacement-range",
      "outside-replacement-range",
    ],
  );
  assert.equal(result.claimsVerified, false);
});
