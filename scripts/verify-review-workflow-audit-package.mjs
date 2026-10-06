import { installAcceptancePackage } from "./install-acceptance-package.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout, clearTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-workflow-package-"),
);
const clients = [];
const children = [];
const exits = new Map();
let result;
let cleanupError;
const hash = (value) => createHash("sha256").update(value).digest("hex");
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
  const tarballSha256 = hash(await readFile(tarball));
  const consumer = path.join(temporary, "consumer");
  await installAcceptancePackage(repository, tarball, consumer);
  const installed = path.join(consumer, "node_modules/@stsepelin/checktrail");
  const {
    createReviewContext,
    ReviewWorkflowSession,
    inspectReviewWorkflowAudit,
  } = await import(pathToFileURL(path.join(installed, "dist/src/index.js")));
  const root = path.join(temporary, "original-source");
  const operator = path.join(temporary, "operator");
  await mkdir(path.join(root, ".checktrail"), { recursive: true });
  await mkdir(operator);
  await chmod(operator, 0o700);
  const auditFiles = {
    library: path.join(operator, "library.jsonl"),
    cli: path.join(operator, "cli.jsonl"),
    mcp: path.join(operator, "mcp.jsonl"),
  };
  const source =
    "export function decision(name){return name.startsWith('grant');}\n";
  await writeFile(path.join(root, "subject.mjs"), source);
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
  const target = {
    id: "OriginalPackageClaim",
    family: "identifiers-allowlists",
    severity: "concern",
    claim: "The declared input may violate the intended identifier boundary.",
    trigger: "Pass grantToken.",
    consequence: "Production caller impact remains unestablished.",
    evidenceGaps: ["Missing production policy and caller evidence."],
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
    id: "OriginalPackageWorkflow",
    family: target.family,
    file: "subject.mjs",
    exportName: "decision",
    minimumTriggerScale: 1,
    guard: null,
    cases: [
      {
        id: "Baseline",
        role: "baseline",
        args: ["grant:read"],
        expected: true,
      },
      { id: "Trigger", role: "trigger", args: ["grantToken"], expected: false },
      { id: "NearMiss", role: "near-miss", args: ["other"], expected: false },
    ],
  });
  const pinned = { contents: recipe, sha256: hash(recipe) };
  const probeFile = path.join(operator, "probe.json");
  await writeFile(probeFile, recipe);
  const response = (assignment, candidates = []) => ({
    assignmentId: assignment.assignmentId,
    assignmentDigest: assignment.assignmentDigest,
    host: {
      client: "original-package-host",
      clientVersion: "fixture-1",
      provider: "operator-any-provider",
      model: "fictional-exact-model",
      sessionId: randomUUID(),
      session: "fresh",
    },
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
          note: "Declared original scope",
        },
      ],
      candidates,
    },
  });
  const exchange = async (call) => {
    const opened = await call({
      operation: "open",
      context: ".checktrail/context.json",
    });
    const reviewer = await call({
      operation: "next",
      workflowId: opened.workflowId,
    });
    assert.equal(reviewer.stage, "reviewer");
    const reviewed = await call({
      operation: "submit",
      workflowId: opened.workflowId,
      response: response(reviewer, [target]),
    });
    const refuter = await call({
      operation: "next",
      workflowId: opened.workflowId,
      target: reviewed.candidateHandles[0],
    });
    assert.equal(refuter.stage, "refuter");
    assert.equal(refuter.packet.includes(target.id), false);
    await call({
      operation: "submit",
      workflowId: opened.workflowId,
      response: response(refuter),
    });
    const native = await call({
      operation: "probe",
      workflowId: opened.workflowId,
      probeId: "OriginalPackageWorkflow",
    });
    assert.equal(native.native.status, "completed");
    assert.equal(native.native.calls, 3);
    const adjudicator = await call({
      operation: "next",
      workflowId: opened.workflowId,
    });
    assert.equal(adjudicator.stage, "adjudicator");
    assert.equal(
      JSON.parse(adjudicator.packet).nativeObservations.cases[1].actual,
      true,
    );
    const done = await call({
      operation: "submit",
      workflowId: opened.workflowId,
      response: response(adjudicator),
    });
    assert.equal(done.disposition, "advisory-stages-completed");
    assert.equal(done.claimsVerified, false);
    assert.equal(done.hostIsolationVerified, false);
    assert.equal(done.resolution, "unresolved");
    assert.equal(done.assignments.length, 3);
    const closed = await call({
      operation: "close",
      workflowId: opened.workflowId,
    });
    assert.equal(closed.retainedBytes, 0);
    assert.equal(closed.native.rawEvidenceRetained, false);
    return {
      stages: 3,
      nativeCalls: 3,
      claimsVerified: false,
      hostIsolationVerified: false,
      rawWorkflowArtifactsDiscarded: true,
    };
  };
  const engine = new ReviewWorkflowSession(root, {
    audit: { file: auditFiles.library },
    allowReviewSource: true,
    trusted: true,
    probes: [pinned],
  });
  let library;
  try {
    library = await exchange((command) => engine.command(command));
  } finally {
    engine.dispose();
  }
  const cli = path.join(installed, "dist/src/cli.js");
  const child = spawn(process.execPath, [
    cli,
    "review-session",
    "--root",
    root,
    "--detailed",
    "--allow-review-source",
    "--workflow-audit",
    auditFiles.cli,
    "--trust-project",
    "--probe",
    probeFile + "#sha256=" + pinned.sha256,
  ]);
  children.push(child);
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  exits.set(child, exited);
  const reader = createInterface({ input: child.stdout });
  const iterator = reader[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const read = async () => {
    let timer;
    try {
      const line = await Promise.race([
        iterator.next(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Package workflow deadline")),
            15000,
          );
        }),
      ]);
      assert.equal(line.done, false);
      return JSON.parse(line.value);
    } finally {
      clearTimeout(timer);
    }
  };
  const commandLine = await exchange(async (command) => {
    child.stdin.write(JSON.stringify(command) + "\n");
    return read();
  });
  child.stdin.end();
  assert.equal((await read()).status, "closed");
  assert.equal(await exited, 0, stderr);
  reader.close();
  const client = new Client(
    { name: "original-package-workflow-client", version: "fixture-1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        cli,
        "serve",
        "--root",
        root,
        "--detailed",
        "--allow-review-source",
        "--workflow-audit",
        auditFiles.mcp,
        "--allow-execution",
        "--probe",
        probeFile + "#sha256=" + pinned.sha256,
      ],
      stderr: "pipe",
    }),
  );
  const mcp = await exchange(async (command) => {
    const output = await client.callTool({
      name: "review_workflow",
      arguments: command,
    });
    assert.equal(output.isError, undefined, JSON.stringify(output));
    return output.structuredContent;
  });
  await client.close();
  const audits = Object.fromEntries(
    Object.entries(auditFiles).map(([surface, file]) => {
      const audit = inspectReviewWorkflowAudit(file);
      assert.equal(audit.journalStatus, "sealed");
      assert.equal(audit.commands.started, 9);
      assert.equal(audit.commands.pending, 0);
      assert.equal(audit.nativeAccountingComplete, true);
      assert.equal(audit.journalVersion, 2);
      assert.deepEqual(audit.nativeReceipts, {
        retained: 1,
        complete: true,
        rawOutputIncluded: false,
      });
      const events = readFileSync(file, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const receipt = events.find((event) => event.body.nativeReceipt)?.body
        .nativeReceipt;
      assert.ok(receipt);
      assert.deepEqual(receipt.recipe, pinned);
      assert.deepEqual(receipt.candidate, target);
      assert.equal(receipt.run.trials.length, 3);
      assert.equal(receipt.run.trials[1].actual, true);
      assert.equal(receipt.run.nativeBudget.calls, 3);
      assert.equal(receipt.run.temporaryArtifacts, "removed");
      assert.equal(audit.allCommandBodiesRetained, true);
      assert.equal(audit.externallyAnchored, false);
      return [
        surface,
        {
          events: audit.events,
          commands: audit.commands.started,
          sealed: true,
          rawCommandBodiesRetained: true,
          nativeAccountingComplete: true,
          nativeReceipts: audit.nativeReceipts,
          claimsVerified: false,
          hostIsolationVerified: false,
        },
      ];
    }),
  );
  result = {
    schemaVersion: 1,
    profile: "original-synthetic-workflow-audit-production-package",
    tarballSha256,
    productionInstall: "offline-omit-dev-ignore-scripts",
    library,
    cli: commandLine,
    mcp,
    audits,
    providerConfigured: false,
    actualInference: false,
    complete: true,
  };
} finally {
  const cleanupErrors = [];
  for (const client of clients) {
    try {
      await client.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      let timer;
      const graceful = await Promise.race([
        exits.get(child).then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 5000);
        }),
      ]);
      clearTimeout(timer);
      if (!graceful) {
        child.kill("SIGKILL");
        await exits.get(child);
        cleanupErrors.push(
          new Error("Owned package child needed forced cleanup"),
        );
      }
    }
  }
  await rm(temporary, { recursive: true, force: true });
  if (cleanupErrors.length)
    cleanupError = new AggregateError(cleanupErrors, "Package cleanup failed");
}
if (cleanupError) throw cleanupError;
result.ownedArtifactsRemoved = true;
process.stdout.write(JSON.stringify(result) + "\n");
