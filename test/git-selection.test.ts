import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { projectPlan, projectReport } from "../src/output.js";
import {
  planSchema,
  planSummarySchema,
  reportSchema,
  reportSummarySchema,
} from "../src/schemas.js";
import { affectedProjects, validateWorkspace } from "../src/workspace.js";
import { fixture, nodeManifest, passingTest } from "./helpers.js";
import { fixtureGit, gitObject, syntheticCommit } from "./git-fixture.js";

const workspace = {
  complete: true,
  dependencies: [{ consumer: "app", producer: "lib" }],
};
const policy = JSON.stringify({
  schemaVersion: 1,
  workspace,
  projects: ["app", "lib", "other"].map((path) => ({
    path,
    checks: ["javascript.node-test"],
  })),
});
const files = {
  "repo-verifier.json": policy,
  "app/package.json": nodeManifest,
  "app/value.test.js":
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../lib/value.js'; test('consumer contract',()=>assert.equal(value,1));",
  "lib/package.json": nodeManifest,
  "lib/value.test.js": passingTest,
  "lib/value.js": "export const value = 1;\n",
  "other/package.json": nodeManifest,
  "other/value.test.js": passingTest,
};

test("workspace impact follows transitive consumers, terminates cycles and falls back for uncertain ownership", () => {
  const graph = {
    complete: true,
    dependencies: [
      ...workspace.dependencies,
      { consumer: "other", producer: "app" },
      { consumer: "lib", producer: "other" },
    ],
  };
  validateWorkspace(graph, ["app", "lib", "other"]);
  assert.deepEqual(
    affectedProjects([".", "x"], ["x/value.js"], {
      complete: true,
      dependencies: [],
    }).projects,
    ["x"],
  );
  assert.equal(
    affectedProjects([".", "x"], ["shared/value.js"], {
      complete: true,
      dependencies: [],
    }).affected,
    false,
  );
  assert.deepEqual(
    affectedProjects(["app", "lib", "other"], ["lib/value.js"], graph).projects,
    ["app", "lib", "other"],
  );
  assert.deepEqual(
    affectedProjects(["app", "lib", "other"], ["other/value.js"], workspace)
      .projects,
    ["other"],
  );
  for (const changed of [
    [],
    ["README.md"],
    ["unknown/value.js"],
    ["lib/.config/settings.json"],
  ])
    assert.equal(
      affectedProjects(["app", "lib", "other"], changed, workspace).affected,
      false,
    );
  assert.equal(
    affectedProjects(["app", "lib"], ["lib/value.js"]).affected,
    false,
  );
  for (const dependencies of [
    [{ consumer: "lib", producer: "lib" }],
    [{ consumer: "missing", producer: "lib" }],
    [...workspace.dependencies, ...workspace.dependencies],
  ])
    assert.throws(() =>
      validateWorkspace({ complete: true, dependencies }, ["app", "lib"]),
    );
});

test("Git scopes committed, staged, unstaged, untracked and renamed files without running filters", async (t) => {
  const root = await fixture(t, files);
  fixtureGit(root, ["init", "--quiet", "--object-format=sha1"]);
  const base = await syntheticCommit(root, files);
  const clean = await createPlan(root, { base });
  assert.equal(clean.plan.selection?.mode, "full");
  assert.match(clean.plan.selection!.reason, /No changed paths/);
  const updated = { ...files, "lib/value.js": "export const value = 2;\n" };
  await writeFile(path.join(root, "lib/value.js"), updated["lib/value.js"]);
  const head = await syntheticCommit(root, updated, base);
  const committed = await createPlan(root, { base });
  assert.equal(
    committed.plan.selection?.mode,
    "affected",
    JSON.stringify(committed.plan.selection),
  );
  assert.deepEqual(committed.plan.selection?.changedFiles, ["lib/value.js"]);
  assert.deepEqual(
    committed.plan.checks.map((check) => check.project),
    ["app", "lib"],
  );
  assert.equal(committed.plan.selection?.git?.headCommit, head);
  assert.equal(committed.plan.selection?.git?.baseCommit, base);
  planSchema.parse(committed.plan);
  planSummarySchema.parse(projectPlan(committed.plan, false));
  assert.ok(
    !JSON.stringify(projectPlan(committed.plan, false)).includes(
      "lib/value.js",
    ),
  );
  const failed = await validate(root, { trusted: true, base });
  assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
  assert.equal(
    failed.checks.find((check) => check.project === "app")?.status,
    "failed",
  );
  assert.match(
    failed.checks.find((check) => check.project === "app")!.processes[0]!
      .stdout,
    /2 !== 1/,
  );
  assert.equal(failed.sourceChanged, false);
  reportSchema.parse(failed);
  reportSummarySchema.parse(projectReport(failed, false));
  await writeFile(path.join(root, "lib/value.js"), files["lib/value.js"]);
  await syntheticCommit(root, files);
  const staged = await gitObject(
    root,
    "blob",
    Buffer.from("export const value = 3;\n"),
  );
  fixtureGit(root, [
    "update-index",
    "--cacheinfo",
    "100644",
    staged,
    "lib/value.js",
  ]);
  assert.deepEqual(
    (await createPlan(root, { base })).plan.selection?.changedFiles,
    ["lib/value.js"],
  );
  fixtureGit(root, ["read-tree", base]);
  await writeFile(
    path.join(root, "lib/with space\nand newline.js"),
    "export const another = 1;\n",
  );
  assert.deepEqual(
    (await createPlan(root, { base })).plan.selection?.changedFiles,
    ["lib/with space\nand newline.js"],
  );
  await rm(path.join(root, "lib/with space\nand newline.js"));
  await rename(
    path.join(root, "lib/value.js"),
    path.join(root, "other/moved.js"),
  );
  assert.deepEqual(
    (await createPlan(root, { base })).plan.selection?.selectedProjects,
    ["app", "lib", "other"],
  );
  await rename(
    path.join(root, "other/moved.js"),
    path.join(root, "lib/value.js"),
  );
  await chmod(path.join(root, "lib/value.js"), 0o755);
  assert.deepEqual(
    (await createPlan(root, { base })).plan.selection?.changedFiles,
    ["lib/value.js"],
  );
  await chmod(path.join(root, "lib/value.js"), 0o644);
  await writeFile(
    path.join(root, ".gitattributes"),
    "*.js filter=synthetic diff=synthetic\n",
  );
  await appendFile(
    path.join(root, ".git/config"),
    '\n[filter "synthetic"]\n\tclean = touch filter-ran\n[diff "synthetic"]\n\tcommand = touch external-diff-ran\n\ttextconv = touch textconv-ran\n[core]\n\tfsmonitor = touch fsmonitor-ran\n',
  );
  await writeFile(path.join(root, "lib/value.js"), updated["lib/value.js"]);
  await createPlan(root, { base });
  for (const sentinel of [
    "filter-ran",
    "external-diff-ran",
    "textconv-ran",
    "fsmonitor-ran",
  ])
    await assert.rejects(readFile(path.join(root, sentinel)), {
      code: "ENOENT",
    });
});

test("Git selection falls back for missing history, root changes, incomplete graphs and tracked excluded content", async (t) => {
  const root = await fixture(t, files);
  assert.equal(
    (await createPlan(root, { base: "HEAD" })).plan.selection?.mode,
    "full",
  );
  fixtureGit(root, ["init", "--quiet", "--object-format=sha1"]);
  assert.equal(
    (await createPlan(root, { base: "HEAD" })).plan.selection?.mode,
    "full",
  );
  const base = await syntheticCommit(root, files);
  assert.equal(
    (await createPlan(root, { base: "--invalid-option" })).plan.selection?.mode,
    "full",
  );
  await writeFile(path.join(root, "README.md"), "Changed root configuration\n");
  assert.equal((await createPlan(root, { base })).plan.selection?.mode, "full");
  await rm(path.join(root, "README.md"));
  const incomplete = JSON.stringify({
    ...JSON.parse(policy),
    workspace: { ...workspace, complete: false },
  });
  await writeFile(path.join(root, "repo-verifier.json"), incomplete);
  const incompleteBase = await syntheticCommit(root, {
    ...files,
    "repo-verifier.json": incomplete,
  });
  await writeFile(path.join(root, "lib/value.js"), "changed\n");
  const fallback = await createPlan(root, { base: incompleteBase });
  assert.equal(fallback.plan.selection?.mode, "full");
  assert.match(fallback.plan.selection!.reason, /completeness/);
  await writeFile(path.join(root, "repo-verifier.json"), policy);
  await writeFile(path.join(root, ".env"), "SYNTHETIC=not-inspected\n");
  const excludedBase = await syntheticCommit(root, {
    ...files,
    ".env": "SYNTHETIC=not-inspected\n",
  });
  const excluded = await createPlan(root, { base: excludedBase });
  assert.equal(excluded.plan.selection?.mode, "full");
  assert.match(excluded.plan.selection!.reason, /Tracked excluded/);
  assert.ok(!JSON.stringify(excluded.plan).includes("not-inspected"));
});

test("worktrees have separate identities and metadata changes during validation invalidate pass", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "sum.test.js": passingTest,
  });
  fixtureGit(root, ["init", "--quiet", "--object-format=sha1"]);
  const base = await syntheticCommit(root, {
    "package.json": nodeManifest,
    "sum.test.js": passingTest,
  });
  const other = await fixture(t, {});
  fixtureGit(root, ["worktree", "add", "--quiet", "--detach", other, base]);
  const first = await createPlan(root, { base });
  const second = await createPlan(other, { base });
  assert.notEqual(
    first.plan.selection?.git?.worktreeId,
    second.plan.selection?.git?.worktreeId,
  );
  assert.ok(second.plan.selection?.git?.worktreeId);
  assert.ok(!second.source.files.includes(".git"));
  await mkdir(path.join(root, ".git/refs/heads"), { recursive: true });
  const replacement = await gitObject(
    root,
    "commit",
    Buffer.from(
      `tree ${fixtureGit(root, ["rev-parse", "HEAD^{tree}"]).trim()}\nauthor Synthetic <fixture@example.invalid> 1 +0000\ncommitter Synthetic <fixture@example.invalid> 1 +0000\n\nOther synthetic commit\n`,
    ),
  );
  await writeFile(
    path.join(root, "sum.test.js"),
    `import {test} from 'node:test'; import {writeFileSync} from 'node:fs'; test('changes revision metadata',()=>writeFileSync('.git/refs/heads/main', '${replacement}\\n'));`,
  );
  const report = await validate(root, { trusted: true, base });
  assert.equal(report.checks[0]!.status, "passed");
  assert.equal(report.sourceChanged, true);
  assert.equal(report.outcome, "incomplete");
});

test("unresolved index stages and project-local Git executables cannot narrow or execute project code", async (t) => {
  const root = await fixture(t, files);
  fixtureGit(root, ["init", "--quiet", "--object-format=sha1"]);
  const base = await syntheticCommit(root, files);
  const blob = await gitObject(
    root,
    "blob",
    Buffer.from(files["lib/value.js"]),
  );
  fixtureGit(
    root,
    ["update-index", "--index-info"],
    `0 ${"0".repeat(40)}\tlib/value.js\n100644 ${blob} 1\tlib/value.js\n100644 ${blob} 2\tlib/value.js\n100644 ${blob} 3\tlib/value.js\n`,
  );
  const conflicted = await createPlan(root, { base });
  assert.equal(conflicted.plan.selection?.mode, "full");
  assert.equal(conflicted.plan.checks.length, 3);
  fixtureGit(root, ["read-tree", base]);
  await mkdir(path.join(root, "bin"));
  await writeFile(
    path.join(root, "bin/git"),
    "#!/bin/sh\ntouch project-git-ran\n",
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  try {
    process.env.PATH = `${path.join(root, "bin")}${path.delimiter}${previous ?? ""}`;
    await createPlan(root, { base });
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
  await assert.rejects(readFile(path.join(root, "project-git-ran")), {
    code: "ENOENT",
  });
});

test("CLI and MCP share startup-selected Git scope and tool calls cannot change the base", async (t) => {
  const root = await fixture(t, files);
  fixtureGit(root, ["init", "--quiet", "--object-format=sha1"]);
  const base = await syntheticCommit(root, files);
  await writeFile(path.join(root, "lib/value.js"), "export const value = 2;\n");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const planned = spawnSync(
    process.execPath,
    [cli, "plan", "--root", root, "--base", base],
    { encoding: "utf8" },
  );
  assert.equal(planned.status, 0, planned.stderr);
  const cliPlan = JSON.parse(planned.stdout);
  assert.equal(cliPlan.selection.mode, "affected");
  assert.equal(cliPlan.checks.length, 2);
  const client = new Client(
    { name: "git-scope-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "serve", "--root", root, "--base", base],
        stderr: "pipe",
      }),
    );
    const result = await client.callTool({
      name: "validation_plan",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, cliPlan);
    const injection = await client.callTool({
      name: "validation_plan",
      arguments: { base: "HEAD" },
    });
    assert.equal(injection.isError, true);
  } finally {
    await client.close();
  }
});
