import process from "node:process";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { clearTimeout, setTimeout } from "node:timers";
import { McpServer } from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const methods = ["tasks/get", "tasks/cancel", "tasks/update"];
const input = new PassThrough();
const output = new PassThrough();
const lines = createInterface({ input: output });
const handle = serveStdio(
  () => {
    const server = new McpServer(
      { name: "tasks-routing-probe", version: "0.0.0" },
      {
        capabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } },
      },
    );
    for (const method of methods) {
      server.server.setRequestHandler(
        method,
        {
          params: z.object({ taskId: z.string() }),
          result: z.object({
            resultType: z.literal("complete"),
            reached: z.boolean(),
          }),
        },
        () => ({ resultType: "complete", reached: true }),
      );
    }
    return server;
  },
  { transport: new StdioServerTransport(input, output) },
);

let timer;
try {
  const responses = new Map();
  const completed = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Tasks routing probe timed out")),
      3000,
    );
    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line);
        if (
          Number.isInteger(response.id) &&
          response.id >= 0 &&
          response.id < methods.length
        ) {
          responses.set(response.id, response);
          if (responses.size === methods.length) resolve();
        }
      } catch (error) {
        reject(error);
      }
    });
  });
  for (const [id, method] of methods.entries()) {
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: { "io.modelcontextprotocol/tasks": {} },
            },
          },
          taskId: "synthetic-probe",
        },
      }) + "\n",
    );
  }
  await completed;
  const results = methods.map((method, id) => ({
    method,
    handlerReached: responses.get(id)?.result?.reached === true,
    errorCode: responses.get(id)?.error?.code ?? null,
  }));
  process.stdout.write(
    JSON.stringify(
      {
        protocol: "2026-07-28",
        probe: "extension method routing only",
        results,
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = results.every((result) => result.handlerReached) ? 0 : 2;
} finally {
  clearTimeout(timer);
  await handle.close();
  lines.close();
  input.destroy();
  output.destroy();
}
