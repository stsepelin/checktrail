import { architectureFixture } from "./architecture-helpers.js";
import { architectureSummarySchema } from "../src/architecture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { TestContext } from "node:test";
import { fixture, nodeManifest, passingTest } from "./helpers.js";
import { copyESLint, eslintConfig, eslintPolicy } from "./eslint-helpers.js";
import { validate } from "../src/engine.js";
import { runtimeComparisonSummarySchema } from "../src/runtime-inventory.js";
import { contractSummarySchema } from "../src/contract-schema.js";
import { contractFixture } from "./contract-helpers.js";
import { createFindingBaseline } from "../src/finding-policy.js";
import {
  findingComparisonSchema,
  findingComparisonSummarySchema,
} from "../src/finding-policy-schema.js";

async function connect(
  t: TestContext,
  root: string,
  args: string[] = [],
  modern = true,
): Promise<Client> {
  const client = new Client(
    { name: "checktrail-test-client", version: "1.0.0" },
    modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../src/cli.js", import.meta.url)),
      "serve",
      "--root",
      root,
      ...args,
    ],
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

test("MCP 2026-07-28 advertises tools, validates input, and cannot elevate execution trust", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "sum.test.js": passingTest,
  });
  const client = await connect(t, root);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "architecture_validation",
    "contract_validation",
    "finding_comparison",
    "mutation_experiment",
    "project_context",
    "review_context",
    "review_guidance",
    "review_receipt",
    "runtime_comparison",
    "validation_plan",
    "validation_report",
    "validation_run",
  ]);
  assert.equal(
    tools.tools.find((tool) => tool.name === "validation_run")?.annotations
      ?.readOnlyHint,
    false,
  );
  const plan = await client.callTool({
    name: "validation_plan",
    arguments: {},
  });
  assert.equal(plan.isError, undefined);
  assert.ok(JSON.stringify(plan).includes("javascript.node-test"));
  assert.ok(!JSON.stringify(plan).includes(root));
  const denied = await client.callTool({
    name: "validation_run",
    arguments: {},
  });
  assert.equal(denied.isError, true);
  const injected = await client.callTool({
    name: "validation_run",
    arguments: { trusted: true },
  });
  assert.equal(injected.isError, true);
});

test("MCP executes trusted checks and retrieves exactly that retained report", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "sum.test.js": passingTest,
  });
  const client = await connect(t, root, ["--allow-execution"]);
  await client.listTools();
  const run = await client.callTool({
    name: "validation_run",
    arguments: { timeoutMs: 5000 },
  });
  assert.equal(run.isError, undefined);
  const value = run.structuredContent as { outcome: string; runId: string };
  assert.equal(value.outcome, "passed");
  const report = await client.callTool({
    name: "validation_report",
    arguments: { runId: value.runId },
  });
  assert.deepEqual(report.structuredContent, run.structuredContent);
  const absent = await client.callTool({
    name: "validation_report",
    arguments: { runId: "00000000-0000-4000-8000-000000000000" },
  });
  assert.equal(absent.isError, true);
});

test("SDK legacy negotiation can inspect the same stdio server", async (t) => {
  const root = await fixture(t, { "package.json": nodeManifest });
  const client = await connect(t, root, [], false);
  const tools = await client.listTools();
  assert.ok(
    tools.tools.some((tool) => tool.name === "architecture_validation"),
  );
  assert.ok(tools.tools.some((tool) => tool.name === "validation_run"));
});

test(
  "MCP contract validation is read-only, responsive, cancellable and summary-only unless the operator opts in",
  { timeout: 10_000 },
  async (t) => {
    const normal = contractFixture();
    const slow = contractFixture();
    slow.contracts[0]!.schema = { type: "string", pattern: "^(a+)+$" };
    slow.contracts[0]!.samples[0]!.payload = "a".repeat(1000) + "!";
    const root = await fixture(t, {
      "package.json": nodeManifest,
      "contract.json": JSON.stringify(normal),
      "slow.json": JSON.stringify(slow),
    });
    const client = await connect(t, root);
    const result = await client.callTool({
      name: "contract_validation",
      arguments: { input: "contract.json" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(
      contractSummarySchema.parse(result.structuredContent).outcome,
      "passed",
    );
    for (const hidden of [root, "catalog-response", "book", "quantity"])
      assert.ok(!JSON.stringify(result).includes(hidden));
    for (const bad of [
      { input: "../outside.json" },
      { input: "contract.json", detailed: true },
      { input: "contract.json", trusted: true },
    ])
      assert.equal(
        (await client.callTool({ name: "contract_validation", arguments: bad }))
          .isError,
        true,
      );
    const controller = new AbortController();
    t.after(() => controller.abort());
    const pending = client.callTool(
      {
        name: "contract_validation",
        arguments: { input: "slow.json", timeoutMs: 30_000 },
      },
      { signal: controller.signal },
    );
    const cancelled = assert.rejects(pending, /abort|cancel/i);
    assert.equal(
      (await client.callTool({ name: "validation_plan", arguments: {} }))
        .isError,
      undefined,
    );
    const overlap = await client.callTool({
      name: "contract_validation",
      arguments: { input: "contract.json" },
    });
    assert.equal(overlap.isError, true);
    assert.match(JSON.stringify(overlap.content), /already running/);
    controller.abort();
    await cancelled;
    for (let attempt = 0; attempt < 40; attempt++) {
      const next = await client.callTool({
        name: "contract_validation",
        arguments: { input: "contract.json" },
      });
      if (!next.isError) {
        assert.equal(
          contractSummarySchema.parse(next.structuredContent).outcome,
          "passed",
        );
        return;
      }
      assert.match(JSON.stringify(next.content), /already running/);
      await delay(25);
    }
    assert.fail("Contract worker remained active after cancellation");
  },
);

test("MCP policy overlay is startup-only and cannot remove checked-in requirements", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "value.test.js": passingTest,
    "value.js": "debugger;\n",
    "eslint.config.mjs": eslintConfig,
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["javascript.node-test"] }],
    }),
    ".checktrail.local.json": eslintPolicy(),
  });
  await copyESLint(root);
  const client = await connect(t, root, [
    "--allow-execution",
    "--policy-overlay",
    ".checktrail.local.json",
  ]);
  const run = await client.callTool({ name: "validation_run", arguments: {} });
  assert.equal(run.isError, undefined);
  assert.equal(
    (run.structuredContent as { outcome: string }).outcome,
    "failed",
  );
  const checks = (
    run.structuredContent as { checks: { id: string; status: string }[] }
  ).checks;
  assert.deepEqual(
    checks.map((check) => [check.id, check.status]),
    [
      ["javascript.node-test", "passed"],
      ["javascript.eslint", "failed"],
    ],
  );
  assert.ok(!JSON.stringify(run).includes(".checktrail.local.json"));
  for (const name of ["validation_plan", "validation_run"])
    assert.equal(
      (
        await client.callTool({
          name,
          arguments: { policyOverlay: "other.json" },
        })
      ).isError,
      true,
    );
});

test("MCP compares runtime artifacts read-only with summary projection and bounded root", async (t) => {
  const before = {
    schemaVersion: 1,
    format: "runtime-inventory",
    producer: { name: "synthetic", version: "1.0.0" },
    assembly: { name: "synthetic-service", environment: "test" },
    sourceFingerprint: "a".repeat(64),
    capturedAt: "2026-09-18T00:00:00.000Z",
    collections: [
      {
        kind: "listeners",
        complete: true,
        ordered: true,
        entries: [{ key: "Created", attributes: { listener: "NotifyOwner" } }],
      },
    ],
  };
  const after = structuredClone(before);
  after.collections[0]!.entries.push(
    structuredClone(after.collections[0]!.entries[0]!),
  );
  const root = await fixture(t, {
    "before.json": JSON.stringify(before),
    "after.json": JSON.stringify(after),
  });
  const client = await connect(t, root);
  const args = { before: "before.json", after: "after.json" };
  const compared = await client.callTool({
    name: "runtime_comparison",
    arguments: args,
  });
  assert.equal(compared.isError, undefined);
  const value = runtimeComparisonSummarySchema.parse(
    compared.structuredContent,
  );
  assert.equal(value.outcome, "failed");
  assert.equal(value.counts.added, 1);
  for (const hidden of [root, "NotifyOwner", "Created", "synthetic-service"])
    assert.ok(!JSON.stringify(compared).includes(hidden));
  for (const bad of [
    { ...args, before: "../outside.json" },
    { ...args, detailed: true },
    { ...args, trusted: true },
  ])
    assert.equal(
      (await client.callTool({ name: "runtime_comparison", arguments: bad }))
        .isError,
      true,
    );
});

test("MCP finding comparison retains native failure and enforces startup detail and artifact boundaries", async (t) => {
  const root = await fixture(t, {
    "package.json": '{"type":"module"}',
    "checktrail.json": eslintPolicy(),
    "eslint.config.mjs": eslintConfig,
    "value.js": "debugger;\n",
  });
  await copyESLint(root);
  const native = await validate(root, { trusted: true });
  const baseline = createFindingBaseline(native, {
    owner: "synthetic-maintainer",
    reason: "Synthetic accepted finding",
  });
  await writeFile(path.join(root, "baseline.json"), JSON.stringify(baseline));
  for (const detailed of [false, true]) {
    const client = await connect(t, root, [
      "--allow-execution",
      ...(detailed ? ["--detailed"] : []),
    ]);
    const run = await client.callTool({
      name: "validation_run",
      arguments: {},
    });
    assert.equal(run.isError, undefined);
    const report = run.structuredContent as { runId: string; outcome: string };
    assert.equal(report.outcome, "failed");
    const args = { runId: report.runId, baseline: "baseline.json" };
    const comparison = await client.callTool({
      name: "finding_comparison",
      arguments: args,
    });
    assert.equal(comparison.isError, undefined);
    const value = (
      detailed ? findingComparisonSchema : findingComparisonSummarySchema
    ).parse(comparison.structuredContent);
    assert.equal(value.outcome, "passed");
    assert.equal(value.validationOutcome, "failed");
    assert.equal(value.counts.matched, 1);
    if (!detailed) {
      assert.ok(!JSON.stringify(comparison).includes(baseline.entries[0]!.id));
      assert.ok(!JSON.stringify(comparison).includes("value.js"));
    }
    for (const changed of [
      { ...args, runId: "00000000-0000-4000-8000-000000000000" },
      { ...args, baseline: "../baseline.json" },
      { ...args, baseline: path.join(root, "baseline.json") },
      { ...args, detailed: true },
      { ...args, now: "2020-01-01T00:00:00.000Z" },
    ]) {
      const rejected = await client.callTool({
        name: "finding_comparison",
        arguments: changed,
      });
      assert.equal(rejected.isError, true);
      assert.ok(!JSON.stringify(rejected).includes(root));
    }
    await client.close();
  }
});

test(
  "MCP remains responsive during validation, rejects overlap, and accepts a run after cancellation",
  { timeout: 10_000 },
  async (t) => {
    const root = await fixture(t, {
      "package.json": nodeManifest,
      "slow.test.js": `import {test} from 'node:test';
import fs from 'node:fs';
test('waits', async () => {
  fs.mkdirSync('.checktrail', {recursive:true});
  fs.writeFileSync('.checktrail/ready', 'ready');
  await new Promise(resolve => setTimeout(resolve, 60000));
});`,
    });
    const client = await connect(t, root, ["--allow-execution"]);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const run = client.callTool(
      { name: "validation_run", arguments: { timeoutMs: 120_000 } },
      { signal: controller.signal },
    );
    const cancelled = assert.rejects(run, /abort|cancel/i);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready =
          (await readFile(path.join(root, ".checktrail/ready"), "utf8")) ===
          "ready";
        break;
      } catch {
        await delay(25);
      }
    }
    assert.equal(ready, true);
    await client.notification({
      method: "notifications/cancelled",
      params: { requestId: "0" },
    });
    const plan = await client.callTool({
      name: "validation_plan",
      arguments: {},
    });
    assert.equal(plan.isError, undefined);
    const overlap = await client.callTool({
      name: "validation_run",
      arguments: {},
    });
    assert.equal(overlap.isError, true);
    assert.match(JSON.stringify(overlap.content), /already running/);
    controller.abort();
    await cancelled;
    await writeFile(path.join(root, "slow.test.js"), passingTest);
    for (let attempt = 0; attempt < 40; attempt++) {
      const next = await client.callTool({
        name: "validation_run",
        arguments: { timeoutMs: 5000 },
      });
      if (!next.isError) {
        assert.equal(
          (next.structuredContent as { outcome: string }).outcome,
          "passed",
        );
        return;
      }
      assert.match(JSON.stringify(next.content), /already running/);
      await delay(25);
    }
    assert.fail("Validation remained busy after cancellation");
  },
);

test("MCP architecture validation shares exact boundary semantics and cannot disclose graph names in summary mode", async (t) => {
  const { graph, policy } = architectureFixture();
  graph.dependencies.push({ consumer: "service-extra", producer: "domain" });
  const root = await fixture(t, {
    "graph.json": JSON.stringify(graph),
    "policy.json": JSON.stringify(policy),
  });
  const client = await connect(t, root);
  const result = await client.callTool({
    name: "architecture_validation",
    arguments: { input: "graph.json", policy: "policy.json" },
  });
  assert.equal(result.isError, undefined);
  const summary = architectureSummarySchema.parse(result.structuredContent);
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.counts.forbidden, 1);
  assert.ok(!JSON.stringify(result).includes("service-extra"));
  for (const input of ["../outside.json", "/outside.json"])
    assert.equal(
      (
        await client.callTool({
          name: "architecture_validation",
          arguments: { input, policy: "policy.json" },
        })
      ).isError,
      true,
    );
  assert.equal(
    (
      await client.callTool({
        name: "architecture_validation",
        arguments: {
          input: "graph.json",
          policy: "policy.json",
          detailed: true,
        },
      })
    ).isError,
    true,
  );
});

test("MCP guidance remains read-only and advisory, with operator-controlled detail", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "private.test.js": "throw new Error('Guidance must not run tests');",
  });
  const client = await connect(t, root);
  const tools = await client.listTools();
  assert.equal(
    tools.tools.find((tool) => tool.name === "review_guidance")?.annotations
      ?.readOnlyHint,
    true,
  );
  const result = await client.callTool({
    name: "review_guidance",
    arguments: { topics: ["package-consumers"] },
  });
  assert.equal(result.isError, undefined);
  const content = result.structuredContent as {
    channel: string;
    automatedCoverage: boolean;
    items: { id: string }[];
  };
  assert.equal(content.channel, "advisory");
  assert.equal(content.automatedCoverage, false);
  assert.deepEqual(
    content.items.map((item) => item.id),
    ["review.test-lifecycle", "review.package-consumers"],
  );
  assert.ok(!JSON.stringify(result).includes("private.test.js"));
  assert.ok(!Object.hasOwn(content, "outcome"));
  assert.ok(!Object.hasOwn(content, "context"));
  for (const args of [
    { topics: ["unknown"] },
    { detailed: true },
    { root: "/" },
    { topics: ["package-consumers", "package-consumers"] },
  ]) {
    assert.equal(
      (await client.callTool({ name: "review_guidance", arguments: args }))
        .isError,
      true,
    );
  }
});

test("MCP mutation experiments enforce startup trust and share native assertion evidence", async (t) => {
  const recipe = {
    schemaVersion: 1,
    profile: "node-flat-tests",
    mutations: [
      { id: "subtract", file: "sum.js", expected: "a+b", replacement: "a-b" },
    ],
  };
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "sum.js": "export const sum=(a,b)=>a+b;",
    "sum.test.js":
      "import {test} from 'node:test';import assert from 'node:assert/strict';import {sum} from './sum.js';test('sum',()=>assert.equal(sum(2,3),5));",
    "mutations.json": JSON.stringify(recipe),
  });
  const denied = await connect(t, root);
  assert.equal(
    (
      await denied.callTool({
        name: "mutation_experiment",
        arguments: { input: "mutations.json" },
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await denied.callTool({
        name: "mutation_experiment",
        arguments: { input: "mutations.json", trusted: true },
      })
    ).isError,
    true,
  );
  const client = await connect(t, root, ["--allow-execution"]);
  const result = await client.callTool({
    name: "mutation_experiment",
    arguments: { input: "mutations.json" },
  });
  assert.equal(result.isError, undefined);
  const report = result.structuredContent as {
    complete: boolean;
    channel: string;
    counts: { killed: number };
  };
  assert.equal(report.complete, true);
  assert.equal(report.channel, "advisory");
  assert.equal(report.counts.killed, 1);
  assert.ok(!JSON.stringify(result).includes("sum.js"));
  assert.ok(!Object.hasOwn(report, "outcome"));
  for (const input of ["../outside.json", "/outside.json"])
    assert.equal(
      (
        await client.callTool({
          name: "mutation_experiment",
          arguments: { input },
        })
      ).isError,
      true,
    );
});

test("MCP mutation cancellation leaves planning responsive and cleans temporary workers", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "sum.js": "export const sum=(a,b)=>a+b;",
    "mutations.json": JSON.stringify({
      schemaVersion: 1,
      profile: "node-flat-tests",
      mutations: [
        { id: "subtract", file: "sum.js", expected: "a+b", replacement: "a-b" },
      ],
    }),
  });
  const probe = path.join(root, ".checktrail/ready");
  await mkdir(path.dirname(probe));
  await writeFile(
    path.join(root, "sum.test.js"),
    `import {test} from 'node:test';import {writeFileSync} from 'node:fs';test('slow',async()=>{writeFileSync(${JSON.stringify(probe)},process.cwd());await new Promise(resolve=>setTimeout(resolve,60000));});`,
  );
  const client = await connect(t, root, ["--allow-execution"]);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = client.callTool(
    {
      name: "mutation_experiment",
      arguments: { input: "mutations.json", timeoutMs: 120000 },
    },
    { signal: controller.signal },
  );
  const cancelled = assert.rejects(pending, /abort|cancel/i);
  let copy: string | undefined;
  for (let i = 0; i < 100; i++) {
    try {
      copy = await readFile(probe, "utf8");
      break;
    } catch {
      await delay(20);
    }
  }
  assert.ok(copy, "Native mutation baseline did not start");
  assert.equal(
    (await client.callTool({ name: "validation_plan", arguments: {} })).isError,
    undefined,
  );
  assert.equal(
    (await client.callTool({ name: "validation_run", arguments: {} })).isError,
    true,
  );
  assert.equal(
    (
      await client.callTool({
        name: "mutation_experiment",
        arguments: { input: "mutations.json" },
      })
    ).isError,
    true,
  );
  controller.abort();
  await cancelled;
  for (let i = 0; i < 100; i++) {
    try {
      await readFile(path.join(copy, "package.json"));
      await delay(20);
    } catch {
      return;
    }
  }
  assert.fail("Temporary mutation copy remained after cancellation");
});
