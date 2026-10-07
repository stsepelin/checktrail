import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { reportSchema } from "../src/schemas.js";
import { cppToolsFixture, cppToolsNative } from "./cpp-tools-fixture.js";
const native = cppToolsNative;
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function connect(root: string, allow: boolean) {
  const client = new Client(
    { name: "original-cpp-tools-client", version: "1.0.0" },
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
  "native C/C++ CLI and negotiated MCP preserve source failures summary privacy and operator-only trust",
  native,
  async (t) => {
    const { root } = await cppToolsFixture(t, ["cpp.ctest"]),
      source = path.join(root, "src/range.c"),
      original = await readFile(source, "utf8");
    const broken =
      "#include <stdio.h>\n" +
      original.replace(
        "return value + ORIGINAL_STEP;",
        'fputs("original_cpp_marker", stderr); return value;',
      );
    assert.notEqual(broken, original);
    await writeFile(source, broken);
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
    const nativePacket = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    assert.ok(
      nativePacket.receipts
        .find((r: { phase: string }) => r.phase === "test")
        .stdout.includes("original_cpp_marker"),
      "Executed callback emitted the privacy marker",
    );
    assert.deepEqual(report.checks[0]!.tests, {
      total: 2,
      passed: 0,
      failed: 2,
      skipped: 0,
    });
    assert.ok(
      report.checks[0]!.findings!.every(
        (f) => f.file === "CMakeLists.txt" && f.line! > 0,
      ),
    );
    const summary = invoke(true, false);
    assert.equal(summary.status, 1, summary.stderr);
    const summarized = JSON.parse(summary.stdout);
    assert.ok(
      !summary.stdout.includes(root) &&
        !summary.stdout.includes("original_cpp_marker") &&
        !summary.stdout.includes("range.c"),
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
          !JSON.stringify(result).includes("original_cpp_marker"),
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
