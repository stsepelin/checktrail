#!/usr/bin/env node
import path from "node:path";
import {
  createReviewContext,
  projectReviewContext,
  receiveReview,
  projectReviewReceipt,
} from "./review.js";
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
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: "string", default: "." },
      "trust-project": { type: "boolean", default: false },
      "allow-execution": { type: "boolean", default: false },
      detailed: { type: "boolean", default: false },
      input: { type: "string" },
      context: { type: "string" },
      "allow-review-source": { type: "boolean", default: false },
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
      "checktrail <inspect|plan|run|serve|adapters|import-junit|export-sarif|create-baseline|compare-findings|compare-runtime|check-contracts|check-architecture|guidance|review-context|review-receipt|mutate|fetch-pack> [--root PATH] [--detailed] [--base REVISION] [--policy-overlay PATH] [--adapter PATH#sha256=DIGEST ...]\nRun: --trust-project [--timeout-ms 30000] [--allow-env NAME ...]\nServe: --allow-execution (optional; disabled by default) [--allow-env NAME ...]\nFetch-pack: --url HTTPS_URL --sha256 DIGEST --output RELATIVE_JSON_PATH\nExit: 0 passed/read-only success/completed advisory experiment, 1 failed checks, 2 incomplete/error\n",
    );
    return;
  }
  if (positionals.length !== 1) throw new Error("Expected exactly one command");
  const command = positionals[0];
  if (
    values["allow-review-source"] &&
    (!values.detailed ||
      !["review-context", "review-receipt", "serve"].includes(command!))
  )
    throw new Error(
      "Review source disclosure requires --detailed with review-context, review-receipt or serve",
    );
  if (values.context !== undefined && command !== "review-receipt")
    throw new Error("--context applies only to review-receipt");
  if (
    command !== "fetch-pack" &&
    (values.url !== undefined ||
      values.sha256 !== undefined ||
      values.output !== undefined)
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
    !["inspect", "plan", "run", "serve", "adapters", "guidance"].includes(
      command!,
    )
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
  const root = await realpath(values.root);
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
      allowExecution: values["allow-execution"],
      allowReviewSource: values["allow-review-source"],
      detailed: values.detailed,
      environment,
      externalAdapters,
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
