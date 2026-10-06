import { installAcceptancePackage } from "./install-acceptance-package.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-go-matrix-package-"),
);
let client;
try {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const consumer = path.join(temporary, "consumer");
  await installAcceptancePackage(
    repository,
    path.join(temporary, packed.filename),
    consumer,
  );
  const goEnv = JSON.parse(
    execFileSync("go", ["env", "-json", "GOHOSTOS", "GOHOSTARCH"], {
      encoding: "utf8",
    }),
  );
  const target = { os: goEnv.GOHOSTOS, arch: goEnv.GOHOSTARCH, cgo: false };
  const foreign = { ...target, os: target.os === "linux" ? "darwin" : "linux" };
  const project = path.join(consumer, "original-go");
  await mkdir(project);
  const foreignFile = `selected_${foreign.os}.go`;
  const files = {
    "go.mod": "module example.invalid/original\n\ngo 1.23\n",
    "main.go":
      "package main\nfunc number() int {return 42}\nfunc main(){_ = number()}\n",
    "main_test.go":
      'package main\nimport "testing"\nfunc TestNumber(t *testing.T){if number()!=42{t.Fatal(number())}}\n',
    [foreignFile]: 'package main\nfunc selected() int{return "wrong"}\n',
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["go.build", "go.test"] }],
    }),
    "checktrail.go-build.json": JSON.stringify({
      schemaVersion: 2,
      profiles: [
        {
          name: "private_host",
          tags: ["private_tag"],
          checks: ["go.build", "go.test"],
          repetitions: 2,
          target,
          excludedFiles: [
            {
              path: foreignFile,
              reason: "Covered by the foreign compile profile",
            },
          ],
        },
        {
          name: "private_foreign",
          tags: [],
          checks: ["go.build"],
          repetitions: 1,
          target: foreign,
          excludedFiles: [],
        },
      ],
    }),
  };
  for (const [file, text] of Object.entries(files))
    await writeFile(path.join(project, file), text);
  const library = (trusted) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {validate,projectReport} from '@stsepelin/checktrail'; console.log(JSON.stringify(await validate('./original-go',{trusted:${trusted},timeoutMs:120000})));`,
        ],
        { cwd: consumer, encoding: "utf8" },
      ),
    );
  const broken = library(true);
  assert.equal(broken.outcome, "failed");
  assert.equal(broken.checks.length, 5);
  assert.equal(broken.checks.filter((c) => c.status === "failed").length, 1);
  const failure = broken.checks.find((c) => c.status === "failed");
  assert.equal(failure.id, "go.build");
  assert.equal(failure.goBuild.profile, "private_foreign");
  assert.ok(
    failure.findingsComplete &&
      failure.findings.some((f) => f.file === foreignFile),
  );
  await writeFile(
    path.join(project, foreignFile),
    "package main\nfunc selected() int{return 7}\n",
  );
  const fixed = library(true);
  assert.equal(fixed.outcome, "passed");
  assert.equal(fixed.sourceChanged, false);
  assert.equal(fixed.requiredExecutionIds.length, 5);
  assert.ok(
    fixed.checks.every(
      (c) => c.status === "passed" && c.executionId && c.goTarget,
    ),
  );
  assert.ok(
    fixed.checks
      .filter((c) => c.id === "go.build")
      .every((c) => !c.tests && c.processes.at(-1).command.temporaryDirectory),
  );
  const binary = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src/cli.js",
  );
  const cli = JSON.parse(
    execFileSync(
      process.execPath,
      [
        binary,
        "run",
        "--root",
        project,
        "--trust-project",
        "--timeout-ms",
        "120000",
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(cli.outcome, "passed");
  assert.deepEqual(
    cli.checks.map((c) => c.executionId),
    fixed.requiredExecutionIds,
  );
  assert.ok(
    !JSON.stringify(cli).includes("private_") &&
      !JSON.stringify(cli).includes(project),
  );
  for (const trusted of [false, true]) {
    client = new Client(
      { name: "original-go-package", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          binary,
          "serve",
          "--root",
          project,
          ...(trusted ? ["--allow-execution"] : []),
        ],
        stderr: "pipe",
      }),
    );
    const plan = await client.callTool({
      name: "validation_plan",
      arguments: {},
    });
    assert.notEqual(plan.isError, true);
    assert.deepEqual(
      plan.structuredContent.checks.map((c) => c.executionId),
      fixed.requiredExecutionIds,
    );
    const result = await client.callTool({
      name: "validation_run",
      arguments: {},
    });
    if (!trusted) assert.equal(result.isError, true);
    else {
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.outcome, "passed");
      assert.deepEqual(result.structuredContent.checks, cli.checks);
      const retained = await client.callTool({
        name: "validation_report",
        arguments: { runId: result.structuredContent.runId },
      });
      assert.deepEqual(retained.structuredContent, result.structuredContent);
    }
    await client.close();
    client = undefined;
  }
  const artifact = await readFile(path.join(temporary, packed.filename));
  const { createHash } = await import("node:crypto");
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: "original-go-matrix-package",
      installation: "offline-production-only",
      tarballSha256: createHash("sha256").update(artifact).digest("hex"),
      library: "passed",
      cli: "passed",
      mcp: "passed",
      trust: "enforced",
      summary: "profile-metadata-withheld",
      requiredExecutions: fixed.requiredExecutionIds.length,
      testsExecuted: true,
      crossTargetRuntime: "not-executed",
    }) + "\n",
  );
} finally {
  await client?.close();
  await rm(temporary, { recursive: true, force: true });
}
