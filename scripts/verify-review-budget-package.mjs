import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-review-budget-package-"),
);
const clients = [];
let result;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
try {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--offline",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        temporary,
      ],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const tarball = path.join(temporary, packed.filename);
  const tarballSha256 = sha256(await readFile(tarball));
  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { cwd: consumer, stdio: "pipe" },
  );
  const installed = path.join(consumer, "node_modules/@stsepelin/checktrail");
  const {
    createReviewContext,
    runReviewVerification,
    parseReviewVerification,
    projectReviewVerification,
  } = await import(
    pathToFileURL(path.join(installed, "dist/src/index.js")).href
  );
  const root = path.join(temporary, "original-project");
  const operator = path.join(temporary, "operator");
  await mkdir(path.join(root, ".checktrail"), { recursive: true });
  await mkdir(operator);
  const source =
    "export function decision(name){return name.startsWith('public');}\n";
  await writeFile(path.join(root, "subject.mjs"), source);
  const context = await createReviewContext(root, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.mjs"],
    supportFiles: [],
    topics: [],
  });
  const target = {
    id: "original-package-budget-hypothesis",
    family: "identifiers-allowlists",
    severity: "concern",
    claim: "The identifier boundary may admit an unintended name.",
    trigger: "Pass publicToken.",
    consequence: "Caller consequences remain unknown.",
    evidenceGaps: ["Production policy and caller not established."],
    attribution: "unknown",
    fixScope: "unknown",
    citations: [
      {
        file: "subject.mjs",
        revision: "current",
        sourceDigest: context.files[0].sha256,
        startLine: 1,
        endLine: 1,
        quote: source.trim(),
      },
    ],
  };
  const recipe = JSON.stringify({
    schemaVersion: 1,
    profile: "node-export-boolean-v1",
    id: "OriginalBudgetPackage",
    family: target.family,
    file: "subject.mjs",
    exportName: "decision",
    minimumTriggerScale: 1,
    guard: null,
    cases: [
      {
        id: "baseline",
        role: "baseline",
        args: ["public:read"],
        expected: true,
      },
      {
        id: "trigger",
        role: "trigger",
        args: ["publicToken"],
        expected: false,
      },
      { id: "near", role: "near-miss", args: ["private"], expected: false },
    ],
  });
  const pin = { contents: recipe, sha256: sha256(recipe) };
  const config = {
    schemaVersion: 1,
    kind: "openai-responses",
    model: "original-budget-package-model",
    credentialEnv: "ORIGINAL_BUDGET_PACKAGE_KEY",
    pricing: null,
    limits: {
      wallMs: 10000,
      maxAttempts: 1,
      retryDelayMs: 0,
      maxRequestBytes: 1048576,
      maxResponseBytes: 1024,
      maxOutputTokens: 20,
      aggregateBudget: {
        inputTokenAllowance: 100,
        maxTotalTokens: 240,
        maxEstimatedCostMicrousd: null,
        maxCalls: 2,
        maxRequestBodyBytes: 2097152,
        maxResponseBodyBytes: 2048,
      },
    },
  };
  const envelope = {
    model: config.model,
    status: "completed",
    usage: { input_tokens: 100, output_tokens: 20 },
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              files: [
                {
                  path: "subject.mjs",
                  disposition: "reviewed",
                  note: "Original synthetic package control",
                },
              ],
              candidates: [],
            }),
          },
        ],
      },
    ],
  };
  const environment = {
    ORIGINAL_BUDGET_PACKAGE_KEY: "original-opaque-package-budget-key",
  };
  for (const funded of [false, true]) {
    const selected = globalThis.structuredClone(config);
    selected.limits.aggregateBudget.maxTotalTokens = funded ? 240 : 239;
    let calls = 0;
    const run = await runReviewVerification(root, context, target, {
      trusted: true,
      recipe: pin,
      wallMs: 10000,
      provider: {
        config: selected,
        environment,
        allowInference: true,
        allowSourceDisclosure: true,
        fetch: async () => {
          calls++;
          return globalThis.Response.json(envelope);
        },
      },
    });
    parseReviewVerification(run);
    assert.equal(calls, funded ? 2 : 1);
    assert.equal(run.status, funded ? "completed" : "incomplete");
    assert.equal(
      run.adjudication.aggregateBudget.observedTokens,
      funded ? 240 : 120,
    );
    assert.equal(
      run.adjudication.aggregateBudget.id,
      run.refutation.verifier.aggregateBudget.id,
    );
    assert.equal(
      projectReviewVerification(run, false, false).sourceIncluded,
      false,
    );
  }
  await writeFile(
    path.join(root, ".checktrail/context.json"),
    JSON.stringify(context),
  );
  await writeFile(
    path.join(root, ".checktrail/target.json"),
    JSON.stringify(target),
  );
  await writeFile(path.join(operator, "recipe.json"), recipe);
  await writeFile(path.join(operator, "provider.json"), JSON.stringify(config));
  const transport = path.join(operator, "transport.mjs");
  await writeFile(
    transport,
    `globalThis.fetch=async()=>globalThis.Response.json(${JSON.stringify(envelope)});\n`,
  );
  const binary = path.join(installed, "dist/src/cli.js");
  const startup = [
    "--provider-config",
    path.join(operator, "provider.json"),
    "--probe",
    path.join(operator, "recipe.json") + "#sha256=" + pin.sha256,
    "--allow-inference",
    "--allow-provider-source",
  ];
  const cli = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        transport,
        binary,
        "review-verify",
        "--root",
        root,
        "--context",
        ".checktrail/context.json",
        "--input",
        ".checktrail/target.json",
        "--trust-project",
        ...startup,
      ],
      { encoding: "utf8", env: { ...process.env, ...environment } },
    ),
  );
  assert.equal(cli.status, "completed");
  assert.equal(cli.budgetScope, "verification-run");
  assert.equal(cli.adjudication.aggregateBudget.observedTokens, 240);
  for (const funded of [false, true]) {
    const selected = globalThis.structuredClone(config);
    selected.limits.aggregateBudget.maxTotalTokens = funded ? 240 : 239;
    await writeFile(
      path.join(operator, "provider.json"),
      JSON.stringify(selected),
    );
    const client = new Client(
      { name: "original-budget-package-control", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          transport,
          binary,
          "serve",
          "--root",
          root,
          "--allow-execution",
          ...startup,
        ],
        env: { PATH: process.env.PATH, ...environment },
        stderr: "pipe",
      }),
    );
    const input = {
      context: ".checktrail/context.json",
      candidate: ".checktrail/target.json",
      probeId: "OriginalBudgetPackage",
    };
    const result = await client.callTool({
      name: "review_verify",
      arguments: input,
    });
    assert.equal(result.isError, undefined);
    const run = result.structuredContent;
    assert.equal(run.status, funded ? "completed" : "incomplete");
    assert.equal(
      run.adjudication.aggregateBudget.observedTokens,
      funded ? 240 : 120,
    );
    assert.ok(!JSON.stringify(run).includes(target.claim));
    assert.ok(
      !JSON.stringify(run).includes(environment.ORIGINAL_BUDGET_PACKAGE_KEY),
    );
    assert.equal(
      (
        await client.callTool({
          name: "review_verify",
          arguments: { ...input, aggregateBudget: { maxCalls: 99 } },
        })
      ).isError,
      true,
    );
    await client.close();
  }
  assert.equal(await readFile(path.join(root, "subject.mjs"), "utf8"), source);
  result = {
    profile: "original-synthetic-review-budget-production-package",
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    tarballSha256,
    offlineInstall: true,
    developmentDependenciesInstalled: false,
    library: "funded-and-exhausted",
    cli: "funded",
    mcp: "funded-and-exhausted-startup-controls",
    providerInference: false,
    fieldEvaluation: false,
    complete: true,
  };
} finally {
  const closed = await Promise.allSettled(
    clients.map((client) => client.close()),
  );
  await rm(temporary, { recursive: true, force: true });
  assert.ok(
    closed.every((item) => item.status === "fulfilled"),
    "Package client cleanup failed",
  );
}

process.stdout.write(JSON.stringify(result) + "\n");
