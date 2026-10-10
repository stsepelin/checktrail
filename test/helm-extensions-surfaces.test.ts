import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  helmExtensionsConfig,
  helmExtensionsFixture,
  helmExtensionsWriteConfig,
  helmExtensionsNative as native,
} from "./helm-extensions-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function connect(root: string, allow: boolean) {
  const client = new Client(
    { name: "original-helm-extension-client", version: "1.0.0" },
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
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (v): v is [string, string] => v[1] !== undefined,
          ),
        ),
        stderr: "pipe",
      }),
    );
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
test("helm-extensions privacy acceptance", native, async (t) => {
  const config = helmExtensionsConfig(),
    marker = "original_helm_extension_marker";
  config.charts[0]!.properties.note = { type: "string" };
  config.charts[0]!.values.note = marker;
  config.charts[0]!.templates["templates/object.yaml"]!.push(
    "  note: {{ .Values.note | quote }}",
  );
  const root = await helmExtensionsFixture(t, config);
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
      { encoding: "utf8", timeout: 150000, maxBuffer: 4 * 1048576 },
    );
  const denied = invoke(false, false);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /trust/i);
  const detailed = invoke(true, true);
  assert.equal(detailed.error, undefined);
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.equal(JSON.parse(detailed.stdout).outcome, "passed");
  assert.ok(detailed.stdout.includes(marker));
  assert.ok(detailed.stdout.includes("charts/worker/charts/leaf"));
  const summary = invoke(true, false);
  assert.equal(summary.error, undefined);
  assert.equal(summary.status, 0, summary.stderr);
  const summarized = JSON.parse(summary.stdout);
  assert.equal(summarized.outcome, "passed");
  for (const value of [
    root,
    marker,
    "charts/worker/charts/leaf/templates/object.yaml",
  ])
    assert.ok(!summary.stdout.includes(value), value);
  const client = await connect(root, true);
  try {
    const result = await client.callTool(
      { name: "validation_run", arguments: { timeoutMs: 120000 } },
      { timeout: 150000 },
    );
    assert.notEqual(result.isError, true);
    assert.equal(
      (result.structuredContent as { outcome: string }).outcome,
      "passed",
    );
    assert.deepEqual(
      (result.structuredContent as { checks: unknown }).checks,
      summarized.checks,
    );
    for (const value of [
      root,
      marker,
      "charts/worker/charts/leaf/templates/object.yaml",
    ])
      assert.ok(!JSON.stringify(result).includes(value), value);
    assert.equal(
      (
        await client.callTool({
          name: "validation_run",
          arguments: { trusted: true },
        })
      ).isError,
      true,
    );
    config.charts[0]!.values.count = 0;
    await helmExtensionsWriteConfig(root, config);
    const failed = await client.callTool(
      { name: "validation_run", arguments: { timeoutMs: 120000 } },
      { timeout: 150000 },
    );
    assert.notEqual(failed.isError, true);
    assert.equal(
      (failed.structuredContent as { outcome: string }).outcome,
      "failed",
    );
    assert.ok(!JSON.stringify(failed).includes(marker));
    config.charts[0]!.values.count = 2;
    await helmExtensionsWriteConfig(root, config);
    const repaired = await client.callTool(
      { name: "validation_run", arguments: { timeoutMs: 120000 } },
      { timeout: 150000 },
    );
    assert.notEqual(repaired.isError, true);
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
});
