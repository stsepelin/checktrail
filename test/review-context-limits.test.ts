import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createReviewContext,
  parseReviewContext,
  projectReviewContext,
  receiveReview,
  type ReviewContext,
} from "../src/review.js";
import { createHypothesisPlan } from "../src/review-hypotheses.js";
import { ReviewWorkflowEngine } from "../src/review-workflow.js";
import {
  reviewWorkflowAssignmentSchema,
  reviewWorkflowSummarySchema,
} from "../src/review-workflow-schema.js";
import { fixture } from "./helpers.js";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";
const select = (files: string[], supportFiles: string[] = []) => ({
  schemaVersion: 7,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  topics: [],
});
function padded(bytes: number, id = 0) {
  const start = `export const value${id} = 1;\n/*`;
  const end = "*/\n";
  return start + "x".repeat(bytes - Buffer.byteLength(start + end)) + end;
}
function files(count: number, bytes: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `unit${String(i).padStart(2, "0")}.mjs`,
      padded(bytes, i),
    ]),
  );
}
function expanded(context: ReviewContext) {
  assert.equal(context.schemaVersion, 7);
  if (context.schemaVersion !== 7) throw new Error("Expected expanded context");
  return context;
}
function rehash(value: ReviewContext) {
  const body: Record<string, unknown> = { ...value };
  delete body.contextDigest;
  return {
    ...body,
    contextDigest: createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex"),
  };
}
function assessment(context: ReviewContext, paths: string[]) {
  return {
    schemaVersion: 2,
    contextDigest: context.contextDigest,
    reviewer: { kind: "human", name: "Original synthetic host" },
    createdAt: new Date().toISOString(),
    usage: {
      inputTokens: null,
      outputTokens: null,
      costUSD: null,
      elapsedMs: null,
    },
    files: paths.map((path) => ({
      path,
      disposition: "reviewed",
      note: "Synthetic declaration",
    })),
    observations: [],
  };
}
const hostResponse = (
  assignment: ReturnType<typeof reviewWorkflowAssignmentSchema.parse>,
  paths: string[],
) => ({
  assignmentId: assignment.assignmentId,
  assignmentDigest: assignment.assignmentDigest,
  host: {
    client: "synthetic-host",
    clientVersion: "1.0.0",
    provider: "synthetic-provider",
    model: "synthetic-model",
    sessionId: randomUUID(),
    session: "fresh",
  },
  status: "completed",
  usage: {
    inputTokens: null,
    outputTokens: null,
    elapsedMs: null,
    costUSD: null,
  },
  output: {
    files: paths.map((path) => ({
      path,
      disposition: "reviewed",
      note: "Synthetic declaration",
    })),
    candidates: [],
  },
});

test("expanded context accepts exactly 32 selected paths and one MiB of source with complete syntax and disposition accounting", async (t) => {
  const data = files(32, 32768),
    paths = Object.keys(data),
    root = await fixture(t, data);
  const context = expanded(
    await createReviewContext(root, select(paths.slice(0, 1), paths.slice(1))),
  );
  assert.equal(context.files.length, 32);
  assert.equal(
    context.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0),
    1048576,
  );
  assert.equal(context.analysis.files.length, 32);
  assert.equal(context.analysis.state, "collected");
  assert.equal(context.analysis.declarations.length, 32);
  assert.equal(createHypothesisPlan(context).scope.selectedPaths, 32);
  assert.equal(
    parseReviewContext(context).contextDigest,
    context.contextDigest,
  );
  const receipt = await receiveReview(
    root,
    context,
    assessment(context, paths),
  );
  assert.equal(receipt.coverage.selected, 32);
  assert.equal(receipt.coverage.unaccounted, 0);
  assert.equal(receipt.claimsVerified, false);
});
test("expanded context keeps per-file UTF-8 byte limits exact while admitting valid multibyte source", async (t) => {
  const exact = "#" + "é".repeat(32767) + "\n",
    root = await fixture(t, { "exact.py": exact, "over.py": exact + "é" });
  assert.equal(Buffer.byteLength(exact), 65536);
  const context = expanded(
    await createReviewContext(root, select(["exact.py"])),
  );
  assert.equal(context.files[0]!.content, exact);
  assert.equal(context.analysis.state, "collected");
  await assert.rejects(
    createReviewContext(root, select(["over.py"])),
    /file limits/,
  );
  const forged = structuredClone(context);
  forged.files[0]!.content += "é";
  forged.files[0]!.sha256 = createHash("sha256")
    .update(forged.files[0]!.content)
    .digest("hex");
  forged.analysis.files[0]!.sha256 = forged.files[0]!.sha256;
  assert.throws(() => parseReviewContext(rehash(forged)), /digest mismatch/);
});
test("expanded context rejects the first combined source byte beyond one MiB during capture and reconstruction", async (t) => {
  const data = files(16, 65536),
    paths = Object.keys(data),
    root = await fixture(t, data);
  const exact = expanded(await createReviewContext(root, select(paths)));
  assert.equal(
    exact.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0),
    1048576,
  );
  await writeFile(path.join(root, "extra.mjs"), "x");
  await assert.rejects(
    createReviewContext(root, select([...paths, "extra.mjs"])),
    /total exceeds limits/,
  );
  const forged = structuredClone(exact);
  forged.selection.supportFiles.push("extra.mjs");
  forged.files.push({
    path: "extra.mjs",
    content: "x",
    sha256: createHash("sha256").update("x").digest("hex"),
  });
  forged.analysis.files.push({
    revision: "current",
    file: "extra.mjs",
    sha256: createHash("sha256").update("x").digest("hex"),
    role: "support",
    state: "collected",
  });
  forged.evidence.fileModes.push({
    path: "extra.mjs",
    before: null,
    after: "100644",
  });
  forged.selection.supportFiles.sort();
  forged.files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  forged.evidence.fileModes.sort((a, b) => a.path.localeCompare(b.path, "en"));
  assert.throws(
    () => parseReviewContext(rehash(forged)),
    /total exceeds limits/,
  );
});
test("expanded context rejects combined primary support overflow duplicate paths and forged extra scope", async (t) => {
  const data = files(33, 100),
    paths = Object.keys(data),
    root = await fixture(t, data);
  await assert.rejects(
    createReviewContext(root, select(paths.slice(0, 2), paths.slice(2))),
    /file limit/,
  );
  await assert.rejects(
    createReviewContext(root, select(paths.slice(0, 1), paths.slice(0, 2))),
    /unique/,
  );
  const context = expanded(
    await createReviewContext(root, select(paths.slice(0, 32))),
  );
  const forged = structuredClone(context);
  forged.selection.files.push(paths[32]!);
  assert.throws(() => parseReviewContext(rehash(forged)));
  assert.equal(context.analysis.functions.length, 0);
  assert.equal(context.analysis.declarations.length, 32);
});
test("expanded context binds 64 base current views and counts immutable index bytes in the same source budget", async (t) => {
  const data = files(32, 16384),
    paths = Object.keys(data),
    root = await realpath(await fixture(t, data));
  fixtureGit(root, ["init"]);
  const base = await syntheticCommit(root, data);
  for (const p of paths)
    await writeFile(path.join(root, p), data[p]!.replace(" = 1;", " = 2;"));
  fixtureGit(root, ["add", "--", ...paths]);
  const input = { ...select(paths), track: "diff", baseCommit: base };
  for (const currentSource of ["working-tree", "index"]) {
    const context = expanded(
      await createReviewContext(root, { ...input, currentSource }),
    );
    assert.equal(context.evidence.track, "diff");
    if (context.evidence.track !== "diff") throw new Error("Expected diff");
    assert.equal(context.evidence.baseFiles.length, 32);
    assert.equal(context.analysis.files.length, 64);
    assert.equal(context.analysis.declarations.length, 64);
    assert.equal(createHypothesisPlan(context).scope.capturedViews, 64);
    assert.equal(
      context.evidence.changes.filter((c) => c.kind === "modified").length,
      32,
    );
    assert.equal(
      parseReviewContext(context).contextDigest,
      context.contextDigest,
    );
  }
  await writeFile(path.join(root, paths[0]!), data[paths[0]!]! + "x");
  await assert.rejects(
    createReviewContext(root, input),
    /total exceeds limits/,
  );
  fixtureGit(root, ["add", "--", paths[0]!]);
  await assert.rejects(
    createReviewContext(root, { ...input, currentSource: "index" }),
    /source exceeds limits/,
  );
});
test("expanded context leaves versions one through six on their previous selected source bounds", async (t) => {
  const data = files(17, 100),
    paths = Object.keys(data),
    root = await fixture(t, data);
  for (const schemaVersion of [1, 2, 3, 4, 5, 6]) {
    const input = {
      schemaVersion,
      files: paths,
      topics: [],
      ...(schemaVersion >= 2 ? { track: "snapshot" } : {}),
      ...(schemaVersion >= 3 ? { supportFiles: [] } : {}),
      ...(schemaVersion >= 5 ? { currentSource: "working-tree" } : {}),
    };
    await assert.rejects(createReviewContext(root, input));
  }
  const large = await fixture(t, files(4, 40000));
  for (const schemaVersion of [5, 6])
    await assert.rejects(
      createReviewContext(large, {
        ...select(Object.keys(files(4, 40000))),
        schemaVersion,
      }),
      /total exceeds limits/,
    );
  const legacy = await createReviewContext(root, {
    ...select(paths.slice(0, 16)),
    schemaVersion: 6,
  });
  assert.equal(legacy.schemaVersion, 6);
  assert.equal(legacy.files.length, 16);
  assert.equal(legacy.contextDigest, parseReviewContext(legacy).contextDigest);
});
test("expanded context keeps startup packet quotas cancellation and 32-file neutral workflow accounting", async (t) => {
  const data = files(32, 32768),
    paths = Object.keys(data),
    root = await fixture(t, data),
    context = await createReviewContext(root, select(paths));
  const limited = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const opened = await limited.open(context);
    const stopped = reviewWorkflowSummarySchema.parse(
      await limited.next(opened.workflowId),
    );
    assert.equal(stopped.status, "incomplete");
    assert.equal(stopped.stopReason, "packet-limit");
    assert.equal(stopped.assignments.length, 0);
  } finally {
    limited.dispose();
  }
  const engine = new ReviewWorkflowEngine(root, {
    allowReviewSource: true,
    limits: {
      maxWorkflows: 1,
      maxAssignments: 6,
      wallMs: 30000,
      maxPacketBytes: 8388608,
      maxResponseBytes: 131072,
      maxRetainedBytes: 16777216,
    },
  });
  try {
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(engine.open(context, aborted.signal));
    assert.equal(engine.snapshots().length, 0);
    const opened = await engine.open(context),
      assignment = reviewWorkflowAssignmentSchema.parse(
        await engine.next(opened.workflowId),
      );
    assert.ok(Buffer.byteLength(assignment.packet) > 1048576);
    assert.equal(assignment.hostIsolationVerified, false);
    const done = await engine.submit(
      opened.workflowId,
      hostResponse(assignment, paths),
    );
    assert.equal(done.status, "completed");
    assert.equal(done.unverifiedCandidates, 0);
    assert.equal(done.claimsVerified, false);
    assert.equal(done.hostIsolationVerified, false);
  } finally {
    engine.dispose();
  }
  await assert.rejects(engine.open(context), /capacity/);
});
test("expanded context library CLI and MCP preserve identical large source grants summaries and receipt accounting", async (t) => {
  const data = files(32, 32768),
    paths = Object.keys(data),
    input = select(paths),
    root = await fixture(t, {
      ...data,
      "selection.json": JSON.stringify(input),
      ".checktrail/keep": "",
      "trap.mjs": "throw new Error('Project code must not execute');",
    });
  const context = await createReviewContext(root, input),
    cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  await mkdir(path.join(root, ".checktrail"), { recursive: true });
  await writeFile(
    path.join(root, ".checktrail/context.json"),
    JSON.stringify(context),
  );
  await writeFile(
    path.join(root, ".checktrail/assessment.json"),
    JSON.stringify(assessment(context, paths)),
  );
  for (const flags of [[], ["--detailed", "--allow-review-source"]]) {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "review-context",
        "--root",
        root,
        "--input",
        "selection.json",
        ...flags,
      ],
      { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1048576 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      projectReviewContext(context, flags.length > 0),
    );
    const client = new Client(
      { name: "original-expanded-context-host", version: "1.0.0" },
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
      const actual = await client.callTool({
        name: "review_context",
        arguments: input,
      });
      assert.equal(actual.isError, undefined);
      assert.deepEqual(
        actual.structuredContent,
        projectReviewContext(context, flags.length > 0),
      );
      assert.equal(
        (
          await client.callTool({
            name: "review_context",
            arguments: { ...input, allowReviewSource: true },
          })
        ).isError,
        true,
      );
      const receipt = await client.callTool({
        name: "review_receipt",
        arguments: {
          context: ".checktrail/context.json",
          input: ".checktrail/assessment.json",
        },
      });
      assert.equal(receipt.isError, undefined);
      assert.equal(
        (receipt.structuredContent as { coverage: { selected: number } })
          .coverage.selected,
        32,
      );
    } finally {
      await client.close();
    }
  }
  const receipt = spawnSync(
    process.execPath,
    [
      cli,
      "review-receipt",
      "--root",
      root,
      "--context",
      ".checktrail/context.json",
      "--input",
      ".checktrail/assessment.json",
    ],
    { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1048576 },
  );
  assert.equal(receipt.status, 0, receipt.stderr);
  assert.equal(JSON.parse(receipt.stdout).coverage.selected, 32);
  const summary = JSON.stringify(projectReviewContext(context, false));
  assert.ok(!summary.includes("value0"));
  assert.ok(!summary.includes("unit00"));
  assert.ok(summary.length < 1024);
  await assert.rejects(access(path.join(root, "executed")));
});
test("expanded context original controls execute against a fresh offline installed runtime", async () => {
  if (process.env.CHECKTRAIL_CONTEXT_LIMITS_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(new URL("../src/review.js", import.meta.url)),
    );
    assert.ok(
      runtime.includes(
        path.join("node_modules", "@stsepelin", "checktrail", "dist", "src"),
      ),
    );
    return;
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "review-context-limits",
  };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          "../../scripts/verify-import-context-package.mjs",
          import.meta.url,
        ),
      ),
    ],
    { env, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1048576 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  assert.equal(receipt.offlineProductionInstall, true);
  assert.equal(receipt.installedRuntimeEvaluated, true);
  assert.equal(receipt.profile.complete, true);
  assert.equal(receipt.profile.required, 9);
  assert.equal(receipt.profile.passed, 9);
});
