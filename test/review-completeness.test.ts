import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { test, type TestContext } from "node:test";
import {
  createReviewContext,
  projectReviewContext,
  receiveReview,
  type ReviewContext,
} from "../src/review.js";
import { fixture } from "./helpers.js";
import { fixtureGit, syntheticCommit, gitObject } from "./git-fixture.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const initial = "export const value = 'base';\n";
const staged = "export const value = 'index';\n";
const working = "export const value = 'working';\n";
async function project(t: TestContext) {
  const root = await fixture(t, {
    "subject.ts": initial,
    ".checktrail/keep": "",
  });
  fixtureGit(root, ["init", "--quiet"]);
  const baseCommit = await syntheticCommit(root, { "subject.ts": initial });
  const id = await gitObject(root, "blob", Buffer.from(staged));
  fixtureGit(root, ["update-index", "--cacheinfo", `100755,${id},subject.ts`]);
  await writeFile(path.join(root, "subject.ts"), working);
  await chmod(path.join(root, "subject.ts"), 0o644);
  return { root, baseCommit, id };
}
const selection = (
  baseCommit: string,
  currentSource: "index" | "working-tree",
) => ({
  schemaVersion: 5,
  track: "diff",
  baseCommit,
  currentSource,
  files: ["subject.ts"],
  supportFiles: [],
  topics: [],
});
function assessment(context: ReviewContext) {
  const source = context.files[0]!;
  return {
    schemaVersion: 2,
    contextDigest: context.contextDigest,
    reviewer: { kind: "human", name: "Synthetic stage reviewer" },
    createdAt: "2026-09-30T00:00:00Z",
    usage: {
      inputTokens: null,
      outputTokens: null,
      elapsedMs: null,
      costUSD: null,
    },
    files: [{ path: "subject.ts", disposition: "reviewed", note: "Declared" }],
    observations: source
      ? [
          {
            id: "address",
            severity: "concern",
            claim: "Unverified synthetic stage concern",
            attribution: "unknown",
            fixScope: "unknown",
            citations: [
              {
                revision: "current",
                file: source.path,
                sourceDigest: source.sha256,
                startLine: 1,
                endLine: 1,
                quote: source.content.split("\n")[0],
              },
            ],
          },
        ]
      : [],
  };
}
function resign(context: ReviewContext) {
  const { contextDigest, ...body } = context;
  void contextDigest;
  context.contextDigest = sha(JSON.stringify(body));
}

test("complete review contexts select exact working or staged bytes and regular-file modes", async (t) => {
  const { root, baseCommit } = await project(t);
  for (const source of ["working-tree", "index"] as const) {
    const context = await createReviewContext(
      root,
      selection(baseCommit, source),
    );
    assert.equal(context.schemaVersion, 5);
    assert.equal(
      context.files[0]!.content,
      source === "index" ? staged : working,
    );
    const detail = projectReviewContext(context, true);
    assert.deepEqual((detail.evidence as Record<string, unknown>).fileModes, [
      {
        path: "subject.ts",
        before: "100644",
        after: source === "index" ? "100755" : "100644",
      },
    ]);
    assert.equal(
      (detail.evidence as Record<string, unknown>).currentSource,
      source,
    );
    assert.equal(
      (detail.completeness as Record<string, unknown>).fileModes,
      "selected-regular-files",
    );
    assert.equal(
      (await receiveReview(root, context, assessment(context))).freshness,
      "current",
    );
    assert.match(context.instructions, /operator-selected current source/);
    for (const text of [
      staged.trim(),
      working.trim(),
      baseCommit,
      "subject.ts",
      "100755",
    ])
      assert.ok(
        !JSON.stringify(projectReviewContext(context, false)).includes(text),
        text,
      );
  }
});

test("staged review sources retain index additions and deletions independently of the working files", async (t) => {
  const { root, baseCommit, id } = await project(t);
  fixtureGit(root, ["update-index", "--force-remove", "subject.ts"]);
  const deleted = await createReviewContext(
    root,
    selection(baseCommit, "index"),
  );
  assert.deepEqual(deleted.files, []);
  const detail = projectReviewContext(deleted, true);
  assert.deepEqual((detail.evidence as Record<string, unknown>).fileModes, [
    { path: "subject.ts", before: "100644", after: null },
  ]);
  assert.equal(
    (await receiveReview(root, deleted, assessment(deleted))).freshness,
    "current",
  );
  fixtureGit(root, [
    "update-index",
    "--add",
    "--cacheinfo",
    `100644,${id},added.ts`,
  ]);
  const added = await createReviewContext(root, {
    ...selection(baseCommit, "index"),
    files: ["added.ts"],
  });
  assert.equal(added.files[0]!.content, staged);
  assert.deepEqual(
    (projectReviewContext(added, true).evidence as Record<string, unknown>)
      .fileModes,
    [{ path: "added.ts", before: null, after: "100644" }],
  );
  assert.equal(
    (
      await receiveReview(root, added, {
        ...assessment(added),
        files: [
          { path: "added.ts", disposition: "reviewed", note: "Index only" },
        ],
      })
    ).freshness,
    "current",
  );
  await assert.rejects(
    createReviewContext(root, {
      ...selection(baseCommit, "index"),
      files: [".env"],
    }),
  );
  await assert.rejects(
    createReviewContext(root, {
      ...selection(baseCommit, "index"),
      files: ["missing.ts"],
    }),
  );
});

test("selected file-mode changes and fabricated mode evidence invalidate review freshness", async (t) => {
  const { root, baseCommit } = await project(t);
  const context = await createReviewContext(
    root,
    selection(baseCommit, "working-tree"),
  );
  const input = assessment(context);
  await chmod(path.join(root, "subject.ts"), 0o755);
  assert.equal((await receiveReview(root, context, input)).freshness, "stale");
  await chmod(path.join(root, "subject.ts"), 0o644);
  assert.equal(
    (await receiveReview(root, context, input)).freshness,
    "current",
  );
  const forged = structuredClone(context);
  const evidence = projectReviewContext(forged, true).evidence as {
    fileModes: { after: string | null }[];
  };
  evidence.fileModes[0]!.after = "100755";
  Object.assign(forged, { evidence });
  resign(forged);
  assert.equal(
    (await receiveReview(root, forged, assessment(forged))).freshness,
    "stale",
  );
  evidence.fileModes[0]!.after = "100644";
  (evidence.fileModes[0]! as { before?: string }).before = "100755";
  Object.assign(forged, { evidence });
  resign(forged);
  assert.equal(
    (await receiveReview(root, forged, assessment(forged))).freshness,
    "stale",
  );
  evidence.fileModes[0]!.after = null;
  Object.assign(forged, { evidence });
  resign(forged);
  await assert.rejects(
    receiveReview(root, forged, assessment(forged)),
    /mode.*reconcile/,
  );
});

test("working snapshots carry selected modes without history and staged snapshots require a distinct future contract", async (t) => {
  const root = await fixture(t, {
    "subject.ts": working,
    ".checktrail/keep": "",
  });
  await chmod(path.join(root, "subject.ts"), 0o755);
  const input = {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.ts"],
    supportFiles: [],
    topics: [],
  };
  const context = await createReviewContext(root, input);
  assert.deepEqual(projectReviewContext(context, true).evidence, {
    track: "snapshot",
    currentSource: "working-tree",
    fileModes: [{ path: "subject.ts", before: null, after: "100755" }],
  });
  assert.equal(
    (await receiveReview(root, context, assessment(context))).freshness,
    "current",
  );
  await assert.rejects(
    createReviewContext(root, { ...input, currentSource: "index" }),
  );
  await chmod(path.join(root, "subject.ts"), 0o644);
  assert.equal(
    (await receiveReview(root, context, assessment(context))).freshness,
    "stale",
  );
});

test("staged source rejects selected unresolved merges symlinks invalid UTF-8 and aggregate overflows", async (t) => {
  const { root, baseCommit, id } = await project(t);
  fixtureGit(root, ["update-index", "--force-remove", "subject.ts"]);
  fixtureGit(
    root,
    ["update-index", "--index-info"],
    `100644 ${id} 1\tsubject.ts\n100644 ${id} 2\tsubject.ts\n`,
  );
  await assert.rejects(
    createReviewContext(root, selection(baseCommit, "index")),
    /index.*regular|unresolved/,
  );
  fixtureGit(root, ["read-tree", baseCommit]);
  for (const [mode, data] of [
    ["120000", Buffer.from("subject.ts")],
    ["100644", Buffer.from([255])],
    ["100644", Buffer.from("x".repeat(65537))],
  ] as const) {
    const blob = await gitObject(root, "blob", data);
    fixtureGit(root, [
      "update-index",
      "--cacheinfo",
      `${mode},${blob},subject.ts`,
    ]);
    await assert.rejects(
      createReviewContext(root, selection(baseCommit, "index")),
    );
  }
  fixtureGit(root, ["read-tree", baseCommit]);
  const big = await gitObject(root, "blob", Buffer.from("x".repeat(65536)));
  for (const name of ["first.txt", "second.txt"])
    fixtureGit(root, [
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${big},${name}`,
    ]);
  await assert.rejects(
    createReviewContext(root, {
      ...selection(baseCommit, "index"),
      supportFiles: ["first.txt", "second.txt"],
    }),
    /source.*limits|total/,
  );
  await rm(path.join(root, "subject.ts"));
  const current = await createReviewContext(
    root,
    selection(baseCommit, "index"),
  );
  assert.equal(current.files[0]!.content, initial);
});

test("mode-only collection races cannot return a supposedly current review packet", async (t) => {
  const { root, baseCommit } = await project(t);
  const host = spawnSync("which", ["git"], { encoding: "utf8" });
  assert.equal(host.status, 0);
  const original = process.env.PATH;
  const binary = await fixture(t, {
    git: `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const {chmodSync}=require('node:fs');const args=process.argv.slice(2);if(args.includes('ls-files'))chmodSync(${JSON.stringify(path.join(root, "subject.ts"))},0o755);const result=spawnSync(${JSON.stringify(host.stdout.trim())},args,{env:process.env});process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??2);\n`,
  });
  await chmod(path.join(binary, "git"), 0o755);
  process.env.PATH = binary + path.delimiter + (original ?? "");
  try {
    // The first ls-files happens before source capture; flip again on the final identity check.
    await writeFile(
      path.join(binary, "git"),
      `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const {existsSync,writeFileSync,chmodSync}=require('node:fs');const args=process.argv.slice(2);const marker=${JSON.stringify(path.join(binary, "seen"))};if(args.includes('ls-files')){if(existsSync(marker))chmodSync(${JSON.stringify(path.join(root, "subject.ts"))},0o755);else writeFileSync(marker,'seen');}const result=spawnSync(${JSON.stringify(host.stdout.trim())},args,{env:process.env});process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??2);\n`,
    );
    await assert.rejects(
      createReviewContext(root, selection(baseCommit, "working-tree")),
      /Source.*changed|mode.*changed/,
    );
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
});

test("staged context selection shares exact CLI and MCP bytes without widening operator permissions", async (t) => {
  const { root, baseCommit } = await project(t);
  const selected = selection(baseCommit, "index");
  await writeFile(
    path.join(root, ".checktrail/selection.json"),
    JSON.stringify(selected),
  );
  const context = await createReviewContext(root, selected);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const args = [
    cli,
    "review-context",
    "--root",
    root,
    "--input",
    ".checktrail/selection.json",
  ];
  for (const disclosure of [false, true]) {
    const flags = disclosure
      ? ["--detailed", "--allow-review-source"]
      : ["--detailed"];
    const result = spawnSync(process.execPath, [...args, ...flags], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      projectReviewContext(context, disclosure),
    );
    const client = new Client(
      { name: "synthetic-staged-client", version: "1" },
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
        name: "review_context",
        arguments: selected,
      });
      assert.equal(response.isError, undefined);
      assert.deepEqual(
        response.structuredContent,
        projectReviewContext(context, disclosure),
      );
      assert.equal(
        JSON.stringify(response).includes(staged.trim()),
        disclosure,
      );
      assert.ok(!JSON.stringify(response).includes(working.trim()));
      assert.equal(
        (
          await client.callTool({
            name: "review_context",
            arguments: { ...selected, allowReviewSource: true },
          })
        ).isError,
        true,
      );
      assert.equal(
        (await client.callTool({ name: "validation_run", arguments: {} }))
          .isError,
        true,
      );
    } finally {
      await client.close();
    }
  }
});
