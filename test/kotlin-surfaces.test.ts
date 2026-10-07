import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { reportSchema } from "../src/schemas.js";
import {
  kotlinFixture,
  nativeOptions,
  brokenKotlin,
  fixedKotlin,
} from "./kotlin-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function connect(root: string, allow: boolean) {
  const client = new Client(
    { name: "synthetic-Kotlin-client", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          cli,
          "serve",
          "--root",
          root,
          ...(allow ? ["--allow-execution"] : []),
        ],
        stderr: "pipe",
      }),
    );
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
test(
  "native Kotlin CLI and negotiated MCP share failures privacy and operator-only execution trust",
  nativeOptions,
  async (t) => {
    const root = await kotlinFixture(t, { "Original.kt": brokenKotlin });
    const invoke = (trust: boolean, detailed: boolean) =>
      spawnSync(
        process.execPath,
        [
          cli,
          "run",
          "--root",
          root,
          ...(trust ? ["--trust-project"] : []),
          ...(detailed ? ["--detailed"] : []),
        ],
        { encoding: "utf8", timeout: 60000 },
      );
    const denied = invoke(false, false);
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /trust/i);
    const output = invoke(true, true);
    assert.equal(output.status, 1, output.stderr);
    const report = reportSchema.parse(JSON.parse(output.stdout));
    assert.equal(report.outcome, "failed");
    assert.equal(report.checks[0]!.findingsComplete, false);
    assert.equal(report.checks[0]!.findings!.length, 1);
    const summary = invoke(true, false);
    assert.equal(summary.status, 1, summary.stderr);
    const summarized = JSON.parse(summary.stdout);
    assert.equal(summarized.outcome, "failed");
    assert.ok(
      !summary.stdout.includes(root) &&
        !summary.stdout.includes("Original.kt") &&
        !summary.stdout.includes("UNSAFE_CALL"),
    );
    const client = await connect(root, true);
    try {
      const result = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
      assert.notEqual(result.isError, true);
      assert.equal(
        (result.structuredContent as { outcome: string }).outcome,
        "failed",
      );
      assert.deepEqual(
        (result.structuredContent as { checks: unknown }).checks,
        summarized.checks,
      );
      assert.ok(
        !JSON.stringify(result).includes(root) &&
          !JSON.stringify(result).includes("Original.kt"),
      );
      const injection = await client.callTool({
        name: "validation_run",
        arguments: { trusted: true },
      });
      assert.equal(injection.isError, true);
      await writeFile(path.join(root, "Original.kt"), fixedKotlin);
      const fixed = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
      assert.notEqual(fixed.isError, true);
      assert.equal(
        (fixed.structuredContent as { outcome: string }).outcome,
        "passed",
        JSON.stringify(fixed),
      );
    } finally {
      await client.close();
    }
    const untrusted = await connect(root, false);
    try {
      assert.equal(
        (await untrusted.callTool({ name: "validation_run", arguments: {} }))
          .isError,
        true,
      );
    } finally {
      await untrusted.close();
    }
    assert.equal(
      await readFile(path.join(root, "Original.kt"), "utf8"),
      fixedKotlin,
    );
  },
);
