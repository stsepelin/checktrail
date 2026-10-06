import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createToolCatalog } from "../src/mcp-tool-catalog.js";

test("extension dispatcher validates original callback inputs and outputs while preserving tool errors", async (t) => {
  const server = new McpServer({ name: "synthetic-catalog", version: "1.0.0" });
  const catalog = createToolCatalog(server);
  let calls = 0;
  catalog.register(
    "synthetic",
    {
      description: "Synthetic schema validation control",
      inputSchema: z.strictObject({
        mode: z.enum(["valid", "wrong-output", "tool-error"]),
      }),
      outputSchema: z.strictObject({ count: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      calls++;
      if (input.mode === "tool-error")
        return {
          isError: true,
          content: [{ type: "text", text: "Explicit interruption" }],
        };
      const value = input.mode === "valid" ? { count: 7 } : { count: "seven" };
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
      };
    },
  );
  server.server.setRequestHandler("tools/call", (request, context) =>
    catalog.call(request.params.name, request.params.arguments, context),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "synthetic-client", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const invalid = await client.callTool({
    name: "synthetic",
    arguments: { mode: "valid", unrecognized: true },
  });
  assert.equal(invalid.isError, true);
  assert.equal(calls, 0);
  const valid = await client.callTool({
    name: "synthetic",
    arguments: { mode: "valid" },
  });
  assert.equal(valid.isError, undefined);
  assert.deepEqual(valid.structuredContent, { count: 7 });
  assert.equal(calls, 1);
  const wrong = await client.callTool({
    name: "synthetic",
    arguments: { mode: "wrong-output" },
  });
  assert.equal(wrong.isError, true);
  assert.equal(wrong.structuredContent, undefined);
  assert.equal(calls, 2);
  const error = await client.callTool({
    name: "synthetic",
    arguments: { mode: "tool-error" },
  });
  assert.equal(error.isError, true);
  assert.equal(error.structuredContent, undefined);
  assert.deepEqual(error.content, [
    { type: "text", text: "Explicit interruption" },
  ]);
  assert.equal(calls, 3);
});
