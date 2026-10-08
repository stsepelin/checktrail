import { readFile, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import {
  ReviewHostAssignmentLease,
  createReviewHostAssignmentServer,
} from "../src/review-host-lease.js";
import { reviewWorkflowAssignmentSchema } from "../src/review-workflow-schema.js";
import { reviewCandidateSchema } from "../src/review-provider-schema.js";
const [mode, configPath] = process.argv.slice(2);
if (!configPath || !["server", "host"].includes(mode ?? ""))
  throw new Error("Synthetic host mode and startup config required");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (mode === "server") {
  const lease = new ReviewHostAssignmentLease(
    config.assignment,
    config.options,
  );
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 262144,
  });
  const handle = serveStdio(() => createReviewHostAssignmentServer(lease), {
    transport,
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void handle.close().finally(() => lease.revoke());
  };
  process.stdin.once("end", close);
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
} else {
  const client = new Client(
    { name: "original-synthetic-independent-host", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(
        new URL("./review-host-process-fixture.js", import.meta.url),
      ),
      "server",
      config.serverConfig,
    ],
    env: { PATH: process.env.PATH ?? "", LANG: "C" },
    stderr: "pipe",
  });
  let errors = "";
  transport.stderr?.on("data", (bytes) => {
    errors += (bytes as Buffer).toString();
    if (Buffer.byteLength(errors) > 65536) {
      errors = errors.slice(0, 65536);
      void client.close();
      process.exitCode = 2;
    }
  });
  try {
    await client.connect(transport);
    const observedServerPid = transport.pid;
    const tools = (await client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
    const result = await client.callTool({
      name: "review_host_assignment",
      arguments: {},
    });
    if (result.isError) throw new Error("Assigned source was not delivered");
    const assignment = reviewWorkflowAssignmentSchema.parse(
      result.structuredContent,
    );
    const rejects = async (name: string, args: Record<string, unknown>) => {
      try {
        return (
          (await client.callTool({ name, arguments: args })).isError === true
        );
      } catch {
        return true;
      }
    };
    if (config.operation === "hold" || config.operation === "flood") {
      await writeFile(
        config.readyPath,
        JSON.stringify({
          workerPid: process.pid,
          serverPid: observedServerPid,
        }),
      );
      if (config.operation === "flood")
        process.stdout.write("x".repeat(1048576));
      await new Promise<void>(() => {});
    }
    if (config.operation === "malformed") {
      const rejected = await rejects("review_host_submit", { output: {} });
      // Observe consumption before a second read could itself exhaust the read budget.
      const status = await client.callTool({
        name: "review_host_status",
        arguments: {},
      });
      const revoked = await rejects("review_host_assignment", {});
      await client.close();
      process.stdout.write(
        JSON.stringify({
          rejected,
          revoked,
          status: status.structuredContent,
        }) + "\n",
      );
    } else {
      const siblingSourceRejected = await rejects("review_host_assignment", {
        file: "../hidden-answer.json",
      });
      const toolGrantRejected = await rejects("review_host_assignment", {
        allowExecution: true,
        allowSourceDisclosure: true,
        maxReads: 32,
      });
      const executionToolRejected = await rejects("validation_run", {});
      const hostOutput = config.candidate
        ? [reviewCandidateSchema.parse(config.candidate)]
        : [];
      const packet = JSON.parse(assignment.packet);
      const context = packet.context;
      if (!context || !Array.isArray(context.files))
        throw new Error("Missing assigned context");
      const response = {
        assignmentId: assignment.assignmentId,
        assignmentDigest: assignment.assignmentDigest,
        host: {
          client: "synthetic-sdk-host",
          clientVersion: "2.3.0",
          provider: "synthetic-provider",
          model: "synthetic-model",
          sessionId: randomUUID(),
          session: "fresh",
        },
        status: "completed",
        usage: {
          inputTokens: null,
          outputTokens: null,
          elapsedMs: null,
          costUSD: null,
        },
        output: {
          files: context.selection.files
            .concat(context.selection.supportFiles)
            .map((path: string) => ({
              path,
              disposition: "reviewed",
              note: "Synthetic stage declaration",
            })),
          candidates: hostOutput,
        },
      };
      const submitted = await client.callTool({
        name: "review_host_submit",
        arguments: response,
      });
      if (submitted.isError) throw new Error("Synthetic submission rejected");
      const sourceRevoked = await rejects("review_host_assignment", {});
      const duplicateResponseRejected = await rejects(
        "review_host_submit",
        response,
      );
      const status = await client.callTool({
        name: "review_host_status",
        arguments: {},
      });
      const sourceFreeStatus = !JSON.stringify(
        status.structuredContent,
      ).includes("subject.mjs");
      await client.close();
      let serverClosed = false;
      if (observedServerPid !== null) {
        try {
          process.kill(observedServerPid, 0);
        } catch (error) {
          serverClosed = (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }
      process.stdout.write(
        JSON.stringify({
          workerPid: process.pid,
          serverPid: observedServerPid,
          serverClosed,
          tools,
          stage: assignment.stage,
          assignmentDigest: assignment.assignmentDigest,
          packetDigest: createHash("sha256")
            .update(assignment.packet)
            .digest("hex"),
          packet: assignment.packet,
          response,
          receipt: submitted.structuredContent,
          siblingSourceRejected,
          toolGrantRejected,
          executionToolRejected,
          sourceRevoked,
          duplicateResponseRejected,
          sourceFreeStatus,
          stderrBytes: Buffer.byteLength(errors),
          hostIsolationVerified: false,
          modelFreshnessVerified: false,
          inferenceInvoked: false,
        }) + "\n",
      );
    }
  } finally {
    await client.close();
  }
}
