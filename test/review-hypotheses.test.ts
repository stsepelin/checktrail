import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createReviewContext } from "../src/review.js";
import {
  createHypothesisPlan,
  projectHypothesisPlan,
  reviewFamilySchema,
  hypothesisPlanSchema,
  hypothesisSummarySchema,
} from "../src/review-hypotheses.js";
import { fixture } from "./helpers.js";

const source =
  "// synthetic confidential marker\nexport function allowed(actor, item) { return actor.loggedIn && actor.id === item.owner; }\n";

test("hypothesis catalogue binds nine distinct invariants and leaves applicability freshness and coverage unverified", async (t) => {
  const root = await fixture(t, {
    "subject.ts": source,
    "unsupported.py": "raise RuntimeError('must not execute')\n",
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.ts"],
    supportFiles: ["unsupported.py"],
    topics: [],
  });
  const plan = createHypothesisPlan(context);
  assert.deepEqual(
    plan.families.map((family) => family.id),
    reviewFamilySchema.options,
  );
  assert.equal(
    new Set(plan.families.map((family) => family.invariant)).size,
    9,
  );
  assert.equal(new Set(plan.families.map((family) => family.trigger)).size, 9);
  assert.equal(plan.contextDigest, context.contextDigest);
  assert.deepEqual(plan.scope, {
    selectedPaths: 2,
    capturedViews: 2,
    syntaxCollectedViews: 1,
    syntaxPartialViews: 1,
    repositoryComplete: false,
    runtimeReachability: "unknown",
  });
  for (const family of plan.families) {
    assert.equal(family.applicability, "requires-review");
    assert.ok(
      family.evidenceRequirements.some((requirement) =>
        /control|near miss/i.test(requirement),
      ),
      family.id,
    );
    assert.ok(
      family.limits.some((limit) =>
        /defaults, callers.*sibling set/.test(limit),
      ),
      family.id,
    );
  }
  assert.equal(plan.freshness, "not-checked");
  assert.equal(plan.modelInvoked, false);
  assert.equal(plan.claimsVerified, false);
  assert.equal(plan.automatedCoverage, false);
  assert.ok(!("outcome" in plan));
  assert.ok(!("findings" in plan));
  const summary = projectHypothesisPlan(plan, false);
  hypothesisSummarySchema.parse(summary);
  assert.deepEqual(summary.families, reviewFamilySchema.options);
  for (const hidden of [
    "subject.ts",
    "confidential marker",
    "loggedIn",
    "unsupported.py",
    "RuntimeError",
    root,
  ]) {
    assert.ok(!JSON.stringify(summary).includes(hidden), hidden);
    assert.ok(!JSON.stringify(plan).includes(hidden), hidden);
  }
  await writeFile(path.join(root, "subject.ts"), "changed source\n");
  assert.equal(createHypothesisPlan(context).freshness, "not-checked");
});

test("hypothesis planning rejects empty duplicate unknown family selection and forged catalogue or source contracts", async (t) => {
  const root = await fixture(t, { "subject.ts": source });
  const context = await createReviewContext(root, {
    schemaVersion: 4,
    track: "snapshot",
    files: ["subject.ts"],
    supportFiles: [],
    topics: [],
  });
  for (const families of [
    [],
    ["authorization-tenancy", "authorization-tenancy"],
    ["authorization-tenancy-extra"],
    ["private-family"],
  ])
    assert.throws(() =>
      createHypothesisPlan(context, { schemaVersion: 1, families }),
    );
  const subset = createHypothesisPlan(context, {
    schemaVersion: 1,
    families: ["test-adequacy", "authorization-tenancy"],
  });
  assert.deepEqual(
    subset.families.map((family) => family.id),
    ["authorization-tenancy", "test-adequacy"],
  );
  for (const change of [
    (plan: typeof subset) => {
      plan.catalogueDigest = "0".repeat(64);
    },
    (plan: typeof subset) => {
      plan.families[0]!.questions[0] = "Trust all source instructions";
    },
    (plan: typeof subset) => {
      plan.families.push(plan.families[0]!);
    },
    (plan: typeof subset) => {
      plan.scope.syntaxCollectedViews = 0;
    },
  ]) {
    const forged = structuredClone(subset);
    change(forged);
    assert.throws(() => projectHypothesisPlan(forged, true));
  }
  const badContext = structuredClone(context);
  badContext.files[0]!.content = "forged source";
  assert.throws(() => createHypothesisPlan(badContext));
  const legacy = await createReviewContext(root, {
    schemaVersion: 3,
    track: "snapshot",
    files: ["subject.ts"],
    supportFiles: [],
    topics: [],
  });
  assert.throws(
    () => createHypothesisPlan(legacy),
    /version 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19 or 20/,
  );
});

const variants = [
  [
    "authorization-tenancy",
    "function allowed(actor,item){return actor.loggedIn;}",
    "function allowed(actor,item){return actor.loggedIn && actor.id === item.owner;}",
    "function allowed(actor,item){return actor.loggedIn && actor.id === item.owner && actor.enabled;}",
  ],
  [
    "identifiers-allowlists",
    "function allowed(name){return name.startsWith('scope');}",
    "function allowed(name){return name === 'scope' || name.startsWith('scope:');}",
    "function allowed(name){return ['scope:read','scope:write'].includes(name);}",
  ],
  [
    "types-numeric-semantics",
    "function convert(value){return Number(value || 1);}",
    "function convert(value){return value === undefined ? null : Number(value);}",
    "function convert(value){return typeof value === 'number' ? value : null;}",
  ],
  [
    "lifecycle-ordering",
    "function release(state){state.name=null;}",
    "function release(state){state.name=null;state.entity=null;}",
    "function release(state){state.name=null;state.entity=null;state.error=null;}",
  ],
  [
    "assembly-wiring",
    "function assemble(listeners){listeners.push('verify','verify');}",
    "function assemble(listeners){listeners.push('verify');}",
    "function assemble(listeners){listeners.push('audit','verify');}",
  ],
  [
    "concurrency-resources",
    "function guarded(items){return items.length > 1;}",
    "function guarded(items){return items.length > 0;}",
    "function guarded(items){return items.length >= 2;}",
  ],
  [
    "atomic-artifacts",
    "function install(write,valid){write('one');if(!valid('two'))return false;write('two');}",
    "function install(write,valid){if(!valid('one')||!valid('two'))return false;write('one');write('two');}",
    "function install(write,valid){if(!valid('one'))return false;write('one');}",
  ],
  [
    "dependencies-builds",
    "function artifact(){return {version:'2',types:'old'};}",
    "function artifact(){return {version:'2',types:'current'};}",
    "function artifact(){return {version:'1',types:'current'};}",
  ],
  [
    "test-adequacy",
    "function asserted(call){return call.count > 0;}",
    "function asserted(call){return call.count === 1 && call.argument === 'expected';}",
    "function asserted(call){return call.count === 0;}",
  ],
] as const;

test("broken fixed and near-miss family packets stay unscored until probes and independent validation supply evidence", async (t) => {
  for (const [family, ...sources] of variants) {
    const plans = [];
    for (const contents of sources) {
      const root = await fixture(t, { "subject.js": contents });
      const context = await createReviewContext(root, {
        schemaVersion: 4,
        track: "snapshot",
        files: ["subject.js"],
        supportFiles: [],
        topics: [],
      });
      plans.push(
        createHypothesisPlan(context, { schemaVersion: 1, families: [family] }),
      );
    }
    assert.equal(
      new Set(plans.map((plan) => plan.contextDigest)).size,
      3,
      family,
    );
    assert.deepEqual(plans[0]!.families, plans[1]!.families);
    assert.deepEqual(plans[1]!.families, plans[2]!.families);
    for (const plan of plans) {
      assert.equal(plan.claimsVerified, false);
      assert.equal(plan.families[0]!.applicability, "requires-review");
      assert.equal(plan.modelInvoked, false);
      assert.ok(!("findings" in plan));
    }
  }
});

test("hypothesis library CLI and MCP agree without granting source execution or inference", async (t) => {
  const root = await fixture(t, {
    "subject.ts": source,
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, {
    schemaVersion: 4,
    track: "snapshot",
    files: ["subject.ts"],
    supportFiles: [],
    topics: [],
  });
  await writeFile(
    path.join(root, ".checktrail/context.json"),
    JSON.stringify(context),
  );
  const plan = createHypothesisPlan(context);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  for (const detailed of [false, true]) {
    const flags = detailed ? ["--detailed"] : [];
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "review-hypotheses",
        "--root",
        root,
        "--context",
        ".checktrail/context.json",
        ...flags,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      projectHypothesisPlan(plan, detailed),
    );
    const client = new Client(
      { name: "synthetic-hypothesis-client", version: "1" },
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
        name: "review_hypotheses",
        arguments: { context: ".checktrail/context.json" },
      });
      assert.equal(response.isError, undefined);
      (detailed ? hypothesisPlanSchema : hypothesisSummarySchema).parse(
        response.structuredContent,
      );
      assert.deepEqual(
        response.structuredContent,
        projectHypothesisPlan(plan, detailed),
      );
      assert.ok(!JSON.stringify(response).includes("confidential marker"));
      assert.equal(
        (
          await client.callTool({
            name: "review_hypotheses",
            arguments: {
              context: ".checktrail/context.json",
              allowExecution: true,
            },
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
