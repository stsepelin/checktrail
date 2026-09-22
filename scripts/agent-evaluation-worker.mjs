import assert from "node:assert/strict";
import process from "node:process";

const { Client } =
  await import("/runtime/node_modules/@modelcontextprotocol/client/dist/index.mjs");
const { StdioClientTransport } =
  await import("/runtime/node_modules/@modelcontextprotocol/client/dist/stdio.mjs");
const action = process.argv[2];
assert.ok(["validation_plan", "validation_run"].includes(action));
const client = new Client(
  { name: "checktrail-isolated-evaluation", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "/runtime/node_modules/@stsepelin/checktrail/dist/src/cli.js",
        "serve",
        "--root",
        "/source",
        "--allow-execution",
        "--detailed",
      ],
      stderr: "pipe",
    }),
  );
  const result = await client.callTool({ name: action, arguments: {} });
  const trace = { server: client.getServerVersion(), action, result };
  if (action === "validation_run" && result.structuredContent?.runId) {
    trace.retainedReport = await client.callTool({
      name: "validation_report",
      arguments: { runId: result.structuredContent.runId },
    });
    assert.deepEqual(
      trace.retainedReport.structuredContent,
      result.structuredContent,
    );
  }
  process.stdout.write(JSON.stringify(trace) + "\n");
} finally {
  await client.close();
}
