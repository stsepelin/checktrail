import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile, mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ReviewWorkflowEngine } from "../src/review-workflow.js";
import {
  reviewWorkflowAllSummarySchema,
  reviewWorkflowAssignmentSchema,
} from "../src/review-workflow-schema.js";
import type { ReviewWorkflowFindingsDeclarations } from "../src/review-workflow-findings.js";
import {
  setup,
  pin,
  recipe,
  response,
  source,
} from "./review-workflow-fixture.js";
export const options = {
  allowReviewSource: true,
  candidateScope: "all" as const,
  trusted: true,
  probes: [pin()],
};
export type Call = (command: unknown) => Promise<unknown>;
export const findingsNativeWallMs = 30000;
export const findingsResponseHeadroomMs = 10000;
export function findingsCliStderrDigest() {
  let bytes = 0;
  const hash = createHash("sha256");
  return {
    append(chunk: Buffer) {
      assert.ok(Buffer.isBuffer(chunk));
      bytes += chunk.length;
      hash.update(chunk);
    },
    snapshot() {
      return { bytes, sha256: hash.copy().digest("hex") };
    },
  };
}
export function findingsCliResponseTimeoutMs(
  operation: string,
  nativeWallMs: number,
) {
  assert.ok(
    Number.isSafeInteger(nativeWallMs) &&
      nativeWallMs > 0 &&
      nativeWallMs <= 120000,
  );
  // Observe the unchanged native deadline, its bounded Windows job drain and
  // directory cleanup, and the final JSON response without aborting a legal probe.
  return ["probe", "finish", "close"].includes(operation)
    ? nativeWallMs + findingsResponseHeadroomMs
    : 15000;
}
export async function findingsCliDeadline<T>(
  pending: Promise<T>,
  timeoutMs: number,
  describe: () => Record<string, unknown>,
): Promise<T> {
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 130000,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = performance.now();
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const context = {
            ...describe(),
            timeoutMs,
            readElapsedMs: Math.round(performance.now() - started),
          };
          reject(
            Object.assign(
              Error(
                "Original findings CLI deadline " + JSON.stringify(context),
              ),
              { code: "FINDINGS_CLI_DEADLINE", context },
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function stopFindingsCliFixture(
  child: {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill(signal: NodeJS.Signals): boolean;
  },
  exited: Promise<number | null>,
  timeoutMs: number,
  describe: () => Record<string, unknown>,
): Promise<void> {
  const alive = () => child.exitCode === null && child.signalCode === null;
  if (alive()) child.kill("SIGTERM");
  try {
    await findingsCliDeadline(exited, timeoutMs, describe);
  } catch (primary) {
    if (alive()) child.kill("SIGKILL");
    const failures: unknown[] = [];
    try {
      await findingsCliDeadline(exited, findingsResponseHeadroomMs, describe);
    } catch (secondary) {
      failures.push(secondary);
    }
    if (failures.length)
      throw new AggregateError(
        [primary, ...failures],
        "Findings CLI fixture cleanup incomplete",
        { cause: primary },
      );
    throw primary;
  }
}
export async function readFindingsCliResponse(
  iterator: AsyncIterator<string>,
  timeoutMs: number,
  describe: () => Record<string, unknown>,
): Promise<unknown> {
  const line = await findingsCliDeadline(iterator.next(), timeoutMs, describe);
  assert.equal(
    line.done,
    false,
    "Original findings CLI EOF " + JSON.stringify(describe()),
  );
  return JSON.parse(line.value!);
}

export async function complete(
  t: TestContext,
  content = source,
  empty = false,
  channel?: (root: string) => Promise<Call>,
  retry = false,
  observe?: (
    stage: "reviewer" | "native" | "cycle",
    boundary: {
      call: Call;
      id: string;
      root: string;
      context: Awaited<ReturnType<typeof setup>>["context"];
      state: ReturnType<typeof reviewWorkflowAllSummarySchema.parse>;
    },
  ) => Promise<void>,
) {
  const d = await setup(t, content);
  const engine = new ReviewWorkflowEngine(d.root, options);
  t.after(() => engine.dispose());
  const call: Call = channel
    ? await channel(d.root)
    : (command) => engine.command(command);
  const opened = reviewWorkflowAllSummarySchema.parse(
    await call({ operation: "open", context: ".checktrail/context.json" }),
  );
  async function next(target?: string) {
    return reviewWorkflowAssignmentSchema.parse(
      await call({
        operation: "next",
        workflowId: opened.workflowId,
        ...(target ? { target } : {}),
      }),
    );
  }
  async function rejected(target?: string) {
    const unavailable = response(await next(target));
    unavailable.status = "unavailable";
    unavailable.output = null;
    unavailable.usage = {
      inputTokens: 17,
      outputTokens: 0,
      elapsedMs: 9,
      costUSD: null,
    };
    await call({
      operation: "submit",
      workflowId: opened.workflowId,
      response: unavailable,
    });
  }
  if (retry) await rejected();
  const reviewer = response(
    await next(),
    empty
      ? []
      : [
          d.target,
          {
            ...d.target,
            id: "OriginalSiblingClaim",
            claim: "A separately declared symptom of the synthetic boundary.",
          },
        ],
  );
  const state = reviewWorkflowAllSummarySchema.parse(
    await call({
      operation: "submit",
      workflowId: opened.workflowId,
      response: reviewer,
    }),
  );
  const boundary = async (stage: "reviewer" | "native" | "cycle") => {
    await observe?.(stage, {
      call,
      id: state.workflowId,
      root: d.root,
      context: d.context,
      state: reviewWorkflowAllSummarySchema.parse(
        await call({ operation: "status", workflowId: state.workflowId }),
      ),
    });
  };
  await boundary("reviewer");
  const hosts: Array<{
    target: string;
    refuter: typeof reviewer.host;
    adjudicator: typeof reviewer.host;
  }> = [];
  // Deliberately process the second handle first. Retained completion order is not reviewer order.
  for (const target of [...state.candidateHandles].reverse()) {
    if (retry) await rejected(target);
    const refuter = response(await next(target));
    await call({
      operation: "submit",
      workflowId: state.workflowId,
      response: refuter,
    });
    const probed = reviewWorkflowAllSummarySchema.parse(
      await call({
        operation: "probe",
        workflowId: state.workflowId,
        probeId: recipe.id,
      }),
    );
    assert.equal(probed.status, "ready", JSON.stringify(probed));
    assert.equal(probed.nextStage, "adjudicator", JSON.stringify(probed));
    assert.equal(probed.native.status, "completed", JSON.stringify(probed));
    await boundary("native");
    if (retry) await rejected();
    const adjudicator = response(await next());
    await call({
      operation: "submit",
      workflowId: state.workflowId,
      response: adjudicator,
    });
    await boundary("cycle");
    hosts.push({
      target,
      refuter: refuter.host,
      adjudicator: adjudicator.host,
    });
  }
  const declarations = declarationsFor(d.context, state.candidateHandles);
  return {
    ...d,
    engine,
    call,
    id: state.workflowId,
    state,
    declarations,
    hosts,
    reviewer,
  };
}
export async function auditFile(t: TestContext) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "checktrail-original-findings-audit-"),
  );
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "epoch.jsonl");
}
export async function channel(
  mode: "cli" | "mcp",
  root: string,
  file?: string,
) {
  const pinned = pin();
  const probeFile = path.join(root, ".checktrail/probe.json");
  await writeFile(probeFile, pinned.contents);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const flags = [
    "--root",
    root,
    "--detailed",
    "--allow-review-source",
    "--workflow-candidates",
    "all",
    "--timeout-ms",
    String(findingsNativeWallMs),
    ...(file ? ["--workflow-audit", file] : []),
    "--probe",
    probeFile + "#sha256=" + pinned.sha256,
  ];
  if (mode === "mcp") {
    const client = new Client(
      { name: "original-workflow-findings-host", version: "fixture-1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cli, "serve", ...flags, "--allow-execution"],
          stderr: "pipe",
        }),
      );
    } catch (error) {
      await client.close();
      throw error;
    }
    return {
      call: async (command: unknown) => {
        const result = await client.callTool({
          name: "review_workflow",
          arguments: command as Record<string, unknown>,
        });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        return result.structuredContent;
      },
      finish: async () => client.close(),
      close: async () => client.close(),
    };
  }
  const launched = performance.now();
  const child = spawn(process.execPath, [
    cli,
    "review-session",
    ...flags,
    "--trust-project",
  ]);
  const reader = createInterface({ input: child.stdout });
  const iterator = reader[Symbol.asyncIterator]();
  const stderr = findingsCliStderrDigest();
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let sequence = 0,
    completedResponses = 0,
    lastCompletedOperation = "none";
  const knownOperations = new Set([
    "open",
    "next",
    "submit",
    "probe",
    "findings",
    "status",
    "close",
    "finish",
  ]);
  const describe =
    (operation: string, request: number, phase: string) => () => {
      const observedStderr = stderr.snapshot();
      return {
        profile: "findings-cli-observation-v1",
        operation: knownOperations.has(operation) ? operation : "unknown",
        sequence: request,
        phase,
        spawnElapsedMs: Math.round(performance.now() - launched),
        completedResponses,
        lastCompletedOperation,
        childExitCode: child.exitCode,
        childSignal: child.signalCode,
        stderrBytes: observedStderr.bytes,
        stderrSha256: observedStderr.sha256,
      };
    };
  const read = async (operation: string, request: number) => {
    const value = await readFindingsCliResponse(
      iterator,
      findingsCliResponseTimeoutMs(operation, findingsNativeWallMs),
      describe(operation, request, "response"),
    );
    completedResponses++;
    lastCompletedOperation = knownOperations.has(operation)
      ? operation
      : "unknown";
    return value;
  };
  return {
    call: async (command: unknown) => {
      const operation =
        command &&
        typeof command === "object" &&
        "operation" in command &&
        typeof command.operation === "string"
          ? command.operation
          : "unknown";
      const request = ++sequence;
      child.stdin.write(JSON.stringify(command) + "\n");
      return read(operation, request);
    },
    finish: async () => {
      const request = ++sequence;
      child.stdin.end();
      const summary = (await read("finish", request)) as { format?: string };
      assert.equal(summary.format, "review-workflow-summary");
      assert.equal(
        await findingsCliDeadline(
          exited,
          findingsCliResponseTimeoutMs("finish", findingsNativeWallMs),
          describe("finish", request, "child-close"),
        ),
        0,
      );
    },
    close: async () => {
      try {
        await stopFindingsCliFixture(
          child,
          exited,
          findingsCliResponseTimeoutMs("close", findingsNativeWallMs),
          describe("close", sequence, "child-close"),
        );
      } finally {
        reader.close();
      }
    },
  };
}

export function declarationsFor(
  context: Awaited<ReturnType<typeof setup>>["context"],
  targets: string[],
): ReviewWorkflowFindingsDeclarations {
  if (!("analysis" in context)) throw Error("Captured functions required");
  const fn = context.analysis.functions.find(
    (f) => f.name === "decision" && f.revision === "current",
  )!;
  return {
    decisions: targets.map((target) => ({
      target,
      refutationRationale:
        "A declared independent counterexample search; host isolation is unverified.",
      adjudicationRationale:
        "A declared reading of the original synthetic source and observed predicate.",
      judgment: {
        disposition: "supported",
        citationIndex: 0,
        functionId: fn.id,
        mechanism:
          "The identifier prefix includes a synthetic sibling identifier.",
        reachableCallers:
          "The synthetic exported function is the declared caller boundary.",
        defaultsChecked: "This original function has no inherited defaults.",
        consequence: {
          category: "wrong-result",
          extent: "single",
          access: "unprivileged",
          recovery: "reversible",
          statement:
            "The synthetic caller receives a different Boolean from its pinned expectation.",
        },
        repair: {
          citationIndex: 0,
          functionId: fn.id,
          requiredParameters: ["name"],
          scope: "this-change",
          text: "Compare the complete parameter name.",
        },
      },
    })),
    commonDefects: !targets.length
      ? []
      : [
          {
            id: "OriginalCommonBoundary",
            rootFunctionId: fn.id,
            targets: targets,
            rationale:
              "Explicit shared-root declaration, not semantic duplicate detection.",
          },
        ],
  };
}
