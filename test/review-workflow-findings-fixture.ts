import assert from "node:assert/strict";
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
  const child = spawn(process.execPath, [
    cli,
    "review-session",
    ...flags,
    "--trust-project",
  ]);
  const reader = createInterface({ input: child.stdout });
  const iterator = reader[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.on("data", (v: Buffer) => {
    stderr += v.toString();
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const read = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const line = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("Original findings CLI deadline")),
            15000,
          );
        }),
      ]);
      assert.equal(line.done, false, stderr);
      return JSON.parse(line.value!);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    call: async (command: unknown) => {
      child.stdin.write(JSON.stringify(command) + "\n");
      return read();
    },
    finish: async () => {
      child.stdin.end();
      assert.equal((await read()).format, "review-workflow-summary");
      assert.equal(await exited, 0, stderr);
    },
    close: async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await exited;
      reader.close();
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
