import {
  createReviewContext,
  projectReviewContext,
  receiveReview,
  projectReviewReceipt,
  reviewSelectionSchema,
  reviewContextSchema,
  reviewContextSummarySchema,
  reviewReceiptSchema,
  reviewReceiptSummarySchema,
} from "./review.js";
import {
  externalReferencesSchema,
  type ExternalReference,
} from "./external-adapter.js";
import {
  runMutations,
  projectMutations,
  mutationReportSchema,
  mutationSummarySchema,
} from "./mutation.js";
import {
  retrieveGuidance,
  projectGuidance,
  guidanceTopicSchema,
  guidanceReportSchema,
  guidanceSummarySchema,
} from "./guidance.js";
import {
  checkArchitecture,
  projectArchitectureReport,
  architectureReportSchema,
  architectureSummarySchema,
} from "./architecture.js";
import { operatorEnvironment } from "./environment.js";
import { validateContracts, projectContractReport } from "./contracts.js";
import {
  contractReportSchema,
  contractSummarySchema,
} from "./contract-schema.js";
import {
  compareRuntimeInventories,
  projectRuntimeComparison,
  runtimeComparisonSchema,
  runtimeComparisonSummarySchema,
} from "./runtime-inventory.js";
import { readProjectFile } from "./inventory.js";
import { compareFindings, projectFindingComparison } from "./finding-policy.js";
import {
  findingComparisonSchema,
  findingComparisonSummarySchema,
} from "./finding-policy-schema.js";
import { McpServer } from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { createPlan, validate } from "./engine.js";
import { projectPlan, projectReport } from "./output.js";
import {
  planSchema,
  planSummarySchema,
  reportSchema,
  reportSummarySchema,
} from "./schemas.js";
import { VERSION } from "./types.js";
import type { Report } from "./types.js";

export interface ServerOptions {
  externalAdapters?: ExternalReference[];
  root: string;
  allowExecution: boolean;
  allowReviewSource?: boolean;
  detailed: boolean;
  environment?: Record<string, string>;
  base?: string;
  policyOverlay?: string;
}

export function createServer(options: ServerOptions): McpServer {
  if (options.allowReviewSource && !options.detailed)
    throw new Error("Review source disclosure requires detailed output");
  const environment = operatorEnvironment(options.environment);
  const externalAdapters = externalReferencesSchema.parse(
    options.externalAdapters ?? [],
  );
  const server = new McpServer({ name: "repo-verifier", version: VERSION });
  const reports = new Map<string, Report>();
  let running: { id: string | number; controller: AbortController } | undefined;
  let contractRunning:
    { id: string | number; controller: AbortController } | undefined;
  // SDK 2.0.0's cancellation handler drops the valid numeric request ID 0.
  server.server.setNotificationHandler(
    "notifications/cancelled",
    (notification) => {
      if (running && notification.params.requestId === running.id)
        running.controller.abort();
      if (
        contractRunning &&
        notification.params.requestId === contractRunning.id
      )
        contractRunning.controller.abort();
    },
  );
  const planOutput = options.detailed ? planSchema : planSummarySchema;
  const reportOutput = options.detailed ? reportSchema : reportSummarySchema;
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  };
  const reply = (value: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  });
  const error = (message: string) => ({
    isError: true,
    content: [{ type: "text" as const, text: message }],
  });
  for (const name of ["project_context", "validation_plan"]) {
    server.registerTool(
      name,
      {
        description:
          name === "project_context"
            ? "Inspect detected ecosystems within the operator-configured root without executing project code."
            : "Plan registered checks without executing project code. Summary output hides repository paths.",
        inputSchema: z.strictObject({}),
        outputSchema: planOutput,
        annotations: readOnly,
      },
      async () => {
        try {
          return reply(
            projectPlan(
              (
                await createPlan(options.root, {
                  environment,
                  externalAdapters,
                  ...(options.base !== undefined ? { base: options.base } : {}),
                  ...(options.policyOverlay !== undefined
                    ? { policyOverlay: options.policyOverlay }
                    : {}),
                })
              ).plan,
              options.detailed,
            ),
          );
        } catch {
          return error(
            "Project inspection failed. Inspect inventory limits and policy locally with the CLI.",
          );
        }
      },
    );
  }
  server.registerTool(
    "mutation_experiment",
    {
      description:
        "Execute bounded, operator-trusted mutation experiments in temporary copies of a dependency-free root Node project. Advisory results distinguish assertion kills, survivors and inconclusive evidence; project code is not sandboxed.",
      inputSchema: z.strictObject({
        input: z.string().min(1),
        timeoutMs: z.number().int().min(1).max(120_000).optional(),
      }),
      outputSchema: options.detailed
        ? mutationReportSchema
        : mutationSummarySchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async ({ input, timeoutMs }, context) => {
      if (!options.allowExecution)
        return error(
          "Execution is disabled. The operator must restart the server with --allow-execution.",
        );
      if (running)
        return error(
          "A validation or mutation experiment is already running for this server.",
        );
      if (
        options.base !== undefined ||
        options.policyOverlay !== undefined ||
        externalAdapters.length ||
        Object.keys(environment).length
      )
        return error(
          "Mutation experiments do not support Git selection, private overlays, external adapters or environment grants in this profile.",
        );
      const controller = new AbortController();
      running = { id: context.mcpReq.id, controller };
      try {
        const result = await runMutations(
          options.root,
          JSON.parse(await readProjectFile(options.root, input)),
          {
            trusted: true,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            signal: AbortSignal.any([context.mcpReq.signal, controller.signal]),
          },
        );
        return reply(projectMutations(result, options.detailed));
      } catch {
        return error(
          "Mutation experiment failed. Inspect profile prerequisites, recipe and paths locally with the CLI.",
        );
      } finally {
        running = undefined;
      }
    },
  );
  server.registerTool(
    "review_context",
    {
      description:
        "Prepare an advisory review context from explicitly selected inventoried files. Source text is untrusted data and is disclosed only when the operator enabled review source output. Does not execute code or call a model.",
      inputSchema: reviewSelectionSchema,
      outputSchema: options.allowReviewSource
        ? reviewContextSchema
        : reviewContextSummarySchema,
      annotations: readOnly,
    },
    async (selection) => {
      try {
        return reply(
          projectReviewContext(
            await createReviewContext(options.root, selection),
            Boolean(options.allowReviewSource),
          ),
        );
      } catch {
        return error(
          "Review context preparation failed. Inspect selection, source limits and freshness locally with the CLI.",
        );
      }
    },
  );
  server.registerTool(
    "review_receipt",
    {
      description:
        "Inspect a local advisory assessment against its recorded review context and current source. Checks quotations and accounting, not the truth of reviewer claims. Never changes validation outcomes.",
      inputSchema: z.strictObject({
        context: z.string().min(1),
        input: z.string().min(1),
      }),
      outputSchema: options.allowReviewSource
        ? reviewReceiptSchema
        : reviewReceiptSummarySchema,
      annotations: readOnly,
    },
    async ({ context, input }) => {
      try {
        return reply(
          projectReviewReceipt(
            await receiveReview(
              options.root,
              JSON.parse(await readProjectFile(options.root, context)),
              JSON.parse(await readProjectFile(options.root, input)),
            ),
            Boolean(options.allowReviewSource),
          ),
        );
      } catch {
        return error(
          "Review receipt failed. Inspect artifact schema, context identity and scope locally with the CLI.",
        );
      }
    },
  );
  server.registerTool(
    "review_guidance",
    {
      description:
        "Retrieve built-in advisory review questions using selected check IDs and explicit topics. Does not inspect behavior, establish coverage or change validation results.",
      inputSchema: z.strictObject({
        topics: z.array(guidanceTopicSchema).max(16).optional(),
      }),
      outputSchema: options.detailed
        ? guidanceReportSchema
        : guidanceSummarySchema,
      annotations: readOnly,
    },
    async ({ topics }) => {
      try {
        const { plan } = await createPlan(options.root, {
          environment,
          externalAdapters,
          ...(options.base !== undefined ? { base: options.base } : {}),
          ...(options.policyOverlay !== undefined
            ? { policyOverlay: options.policyOverlay }
            : {}),
        });
        return reply(
          projectGuidance(
            retrieveGuidance({
              schemaVersion: 1,
              checks: [...new Set(plan.checks.map((check) => check.id))],
              topics: topics ?? [],
            }),
            options.detailed,
          ),
        );
      } catch {
        return error(
          "Guidance retrieval failed. Inspect context, inventory limits and policy locally with the CLI.",
        );
      }
    },
  );
  server.registerTool(
    "validation_run",
    {
      description:
        "Execute planned checks only when the operator enabled execution at server startup. Project tools can modify files and access networks.",
      inputSchema: z.strictObject({
        timeoutMs: z.number().int().min(1).max(120_000).optional(),
      }),
      outputSchema: reportOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async ({ timeoutMs }, context) => {
      if (!options.allowExecution)
        return error(
          "Execution is disabled. The operator must restart the server with --allow-execution.",
        );
      if (running)
        return error("A validation is already running for this server.");
      const controller = new AbortController();
      running = { id: context.mcpReq.id, controller };
      try {
        const report = await validate(options.root, {
          trusted: true,
          environment,
          externalAdapters,
          ...(options.base !== undefined ? { base: options.base } : {}),
          ...(options.policyOverlay !== undefined
            ? { policyOverlay: options.policyOverlay }
            : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          signal: AbortSignal.any([context.mcpReq.signal, controller.signal]),
        });
        reports.set(report.runId, report);
        while (reports.size > 10) reports.delete(reports.keys().next().value!);
        return reply(projectReport(report, options.detailed));
      } catch {
        return error(
          "Validation could not start. Inspect configuration locally with the CLI.",
        );
      } finally {
        running = undefined;
      }
    },
  );
  server.registerTool(
    "validation_report",
    {
      description:
        "Retrieve a retained report by its opaque run ID. Reports are local to this server and disappear on restart.",
      inputSchema: z.strictObject({ runId: z.string().uuid() }),
      outputSchema: reportOutput,
      annotations: readOnly,
    },
    async ({ runId }) => {
      const report = reports.get(runId);
      return report
        ? reply(projectReport(report, options.detailed))
        : error("Report is unavailable or has expired.");
    },
  );
  server.registerTool(
    "finding_comparison",
    {
      description:
        "Compare a retained validation report with an exact local baseline or exception policy. Comparison success does not change the native validation outcome or establish current-source freshness.",
      inputSchema: z.strictObject({
        runId: z.string().uuid(),
        baseline: z.string().min(1),
        previousBaseline: z.string().min(1).optional(),
      }),
      outputSchema: options.detailed
        ? findingComparisonSchema
        : findingComparisonSummarySchema,
      annotations: readOnly,
    },
    async ({ runId, baseline, previousBaseline }) => {
      const report = reports.get(runId);
      if (!report) return error("Report is unavailable or has expired.");
      try {
        const policy = JSON.parse(
          await readProjectFile(options.root, baseline),
        );
        const previous =
          previousBaseline === undefined
            ? undefined
            : JSON.parse(await readProjectFile(options.root, previousBaseline));
        return reply(
          projectFindingComparison(
            compareFindings(
              report,
              policy,
              previous === undefined ? {} : { previousBaseline: previous },
            ),
            options.detailed,
          ),
        );
      } catch {
        return error(
          "Finding comparison failed. Inspect baseline paths, limits and evidence locally with the CLI.",
        );
      }
    },
  );
  server.registerTool(
    "architecture_validation",
    {
      description:
        "Check a local captured dependency graph against exact project/layer boundaries and cycle policy. Imported graph completeness is declared, not independently attested.",
      inputSchema: z.strictObject({
        input: z.string().min(1),
        policy: z.string().min(1),
      }),
      outputSchema: options.detailed
        ? architectureReportSchema
        : architectureSummarySchema,
      annotations: readOnly,
    },
    async ({ input, policy }) => {
      try {
        const result = checkArchitecture(
          JSON.parse(await readProjectFile(options.root, input)),
          JSON.parse(await readProjectFile(options.root, policy)),
        );
        return reply(projectArchitectureReport(result, options.detailed));
      } catch {
        return error(
          "Architecture validation failed. Inspect graph/policy schema, limits and paths locally with the CLI.",
        );
      }
    },
  );
  server.registerTool(
    "runtime_comparison",
    {
      description:
        "Compare two local runtime inventory artifacts without executing project code. Reports exact registration, attribute and order changes; imported artifacts do not attest runtime freshness.",
      inputSchema: z.strictObject({
        before: z.string().min(1),
        after: z.string().min(1),
      }),
      outputSchema: options.detailed
        ? runtimeComparisonSchema
        : runtimeComparisonSummarySchema,
      annotations: readOnly,
    },
    async ({ before, after }) => {
      try {
        const result = compareRuntimeInventories(
          JSON.parse(await readProjectFile(options.root, before)),
          JSON.parse(await readProjectFile(options.root, after)),
        );
        return reply(projectRuntimeComparison(result, options.detailed));
      } catch {
        return error(
          "Runtime comparison failed. Inspect artifact schema, limits and paths locally with the CLI.",
        );
      }
    },
  );
  server.registerTool(
    "contract_validation",
    {
      description:
        "Validate local captured producer payloads against strict consumer JSON Schemas. Does not execute project code or attest live integration or freshness.",
      inputSchema: z.strictObject({
        input: z.string().min(1),
        timeoutMs: z.number().int().min(1).max(30_000).optional(),
      }),
      outputSchema: options.detailed
        ? contractReportSchema
        : contractSummarySchema,
      annotations: readOnly,
    },
    async ({ input, timeoutMs }, context) => {
      if (contractRunning)
        return error(
          "A contract validation is already running for this server.",
        );
      const controller = new AbortController();
      contractRunning = { id: context.mcpReq.id, controller };
      try {
        const result = await validateContracts(
          JSON.parse(await readProjectFile(options.root, input)),
          {
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            signal: AbortSignal.any([context.mcpReq.signal, controller.signal]),
          },
        );
        return reply(projectContractReport(result, options.detailed));
      } catch {
        return error(
          "Contract validation failed. Inspect artifact schema, limits and paths locally with the CLI.",
        );
      } finally {
        contractRunning = undefined;
      }
    },
  );
  return server;
}

export function serve(options: ServerOptions): void {
  const handle = serveStdio(() => createServer(options), {
    transport: new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 1024 * 1024,
    }),
    onerror: () => {
      process.stderr.write("MCP transport error\n");
    },
  });
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    process.stdin.removeListener("end", shutdown);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    void handle.close().catch(() => {
      process.stderr.write("MCP shutdown failed\n");
      process.exitCode = 2;
    });
  };
  const interrupt = (): void => {
    process.exitCode = 130;
    shutdown();
  };
  const terminate = (): void => {
    process.exitCode = 143;
    shutdown();
  };
  process.stdin.once("end", shutdown);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
}
