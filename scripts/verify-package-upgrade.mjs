import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

if (process.argv.length !== 4)
  throw new Error(
    "Usage: node scripts/verify-package-upgrade.mjs BASELINE_TGZ CANDIDATE_TGZ",
  );
const baseline = await realpath(process.argv[2]);
const candidate = await realpath(process.argv[3]);
const digest = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const hashes = {
  baseline: await digest(baseline),
  candidate: await digest(candidate),
};
assert.notEqual(
  hashes.baseline,
  hashes.candidate,
  "Upgrade requires different artifacts",
);
const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-upgrade-"));
let client;
try {
  const installation = path.join(temporary, "installation");
  const project = path.join(temporary, "project");
  await mkdir(installation);
  await mkdir(project);
  await writeFile(
    path.join(installation, "package.json"),
    JSON.stringify({ private: true }),
  );
  const source = {
    "package.json": JSON.stringify({
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    }),
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["javascript.node-test"] }],
      workspace: { complete: true, dependencies: [] },
    }),
    "example.test.js":
      "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('arithmetic', () => assert.equal(2 + 3, 5));\n",
    ".mcp.json": JSON.stringify({
      mcpServers: {
        existing: { command: "synthetic-existing-server", args: [] },
      },
    }),
  };
  for (const [name, value] of Object.entries(source))
    await writeFile(path.join(project, name), value);
  const binary = path.join(
    installation,
    "node_modules/@stsepelin/checktrail/dist/src/cli.js",
  );
  const invoke = (args) =>
    execFileSync(process.execPath, [binary, ...args], {
      cwd: installation,
      encoding: "utf8",
      timeout: 30_000,
    });
  const stages = [];
  let baselineReport;
  for (const [phase, tarball] of [
    ["baseline", baseline],
    ["upgrade", candidate],
    ["rollback", baseline],
  ]) {
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
      { cwd: installation, stdio: "pipe", timeout: 60_000 },
    );
    const version = invoke(["--version"]).trim();
    const plan = JSON.parse(invoke(["plan", "--root", project, "--detailed"]));
    assert.deepEqual(
      plan.checks.map((check) => check.id),
      ["javascript.node-test"],
    );
    const report = JSON.parse(
      invoke(["run", "--root", project, "--trust-project", "--detailed"]),
    );
    assert.equal(report.outcome, "passed");
    assert.equal(report.checks[0].status, "passed");
    if (phase === "baseline") baselineReport = report;
    if (phase === "upgrade") {
      assert.notEqual(version, stages[0].version);
      assert.equal(
        JSON.parse(invoke(["init", "--root", project, "--write"])).status,
        "preserved",
      );
      assert.equal(
        JSON.parse(invoke(["doctor", "--root", project])).status,
        "no-static-blockers",
      );
      await writeFile(
        path.join(project, "prior-report.json"),
        JSON.stringify(baselineReport),
      );
      const sarif = JSON.parse(
        invoke([
          "export-sarif",
          "--root",
          project,
          "--input",
          "prior-report.json",
        ]),
      );
      assert.equal(sarif.version, "2.1.0");
      await rm(path.join(project, "prior-report.json"));
    }
    if (phase === "rollback") assert.equal(version, stages[0].version);
    client = new Client(
      { name: "synthetic-upgrade-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [binary, "serve", "--root", project],
        stderr: "pipe",
      }),
    );
    const planned = await client.callTool({
      name: "validation_plan",
      arguments: {},
    });
    assert.notEqual(planned.isError, true);
    assert.ok(JSON.stringify(planned).includes("javascript.node-test"));
    const denied = await client.callTool({
      name: "validation_run",
      arguments: {},
    });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /Execution is disabled/);
    await client.close();
    client = undefined;
    for (const [name, value] of Object.entries(source))
      assert.equal(
        await readFile(path.join(project, name), "utf8"),
        value,
        `${phase} changed ${name}`,
      );
    stages.push({
      phase,
      version,
      cli: "passed",
      mcp: "passed",
      configuration: "unchanged",
    });
  }
  process.stdout.write(
    `${JSON.stringify({ hashes, stages, installation: "offline", priorReportImport: "passed" }, null, 2)}\n`,
  );
} finally {
  await client?.close();
  await rm(temporary, { recursive: true, force: true });
}
