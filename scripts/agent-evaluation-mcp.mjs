import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const [cli, root, tool, argumentJson, trace, trust, ...extra] =
  process.argv.slice(2);
assert.ok(
  cli && root && tool && argumentJson && trace && extra.length === 0,
  "Usage: agent-evaluation-mcp.mjs CLI ROOT TOOL JSON TRACE [--trust-project]",
);
assert.ok(trust === undefined || trust === "--trust-project");
assert.ok(
  !path.resolve(trace).startsWith(path.resolve(root) + path.sep),
  "Write traces outside reviewed source",
);
const args = JSON.parse(argumentJson);
const traceHandle = await fs.open(trace, "wx", 0o600);
const client = new Client(
  { name: "checktrail-evaluation-reviewer", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
const transcript = {
  schemaVersion: 1,
  tool,
  arguments: args,
  startedAt: new Date().toISOString(),
  executionEnabled: trust === "--trust-project",
};
const started = performance.now();
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        path.resolve(cli),
        "serve",
        "--root",
        path.resolve(root),
        ...(trust ? ["--allow-execution"] : []),
      ],
      stderr: "pipe",
    }),
  );
  transcript.server = client.getServerVersion();
  transcript.result =
    tool === "list"
      ? await client.listTools()
      : await client.callTool({ name: tool, arguments: args });
  if (tool === "validation_run" && transcript.result.structuredContent?.runId) {
    transcript.retainedReport = await client.callTool({
      name: "validation_report",
      arguments: { runId: transcript.result.structuredContent.runId },
    });
    assert.deepEqual(
      transcript.retainedReport.structuredContent,
      transcript.result.structuredContent,
    );
  }
  console.log(JSON.stringify(transcript.result, null, 2));
} catch (error) {
  transcript.error = error.message;
  process.exitCode = 2;
  console.error(error.message);
} finally {
  try {
    await client.close();
  } catch (error) {
    transcript.closeError = error.message;
    process.exitCode = 2;
  }
  transcript.elapsedMs = performance.now() - started;
  const bytes = JSON.stringify(transcript);
  try {
    await traceHandle.writeFile(
      JSON.stringify(
        {
          transcript,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await traceHandle.close();
  }
}
