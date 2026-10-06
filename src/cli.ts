#!/usr/bin/env node
import {
  ReviewBenchmark,
  freezeReviewBenchmark,
  readReviewBenchmarkOperatorInput,
  parseReviewBenchmarkReference,
} from "./review-benchmark.js";
import { reviewWorkflowAuditBindingSchema } from "./review-workflow-audit-schema.js";
import { inspectReviewWorkflowAudit } from "./review-workflow-audit.js";
import {
  loadReviewWorkflowLimits,
  serveReviewSession,
} from "./review-workflow-cli.js";
import {
  runReviewVerification,
  projectReviewVerification,
} from "./review-verification.js";
import { reviewNativeBudgetLimitsSchema } from "./review-probe-schema.js";
import {
  runReviewProbe,
  projectReviewProbe,
  loadPinnedReviewProbe,
} from "./review-probe.js";
import {
  runProviderRefutation,
  projectProviderRefutation,
} from "./review-refutation.js";
import { scoreReviewTrials, projectReviewScoring } from "./review-scoring.js";
import path from "node:path";
import {
  loadReviewProviderConfig,
  runProviderReview,
  projectProviderReview,
} from "./review-provider.js";
import {
  initialize,
  diagnose,
  mcpConfiguration,
  mcpClients,
  type McpClient,
} from "./onboarding.js";
import {
  createReviewContext,
  projectReviewContext,
  receiveReview,
  projectReviewReceipt,
} from "./review.js";
import {
  createHypothesisPlan,
  projectHypothesisPlan,
} from "./review-hypotheses.js";
import { fetchPolicyPack } from "./fetch-pack.js";
import {
  externalReferencesSchema,
  loadExternalAdapters,
} from "./external-adapter.js";
import { runMutations, projectMutations } from "./mutation.js";
import { retrieveGuidance, projectGuidance } from "./guidance.js";
import {
  createFindingBaseline,
  compareFindings,
  projectFindingComparison,
} from "./finding-policy.js";
import {
  checkArchitecture,
  projectArchitectureReport,
} from "./architecture.js";
import { inheritEnvironment } from "./environment.js";
import { parseArgs } from "node:util";
import { realpath } from "node:fs/promises";
import { adapters } from "./adapters.js";
import { createPlan, validate } from "./engine.js";
import { serve } from "./mcp.js";
import { projectPlan, projectReport } from "./output.js";
import { exportSarif } from "./sarif.js";
import { reportSchema } from "./schemas.js";
import { importJUnit } from "./junit.js";
import { readProjectFile } from "./inventory.js";
import { VERSION } from "./types.js";
import { validateContracts, projectContractReport } from "./contracts.js";
import {
  compareRuntimeInventories,
  projectRuntimeComparison,
} from "./runtime-inventory.js";

async function main(): Promise<void> {
  const { values, positionals, tokens } = parseArgs({
    tokens: true,
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: "string", default: "." },
      write: { type: "boolean", default: false },
      check: { type: "string", multiple: true },
      client: { type: "string" },
      "trust-project": { type: "boolean", default: false },
      "allow-execution": { type: "boolean", default: false },
      detailed: { type: "boolean", default: false },
      input: { type: "string" },
      context: { type: "string" },
      "allow-review-source": { type: "boolean", default: false },
      "allow-provider-source": { type: "boolean", default: false },
      "allow-inference": { type: "boolean", default: false },
      "provider-config": { type: "string" },
      probe: { type: "string", multiple: true },
      url: { type: "string" },
      sha256: { type: "string" },
      output: { type: "string" },
      topic: { type: "string", multiple: true },
      policy: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      baseline: { type: "string" },
      "previous-baseline": { type: "string" },
      owner: { type: "string" },
      reason: { type: "string" },
      base: { type: "string" },
      "policy-overlay": { type: "string" },
      adapter: { type: "string", multiple: true },
      "allow-env": { type: "string", multiple: true },
      "timeout-ms": { type: "string", default: "30000" },
      "task-store": { type: "string" },
      "workflow-limits": { type: "string" },
      "workflow-audit": { type: "string" },
      "workflow-audit-binding": { type: "string" },
      benchmark: { type: "string" },
      trial: { type: "string" },
      judge: { type: "string" },
      "workflow-audit-max-bytes": { type: "string" },
      "workflow-audit-max-events": { type: "string" },
      "native-max-calls": { type: "string" },
      "native-max-output-bytes": { type: "string" },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
  });
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(
      "checktrail <init|doctor|mcp-config|inspect|plan|run|serve|adapters|import-junit|export-sarif|create-baseline|compare-findings|compare-runtime|check-contracts|check-architecture|guidance|review-context|review-receipt|review-hypotheses|review-session|review-audit|review-benchmark-freeze|review-benchmark-status|review-benchmark-packet|review-benchmark-setup|review-benchmark-collect|review-benchmark-judge|review-benchmark-judge-setup|review-benchmark-judge-packet|review-benchmark-seal-judgments|review-run|review-refute|review-probe|review-verify|review-score|mutate|fetch-pack> [--root PATH] [--detailed] [--base REVISION] [--policy-overlay PATH] [--adapter PATH#sha256=DIGEST ...]\nInit: [--write] [--check PATH#CHECK_ID ...] (preview by default; preserves existing config)\nDoctor: [--detailed] [--policy-overlay PATH] [--allow-env NAME ...] [--adapter PATH#sha256=DIGEST ...] (no execution)\nMcp-config: --client codex|claude-code|claude-desktop|cursor|vscode (prints configuration only)\nRun: --trust-project [--timeout-ms 30000] [--allow-env NAME ...]\nServe: --allow-execution (optional; disabled by default) [--allow-env NAME ...] [--task-store PRIVATE_DIRECTORY --timeout-ms 30000]\nReview-session: foreground JSON-lines commands on stdin; [--detailed --allow-review-source] [--trust-project --probe PATH#sha256=DIGEST]\nReview-session/serve: [--workflow-limits OPERATOR_JSON] [--workflow-audit PRIVATE_FILE --workflow-audit-max-bytes 67108864 --workflow-audit-max-events 1024]\nReview-audit: --input PRIVATE_FILE (read-only metadata, no resume)\nReview-benchmark-freeze: --input PRIVATE_PLAN --output PRIVATE_NEW_DIRECTORY (synthetic readiness only)\nReview-benchmark-status/packet/setup/collect/judge: --benchmark ABSOLUTE_DIRECTORY#sha256=DIGEST; packet/setup require --trial UUID; packet requires --detailed --allow-review-source\nReview-benchmark-judge-setup/judge-packet: --benchmark REFERENCE --judge UUID; judge-packet requires --detailed --allow-review-source; seal-judgments closes all frozen judge slots\nServe: [--benchmark ABSOLUTE_DIRECTORY#sha256=DIGEST --trial UUID] exposes read-only anonymous benchmark packets; collection/sealing remain operator commands; alternatively --judge UUID exposes one prepared anonymous judge packet\nReview-session/serve: [--workflow-audit-binding PRIVATE_JSON] binds a journal to a frozen trial\nReview-probe/review-verify/review-session/serve: [--native-max-calls 16] [--native-max-output-bytes 65536] (per run; operator only)\nFetch-pack: --url HTTPS_URL --sha256 DIGEST --output RELATIVE_JSON_PATH\nExit: 0 passed/read-only success/completed advisory experiment, 1 failed checks, 2 incomplete/error\n",
    );
    return;
  }
  if (positionals.length !== 1) throw new Error("Expected exactly one command");
  const command = positionals[0];
  if (values["task-store"] && command !== "serve")
    throw new Error("--task-store applies only to serve");
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (["write", "check"].includes(token.name) && command !== "init")
      throw new Error(`--${token.name} applies only to init`);
    if (token.name === "client" && command !== "mcp-config")
      throw new Error("--client applies only to mcp-config");
    const allowed =
      command === "init"
        ? ["root", "write", "check"]
        : command === "doctor"
          ? ["root", "detailed", "policy-overlay", "allow-env", "adapter"]
          : command === "mcp-config"
            ? ["root", "client"]
            : undefined;
    if (allowed && !allowed.includes(token.name))
      throw new Error(`--${token.name} does not apply to ${command}`);
  }
  if (
    values["allow-review-source"] &&
    (!values.detailed ||
      ![
        "review-benchmark-packet",
        "review-benchmark-judge-packet",
        "review-context",
        "review-receipt",
        "review-run",
        "review-refute",
        "review-probe",
        "review-verify",
        "review-session",
        "serve",
      ].includes(command!))
  )
    throw new Error(
      "Review source disclosure requires --detailed with review-context, review-receipt or serve",
    );
  if (
    values.context !== undefined &&
    ![
      "review-receipt",
      "review-hypotheses",
      "review-run",
      "review-refute",
      "review-probe",
      "review-verify",
    ].includes(command!)
  )
    throw new Error(
      "--context applies only to review-receipt and review-hypotheses",
    );
  if (
    (values["provider-config"] !== undefined ||
      values["allow-inference"] ||
      values["allow-provider-source"]) &&
    !["review-run", "review-refute", "review-verify", "serve"].includes(
      command!,
    )
  )
    throw new Error(
      "Provider configuration and inference grants apply only to review-run or serve",
    );
  if (
    values["workflow-limits"] !== undefined &&
    !["review-session", "serve"].includes(command!)
  )
    throw new Error("Workflow limits apply only to review-session or serve");
  const auditFlags =
    values["workflow-audit-binding"] !== undefined ||
    values["workflow-audit"] !== undefined ||
    values["workflow-audit-max-bytes"] !== undefined ||
    values["workflow-audit-max-events"] !== undefined;
  if (
    auditFlags &&
    (!["serve", "review-session"].includes(command!) ||
      !values["workflow-audit"])
  )
    throw new Error(
      "Workflow audit flags require serve/review-session and an operator audit path",
    );
  const workflowAudit = values["workflow-audit"]
    ? {
        file: path.resolve(values["workflow-audit"]),
        ...(values["workflow-audit-binding"]
          ? {
              binding: reviewWorkflowAuditBindingSchema.parse(
                readReviewBenchmarkOperatorInput(
                  path.resolve(values["workflow-audit-binding"]),
                ),
              ),
            }
          : {}),
        ...(values["workflow-audit-max-bytes"] !== undefined
          ? { maxBytes: Number(values["workflow-audit-max-bytes"]) }
          : {}),
        ...(values["workflow-audit-max-events"] !== undefined
          ? { maxEvents: Number(values["workflow-audit-max-events"]) }
          : {}),
      }
    : undefined;
  const benchmarkCommands = [
    "review-benchmark-status",
    "review-benchmark-packet",
    "review-benchmark-setup",
    "review-benchmark-collect",
    "review-benchmark-judge",
    "review-benchmark-judge-setup",
    "review-benchmark-judge-packet",
    "review-benchmark-seal-judgments",
  ];
  if (values.benchmark && !["serve", ...benchmarkCommands].includes(command!))
    throw new Error(
      "Benchmark startup reference applies only to serve and benchmark commands",
    );
  if (
    values.trial &&
    !["review-benchmark-packet", "review-benchmark-setup", "serve"].includes(
      command!,
    )
  )
    throw new Error("Trial applies only to benchmark packet/setup");
  if (
    values.judge &&
    ![
      "serve",
      "review-benchmark-judge-setup",
      "review-benchmark-judge-packet",
    ].includes(command!)
  )
    throw new Error(
      "Judge applies only to benchmark judge packet/setup or serve",
    );
  if (values.judge && values.trial)
    throw new Error("A worker selects one review trial or judge slot");
  const benchmarkReference = values.benchmark
    ? parseReviewBenchmarkReference(values.benchmark)
    : undefined;
  if (
    command === "serve" &&
    Boolean(benchmarkReference) !== Boolean(values.trial || values.judge)
  )
    throw new Error(
      "Serve benchmark workers require --benchmark and one --trial or --judge UUID",
    );
  const workflowLimits =
    values["workflow-limits"] !== undefined
      ? await loadReviewWorkflowLimits(path.resolve(values["workflow-limits"]))
      : undefined;
  const nativeBudgetFlags =
    values["native-max-calls"] !== undefined ||
    values["native-max-output-bytes"] !== undefined;
  if (
    nativeBudgetFlags &&
    !["review-probe", "review-verify", "review-session", "serve"].includes(
      command!,
    )
  )
    throw new Error(
      "Native review budgets apply only to review-probe, review-verify or serve",
    );
  const nativeBudget = nativeBudgetFlags
    ? {
        maxCalls:
          values["native-max-calls"] === undefined
            ? 16
            : Number(values["native-max-calls"]),
        maxOutputBytes:
          values["native-max-output-bytes"] === undefined
            ? 65536
            : Number(values["native-max-output-bytes"]),
      }
    : undefined;
  if (nativeBudget) reviewNativeBudgetLimitsSchema.parse(nativeBudget);
  if (
    values.probe &&
    !["review-probe", "review-verify", "review-session", "serve"].includes(
      command!,
    )
  )
    throw new Error(
      "Operator probe registration applies only to review-probe or serve",
    );
  if (
    values["allow-inference"] &&
    (!values["provider-config"] || !values["allow-provider-source"])
  )
    throw new Error(
      "Inference requires --provider-config and --allow-provider-source",
    );
  if (
    command !== "fetch-pack" &&
    (values.url !== undefined ||
      values.sha256 !== undefined ||
      (values.output !== undefined && command !== "review-benchmark-freeze"))
  )
    throw new Error("Download options apply only to fetch-pack");
  const externalAdapters = externalReferencesSchema.parse(
    (values.adapter ?? []).map((value) => {
      const split = value.lastIndexOf("#sha256=");
      if (split <= 0)
        throw new Error("External adapters require PATH#sha256=DIGEST");
      return {
        path: path.resolve(value.slice(0, split)),
        sha256: value.slice(split + 8),
      };
    }),
  );
  if (
    externalAdapters.length &&
    ![
      "inspect",
      "plan",
      "run",
      "serve",
      "adapters",
      "guidance",
      "doctor",
    ].includes(command!)
  )
    throw new Error(
      "External adapters apply only to inspection, planning, validation, serving and derived guidance",
    );
  if (externalAdapters.length && command === "guidance" && values.input)
    throw new Error(
      "External adapters require derived guidance, not an imported context",
    );
  const print = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  };
  if (command === "adapters") {
    print([
      ...adapters,
      ...(await loadExternalAdapters(externalAdapters)).map((item) => ({
        ...item.identity,
        markers: item.manifest.markers,
        checks: item.manifest.checks.map(
          (check) => `${item.identity.id}.${check.id}`,
        ),
      })),
    ]);
    return;
  }
  if (command === "doctor") {
    const result = await diagnose(values.root, {
      detailed: values.detailed,
      externalAdapters,
      environment: inheritEnvironment(values["allow-env"] ?? []),
      ...(values["policy-overlay"]
        ? { policyOverlay: values["policy-overlay"] }
        : {}),
    });
    print(result);
    process.exitCode = result.status === "no-static-blockers" ? 0 : 2;
    return;
  }
  const root = await realpath(values.root);
  if (command === "init") {
    const selections = new Map<string, string[]>();
    for (const value of values.check ?? []) {
      const split = value.lastIndexOf("#");
      if (split <= 0 || split === value.length - 1)
        throw new Error("Check selection requires PATH#CHECK_ID");
      const selectedPath = value.slice(0, split);
      selections.set(selectedPath, [
        ...(selections.get(selectedPath) ?? []),
        value.slice(split + 1),
      ]);
    }
    const result = await initialize(root, {
      write: values.write,
      selections: [...selections].map(([selectedPath, checks]) => ({
        path: selectedPath,
        checks,
      })),
    });
    print(result);
    process.exitCode = result.status === "needs-selection" ? 2 : 0;
    return;
  }
  if (command === "mcp-config") {
    if (!mcpClients.includes(values.client as McpClient))
      throw new Error(`mcp-config requires --client ${mcpClients.join("|")}`);
    print(await mcpConfiguration(root, values.client as McpClient));
    return;
  }
  if (command === "fetch-pack") {
    if (!values.url || !values.sha256 || !values.output)
      throw new Error(
        "fetch-pack requires --url HTTPS_URL --sha256 DIGEST --output RELATIVE_JSON_PATH",
      );
    if (
      values["trust-project"] ||
      values["allow-execution"] ||
      values.base ||
      values["policy-overlay"] ||
      values["allow-env"]?.length
    )
      throw new Error(
        "Policy pack download does not accept execution or project policy options",
      );
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      print(
        await fetchPolicyPack(root, {
          url: values.url,
          sha256: values.sha256,
          output: values.output,
          timeoutMs: Number(values["timeout-ms"]),
          signal: controller.signal,
        }),
      );
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    return;
  }
  if (command === "review-benchmark-freeze") {
    if (!values.input || !values.output)
      throw new Error(
        "Benchmark freeze requires a private operator plan and new output directory",
      );
    print(
      freezeReviewBenchmark(
        root,
        readReviewBenchmarkOperatorInput(path.resolve(values.input)),
        path.resolve(values.output),
      ),
    );
    return;
  }
  if (benchmarkCommands.includes(command!)) {
    if (!benchmarkReference)
      throw new Error(
        "Benchmark command requires an operator-pinned reference",
      );
    const benchmark = new ReviewBenchmark(root, benchmarkReference);
    if (command === "review-benchmark-judge-setup") {
      if (!values.judge)
        throw new Error("Benchmark judge setup requires a judge ID");
      print(benchmark.judgeSetup(values.judge));
    } else if (command === "review-benchmark-judge-packet") {
      if (!values.judge)
        throw new Error("Benchmark judge packet requires a judge ID");
      print(
        benchmark.judgeWorkerCommand(
          { operation: "packet" },
          values["allow-review-source"],
          values.judge,
        ),
      );
    } else if (command === "review-benchmark-setup") {
      if (!values.trial) throw new Error("Benchmark setup requires a trial ID");
      print(benchmark.trialSetup(values.trial));
    } else if (command === "review-benchmark-packet") {
      if (!values.trial)
        throw new Error("Benchmark packet requires a trial ID");
      print(
        benchmark.command(
          { operation: "packet", trialId: values.trial },
          values["allow-review-source"],
        ),
      );
    } else {
      const result =
        command === "review-benchmark-collect"
          ? benchmark.collect()
          : command === "review-benchmark-judge"
            ? benchmark.prepareJudging()
            : command === "review-benchmark-seal-judgments"
              ? benchmark.sealJudgments()
              : benchmark.status();
      print(result);
      if (
        (result.state !== "frozen" && result.completed !== result.planned) ||
        (result.judgments &&
          result.judgments.resolved !== result.judgments.planned)
      )
        process.exitCode = 2;
    }
    return;
  }
  if (command === "review-audit") {
    if (!values.input)
      throw new Error("Review-audit requires an operator input file");
    const audit = inspectReviewWorkflowAudit(path.resolve(values.input));
    print(audit);
    if (
      audit.journalStatus !== "sealed" ||
      !audit.nativeAccountingComplete ||
      !audit.nativeReceipts.complete ||
      !audit.allCommandBodiesRetained ||
      !audit.commands.started ||
      audit.workflows.some(
        (workflow) => workflow.disposition === "not-complete",
      )
    )
      process.exitCode = 2;
    return;
  }
  if (command === "review-session") {
    if (values.input || values.context || values["allow-execution"])
      throw new Error(
        "Review-session uses JSON-lines stdin and --trust-project for optional native execution",
      );
    await serveReviewSession(root, {
      allowReviewSource: values["allow-review-source"],
      trusted: values["trust-project"],
      ...(workflowLimits ? { limits: workflowLimits } : {}),
      ...(workflowAudit ? { audit: workflowAudit } : {}),
      probes: await Promise.all(
        (values.probe ?? []).map(loadPinnedReviewProbe),
      ),
      nativeWallMs: Number(values["timeout-ms"]),
      maxNativeOutputBytes: 65536,
      ...(nativeBudget ? { nativeBudget } : {}),
    });
    return;
  }
  if (command === "review-context") {
    if (!values.input)
      throw new Error("review-context requires --input selection.json");
    print(
      projectReviewContext(
        await createReviewContext(
          root,
          JSON.parse(await readProjectFile(root, values.input)),
        ),
        values["allow-review-source"],
      ),
    );
    return;
  }
  if (command === "review-score") {
    if (!values.input)
      throw new Error("review-score requires --input scoring-input.json");
    print(
      projectReviewScoring(
        scoreReviewTrials(
          JSON.parse(await readProjectFile(root, values.input)),
        ),
        values.detailed,
      ),
    );
    return;
  }
  if (command === "review-hypotheses") {
    if (!values.context)
      throw new Error("review-hypotheses requires --context context.json");
    print(
      projectHypothesisPlan(
        createHypothesisPlan(
          JSON.parse(await readProjectFile(root, values.context)),
          values.input
            ? JSON.parse(await readProjectFile(root, values.input))
            : undefined,
        ),
        values.detailed,
      ),
    );
    return;
  }
  if (command === "review-probe") {
    if (values.detailed && !values["allow-review-source"])
      throw new Error(
        "Detailed review probes require operator source-output permission",
      );
    if (
      !values.context ||
      !values.input ||
      values.probe?.length !== 1 ||
      !values["trust-project"]
    )
      throw new Error(
        "review-probe requires --context, --input candidate, one --probe PATH#sha256=DIGEST and --trust-project",
      );
    const recipe = await loadPinnedReviewProbe(values.probe[0]!);
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const result = await runReviewProbe(
        root,
        JSON.parse(await readProjectFile(root, values.context)),
        JSON.parse(await readProjectFile(root, values.input)),
        {
          trusted: true,
          recipe,
          ...(nativeBudget ? { nativeBudget } : {}),
          timeoutMs: Number(values["timeout-ms"]),
          signal: controller.signal,
        },
      );
      print(projectReviewProbe(result, values.detailed));
      process.exitCode = result.status === "completed" ? 0 : 2;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    return;
  }
  if (command === "review-verify") {
    if (values.detailed && !values["allow-review-source"])
      throw new Error(
        "Detailed verification requires operator source-output permission",
      );
    if (
      !values.context ||
      !values.input ||
      values.probe?.length !== 1 ||
      !values["trust-project"] ||
      !values["provider-config"] ||
      !values["allow-inference"] ||
      !values["allow-provider-source"]
    )
      throw new Error(
        "review-verify requires --context, --input candidate, one pinned --probe, --trust-project, --provider-config, --allow-inference and --allow-provider-source",
      );
    const recipe = await loadPinnedReviewProbe(values.probe[0]!);
    const config = await loadReviewProviderConfig(
      path.resolve(values["provider-config"]),
    );
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const run = await runReviewVerification(
        root,
        JSON.parse(await readProjectFile(root, values.context)),
        JSON.parse(await readProjectFile(root, values.input)),
        {
          trusted: true,
          recipe,
          ...(nativeBudget ? { nativeBudget } : {}),
          wallMs: Number(values["timeout-ms"]),
          signal: controller.signal,
          provider: {
            config,
            allowInference: true,
            allowSourceDisclosure: true,
          },
        },
      );
      print(
        projectReviewVerification(
          run,
          values.detailed,
          values["allow-review-source"],
        ),
      );
      process.exitCode = run.status === "completed" ? 0 : 2;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    return;
  }
  if (command === "review-refute") {
    if (
      !values.context ||
      !values.input ||
      !values["provider-config"] ||
      !values["allow-inference"] ||
      !values["allow-provider-source"]
    )
      throw new Error(
        "review-refute requires --input candidate, --context, --provider-config, --allow-inference and --allow-provider-source",
      );
    const config = await loadReviewProviderConfig(
      path.resolve(values["provider-config"]),
    );
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const result = await runProviderRefutation(
        root,
        JSON.parse(await readProjectFile(root, values.context)),
        JSON.parse(await readProjectFile(root, values.input)),
        {
          config,
          allowInference: true,
          allowSourceDisclosure: true,
          signal: controller.signal,
        },
      );
      print(
        projectProviderRefutation(
          result,
          values.detailed,
          values["allow-review-source"],
        ),
      );
      process.exitCode = result.verifier.status === "completed" ? 0 : 2;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    return;
  }
  if (command === "review-run") {
    if (
      !values.context ||
      !values["provider-config"] ||
      !values["allow-inference"] ||
      !values["allow-provider-source"]
    )
      throw new Error(
        "review-run requires --context, --provider-config, --allow-inference and --allow-provider-source",
      );
    const config = await loadReviewProviderConfig(
      path.resolve(values["provider-config"]),
    );
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const result = await runProviderReview(
        root,
        JSON.parse(await readProjectFile(root, values.context)),
        {
          config,
          allowInference: true,
          allowSourceDisclosure: true,
          signal: controller.signal,
        },
      );
      print(
        projectProviderReview(
          result,
          values.detailed,
          values["allow-review-source"],
        ),
      );
      process.exitCode = result.status === "completed" ? 0 : 2;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    return;
  }
  if (command === "review-receipt") {
    if (!values.context || !values.input)
      throw new Error(
        "review-receipt requires --context context.json and --input assessment.json",
      );
    const result = await receiveReview(
      root,
      JSON.parse(await readProjectFile(root, values.context)),
      JSON.parse(await readProjectFile(root, values.input)),
    );
    print(projectReviewReceipt(result, values["allow-review-source"]));
    process.exitCode =
      result.freshness === "current" && result.citations.unmatched === 0
        ? 0
        : 2;
    return;
  }
  if (command === "mutate") {
    if (
      values.base !== undefined ||
      values["policy-overlay"] !== undefined ||
      values["allow-env"]?.length
    )
      throw new Error(
        "Mutation experiments do not support Git selection, private overlays or environment grants in this profile",
      );
    if (!values["trust-project"])
      throw new Error("Mutation experiments require --trust-project");
    if (!values.input)
      throw new Error("Mutation experiments require --input recipe path");
    const report = await runMutations(
      root,
      JSON.parse(await readProjectFile(root, values.input)),
      {
        trusted: true,
        timeoutMs: Number(values["timeout-ms"]),
      },
    );
    print(projectMutations(report, values.detailed));
    process.exitCode = report.complete ? 0 : 2;
    return;
  }
  if (command === "guidance") {
    if (values.input && values.topic)
      throw new Error("Use either --input context or --topic, not both");
    const context = values.input
      ? JSON.parse(await readProjectFile(root, values.input))
      : {
          schemaVersion: 1,
          checks: [
            ...new Set(
              (
                await createPlan(root, {
                  externalAdapters,
                  environment: inheritEnvironment(values["allow-env"] ?? []),
                  ...(values.base !== undefined ? { base: values.base } : {}),
                  ...(values["policy-overlay"] !== undefined
                    ? { policyOverlay: values["policy-overlay"] }
                    : {}),
                })
              ).plan.checks.map((check) => check.id),
            ),
          ],
          topics: values.topic ?? [],
        };
    print(projectGuidance(retrieveGuidance(context), values.detailed));
    return;
  }
  if (command === "check-architecture") {
    if (!values.input || !values.policy)
      throw new Error(
        "Architecture validation requires --input graph and --policy boundary artifact paths",
      );
    const result = checkArchitecture(
      JSON.parse(await readProjectFile(root, values.input)),
      JSON.parse(await readProjectFile(root, values.policy)),
    );
    print(projectArchitectureReport(result, values.detailed));
    process.exitCode =
      result.outcome === "passed" ? 0 : result.outcome === "failed" ? 1 : 2;
    return;
  }
  if (command === "check-contracts") {
    if (!values.input)
      throw new Error(
        "Contract validation requires --input relative artifact path",
      );
    const result = await validateContracts(
      JSON.parse(await readProjectFile(root, values.input)),
      { timeoutMs: Number(values["timeout-ms"]) },
    );
    print(projectContractReport(result, values.detailed));
    process.exitCode =
      result.outcome === "passed" ? 0 : result.outcome === "failed" ? 1 : 2;
    return;
  }
  if (command === "compare-runtime") {
    if (!values.before || !values.after)
      throw new Error(
        "Runtime comparison requires --before and --after relative artifact paths",
      );
    const result = compareRuntimeInventories(
      JSON.parse(await readProjectFile(root, values.before)),
      JSON.parse(await readProjectFile(root, values.after)),
    );
    print(projectRuntimeComparison(result, values.detailed));
    process.exitCode =
      result.outcome === "passed" ? 0 : result.outcome === "failed" ? 1 : 2;
    return;
  }
  if (command === "create-baseline" || command === "compare-findings") {
    if (!values.input)
      throw new Error("Finding policy requires --input relative/report.json");
    const report = JSON.parse(await readProjectFile(root, values.input));
    if (command === "create-baseline") {
      if (!values.owner || !values.reason)
        throw new Error("Baseline creation requires --owner and --reason");
      const result = createFindingBaseline(report, {
        owner: values.owner,
        reason: values.reason,
      });
      print(
        values.detailed
          ? result
          : {
              schemaVersion: result.schemaVersion,
              provenance: "baseline-draft",
              entries: result.entries.length,
              limits: result.limits,
            },
      );
    } else {
      if (!values.baseline)
        throw new Error(
          "Comparison requires --baseline relative/baseline.json",
        );
      const previous =
        values["previous-baseline"] === undefined
          ? undefined
          : JSON.parse(
              await readProjectFile(root, values["previous-baseline"]),
            );
      const result = compareFindings(
        report,
        JSON.parse(await readProjectFile(root, values.baseline)),
        previous === undefined ? {} : { previousBaseline: previous },
      );
      print(projectFindingComparison(result, values.detailed));
      process.exitCode =
        result.outcome === "passed" ? 0 : result.outcome === "failed" ? 1 : 2;
    }
    return;
  }
  if (command === "export-sarif") {
    if (!values.input)
      throw new Error("SARIF export requires --input relative/report.json");
    const report = reportSchema.parse(
      JSON.parse(await readProjectFile(root, values.input)),
    );
    print(exportSarif(report));
    process.exitCode =
      report.outcome === "passed" ? 0 : report.outcome === "failed" ? 1 : 2;
    return;
  }
  if (command === "import-junit") {
    if (!values.input)
      throw new Error("JUnit import requires --input relative/path.xml");
    const result = importJUnit(await readProjectFile(root, values.input));
    print(
      values.detailed
        ? result
        : {
            schemaVersion: result.schemaVersion,
            engineVersion: result.engineVersion,
            format: result.format,
            provenance: result.provenance,
            outcome: result.outcome,
            reason: result.reason,
            ...(result.tests ? { tests: result.tests } : {}),
          },
    );
    process.exitCode =
      result.outcome === "passed" ? 0 : result.outcome === "failed" ? 1 : 2;
    return;
  }
  const environment = inheritEnvironment(values["allow-env"] ?? []);
  if (command === "serve") {
    await serve({
      root,
      ...(values["task-store"]
        ? {
            validationTasks: {
              directory: path.resolve(values["task-store"]),
              timeoutMs: Number(values["timeout-ms"]),
            },
          }
        : {}),
      ...(benchmarkReference
        ? {
            reviewBenchmark: benchmarkReference,
            ...(values.trial
              ? { reviewBenchmarkTrialId: values.trial }
              : { reviewBenchmarkJudgeId: values.judge! }),
          }
        : {}),
      ...(workflowLimits ? { reviewWorkflowLimits: workflowLimits } : {}),
      allowExecution: values["allow-execution"],
      ...(values.probe
        ? {
            reviewProbes: await Promise.all(
              values.probe.map(loadPinnedReviewProbe),
            ),
            probeLimits: {
              wallMs: Number(values["timeout-ms"]),
              maxOutputBytes: 65536,
              ...(nativeBudget ? { nativeBudget } : {}),
            },
          }
        : {}),
      ...(workflowAudit ? { reviewWorkflowAudit: workflowAudit } : {}),
      allowReviewSource: values["allow-review-source"],
      detailed: values.detailed,
      environment,
      externalAdapters,
      ...(values["provider-config"]
        ? {
            reviewProvider: {
              config: await loadReviewProviderConfig(
                path.resolve(values["provider-config"]),
              ),
              allowInference: values["allow-inference"],
              allowSourceDisclosure: values["allow-provider-source"],
            },
          }
        : {}),
      ...(values.base !== undefined ? { base: values.base } : {}),
      ...(values["policy-overlay"] !== undefined
        ? { policyOverlay: values["policy-overlay"] }
        : {}),
    });
    return;
  }
  if (command === "inspect" || command === "plan") {
    print(
      projectPlan(
        (
          await createPlan(root, {
            environment,
            externalAdapters,
            ...(values.base !== undefined ? { base: values.base } : {}),
            ...(values["policy-overlay"] !== undefined
              ? { policyOverlay: values["policy-overlay"] }
              : {}),
          })
        ).plan,
        values.detailed,
      ),
    );
    return;
  }
  if (command === "run") {
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const report = await validate(root, {
        trusted: values["trust-project"],
        environment,
        externalAdapters,
        ...(values.base !== undefined ? { base: values.base } : {}),
        ...(values["policy-overlay"] !== undefined
          ? { policyOverlay: values["policy-overlay"] }
          : {}),
        timeoutMs: Number(values["timeout-ms"]),
        signal: controller.signal,
      });
      print(projectReport(report, values.detailed));
      process.exitCode =
        report.outcome === "passed" ? 0 : report.outcome === "failed" ? 1 : 2;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    return;
  }
  throw new Error("Unknown command");
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Unexpected error"}\n`,
  );
  process.exitCode = 2;
});
