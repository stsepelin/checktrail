import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { reportSchema } from "../src/schemas.js";
import { validate } from "../src/engine.js";
import {
  checkstyleFixture,
  nativeOptions,
  brokenJava,
  goodJava,
} from "./checkstyle-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function connect(root: string, allow: boolean) {
  const client = new Client(
    { name: "synthetic-checkstyle-client", version: "1.0.0" },
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
  "native Checkstyle CLI and negotiated MCP share failures privacy and operator-only execution trust",
  nativeOptions,
  async (t) => {
    const root = await checkstyleFixture(t, { "First.java": brokenJava });
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
        { encoding: "utf8", timeout: 30000 },
      );
    const denied = invoke(false, false);
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /trust/i);
    const output = invoke(true, true);
    assert.equal(output.status, 1, output.stderr);
    const report = reportSchema.parse(JSON.parse(output.stdout));
    assert.equal(report.outcome, "failed");
    assert.equal(report.checks[0]!.findingsComplete, true);
    assert.equal(report.checks[0]!.findings!.length, 2);
    const summary = invoke(true, false);
    assert.equal(summary.status, 1, summary.stderr);
    const summarized = JSON.parse(summary.stdout);
    assert.equal(summarized.outcome, "failed");
    assert.ok(
      !summary.stdout.includes(root) &&
        !summary.stdout.includes("First.java") &&
        !summary.stdout.includes("NeedBraces"),
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
          !JSON.stringify(result).includes("First.java"),
      );
      const injection = await client.callTool({
        name: "validation_run",
        arguments: { trusted: true },
      });
      assert.equal(injection.isError, true);
      await writeFile(path.join(root, "First.java"), goodJava);
      const fixed = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
      assert.notEqual(fixed.isError, true);
      assert.equal(
        (fixed.structuredContent as { outcome: string }).outcome,
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
    assert.equal(
      await readFile(path.join(root, "First.java"), "utf8"),
      goodJava,
    );
  },
);

test(
  "native Checkstyle declared root checks report violations and fixed controls for every supported file-set module",
  nativeOptions,
  async (t) => {
    const root = await checkstyleFixture(t);
    const cases = [
      {
        name: "FileTabCharacter",
        properties: "",
        broken: "class First {\n\tint value;\n}\n",
        fixed: goodJava,
      },
      {
        name: "NewlineAtEndOfFile",
        properties: "",
        broken: "class First {}",
        fixed: "class First {}\n",
      },
      {
        name: "LineLength",
        properties: '<property name="max" value="40"/>',
        broken: "// " + "x".repeat(50) + "\nclass First {}\n",
        fixed: "// " + "x".repeat(35) + "\nclass First {}\n",
      },
      {
        name: "RegexpSingleline",
        properties: '<property name="format" value="FORBIDDEN"/>',
        broken: "// FORBIDDEN\nclass First {}\n",
        fixed: "// forbidden\nclass First {}\n",
      },
      {
        name: "RegexpMultiline",
        properties:
          '<property name="format" value="FORBIDDEN[\\s\\S]*ENDING"/>',
        broken: "// FORBIDDEN\n// ENDING\nclass First {}\n",
        fixed: "// FORBIDDEN\n// ending\nclass First {}\n",
      },
    ];
    for (const item of cases) {
      await writeFile(
        path.join(root, "checkstyle.xml"),
        `<module name="Checker"><module name="${item.name}">${item.properties}</module></module>`,
      );
      await writeFile(path.join(root, "First.java"), item.broken);
      const broken = await validate(root, { trusted: true });
      assert.equal(
        broken.outcome,
        "failed",
        `${item.name}: ${JSON.stringify(broken.checks)}`,
      );
      assert.equal(broken.checks[0]!.findingsComplete, true, item.name);
      assert.ok(
        broken.checks[0]!.findings!.some(
          (f) =>
            f.file === "First.java" &&
            f.line! > 0 &&
            f.ruleId.endsWith(item.name + "Check"),
        ),
        item.name,
      );
      await writeFile(path.join(root, "First.java"), item.fixed);
      const fixed = await validate(root, { trusted: true });
      assert.equal(
        fixed.outcome,
        "passed",
        `${item.name}: ${JSON.stringify(fixed.checks)}`,
      );
      assert.equal(fixed.checks[0]!.findingsComplete, true, item.name);
    }
  },
);
