import { supportedClangVersion } from "../dist/src/clang-protocol.js";
import { architectureFixture } from "../dist/test/architecture-helpers.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
import { contractFixture } from "../dist/test/contract-helpers.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "repo-verifier-package-"));
let client;
try {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const initialTarball = await readFile(path.join(temporary, packed.filename));
  const [repacked] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  assert.deepEqual(repacked.files, packed.files);
  assert.equal(
    createHash("sha256")
      .update(await readFile(path.join(temporary, repacked.filename)))
      .digest("hex"),
    createHash("sha256").update(initialTarball).digest("hex"),
    "Repeated packing of the same checkout must produce identical bytes",
  );
  for (const file of packed.files)
    assert.match(
      file.path,
      /^(?:dist\/src\/|schemas\/|packs\/|docs\/|package\.json$|server\.json$|README\.md$|LICENSE$|SECURITY\.md$|CONTRIBUTING\.md$)/,
    );
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
      path.join(temporary, packed.filename),
    ],
    { cwd: consumer, stdio: "pipe" },
  );
  await copyInstalledPackages(consumer, [
    "typescript",
    "eslint",
    "vitest",
    "vite",
    "jest",
    "vue-tsc",
    "vue",
    "@playwright/test",
  ]);
  const installedMetadata = JSON.parse(
    await readFile(
      path.join(consumer, "node_modules/@stsepelin/repo-verifier/server.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    installedMetadata,
    JSON.parse(await readFile(path.join(repository, "server.json"), "utf8")),
  );
  const contract = contractFixture();
  await writeFile(
    path.join(consumer, "contract.json"),
    JSON.stringify(contract),
  );
  const contractLibrary = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {validateContracts} from "@stsepelin/repo-verifier";import {readFileSync} from "node:fs";console.log(JSON.stringify(await validateContracts(JSON.parse(readFileSync("contract.json","utf8")))));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(contractLibrary.outcome, "passed");
  assert.equal(contractLibrary.counts.accepted, 1);
  const checks = [
    "node-test",
    "typescript",
    "typescript-build",
    "eslint",
    "vitest",
    "jest",
    "vue-tsc",
    "playwright",
  ];
  const publicPack = await readFile(
    path.join(
      consumer,
      "node_modules/@stsepelin/repo-verifier/packs/javascript-node.json",
    ),
    "utf8",
  );
  const files = {
    "policy/node.json": publicPack,
    "repo-verifier.json": JSON.stringify({
      schemaVersion: 1,
      projects: checks.map((name) => ({
        path: name,
        checks: name === "node-test" ? [] : [`javascript.${name}`],
        ...(name === "node-test"
          ? {
              packs: [
                {
                  path: "policy/node.json",
                  sha256: createHash("sha256").update(publicPack).digest("hex"),
                },
              ],
            }
          : {}),
      })),
    }),
    "node-test/sum.test.js":
      "import {test} from 'node:test';import assert from 'node:assert/strict';test('adds',()=>assert.equal(2+3,5));",
    "node-test/eslint.config.mjs":
      "export default [{rules:{'no-debugger':'error'}}];",
    "typescript/tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, types: [] },
      include: ["value.ts"],
    }),
    "typescript/value.ts": "export const value: number = 42;",
    "typescript-build/tsconfig.json": JSON.stringify({
      files: [],
      references: [{ path: "./library" }],
    }),
    "typescript-build/library/tsconfig.json": JSON.stringify({
      compilerOptions: {
        composite: true,
        strict: true,
        noEmit: true,
        noCheck: true,
        types: [],
        outDir: "build",
      },
      files: ["value.ts"],
    }),
    "typescript-build/library/value.ts": "export const value: number = 42;",
    "eslint/eslint.config.mjs":
      "export default [{files:['**/*.js','**/*.mjs'],rules:{'no-undef':'error'}}];",
    "eslint/value.js": "export const value = 42;",
    "vitest/sum.test.js":
      "import {test,expect} from 'vitest';test('adds',()=>expect(2+3).toBe(5));",
    "playwright/sum.spec.js":
      "import {test,expect} from '@playwright/test';test('adds',()=>expect(2+3).toBe(5));",
    "jest/sum.test.cjs": "test('adds',()=>expect(2+3).toBe(5));",
    "jest/jest.config.cjs": "module.exports={};",
    "vue-tsc/tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        types: [],
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      include: ["App.vue"],
    }),
    "vue-tsc/App.vue":
      '<script setup lang="ts">const value: number = 42;</script><template>{{ value.toFixed(2) }}</template>',
  };
  for (const name of checks)
    files[`${name}/package.json`] = JSON.stringify({ type: "module" });
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(consumer, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const library = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {validate} from "@stsepelin/repo-verifier";const report=await validate(process.cwd(),{trusted:true});console.log(JSON.stringify(report));',
      ],
      { cwd: consumer, encoding: "utf8", timeout: 60_000 },
    ),
  );
  assert.equal(library.outcome, "passed", JSON.stringify(library.checks));
  assert.equal(library.checks.length, checks.length + 1);
  assert.ok(
    library.checks.every((check) =>
      check.tools.every((tool) => tool.status === "identified"),
    ),
  );
  const binary = path.join(consumer, "node_modules/.bin/repo-verifier");
  const architectureInput = architectureFixture();
  await writeFile(
    path.join(consumer, "graph.json"),
    JSON.stringify(architectureInput.graph),
  );
  await writeFile(
    path.join(consumer, "architecture.json"),
    JSON.stringify(architectureInput.policy),
  );
  const architectureLibrary = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {checkArchitecture} from "@stsepelin/repo-verifier";import {readFileSync} from "node:fs";const read=p=>JSON.parse(readFileSync(p,"utf8"));console.log(JSON.stringify(checkArchitecture(read("graph.json"),read("architecture.json"))));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(architectureLibrary.outcome, "passed");
  const architectureCli = JSON.parse(
    execFileSync(
      binary,
      [
        "check-architecture",
        "--root",
        consumer,
        "--input",
        "graph.json",
        "--policy",
        "architecture.json",
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(architectureCli.outcome, "passed");
  assert.equal(architectureCli.projects, undefined);

  const contractCli = JSON.parse(
    execFileSync(
      binary,
      ["check-contracts", "--root", consumer, "--input", "contract.json"],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(contractCli.outcome, "passed");
  assert.equal(contractCli.contracts, undefined);
  await writeFile(
    path.join(consumer, "junit.xml"),
    '<testsuite tests="1"><testcase name="synthetic" file="private-path.php"/></testsuite>',
  );
  const imported = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {importJUnit} from "@stsepelin/repo-verifier";import {readFileSync} from "node:fs";console.log(JSON.stringify(importJUnit(readFileSync("junit.xml","utf8"))));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(imported.outcome, "passed");
  assert.equal(imported.provenance, "imported-report");
  const importedCli = JSON.parse(
    execFileSync(
      binary,
      ["import-junit", "--root", consumer, "--input", "junit.xml"],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(importedCli.outcome, "passed");
  assert.ok(!JSON.stringify(importedCli).includes("private-path.php"));
  await writeFile(
    path.join(consumer, "validation.json"),
    JSON.stringify(library),
  );
  const sarifCli = JSON.parse(
    execFileSync(
      binary,
      ["export-sarif", "--root", consumer, "--input", "validation.json"],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(sarifCli.version, "2.1.0");
  assert.equal(sarifCli.runs.length, checks.length + 1);
  assert.ok(
    sarifCli.runs.every((run) => run.invocations[0].executionSuccessful),
  );
  const sarifLibrary = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {exportSarif} from "@stsepelin/repo-verifier";import {readFileSync} from "node:fs";console.log(JSON.stringify(exportSarif(JSON.parse(readFileSync("validation.json","utf8")))));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.deepEqual(sarifLibrary, sarifCli);
  const baseline = JSON.parse(
    execFileSync(
      binary,
      [
        "create-baseline",
        "--root",
        consumer,
        "--input",
        "validation.json",
        "--owner",
        "synthetic-maintainer",
        "--reason",
        "Synthetic package check",
        "--detailed",
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  await writeFile(
    path.join(consumer, "baseline.json"),
    JSON.stringify(baseline),
  );
  const comparison = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {compareFindings} from "@stsepelin/repo-verifier";import {readFileSync} from "node:fs";const read=p=>JSON.parse(readFileSync(p,"utf8"));console.log(JSON.stringify(compareFindings(read("validation.json"),read("baseline.json"))));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(comparison.outcome, "passed");
  assert.equal(comparison.counts.current, 0);
  const cli = JSON.parse(
    execFileSync(binary, ["run", "--root", consumer, "--trust-project"], {
      cwd: consumer,
      encoding: "utf8",
      timeout: 60_000,
    }),
  );
  assert.equal(cli.outcome, "passed");
  const registryClient = new Client(
    { name: "synthetic-registry-install", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    const launch = installedMetadata.packages[0].packageArguments.flatMap(
      (argument) =>
        argument.type === "named"
          ? [
              `${argument.name}=${argument.value.replace("{project_root}", consumer)}`,
            ]
          : [argument.value],
    );
    await registryClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          path.join(
            consumer,
            "node_modules/@stsepelin/repo-verifier/dist/src/cli.js",
          ),
          ...launch,
        ],
        stderr: "pipe",
      }),
    );
    const planned = await registryClient.callTool({
      name: "validation_plan",
      arguments: {},
    });
    assert.equal(planned.isError, undefined);
    assert.ok(!JSON.stringify(planned).includes(consumer));
    const denied = await registryClient.callTool({
      name: "validation_run",
      arguments: {},
    });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /Execution is disabled/);
  } finally {
    await registryClient.close();
  }
  client = new Client(
    { name: "synthetic-package-client", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StdioClientTransport({
      command: binary,
      args: ["serve", "--root", consumer, "--allow-execution"],
      stderr: "pipe",
    }),
  );
  const result = await client.callTool({
    name: "validation_run",
    arguments: { timeoutMs: 30_000 },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.outcome, "passed");
  assert.ok(!JSON.stringify(result).includes(consumer));
  assert.deepEqual(cli.checks, result.structuredContent.checks);
  const compared = await client.callTool({
    name: "finding_comparison",
    arguments: {
      runId: result.structuredContent.runId,
      baseline: "baseline.json",
    },
  });
  assert.equal(compared.isError, undefined);
  assert.equal(compared.structuredContent.outcome, "passed");
  assert.equal(compared.structuredContent.entries, undefined);
  const contractMcp = await client.callTool({
    name: "contract_validation",
    arguments: { input: "contract.json" },
  });
  assert.equal(contractMcp.isError, undefined);
  assert.equal(contractMcp.structuredContent.outcome, "passed");
  assert.deepEqual(contractMcp.structuredContent.counts, contractCli.counts);
  const architectureMcp = await client.callTool({
    name: "architecture_validation",
    arguments: { input: "graph.json", policy: "architecture.json" },
  });
  assert.equal(architectureMcp.isError, undefined);
  assert.deepEqual(
    architectureMcp.structuredContent.counts,
    architectureCli.counts,
  );
  assert.equal(architectureMcp.structuredContent.projects, undefined);
  const guidanceLibrary = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {retrieveGuidance} from "@stsepelin/repo-verifier";console.log(JSON.stringify(retrieveGuidance({schemaVersion:1,checks:["javascript.node-test"],topics:[]})));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(guidanceLibrary.channel, "advisory");
  assert.equal(guidanceLibrary.items[0].id, "review.test-lifecycle");
  const guidanceCli = JSON.parse(
    execFileSync(binary, ["guidance", "--root", consumer], {
      cwd: consumer,
      encoding: "utf8",
    }),
  );
  const guidanceMcp = await client.callTool({
    name: "review_guidance",
    arguments: {},
  });
  assert.equal(guidanceMcp.isError, undefined);
  assert.deepEqual(guidanceMcp.structuredContent, guidanceCli);
  assert.equal(guidanceCli.automatedCoverage, false);
  assert.equal(guidanceCli.context, undefined);
  await client.close();
  const mutationRoot = path.join(consumer, "mutation");
  await mkdir(mutationRoot);
  for (const file of [
    "package.json",
    "quantity.js",
    "quantity.test.js",
    "mutations.json",
  ])
    await writeFile(
      path.join(mutationRoot, file),
      await readFile(path.join(repository, "examples/mutations", file)),
    );
  const mutationLibrary = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {runMutations} from "@stsepelin/repo-verifier";import {readFileSync} from "node:fs";console.log(JSON.stringify(await runMutations("mutation",JSON.parse(readFileSync("mutation/mutations.json","utf8")),{trusted:true})));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(mutationLibrary.complete, true);
  assert.deepEqual(
    mutationLibrary.trials.map((trial) => trial.status),
    ["killed", "survived"],
  );
  const mutationCli = JSON.parse(
    execFileSync(
      binary,
      [
        "mutate",
        "--root",
        mutationRoot,
        "--input",
        "mutations.json",
        "--trust-project",
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(mutationCli.complete, true);
  assert.equal(mutationCli.trials, undefined);
  client = new Client(
    { name: "synthetic-mutation-client", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StdioClientTransport({
      command: binary,
      args: ["serve", "--root", mutationRoot, "--allow-execution"],
      stderr: "pipe",
    }),
  );
  const mutationMcp = await client.callTool({
    name: "mutation_experiment",
    arguments: { input: "mutations.json" },
  });
  assert.equal(mutationMcp.isError, undefined);
  assert.equal(mutationMcp.structuredContent.complete, true);
  assert.deepEqual(mutationMcp.structuredContent.counts, mutationCli.counts);
  const clangVersion = spawnSync(
    "clang",
    ["--no-default-config", "--version"],
    { encoding: "utf8", timeout: 10000 },
  );
  let clangSmoke = "unavailable: verified compiler not present";
  if (
    clangVersion.status === 0 &&
    !clangVersion.stderr.trim() &&
    supportedClangVersion(clangVersion.stdout)
  ) {
    const clangRoot = path.join(consumer, "cpp");
    await cp(path.join(repository, "examples/cpp"), clangRoot, {
      recursive: true,
    });
    const clangLibrary = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import {validate} from "@stsepelin/repo-verifier";console.log(JSON.stringify(await validate("cpp",{trusted:true})));',
        ],
        { cwd: consumer, encoding: "utf8" },
      ),
    );
    assert.equal(
      clangLibrary.outcome,
      "passed",
      JSON.stringify(clangLibrary.checks),
    );
    assert.equal(clangLibrary.checks[0].id, "cpp.clang-check");
    const clangCli = JSON.parse(
      execFileSync(binary, ["run", "--root", clangRoot, "--trust-project"], {
        cwd: consumer,
        encoding: "utf8",
      }),
    );
    assert.equal(clangCli.outcome, "passed");
    await client.close();
    client = new Client(
      { name: "synthetic-clang-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StdioClientTransport({
        command: binary,
        args: ["serve", "--root", clangRoot, "--allow-execution"],
        stderr: "pipe",
      }),
    );
    const clangMcp = await client.callTool({
      name: "validation_run",
      arguments: {},
    });
    assert.equal(clangMcp.isError, undefined);
    assert.equal(clangMcp.structuredContent.outcome, "passed");
    assert.deepEqual(clangMcp.structuredContent.checks, clangCli.checks);
    assert.ok(!JSON.stringify(clangMcp).includes(clangRoot));
    clangSmoke = "passed";
  }
  process.stdout.write(
    `${JSON.stringify({ package: packed.filename, files: packed.files.length, checks, library: "passed", cli: "passed", mcp: "passed", installation: "offline", reproduciblePacking: "same-checkout", junit: "passed", sarif: "passed", architecture: "passed", guidance: "passed", mutations: "passed", clang: clangSmoke })}\n`,
  );
} finally {
  await client?.close();
  await rm(temporary, { recursive: true, force: true });
}
