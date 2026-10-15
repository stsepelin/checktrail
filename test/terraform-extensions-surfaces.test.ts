import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  terraformExtensionsFixture,
  terraformExtensionsNative as native,
  terraformExtensionsWriteConfig,
} from "./terraform-extensions-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function connect(root: string, allow: boolean) {
  const client = new Client(
    { name: "original-terraform-extension-client", version: "1.0.0" },
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
  } catch (e) {
    await client.close();
    throw e;
  }
}
test("terraform-extensions privacy acceptance", native, async (t) => {
  const { root, config } = await terraformExtensionsFixture(t),
    marker = "original_terraform_extension_marker";
  config.modules[2]!.resources.selected!.max = marker;
  await terraformExtensionsWriteConfig(root, config);
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
  assert.equal(detailed.status, 1, detailed.stderr);
  const report = JSON.parse(detailed.stdout);
  assert.equal(report.outcome, "failed");
  assert.equal(report.checks[0].findings.length, 2);
  assert.ok(detailed.stdout.includes(marker));
  const summary = invoke(true, false);
  assert.equal(summary.status, 1, summary.stderr);
  const summarized = JSON.parse(summary.stdout);
  for (const value of [root, marker, "modules/leaf/main.tf", providerMarker()])
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
      "failed",
    );
    assert.deepEqual(
      (result.structuredContent as { checks: unknown }).checks,
      summarized.checks,
    );
    assert.ok(!JSON.stringify(result).includes(root));
    assert.ok(!JSON.stringify(result).includes(marker));
    assert.ok(!JSON.stringify(result).includes(providerMarker()));
    assert.equal(
      (
        await client.callTool({
          name: "validation_run",
          arguments: { trusted: true },
        })
      ).isError,
      true,
    );
    config.modules[2]!.resources.selected!.max = 5;
    await terraformExtensionsWriteConfig(root, config);
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
});
function providerMarker() {
  return "terraform-provider-random_v3.9.1_x5";
}
