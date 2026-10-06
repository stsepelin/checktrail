import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  collectImportContext,
  assertImportContextCurrent,
  projectImportContext,
  importContextInputSchema,
} from "../src/import-context.js";
import { checkArchitecture } from "../src/architecture.js";
import { createPlan } from "../src/engine.js";
import { fixture } from "./helpers.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const input = () =>
  importContextInputSchema.parse({
    schemaVersion: 1,
    profile: "js-ts-selected-imports-v1",
    projects: [
      { id: "core", root: "core" },
      { id: "service", root: "service" },
      { id: "web", root: "web" },
      { id: "website", root: "website" },
    ],
    changedFiles: ["core/decision.ts"],
  });
const files = () => ({
  "core/decision.ts":
    "export function decision(role = 'guest') { return role === 'guest'; }\nthrow new Error('ImportExecutionTrap');",
  "service/barrel.ts":
    "export { decision as permit } from '../core/decision.js';",
  "web/use.ts":
    "import { permit } from '../service/barrel.js'; export const use = () => permit();",
  "website/unrelated.ts": "export const unrelated = 1;",
  "tsconfig.json": "{ definitely-invalid-and-must-not-be-loaded",
  "package.json": JSON.stringify({
    type: "module",
    scripts: { pretest: "exit 88" },
  }),
});
const rehash = <T extends { reportDigest: string }>(value: T): T => {
  const body = { ...value };
  delete (body as Partial<T>).reportDigest;
  value.reportDigest = createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  return value;
};
test("import context automatically retains exact root-boundary consumers and whole decisions without project or configuration execution", async (t) => {
  const root = await fixture(t, files());
  const report = await collectImportContext(root, input());
  assert.equal(report.state, "collected");
  assert.equal(report.executionInvoked, false);
  assert.equal(report.runtimeGraphComplete, false);
  assert.equal(report.runtimeReachabilityVerified, false);
  assert.deepEqual(report.dependencies, [
    { consumer: "service", producer: "core" },
    { consumer: "web", producer: "service" },
  ]);
  assert.deepEqual(report.impact, {
    mode: "affected",
    projects: ["core", "service", "web"],
    reasons: [],
  });
  assert.deepEqual(report.counts, {
    projects: 4,
    observedFiles: 4,
    capturedFiles: 4,
    omittedFiles: 0,
    importOccurrences: 2,
    resolvedOccurrences: 2,
    unresolvedOccurrences: 0,
    projectEdges: 2,
    affectedProjects: 3,
  });
  const context = report.context!;
  assert.equal(context.schemaVersion, 5);
  if (context.schemaVersion !== 5)
    throw new Error("Expected current-source profile");
  const fn = context.analysis.functions.find((f) => f.name === "decision")!;
  const source = context.files.find((f) => f.path === fn.file)!;
  assert.equal(
    source.content.slice(fn.start, fn.end),
    "export function decision(role = 'guest') { return role === 'guest'; }",
  );
  assert.ok(
    context.analysis.declarations.some(
      (d) => d.kind === "parameter" && d.initializer !== null,
    ),
  );
  assert.equal(report.validationPlanUnchanged, true);
  assert.deepEqual(await assertImportContextCurrent(root, report), report);
  const reordered = input();
  reordered.projects.reverse();
  assert.deepEqual(await collectImportContext(root, reordered), report);
  assert.deepEqual(
    (
      await collectImportContext(root, {
        ...input(),
        changedFiles: ["service/barrel.ts"],
      })
    ).impact.projects,
    ["service", "web"],
  );
  assert.deepEqual(
    (await collectImportContext(root, { ...input(), changedFiles: [] })).impact
      .projects,
    [],
  );
});
test("import graph catches forbidden broken edges while fixed and valid boundary near misses remain clean", async (t) => {
  const roots = await Promise.all([
    fixture(t, {
      ...files(),
      "core/decision.ts":
        "import '../web/use.js'; export const decision = () => true;",
    }),
    fixture(t, files()),
    fixture(t, {
      ...files(),
      "website/unrelated.ts":
        "import '../core/decision.js'; export const unrelated = 1;",
    }),
  ]);
  const reports = await Promise.all(
    roots.map((root) => collectImportContext(root, input())),
  );
  const policy = {
    schemaVersion: 1,
    format: "architecture-policy",
    projects: input().projects.map((p) => ({
      id: p.id,
      layer: p.id === "core" ? "domain" : "application",
    })),
    layers: ["domain", "application"],
    allowedDependencies: [
      { consumer: "application", producer: "domain" },
      { consumer: "application", producer: "application" },
    ],
    requireAcyclic: false,
  };
  const outcomes = reports.map((r) =>
    checkArchitecture(
      {
        schemaVersion: 1,
        format: "dependency-graph",
        capturedAt: "2026-10-06T00:00:00.000Z",
        collector: { name: r.profile, version: r.parserVersion },
        complete: r.state === "collected",
        projects: r.input.projects.map((p) => ({
          id: p.id,
          language: r.profile,
          sourceFingerprint: r.sourceFingerprint,
          complete: r.state === "collected",
        })),
        dependencies: r.dependencies,
      },
      policy,
    ),
  );
  assert.deepEqual(
    outcomes.map((r) => r.outcome),
    ["failed", "passed", "passed"],
  );
  assert.equal(outcomes[0]!.counts.forbidden, 1);
  assert.deepEqual(
    outcomes[0]!.dependencies.filter((d) => d.status === "forbidden"),
    [{ consumer: "core", producer: "web", status: "forbidden" }],
  );
  const cycleRoot = await fixture(t, {
    ...files(),
    "core/decision.ts": "export { use } from '../web/use.js';",
  });
  const cycle = await collectImportContext(cycleRoot, input());
  assert.deepEqual(cycle.impact.projects, ["core", "service", "web"]);
});
test("unknown import kinds ambiguity omitted source and syntax exhaustion retain every declared project in full fallback", async (t) => {
  for (const [extra, reason] of [
    [
      { "web/use.ts": "import 'AliasToUnselectedConsumer';" },
      "unresolved-import",
    ],
    [{ "web/use.ts": "import './missing';" }, "unresolved-import"],
    [
      { "web/use.ts": "export const load = (name: string) => import(name);" },
      "unresolved-import",
    ],
    [
      {
        "web/use.ts": "require('../core/decision.js');",
      },
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
    [{ "web/use.ts": "import '../../../../escape.js';" }, "unresolved-import"],
    [{ "web/use.ts": "export function malformed( {" }, "syntax-incomplete"],
    [
      { "web/use.ts": "export const crowded = [" + "1,".repeat(20001) + "];" },
      "syntax-incomplete",
    ],
    [{ "web/use.ts": "//" + "x".repeat(65536) }, "source-capture-unavailable"],
  ] as const) {
    const root = await fixture(t, { ...files(), ...extra });
    const report = await collectImportContext(root, input());
    assert.equal(report.state, "partial", reason);
    assert.equal(report.impact.mode, "full-fallback", reason);
    assert.ok(report.impact.reasons.includes(reason), reason);
    assert.deepEqual(
      report.impact.projects,
      ["core", "service", "web", "website"],
      reason,
    );
    assert.equal(
      report.counts.observedFiles,
      report.counts.capturedFiles + report.counts.omittedFiles,
    );
    assert.equal(
      report.counts.importOccurrences,
      report.counts.resolvedOccurrences + report.counts.unresolvedOccurrences,
    );
  }
  const shadowedRoot = await fixture(t, {
    ...files(),
    "web/use.ts":
      "const require = (value: string) => value; require('../core/decision.js');",
  });
  const shadowed = await collectImportContext(shadowedRoot, input());
  assert.equal(shadowed.state, "collected");
  assert.equal(shadowed.counts.unresolvedOccurrences, 0);
  assert.deepEqual(shadowed.dependencies, [
    { consumer: "service", producer: "core" },
  ]);
  const typeRoot = await fixture(t, {
    ...files(),
    "web/use.ts":
      "import permit = require('../core/decision.js'); type Policy = import('../service/barrel.js').Policy;",
  });
  const typeImports = await collectImportContext(typeRoot, input());
  assert.equal(typeImports.state, "collected");
  assert.deepEqual(typeImports.dependencies, [
    { consumer: "service", producer: "core" },
    { consumer: "web", producer: "core" },
    { consumer: "web", producer: "service" },
  ]);
  assert.equal(typeImports.counts.importOccurrences, 3);
  const more = Object.fromEntries(
    Array.from({ length: 13 }, (_, i) => [
      "core/additional" + i + ".ts",
      "export {};",
    ]),
  );
  const limited = await collectImportContext(
    await fixture(t, { ...files(), ...more }),
    input(),
  );
  assert.deepEqual(limited.impact.reasons, ["file-budget"]);
  assert.equal(limited.counts.observedFiles, 17);
  assert.equal(limited.counts.capturedFiles, 16);
  assert.equal(limited.counts.omittedFiles, 1);
  const unknown = await collectImportContext(await fixture(t, files()), {
    ...input(),
    changedFiles: ["config/unknown.json", "core/deleted.ts"],
  });
  assert.deepEqual(unknown.impact.reasons, ["unknown-changed-file"]);
  const empty = await collectImportContext(
    await fixture(t, { "core/readme.md": "not source" }),
    input(),
  );
  assert.equal(empty.state, "partial");
  assert.equal(empty.context, null);
  assert.equal(empty.counts.capturedFiles, 0);
  assert.deepEqual(empty.impact.reasons, [
    "empty-project",
    "unknown-changed-file",
  ]);
});
test("import context rejects root escapes overlaps stale modes and rehashed forged dependency or impact evidence", async (t) => {
  const root = await fixture(t, files());
  for (const projects of [
    [{ id: "bad", root: "../core" }],
    [{ id: "bad", root: "/core" }],
    [
      { id: "core", root: "core" },
      { id: "nested", root: "core/sub" },
    ],
    [
      { id: "core", root: "." },
      { id: "nested", root: "web" },
    ],
    [
      { id: "core", root: "core" },
      { id: "core", root: "web" },
    ],
  ])
    await assert.rejects(collectImportContext(root, { ...input(), projects }));
  await assert.rejects(
    collectImportContext(root, {
      ...input(),
      changedFiles: ["core/decision.ts", "core/decision.ts"],
    }),
  );
  const report = await collectImportContext(root, input());
  const forged = structuredClone(report);
  forged.dependencies = [];
  rehash(forged);
  await assert.rejects(
    assertImportContextCurrent(root, forged),
    /Stale or forged/,
  );
  const narrowed = structuredClone(report);
  narrowed.impact.projects = ["core"];
  rehash(narrowed);
  await assert.rejects(
    assertImportContextCurrent(root, narrowed),
    /Stale or forged/,
  );
  const mutated = structuredClone(report);
  mutated.context!.files[0]!.content += "\n";
  rehash(mutated);
  await assert.rejects(
    assertImportContextCurrent(root, mutated),
    /Stale or forged/,
  );
  await writeFile(
    path.join(root, "website/unrelated.ts"),
    "export const unrelated = 2;",
  );
  await assert.rejects(
    assertImportContextCurrent(root, report),
    /Stale or forged/,
  );
  const modeRoot = await fixture(t, files());
  const modeReport = await collectImportContext(modeRoot, input());
  try {
    await chmod(path.join(modeRoot, "core/decision.ts"), 0o755);
    await assert.rejects(
      assertImportContextCurrent(modeRoot, modeReport),
      /Stale or forged/,
    );
  } finally {
    await chmod(path.join(modeRoot, "core/decision.ts"), 0o644);
  }
  const excludedRoot = await fixture(t, files());
  await symlink(
    path.join(excludedRoot, "core/decision.ts"),
    path.join(excludedRoot, "web/hidden.ts"),
  );
  const excluded = await collectImportContext(excludedRoot, input());
  assert.deepEqual(excluded.impact.reasons, ["excluded-source"]);
  assert.equal(
    excluded.context!.files.some((file) => file.path.endsWith("hidden.ts")),
    false,
  );
});
test("import collection shares exact library CLI MCP evidence and summary disclosure without changing validation plans", async (t) => {
  const selected = input();
  const root = await fixture(t, {
    ...files(),
    "scope.json": JSON.stringify(selected),
  });
  const plannedBefore = await createPlan(root);
  const report = await collectImportContext(root, selected);
  const plannedAfter = await createPlan(root);
  assert.deepEqual(plannedAfter, plannedBefore);
  const detailed = spawnSync(
    process.execPath,
    [
      cli,
      "collect-imports",
      "--root",
      root,
      "--input",
      "scope.json",
      "--detailed",
      "--allow-review-source",
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.deepEqual(JSON.parse(detailed.stdout), report);
  const summary = projectImportContext(report, false, false);
  for (const flags of [[], ["--detailed"]]) {
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
    assert.deepEqual(JSON.parse(result.stdout), summary);
  }
  assert.equal(JSON.stringify(summary).includes("decision"), false);
  assert.equal(JSON.stringify(summary).includes("website"), false);
  for (const enabled of [false, true]) {
    const client = new Client({
      name: "OriginalImportContextClient",
      version: "1",
    });
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
      const tools = await client.listTools();
      const tool = tools.tools.find((tool) => tool.name === "import_context")!;
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(
        JSON.stringify(tool.inputSchema).includes("allowReviewSource"),
        false,
      );
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
      const escaped = await client.callTool({
        name: "import_context",
        arguments: { input: "../scope.json" },
      });
      assert.equal(escaped.isError, true);
    } finally {
      await client.close();
    }
  }
  await writeFile(path.join(root, "web/use.ts"), "import './missing';");
  const incomplete = spawnSync(
    process.execPath,
    [cli, "collect-imports", "--root", root, "--input", "scope.json"],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(incomplete.status, 2);
  assert.equal(JSON.parse(incomplete.stdout).state, "partial");
  assert.equal(
    await readFile(path.join(root, "tsconfig.json"), "utf8"),
    files()["tsconfig.json"],
  );
});
