import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { chmod, rename, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  collectImportContext,
  assertImportContextCurrent,
  projectImportContext,
} from "../src/import-context.js";
import {
  historicalImportInputSchema,
  type HistoricalImportReport,
} from "../src/import-history.js";
import { createPlan } from "../src/engine.js";
import { fixture } from "./helpers.js";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const baseFiles = () => ({
  "core/decision.ts":
    "export function decision(role = 'guest') { return role === 'guest'; }\nthrow new Error('HistoryExecutionTrap');",
  "service/barrel.ts":
    "export { decision as permit } from '../core/decision.js';",
  "web/use.ts":
    "import { permit } from '../service/barrel.js'; export const use = () => permit();",
  "website/unrelated.ts": "export const unrelated = 1;",
  "tsconfig.json": "{invalid-and-must-not-be-evaluated",
  "package.json": JSON.stringify({
    type: "module",
    scripts: { pretest: "exit 88" },
  }),
});
async function setup(t: TestContext, extra: Record<string, string> = {}) {
  const source = { ...baseFiles(), ...extra };
  const root = await fixture(t, source);
  fixtureGit(root, ["init", "--quiet"]);
  const baseCommit = await syntheticCommit(root, source);
  const input = historicalImportInputSchema.parse({
    schemaVersion: 2,
    profile: "js-ts-historical-imports-v1",
    projects: [
      { id: "core", root: "core" },
      { id: "service", root: "service" },
      { id: "web", root: "web" },
      { id: "website", root: "website" },
    ],
    baseCommit,
    currentSource: "working-tree",
  });
  return { root, input };
}
async function collect(
  root: string,
  input: unknown,
): Promise<HistoricalImportReport> {
  const report = await collectImportContext(root, input);
  assert.equal(report.schemaVersion, 2);
  if (report.schemaVersion !== 2)
    throw new Error("Expected historical profile");
  return report;
}
function rehash<T extends { reportDigest: string }>(value: T): T {
  const body = { ...value };
  delete (body as Partial<T>).reportDigest;
  value.reportDigest = createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  return value;
}
test("historical imports retain deleted consumers and whole old decisions while fixed and root-boundary near misses remain distinct", async (t) => {
  const { root, input } = await setup(t);
  const original = await collect(root, input);
  assert.equal(original.state, "collected");
  assert.deepEqual(original.changes, []);
  assert.deepEqual(original.impact.projects, []);
  await writeFile(
    path.join(root, "core/decision.ts"),
    "export const decision = (role = 'guest') => role !== 'guest';",
  );
  await rm(path.join(root, "web/use.ts"));
  const deleted = await collect(root, input);
  assert.equal(deleted.state, "collected");
  assert.equal(deleted.renamesInferred, false);
  assert.deepEqual(deleted.revisionDependencies, {
    base: [
      { consumer: "service", producer: "core" },
      { consumer: "web", producer: "service" },
    ],
    current: [{ consumer: "service", producer: "core" }],
  });
  assert.deepEqual(deleted.dependencies, deleted.revisionDependencies.base);
  assert.deepEqual(deleted.impact.projects, ["core", "service", "web"]);
  assert.deepEqual(deleted.changes, [
    { path: "core/decision.ts", kind: "modified" },
    { path: "web/use.ts", kind: "deleted" },
  ]);
  assert.equal(deleted.counts.observedFiles, 4);
  assert.equal(deleted.counts.capturedFiles, 4);
  assert.equal(deleted.counts.omittedFiles, 0);
  assert.equal(deleted.counts.importOccurrences, 3);
  assert.equal(deleted.counts.resolvedOccurrences, 3);
  assert.equal(deleted.counts.unresolvedOccurrences, 0);
  const context = deleted.context!;
  assert.equal(context.schemaVersion, 5);
  if (context.schemaVersion !== 5 || context.evidence.track !== "diff")
    throw new Error("Expected diff context");
  assert.equal(
    context.analysis.functions.filter(
      (f) => f.revision === "base" && f.name === "decision",
    ).length,
    1,
  );
  assert.equal(
    context.analysis.calls.filter(
      (c) =>
        c.revision === "base" &&
        c.file === "web/use.ts" &&
        c.resolution === "lexical-binding",
    ).length,
    1,
  );
  assert.ok(
    context.analysis.declarations.some(
      (d) =>
        d.revision === "base" &&
        d.kind === "parameter" &&
        d.initializer !== null,
    ),
  );
  assert.equal(
    context.evidence.baseFiles.find((f) => f.path === "web/use.ts")?.content,
    baseFiles()["web/use.ts"],
  );
  assert.equal(
    context.files.some((f) => f.path === "web/use.ts"),
    false,
  );
  await writeFile(
    path.join(root, "core/decision.ts"),
    baseFiles()["core/decision.ts"],
  );
  await writeFile(path.join(root, "web/use.ts"), baseFiles()["web/use.ts"]);
  const fixed = await collect(root, input);
  assert.deepEqual(fixed.changes, []);
  assert.deepEqual(fixed.impact.projects, []);
  await writeFile(
    path.join(root, "website/unrelated.ts"),
    "export const unrelated = 2;",
  );
  assert.deepEqual((await collect(root, input)).impact.projects, ["website"]);
});
test("historical imports distinguish stage-zero index working bytes mode-only changes and moved source without guessing renames", async (t) => {
  const { root, input } = await setup(t);
  await writeFile(
    path.join(root, "web/use.ts"),
    "export const use = () => false;",
  );
  fixtureGit(root, ["add", "--", "web/use.ts"]);
  await writeFile(
    path.join(root, "web/use.ts"),
    "export const use = () => true;",
  );
  const staged = await collect(root, { ...input, currentSource: "index" });
  assert.equal(staged.state, "collected");
  assert.equal(
    staged.context!.files.find((f) => f.path === "web/use.ts")?.content,
    "export const use = () => false;",
  );
  const working = await collect(root, input);
  assert.equal(
    working.context!.files.find((f) => f.path === "web/use.ts")?.content,
    "export const use = () => true;",
  );
  assert.notEqual(staged.reportDigest, working.reportDigest);
  await writeFile(path.join(root, "web/use.ts"), baseFiles()["web/use.ts"]);
  await chmod(path.join(root, "website/unrelated.ts"), 0o755);
  try {
    const modes = await collect(root, input);
    assert.ok(
      modes.changes.some(
        (c) => c.path === "website/unrelated.ts" && c.kind === "mode-only",
      ),
    );
    assert.deepEqual(modes.impact.projects, ["website"]);
  } finally {
    await chmod(path.join(root, "website/unrelated.ts"), 0o644);
  }
  await rename(path.join(root, "web/use.ts"), path.join(root, "web/moved.ts"));
  const moved = await collect(root, input);
  assert.equal(moved.state, "collected");
  assert.deepEqual(moved.changes, [
    { path: "web/moved.ts", kind: "added" },
    { path: "web/use.ts", kind: "deleted" },
  ]);
  assert.equal(moved.renamesInferred, false);
  assert.deepEqual(moved.impact.projects, ["web"]);
  const stagedOld = await collect(root, { ...input, currentSource: "index" });
  assert.equal(
    stagedOld.context!.files.some((f) => f.path === "web/moved.ts"),
    false,
  );
  assert.equal(
    stagedOld.context!.files.some((f) => f.path === "web/use.ts"),
    true,
  );
});
test("historical imports retain full fallback for old missing aliases ambiguous targets symlinks malformed source and exhausted discovery", async (t) => {
  for (const [extra, reason] of [
    [{ "web/use.ts": "import '../missing.js';" }, "unresolved-import"],
    [
      { "web/use.ts": "import 'AliasToPrivateDependency';" },
      "unresolved-import",
    ],
    [
      {
        "web/use.ts": "import './ambiguous';",
        "web/ambiguous.ts": "export {};",
        "web/ambiguous.js": "export {};",
      },
      "unresolved-import",
    ],
    [{ "web/use.ts": "export const missing = (" }, "syntax-incomplete"],
    [
      { "web/use.ts": "export const many=[" + "1,".repeat(20001) + "];" },
      "syntax-incomplete",
    ],
    [
      Object.fromEntries(
        Array.from({ length: 14 }, (_, i) => [
          "web/many" + i + ".ts",
          "export {};",
        ]),
      ),
      "file-budget",
    ],
  ] as const) {
    const { root, input } = await setup(t, extra);
    await writeFile(path.join(root, "web/use.ts"), "export {};");
    const report = await collect(root, input);
    assert.equal(report.state, "partial");
    assert.ok(report.impact.reasons.includes(reason));
    assert.deepEqual(report.impact.projects, [
      "core",
      "service",
      "web",
      "website",
    ]);
    assert.equal(
      report.counts.importOccurrences,
      report.counts.resolvedOccurrences + report.counts.unresolvedOccurrences,
    );
  }
  for (const name of ["hidden.ts", "hiddenDirectory"]) {
    const linkedScope = await setup(t);
    await symlink(
      path.join(
        linkedScope.root,
        name.endsWith(".ts") ? "core/decision.ts" : "core",
      ),
      path.join(linkedScope.root, "web", name),
    );
    const linked = await collect(linkedScope.root, linkedScope.input);
    assert.equal(linked.state, "partial");
    assert.ok(linked.impact.reasons.includes("excluded-source"));
    assert.equal(
      linked.context!.files.some((f) => f.path.endsWith(name)),
      false,
    );
  }
  const { root, input } = await setup(t);
  const noGit = await collect(root, { ...input, baseCommit: "0".repeat(40) });
  assert.equal(noGit.state, "partial");
  assert.equal(noGit.git, null);
  assert.equal(noGit.context, null);
  assert.ok(noGit.impact.reasons.includes("git-scope-unavailable"));
  const empty = await collect(root, {
    ...input,
    projects: [{ id: "empty", root: "absent" }],
  });
  assert.equal(empty.state, "partial");
  assert.equal(empty.context, null);
  assert.equal(empty.counts.capturedFiles, 0);
  assert.deepEqual(empty.impact.reasons, ["empty-project"]);
});
test("historical import reconstruction rejects stale base current index modes scope and coherent rehashed edges or impact", async (t) => {
  const { root, input } = await setup(t);
  await writeFile(
    path.join(root, "core/decision.ts"),
    "export const decision = () => true;",
  );
  const report = await collect(root, input);
  assert.deepEqual(await assertImportContextCurrent(root, report), report);
  for (const mutate of [
    (r: HistoricalImportReport) => {
      r.revisionDependencies.base = [];
    },
    (r: HistoricalImportReport) => {
      r.dependencies = [];
    },
    (r: HistoricalImportReport) => {
      r.impact.projects = ["core"];
    },
    (r: HistoricalImportReport) => {
      r.changes = [];
    },
    (r: HistoricalImportReport) => {
      r.counts.importOccurrences++;
    },
  ]) {
    const forged = structuredClone(report);
    mutate(forged);
    rehash(forged);
    await assert.rejects(
      assertImportContextCurrent(root, forged),
      /Stale or forged/,
    );
  }
  await writeFile(path.join(root, "web/use.ts"), "export const use = () => 2;");
  await assert.rejects(
    assertImportContextCurrent(root, report),
    /Stale or forged/,
  );
  const next = await collect(root, input);
  fixtureGit(root, ["add", "--", "web/use.ts"]);
  await assert.rejects(
    assertImportContextCurrent(root, next),
    /Stale or forged/,
  );
  const index = await collect(root, { ...input, currentSource: "index" });
  const workingModes = await collect(root, input);
  await chmod(path.join(root, "website/unrelated.ts"), 0o755);
  try {
    await assert.rejects(
      assertImportContextCurrent(root, workingModes),
      /Stale or forged/,
    );
    // Stage-zero mode is the declared source for index receipts; a working mode is outside it.
    assert.deepEqual(await assertImportContextCurrent(root, index), index);
  } finally {
    await chmod(path.join(root, "website/unrelated.ts"), 0o644);
  }
  fixtureGit(root, [
    "update-index",
    "--chmod=+x",
    "--",
    "website/unrelated.ts",
  ]);
  await assert.rejects(
    assertImportContextCurrent(root, index),
    /Stale or forged/,
  );
  for (const bad of [
    { ...input, baseCommit: "HEAD" },
    { ...input, currentSource: "head" },
    { ...input, projects: [{ id: "escape", root: "../core" }] },
    {
      ...input,
      projects: [
        { id: "core", root: "core" },
        { id: "nested", root: "core/sub" },
      ],
    },
    {
      ...input,
      projects: [
        { id: "same", root: "core" },
        { id: "same", root: "web" },
      ],
    },
  ])
    await assert.rejects(collect(root, bad));
});
test("historical import CLI and SDK MCP share old consumers privacy operator disclosure and unchanged validation plans", async (t) => {
  const { root, input } = await setup(t);
  await rm(path.join(root, "web/use.ts"));
  await writeFile(path.join(root, "scope.json"), JSON.stringify(input));
  const planned = await createPlan(root);
  const report = await collect(root, input);
  assert.deepEqual(await createPlan(root), planned);
  const summary = projectImportContext(report, false, false);
  for (const flags of [
    [],
    ["--detailed"],
    ["--detailed", "--allow-review-source"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "collect-imports",
        "--root",
        root,
        "--input",
        "scope.json",
        ...flags,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      flags.length === 2 ? report : summary,
    );
  }
  const text = JSON.stringify(summary);
  for (const privateValue of [
    root,
    input.baseCommit,
    "HistoryExecutionTrap",
    "web/use.ts",
    "website",
  ])
    assert.equal(text.includes(privateValue), false);
  for (const enabled of [false, true]) {
    const client = new Client({ name: "OriginalHistoryClient", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        cli,
        "serve",
        "--root",
        root,
        "--detailed",
        ...(enabled ? ["--allow-review-source"] : []),
      ],
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "import_context",
        arguments: { input: "scope.json" },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, enabled ? report : summary);
      const denied = await client.callTool({
        name: "import_context",
        arguments: { input: "scope.json", allowReviewSource: true },
      });
      assert.equal(denied.isError, true);
    } finally {
      await client.close();
    }
  }
  await writeFile(path.join(root, "core/decision.ts"), "import './missing';");
  const partial = spawnSync(
    process.execPath,
    [cli, "collect-imports", "--root", root, "--input", "scope.json"],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(partial.status, 2, partial.stderr);
  assert.equal(JSON.parse(partial.stdout).state, "partial");
});

test("historical imports reject parent Git enumeration before reading objects outside the configured nested root", async (t) => {
  const { root, input } = await setup(t);
  const nested = await collect(path.join(root, "web"), {
    ...input,
    projects: [{ id: "selected", root: "." }],
  });
  assert.equal(nested.state, "partial");
  assert.equal(nested.git, null);
  assert.equal(nested.context, null);
  assert.deepEqual(nested.files, ["use.ts"]);
  assert.equal(nested.counts.baseFiles, 0);
  assert.equal(nested.counts.currentFiles, 1);
  assert.equal(nested.counts.capturedFiles, 0);
  assert.deepEqual(nested.impact, {
    mode: "full-fallback",
    projects: ["selected"],
    reasons: ["git-scope-unavailable"],
  });
  for (const outsideName of [
    "core/decision.ts",
    "service/barrel.ts",
    "website/unrelated.ts",
  ])
    assert.equal(JSON.stringify(nested).includes(outsideName), false);
});
