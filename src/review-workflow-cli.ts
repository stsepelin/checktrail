import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import {
  ReviewWorkflowEngine,
  type ReviewWorkflowOptions,
} from "./review-workflow.js";
import {
  reviewWorkflowLimitsSchema,
  type ReviewWorkflowLimits,
} from "./review-workflow-schema.js";
export async function loadReviewWorkflowLimits(
  file: string,
): Promise<ReviewWorkflowLimits> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 4096n)
      throw new Error(
        "Workflow limits must be a bounded regular operator file",
      );
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat({ bigint: true });
    if (
      bytesRead > 4096 ||
      before.size !== BigInt(bytesRead) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("Operator workflow limits changed while loading");
    return reviewWorkflowLimitsSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, bytesRead),
        ),
      ),
    );
  } finally {
    await handle.close();
  }
}
/** Foreground JSON-lines exchange; one engine epoch until EOF or termination. */
export async function serveReviewSession(
  root: string,
  options: ReviewWorkflowOptions,
): Promise<void> {
  const engine = new ReviewWorkflowEngine(root, options);
  const controller = new AbortController();
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const interrupt = (): void => {
    controller.abort();
    engine.dispose();
    process.stdin.destroy();
    process.exitCode = 130;
  };
  const terminate = (): void => {
    controller.abort();
    engine.dispose();
    process.stdin.destroy();
    process.exitCode = 143;
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const line = async (text: string): Promise<void> => {
    if (!text.trim()) return;
    try {
      const result = await engine.command(JSON.parse(text), controller.signal);
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch {
      if (controller.signal.aborted) return;
      process.stdout.write('{"error":"Workflow command rejected"}\n');
      process.exitCode = 2;
    }
  };
  try {
    for await (const chunk of process.stdin) {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(text) > 1048576)
          throw new Error("Workflow command line exceeds transport bounds");
        await line(text);
      }
      if (Buffer.byteLength(buffer) > 1048576)
        throw new Error("Workflow command line exceeds transport bounds");
    }
    buffer += decoder.end();
    if (Buffer.byteLength(buffer) > 1048576)
      throw new Error("Workflow command line exceeds transport bounds");
    await line(buffer);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    const summaries = engine.dispose();
    if (
      (!summaries.length ||
        summaries.some((summary) => summary.disposition === "not-complete")) &&
      !process.exitCode
    )
      process.exitCode = 2;
    for (const summary of summaries)
      process.stdout.write(JSON.stringify(summary) + "\n");
  }
}
