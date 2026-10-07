import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { reportSchema } from "../src/schemas.js";
import { kubeFixture, kubeNative } from "./kubeconform-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function connect(root: string, allow: boolean) {
  const client = new Client(
    { name: "original-kubernetes-client", version: "1.0.0" },
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
  "native Kubernetes CLI and negotiated MCP retain schema defects repair summary privacy and startup-only trust",
  kubeNative,
  async (t) => {
    const root = await kubeFixture(t),
      source = path.join(root, "manifests/original.yaml"),
      original = await readFile(source, "utf8"),
      marker = "original_kubernetes_marker";
    await writeFile(
      source,
      original.replace("replicas: 2", "replicas: " + marker),
    );
    const invoke = (trusted: boolean, detailed: boolean) =>
      spawnSync(
        process.execPath,
        [
          cli,
          "run",
          "--root",
          root,
          "--timeout-ms",
          "120000",
          ...(trusted ? ["--trust-project"] : []),
          ...(detailed ? ["--detailed"] : []),
        ],
        { encoding: "utf8", timeout: 150000, maxBuffer: 4 * 1024 * 1024 },
      );
    const denied = invoke(false, false);
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /trust/i);
    const detailed = invoke(true, true);
    assert.equal(detailed.status, 1, detailed.stderr);
    const report = reportSchema.parse(JSON.parse(detailed.stdout));
    assert.equal(report.outcome, "failed");
    assert.equal(report.checks[0]!.findings![0]!.line, 6);
    assert.ok(
      detailed.stdout.includes(marker),
      "Detailed command records contain the original source marker",
    );
    const summary = invoke(true, false);
    assert.equal(summary.status, 1, summary.stderr);
    const summarized = JSON.parse(summary.stdout);
    assert.ok(
      !summary.stdout.includes(root) &&
        !summary.stdout.includes(marker) &&
        !summary.stdout.includes("original.yaml"),
    );
    const client = await connect(root, true);
    try {
      const result = await client.callTool(
        { name: "validation_run", arguments: { timeoutMs: 120000 } },
        { timeout: 150000 },
      );
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
          !JSON.stringify(result).includes(marker),
      );
      assert.equal(
        (
          await client.callTool({
            name: "validation_run",
            arguments: { trusted: true },
          })
        ).isError,
        true,
      );
      await writeFile(source, original);
      const repaired = await client.callTool(
        { name: "validation_run", arguments: { timeoutMs: 120000 } },
        { timeout: 150000 },
      );
      assert.equal(
        (repaired.structuredContent as { outcome: string }).outcome,
        "passed",
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
  },
);
