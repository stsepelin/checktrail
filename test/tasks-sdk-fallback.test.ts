import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fixture, nodeManifest, passingTest } from "./helpers.js";

test("Tasks-enabled servers retain ordinary native validation with pinned SDK modern and legacy clients", async (t) => {
  for (const modern of [true, false]) {
    const root = await realpath(
      await fixture(t, {
        "package.json": nodeManifest,
        "value.test.js": passingTest,
      }),
    );
    const directory = path.join(await realpath(await fixture(t, {})), "tasks");
    const client = new Client(
      { name: "original-tasks-matrix-client", version: "1.0.0" },
      modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../src/cli.js", import.meta.url)),
        "serve",
        "--root",
        root,
        "--task-store",
        directory,
        "--allow-execution",
        "--timeout-ms",
        "15000",
      ],
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const plan = await client.callTool({
        name: "validation_plan",
        arguments: {},
      });
      assert.equal(plan.isError, undefined);
      const run = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
      assert.notEqual(run.isError, true);
      const summary = run.structuredContent as {
        outcome: string;
        runId: string;
        checks: Array<{
          status: string;
          tests?: { total: number; passed: number };
        }>;
      };
      assert.equal(summary.outcome, "passed", JSON.stringify(run));
      assert.deepEqual(
        summary.checks.map((c) => [c.status, c.tests?.total, c.tests?.passed]),
        [["passed", 1, 1]],
      );
      assert.equal(Object.hasOwn(run, "taskId"), false);
      const retained = await client.callTool({
        name: "validation_report",
        arguments: { runId: summary.runId },
      });
      assert.deepEqual(retained.structuredContent, summary);
      assert.equal(JSON.stringify(run).includes(root), false);
      assert.equal(JSON.stringify(run).includes("value.test.js"), false);
    } finally {
      await client.close();
    }
  }
});
