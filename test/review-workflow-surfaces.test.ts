import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  reviewWorkflowAssignmentSchema,
  reviewWorkflowSummarySchema,
} from "../src/review-workflow-schema.js";
import {
  recipe,
  pin,
  setup,
  response,
  limits,
} from "./review-workflow-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const assigned = (value: unknown) =>
  reviewWorkflowAssignmentSchema.parse(value);
const summary = (value: unknown) => reviewWorkflowSummarySchema.parse(value);
async function exchange(
  call: (command: unknown) => Promise<unknown>,
  target: NonNullable<Parameters<typeof response>[1]>[number],
) {
  const opened = summary(
    await call({ operation: "open", context: ".checktrail/context.json" }),
  );
  const reviewer = assigned(
    await call({ operation: "next", workflowId: opened.workflowId }),
  );
  const reviewed = summary(
    await call({
      operation: "submit",
      workflowId: opened.workflowId,
      response: response(reviewer, [target]),
    }),
  );
  const refuter = assigned(
    await call({
      operation: "next",
      workflowId: opened.workflowId,
      target: reviewed.candidateHandles[0],
    }),
  );
  const refuted = summary(
    await call({
      operation: "submit",
      workflowId: opened.workflowId,
      response: response(refuter),
    }),
  );
  assert.equal(refuted.nextStage, "probe");
  const native = summary(
    await call({
      operation: "probe",
      workflowId: opened.workflowId,
      probeId: recipe.id,
    }),
  );
  assert.equal(native.native.calls, 3);
  assert.equal(native.native.accountingComplete, true);
  const adjudicator = assigned(
    await call({ operation: "next", workflowId: opened.workflowId }),
  );
  assert.equal(adjudicator.stage, "adjudicator");
  const done = summary(
    await call({
      operation: "submit",
      workflowId: opened.workflowId,
      response: response(adjudicator),
    }),
  );
  assert.equal(done.disposition, "advisory-stages-completed");
  assert.equal(done.claimsVerified, false);
  assert.equal(done.hostIsolationVerified, false);
  assert.equal(done.assignments.length, 3);
  assert.equal(
    done.assignments.every((attempt) => attempt.status === "accepted"),
    true,
  );
  const closed = summary(
    await call({ operation: "close", workflowId: opened.workflowId }),
  );
  assert.equal(closed.status, "closed");
  assert.equal(closed.retainedBytes, 0);
  assert.equal(closed.native.rawEvidenceRetained, false);
  assert.equal(closed.disposition, "advisory-stages-completed");
  return done;
}
function lines(child: ChildProcessWithoutNullStreams) {
  const reader = createInterface({ input: child.stdout });
  const iterator = reader[Symbol.asyncIterator]();
  const read = async (): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("CLI workflow response timed out")),
            15000,
          );
        }),
      ]);
      assert.equal(result.done, false);
      return JSON.parse(result.value!);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    read,
    close: () => reader.close(),
    call: async (command: unknown) => {
      child.stdin.write(JSON.stringify(command) + "\n");
      return read();
    },
  };
}
async function configured(t: Parameters<typeof setup>[0]) {
  const data = await setup(t);
  const pinned = pin();
  const file = path.join(data.root, ".checktrail/probe.json");
  await writeFile(file, pinned.contents);
  return { ...data, probe: file + "#sha256=" + pinned.sha256 };
}

test("neutral workflow foreground CLI uses the shared provider-free engine and retains final cleanup on EOF", async (t) => {
  const { root, target, probe } = await configured(t);
  const child = spawn(process.execPath, [
    cli,
    "review-session",
    "--root",
    root,
    "--detailed",
    "--allow-review-source",
    "--trust-project",
    "--probe",
    probe,
  ]);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const reader = lines(child);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    await exchange(reader.call, target);
    child.stdin.end();
    const closed = summary(await reader.read());
    assert.equal(closed.status, "closed");
    assert.equal(closed.retainedBytes, 0);
    assert.equal(await exited, 0, stderr);
  } finally {
    child.kill("SIGKILL");
    reader.close();
    await exited;
  }
});

test("neutral workflow MCP uses one strict provider-free tool with startup source native and budget grants", async (t) => {
  const { root, target, probe } = await configured(t);
  for (const flags of [
    [],
    ["--detailed", "--allow-review-source"],
    [
      "--detailed",
      "--allow-review-source",
      "--allow-execution",
      "--probe",
      probe,
    ],
  ]) {
    const client = new Client(
      { name: "original-workflow-host", version: "fixture-1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cli, "serve", "--root", root, ...flags],
          stderr: "pipe",
        }),
      );
      const call = async (command: unknown): Promise<unknown> => {
        const result = await client.callTool({
          name: "review_workflow",
          arguments: command as Record<string, unknown>,
        });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        return result.structuredContent;
      };
      for (const extra of [
        { limits },
        { trusted: true },
        { allowReviewSource: true },
        { provider: "arbitrary" },
        { audit: { file: "arbitrary" } },
        { reviewWorkflowAudit: { file: "arbitrary" } },
      ])
        assert.equal(
          (
            await client.callTool({
              name: "review_workflow",
              arguments: {
                operation: "open",
                context: ".checktrail/context.json",
                ...extra,
              },
            })
          ).isError,
          true,
        );
      if (flags.includes("--allow-execution")) {
        await exchange(call, target);
        continue;
      }
      const opened = summary(
        await call({ operation: "open", context: ".checktrail/context.json" }),
      );
      const issued = await client.callTool({
        name: "review_workflow",
        arguments: { operation: "next", workflowId: opened.workflowId },
      });
      if (!flags.includes("--allow-review-source")) {
        assert.equal(issued.isError, true);
        assert.equal(JSON.stringify(issued).includes("subject.mjs"), false);
      } else {
        const reviewer = assigned(issued.structuredContent);
        const reviewed = summary(
          await call({
            operation: "submit",
            workflowId: opened.workflowId,
            response: response(reviewer, [target]),
          }),
        );
        const refuter = assigned(
          await call({
            operation: "next",
            workflowId: opened.workflowId,
            target: reviewed.candidateHandles[0],
          }),
        );
        await call({
          operation: "submit",
          workflowId: opened.workflowId,
          response: response(refuter),
        });
        assert.equal(
          (
            await client.callTool({
              name: "review_workflow",
              arguments: {
                operation: "probe",
                workflowId: opened.workflowId,
                probeId: recipe.id,
              },
            })
          ).isError,
          true,
        );
        assert.equal(
          summary(
            await call({ operation: "status", workflowId: opened.workflowId }),
          ).native.status,
          "not-started",
        );
      }
      await call({ operation: "close", workflowId: opened.workflowId });
    } finally {
      await client.close();
    }
  }
});

test("neutral workflow CLI treats empty EOF and interrupted pending assignments as incomplete and rejects mismatched startup limits", async (t) => {
  const { root } = await configured(t);
  const empty = spawnSync(
    process.execPath,
    [cli, "review-session", "--root", root],
    { input: "", encoding: "utf8", timeout: 15000 },
  );
  assert.equal(empty.status, 2);
  assert.equal(empty.stdout, "");
  const operatorFile = path.join(root, ".checktrail/limits.json");
  await writeFile(operatorFile, JSON.stringify({ ...limits, maxWorkflows: 0 }));
  const denied = spawnSync(
    process.execPath,
    [cli, "review-session", "--root", root, "--workflow-limits", operatorFile],
    {
      input:
        JSON.stringify({
          operation: "open",
          context: ".checktrail/context.json",
        }) + "\n",
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(denied.status, 2);
  assert.deepEqual(JSON.parse(denied.stdout), {
    error: "Workflow command rejected",
  });
  await writeFile(
    operatorFile,
    JSON.stringify({ ...limits, maxWorkflows: 17 }),
  );
  const mismatch = spawnSync(
    process.execPath,
    [cli, "review-session", "--root", root, "--workflow-limits", operatorFile],
    { input: "", encoding: "utf8", timeout: 15000 },
  );
  assert.equal(mismatch.status, 2);
  assert.equal(mismatch.stdout, "");
  const child = spawn(process.execPath, [
    cli,
    "review-session",
    "--root",
    root,
    "--detailed",
    "--allow-review-source",
  ]);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const reader = lines(child);
  try {
    const opened = summary(
      await reader.call({
        operation: "open",
        context: ".checktrail/context.json",
      }),
    );
    assigned(
      await reader.call({ operation: "next", workflowId: opened.workflowId }),
    );
    child.stdin.end();
    const closed = summary(await reader.read());
    assert.equal(closed.assignments[0]!.status, "cancelled");
    assert.equal(closed.retainedBytes, 0);
    assert.equal(closed.disposition, "not-complete");
    assert.equal(await exited, 2);
  } finally {
    child.kill("SIGKILL");
    reader.close();
    await exited;
  }
});
