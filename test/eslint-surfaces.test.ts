import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fixture } from "./helpers.js";
import { copyESLint, eslintConfig, eslintPolicy } from "./eslint-helpers.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test(
  "CLI and MCP agree on passed, failed and incomplete ESLint checks without exposing diagnostics in summaries",
  { timeout: 30_000 },
  async (t) => {
    const root = await fixture(t, {
      "package.json": '{"type":"module"}',
      "repo-verifier.json": eslintPolicy(),
      "eslint.config.js": eslintConfig,
      "source.js": "export const value = 42;\n",
    });
    await copyESLint(root);
    const client = new Client(
      { name: "eslint-surface-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    t.after(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "serve", "--root", root, "--allow-execution"],
        stderr: "pipe",
      }),
    );
    await client.listTools();
    const scenarios = [
      {
        source: "export const value = 42;\n",
        config: eslintConfig,
        outcome: "passed",
        code: 0,
      },
      {
        source: "debugger;\n",
        config: eslintConfig,
        outcome: "failed",
        code: 1,
      },
      {
        source: "debugger;\n",
        config:
          "export default [{ignores:['source.js']},{rules:{'no-debugger':'error'}}];\n",
        outcome: "incomplete",
        code: 2,
      },
    ];
    for (const scenario of scenarios) {
      await writeFile(path.join(root, "source.js"), scenario.source);
      await writeFile(path.join(root, "eslint.config.js"), scenario.config);
      let output: string;
      let code = 0;
      try {
        output = (
          await exec(process.execPath, [
            cli,
            "run",
            "--root",
            root,
            "--trust-project",
          ])
        ).stdout;
      } catch (error) {
        const failure = error as { stdout: string; code: number };
        output = failure.stdout;
        code = failure.code;
      }
      assert.equal(code, scenario.code);
      const cliReport = JSON.parse(output) as {
        outcome: string;
        checks: unknown[];
      };
      const run = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
      assert.equal(run.isError, undefined);
      const report = run.structuredContent as {
        outcome: string;
        checks: unknown[];
        runId: string;
      };
      assert.equal(report.outcome, scenario.outcome);
      assert.equal(cliReport.outcome, scenario.outcome);
      assert.deepEqual(report.checks, cliReport.checks);
      const saved = await client.callTool({
        name: "validation_report",
        arguments: { runId: report.runId },
      });
      assert.deepEqual(saved.structuredContent, run.structuredContent);
      for (const value of [JSON.stringify(run), output]) {
        assert.ok(!value.includes(root));
        assert.ok(!value.includes("source.js"));
        assert.ok(!value.includes("no-debugger"));
      }
    }
  },
);
