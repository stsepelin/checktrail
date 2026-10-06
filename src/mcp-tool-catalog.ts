import { z } from "zod";
import {
  type CallToolResult,
  type McpServer,
  type ServerContext,
  type ToolAnnotations,
  type ToolCallback,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";

// Keep application callbacks and schemas together when an extension owns tools/call.
// Registration and wire projection still use the public SDK APIs.
export function createToolCatalog(server: McpServer) {
  const tools = new Map<
    string,
    {
      parse: (input: unknown) => Promise<unknown>;
      call: (input: unknown, context: ServerContext) => Promise<CallToolResult>;
      project: (result: CallToolResult) => CallToolResult;
    }
  >();
  function register<I extends z.ZodType, O extends z.ZodType>(
    name: string,
    config: {
      description: string;
      inputSchema: I;
      outputSchema: O;
      annotations: ToolAnnotations;
    },
    callback: (
      input: z.output<I>,
      context: ServerContext,
    ) => Promise<CallToolResult>,
  ): void {
    server.registerTool(name, config, callback as ToolCallback<I>);
    const output = z.toJSONSchema(config.outputSchema, {
      target: "draft-2020-12",
      io: "output",
    });
    // All Checktrail outputs are objects, including unions of objects. Reject a
    // future non-object schema rather than misprojecting it for legacy clients.
    function objectRoot(value: Record<string, unknown>): boolean {
      if (value.type !== undefined) return value.type === "object";
      return ["anyOf", "oneOf", "allOf"].some((key) => {
        const alternatives = value[key];
        return (
          Array.isArray(alternatives) &&
          alternatives.length > 0 &&
          alternatives.every(
            (v) => typeof v === "object" && v !== null && objectRoot(v),
          )
        );
      });
    }
    if (!objectRoot(output))
      throw new Error("Tool output must describe an object");
    const schema = { type: "object", ...output };
    tools.set(name, {
      parse: (input) => config.inputSchema.parseAsync(input ?? {}),
      call: async (input, context) => {
        const result = await callback(
          await config.inputSchema.parseAsync(input ?? {}),
          context,
        );
        if (!result.isError)
          await config.outputSchema.parseAsync(result.structuredContent);
        return result;
      },
      project: (result) => server.server.projectCallToolResult(result, schema),
    });
  }
  function lookup(name: string) {
    const tool = tools.get(name);
    if (!tool)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown tool");
    return tool;
  }
  return {
    register,
    parse: (name: string, input: unknown) => lookup(name).parse(input),
    project: (name: string, result: CallToolResult) =>
      lookup(name).project(result),
    async call(
      name: string,
      input: unknown,
      context: ServerContext,
    ): Promise<CallToolResult> {
      const tool = lookup(name);
      try {
        return tool.project(await tool.call(input, context));
      } catch {
        return {
          isError: true,
          content: [
            { type: "text", text: "Tool input or output validation failed." },
          ],
        };
      }
    },
  };
}
