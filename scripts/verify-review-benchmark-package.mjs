import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-benchmark-package-"),
);
const clients = [],
  children = [];
let evidence;
let failure;
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
  const tarball = path.join(temporary, packed.filename),
    consumer = path.join(temporary, "consumer");
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
    freezeReviewBenchmark,
    ReviewBenchmark,
    ReviewWorkflowSession,
  } = await import(pathToFileURL(path.join(installed, "dist/src/index.js")));
  const root = path.join(temporary, "source"),
    operator = path.join(temporary, "operator");
  await mkdir(path.join(root, ".checktrail"), { recursive: true });
  await mkdir(operator, { mode: 0o700 });
  await writeFile(
    path.join(root, "subject.mjs"),
    "export function decision(name){return name.startsWith('grant');}\n",
  );
  const context = await createReviewContext(root, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.mjs"],
    supportFiles: [],
    topics: [],
  });
  await writeFile(
    path.join(root, ".checktrail/context.json"),
    JSON.stringify(context),
  );
  const host = {
    client: "original-package-host",
    clientVersion: "fixture-1",
    provider: "operator-selected",
    model: "fictional-pinned-model",
  };
  const settings = {
    allowReviewSource: true,
    trusted: false,
    workflowLimits: {
      maxWorkflows: 1,
      maxAssignments: 6,
      wallMs: 30000,
      maxPacketBytes: 524288,
      maxResponseBytes: 131072,
      maxRetainedBytes: 4194304,
    },
    nativeWallMs: 30000,
    maxNativeOutputBytes: 65536,
    nativeBudget: { maxCalls: 16, maxOutputBytes: 65536 },
    probes: [],
  };
  const plan = {
    schemaVersion: 1,
    profile: "workflow-journal-paired-synthetic-v1",
    provenance: "operator-declared-original-synthetic",
    curatorSessionId: "OriginalPackageCurator",
    repetitions: 2,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    arms: [
      {
        id: "OriginalPackageArmA",
        instructions: "Independent declared condition A.",
        settings,
        host,
      },
      {
        id: "OriginalPackageArmB",
        instructions: "Independent declared condition B.",
        settings,
        host,
      },
    ],
    cases: [
      {
        id: "OriginalPackagePrivateCase",
        group: "OriginalPackagePrivateGroup",
        context,
        labels: {
          variant: "broken",
          expectedDefects: [
            {
              id: "OriginalPackageHiddenAnswer",
              claim: "Synthetic prefix may admit a suffixed identifier.",
            },
          ],
        },
      },
    ],
  };
  const frozen = freezeReviewBenchmark(root, plan, path.join(operator, "run")),
    benchmark = new ReviewBenchmark(root, frozen.reference);
  const reference = `${frozen.reference.directory}#sha256=${frozen.reference.sha256}`;
  const binary = path.join(installed, "dist/src/cli.js");
  const reply = (assignment) => ({
    assignmentId: assignment.assignmentId,
    assignmentDigest: assignment.assignmentDigest,
    host: { ...host, sessionId: randomUUID(), session: "fresh" },
    status: "completed",
    usage: {
      inputTokens: null,
      outputTokens: null,
      elapsedMs: null,
      costUSD: null,
    },
    output: {
      files: [
        {
          path: "subject.mjs",
          disposition: "reviewed",
          note: "Original synthetic fixture",
        },
      ],
      candidates: [],
    },
  });
  const run = async (command) => {
    const opened = await command({
      operation: "open",
      context: ".checktrail/context.json",
    });
    const assignment = await command({
      operation: "next",
      workflowId: opened.workflowId,
    });
    const result = await command({
      operation: "submit",
      workflowId: opened.workflowId,
      response: reply(assignment),
    });
    assert.equal(result.disposition, "no-candidates-declared");
  };
  const first = benchmark.trialSetup(frozen.summary.trials[0].trialId);
  const session = new ReviewWorkflowSession(root, {
    allowReviewSource: true,
    limits: settings.workflowLimits,
    audit: first.audit,
  });
  try {
    await run((command) => session.command(command));
  } finally {
    session.dispose();
  }
  const startupArgs = async (index) => {
    const startup = benchmark.trialSetup(frozen.summary.trials[index].trialId);
    const binding = path.join(operator, `binding-${index}.json`),
      limits = path.join(operator, `limits-${index}.json`);
    await writeFile(binding, JSON.stringify(startup.audit.binding), {
      mode: 0o600,
    });
    await writeFile(limits, JSON.stringify(settings.workflowLimits), {
      mode: 0o600,
    });
    return [
      "--root",
      root,
      "--detailed",
      "--allow-review-source",
      "--workflow-audit",
      startup.audit.file,
      "--workflow-audit-binding",
      binding,
      "--workflow-audit-max-bytes",
      String(startup.audit.maxBytes),
      "--workflow-audit-max-events",
      String(startup.audit.maxEvents),
      "--workflow-limits",
      limits,
    ];
  };
  const args = await startupArgs(1);
  const child = spawn(process.execPath, [binary, "review-session", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (value) => (stderr += value));
  const exited = new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  await run(async (command) => {
    child.stdin.write(JSON.stringify(command) + "\n");
    const line = await lines.next();
    assert.equal(line.done, false, stderr);
    return JSON.parse(line.value);
  });
  child.stdin.end();
  assert.equal(await exited, 0, stderr);
  const client = new Client(
    { name: "original-package-benchmark", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        binary,
        "serve",
        ...(await startupArgs(2)),
        "--benchmark",
        reference,
        "--trial",
        frozen.summary.trials[2].trialId,
      ],
      stderr: "pipe",
    }),
  );
  const status = await client.callTool({
    name: "review_benchmark",
    arguments: { operation: "status" },
  });
  assert.deepEqual(
    status.structuredContent,
    benchmark.workerCommand(
      { operation: "status" },
      false,
      frozen.summary.trials[2].trialId,
    ),
  );
  const packet = await client.callTool({
    name: "review_benchmark",
    arguments: { operation: "packet" },
  });
  assert.deepEqual(
    packet.structuredContent,
    benchmark.command(
      { operation: "packet", trialId: frozen.summary.trials[2].trialId },
      true,
    ),
  );
  for (const hidden of [
    "OriginalPackagePrivateCase",
    "OriginalPackagePrivateGroup",
    "OriginalPackageHiddenAnswer",
    operator,
    frozen.summary.trials[0].trialId,
  ])
    assert.equal(JSON.stringify(packet).includes(hidden), false);
  await run(async (command) => {
    const result = await client.callTool({
      name: "review_workflow",
      arguments: command,
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return result.structuredContent;
  });
  await client.close();
  const invoke = (command) =>
    spawnSync(
      process.execPath,
      [binary, command, "--root", root, "--benchmark", reference],
      { encoding: "utf8", timeout: 10000 },
    );
  const collected = invoke("review-benchmark-collect");
  assert.equal(collected.status, 2, collected.stderr);
  const summary = JSON.parse(collected.stdout);
  assert.equal(summary.planned, 4);
  assert.equal(summary.accounted, 4);
  assert.equal(summary.completed, 3);
  assert.deepEqual(
    summary.trials.map((t) => t.status),
    ["sealed-completed", "sealed-completed", "sealed-completed", "missing"],
  );
  const judged = invoke("review-benchmark-judge");
  assert.equal(judged.status, 2, judged.stderr);
  assert.equal(JSON.parse(judged.stdout).state, "judging-prepared");
  assert.equal(benchmark.status().qualityAssessed, false);
  for (const name of [
    "review-benchmark-plan",
    "review-benchmark-packet",
    "review-benchmark-worker-command",
    "review-benchmark-judging",
    "review-workflow-audit-binding",
  ])
    JSON.parse(
      await readFile(
        path.join(installed, `schemas/${name}.schema.json`),
        "utf8",
      ),
    );
  evidence = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    tarballSha256: createHash("sha256")
      .update(await readFile(tarball))
      .digest("hex"),
    installation: "offline-production",
    library: "passed",
    cli: "passed",
    mcp: "passed",
    planned: summary.planned,
    accounted: summary.accounted,
    completed: summary.completed,
    missing: 1,
    inferenceInvoked: false,
    hostIsolationVerified: false,
    qualityAssessed: false,
  };
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  for (const client of clients)
    try {
      await client.close();
    } catch (error) {
      errors.push(error);
    }
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      if (
        (await Promise.race([
          ended.then(() => true),
          delay(2000).then(() => false),
        ])) === false
      ) {
        child.kill("SIGKILL");
        await ended;
        errors.push(new Error("Owned package child required forced cleanup"));
      }
    }
  await rm(temporary, { recursive: true, force: true });
  if (errors.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Package cleanup failed",
    );
}
if (failure) throw failure;
process.stdout.write(JSON.stringify(evidence) + "\n");
