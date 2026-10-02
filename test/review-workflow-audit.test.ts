import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  chmod,
  stat,
  symlink,
  link,
  mkdir,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { ReviewWorkflowSession } from "../src/review-workflow-session.js";
import { inspectReviewWorkflowAudit } from "../src/review-workflow-audit.js";
import {
  reviewWorkflowAssignmentSchema,
  reviewWorkflowSummarySchema,
} from "../src/review-workflow-schema.js";
import { setup, pin, recipe, response } from "./review-workflow-fixture.js";
const assigned = (value: unknown) =>
  reviewWorkflowAssignmentSchema.parse(value);
const summary = (value: unknown) => reviewWorkflowSummarySchema.parse(value);
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
async function auditFile(t: Parameters<typeof setup>[0]) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "checktrail-original-audit-"),
  );
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, "epoch.jsonl") };
}
async function open(session: ReviewWorkflowSession) {
  return summary(
    await session.command({
      operation: "open",
      context: ".checktrail/context.json",
    }),
  );
}
async function prepare(
  session: ReviewWorkflowSession,
  target: Parameters<typeof response>[1],
) {
  const opened = await open(session);
  const reviewer = assigned(
    await session.command({ operation: "next", workflowId: opened.workflowId }),
  );
  const reviewed = summary(
    await session.command({
      operation: "submit",
      workflowId: opened.workflowId,
      response: response(reviewer, target),
    }),
  );
  const refuter = assigned(
    await session.command({
      operation: "next",
      workflowId: opened.workflowId,
      target: reviewed.candidateHandles[0],
    }),
  );
  await session.command({
    operation: "submit",
    workflowId: opened.workflowId,
    response: response(refuter),
  });
  return { id: opened.workflowId, reviewer, refuter };
}
test("workflow audit retains issued packets invalid responses live native stages and terminal metadata without passing history to workers", async (t) => {
  const { file } = await auditFile(t);
  const code = `export function decision(name){const events=process.getBuiltinModule('node:fs').readFileSync(${JSON.stringify(file)},'utf8').trimEnd().split('\\n').map(line=>JSON.parse(line));const last=events.at(-1);if(last.body.kind!=='begin' || last.body.operation!=='probe')throw new Error('Original intent must precede native execution');return name.startsWith('grant');}\n`;
  const { root, target } = await setup(t, code);
  const session = new ReviewWorkflowSession(root, {
    allowReviewSource: true,
    trusted: true,
    probes: [pin()],
    audit: { file },
  });
  try {
    const opened = await open(session),
      id = opened.workflowId;
    const first = assigned(
      await session.command({ operation: "next", workflowId: id }),
    );
    const invalid = {
      ...response(first, [target]),
      assignmentDigest: "0".repeat(64),
      privatePreviousOutput: "OriginalPreviousOutputCanary",
    };
    const rejected = summary(
      await session.command({
        operation: "submit",
        workflowId: id,
        response: invalid,
      }),
    );
    assert.equal(rejected.assignments[0]!.status, "malformed");
    const reviewer = assigned(
      await session.command({ operation: "next", workflowId: id }),
    );
    assert.equal(
      JSON.stringify(reviewer).includes("OriginalPreviousOutputCanary"),
      false,
    );
    const reviewed = summary(
      await session.command({
        operation: "submit",
        workflowId: id,
        response: response(reviewer, [target]),
      }),
    );
    const refuter = assigned(
      await session.command({
        operation: "next",
        workflowId: id,
        target: reviewed.candidateHandles[0],
      }),
    );
    assert.equal(refuter.packet.includes(target.id), false);
    await session.command({
      operation: "submit",
      workflowId: id,
      response: response(refuter),
    });
    const native = summary(
      await session.command({
        operation: "probe",
        workflowId: id,
        probeId: recipe.id,
      }),
    );
    assert.equal(native.native.calls, 3);
    assert.equal(native.native.status, "completed");
    assert.equal(native.nextStage, "adjudicator");
    const adjudicator = assigned(
      await session.command({ operation: "next", workflowId: id }),
    );
    assert.equal(
      JSON.parse(adjudicator.packet).nativeObservations.cases[1].actual,
      true,
    );
    assert.equal(
      adjudicator.packet.includes("OriginalPreviousOutputCanary"),
      false,
    );
    const done = summary(
      await session.command({
        operation: "submit",
        workflowId: id,
        response: response(adjudicator),
      }),
    );
    assert.equal(done.disposition, "advisory-stages-completed");
  } finally {
    session.dispose();
  }
  const checked = inspectReviewWorkflowAudit(file);
  assert.equal(checked.journalStatus, "sealed");
  assert.equal(checked.commands.started, 10);
  assert.equal(checked.commands.finished, 10);
  assert.equal(checked.commands.pending, 0);
  assert.equal(checked.nativeAccountingComplete, true);
  assert.equal(checked.claimsVerified, false);
  assert.equal(checked.hostIsolationVerified, false);
  assert.equal(checked.externallyAnchored, false);
  assert.equal(checked.workflows[0]!.native.calls, 3);
  assert.equal(checked.workflows[0]!.retainedBytes, 0);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const contents = await readFile(file, "utf8");
  assert.equal(contents.includes("OriginalPreviousOutputCanary"), true);
  assert.equal(
    JSON.stringify(checked).includes("OriginalPreviousOutputCanary"),
    false,
  );
  assert.equal(JSON.stringify(checked).includes("subject.mjs"), false);
  const events = contents
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const erasedNative = structuredClone(events);
  erasedNative.at(-1)!.body.states[0].native.calls = 0;
  erasedNative.at(-1)!.body.states[0].native.outputBytes = 0;
  let previous: string | null = null;
  for (const [i, event] of erasedNative.entries()) {
    event.sequence = i;
    event.previous = previous;
    const { digest: old, ...base } = event;
    assert.ok(old);
    event.digest = digest(JSON.stringify(base));
    previous = event.digest;
  }
  const erasedFile = path.join(path.dirname(file), "erased-native.jsonl");
  await writeFile(
    erasedFile,
    erasedNative.map((event) => JSON.stringify(event)).join("\n") + "\n",
    { mode: 0o600 },
  );
  assert.throws(() => inspectReviewWorkflowAudit(erasedFile));
  assert.equal(events.filter((e) => e.body.kind === "begin").length, 10);
  assert.equal(
    events.filter((e) => e.body.result?.format === "review-workflow-assignment")
      .length,
    4,
  );
  assert.throws(
    () =>
      new ReviewWorkflowSession(root, {
        allowReviewSource: true,
        audit: { file },
      }),
  );
});
test("workflow audit rejects public linked existing inside-project and undisclosed storage before changing artifacts", async (t) => {
  const { root } = await setup(t),
    { directory, file } = await auditFile(t);
  assert.throws(
    () =>
      new ReviewWorkflowSession(root, {
        allowReviewSource: false,
        audit: { file },
      }),
  );
  await assert.rejects(stat(file));
  for (const limits of [
    { maxBytes: 0 },
    { maxEvents: 0 },
    { maxBytes: 134217729 },
    { maxEvents: 4097 },
  ]) {
    assert.throws(
      () =>
        new ReviewWorkflowSession(root, {
          allowReviewSource: true,
          audit: { file, ...limits },
        }),
    );
    await assert.rejects(stat(file));
  }
  await chmod(directory, 0o755);
  assert.throws(
    () =>
      new ReviewWorkflowSession(root, {
        allowReviewSource: true,
        audit: { file },
      }),
  );
  await assert.rejects(stat(file));
  await chmod(directory, 0o700);
  const internal = path.join(root, "private-audit");
  await mkdir(internal, { mode: 0o700 });
  assert.throws(
    () =>
      new ReviewWorkflowSession(root, {
        allowReviewSource: true,
        audit: { file: path.join(internal, "epoch.jsonl") },
      }),
  );
  await writeFile(file, "", { mode: 0o600 });
  assert.throws(
    () =>
      new ReviewWorkflowSession(root, {
        allowReviewSource: true,
        audit: { file },
      }),
  );
  assert.equal(await readFile(file, "utf8"), "");
  await writeFile(file, "OriginalExistingArtifact", { mode: 0o600 });
  assert.throws(
    () =>
      new ReviewWorkflowSession(root, {
        allowReviewSource: true,
        audit: { file },
      }),
  );
  assert.equal(await readFile(file, "utf8"), "OriginalExistingArtifact");
  const symbolic = path.join(directory, "symbolic"),
    hard = path.join(directory, "hard");
  await symlink(file, symbolic);
  assert.throws(() => inspectReviewWorkflowAudit(symbolic));
  await link(file, hard);
  assert.throws(() => inspectReviewWorkflowAudit(file));
  await rm(hard);
  await chmod(file, 0o644);
  assert.throws(() => inspectReviewWorkflowAudit(file));
});
test("workflow audit reserves event and byte completion before native execution and simultaneous admissions", async (t) => {
  const { root, target } = await setup(t),
    { directory } = await auditFile(t);
  const before = path.join(directory, "before-native.jsonl");
  const session = new ReviewWorkflowSession(root, {
    allowReviewSource: true,
    trusted: true,
    probes: [pin()],
    audit: { file: before, maxEvents: 12 },
  });
  const prepared = await prepare(session, [target]);
  await assert.rejects(
    session.command({
      operation: "probe",
      workflowId: prepared.id,
      probeId: recipe.id,
    }),
  );
  session.dispose();
  const stopped = inspectReviewWorkflowAudit(before);
  assert.equal(stopped.events, 12);
  assert.equal(stopped.workflows[0]!.native.calls, 0);
  assert.equal(stopped.workflows[0]!.native.status, "not-started");
  assert.equal(stopped.workflows[0]!.disposition, "not-complete");
  for (const limits of [{ maxEvents: 4 }, { maxBytes: 3145728 }]) {
    const file = path.join(directory, randomUUID() + ".jsonl"),
      options = { file, ...limits };
    const concurrent = new ReviewWorkflowSession(root, {
      allowReviewSource: true,
      audit: options,
    });
    const results = await Promise.allSettled([
      open(concurrent),
      open(concurrent),
    ]);
    assert.equal(
      results.every((r) => r.status === "rejected"),
      true,
    );
    concurrent.dispose();
    const report = inspectReviewWorkflowAudit(file);
    assert.equal(report.commands.started, 1);
    assert.equal(report.commands.finished, 1);
    assert.equal(report.commands.pending, 0);
    assert.equal(report.journalStatus, "sealed");
    assert.ok(report.bytes < (limits.maxBytes ?? 67108864));
  }
  const immutable = path.join(directory, "immutable.jsonl"),
    options = { file: immutable, maxEvents: 4 };
  const fixed = new ReviewWorkflowSession(root, {
    allowReviewSource: true,
    audit: options,
  });
  options.maxEvents = 4096;
  const opened = await open(fixed);
  await assert.rejects(
    fixed.command({ operation: "next", workflowId: opened.workflowId }),
  );
  fixed.dispose();
  assert.equal(
    inspectReviewWorkflowAudit(immutable).workflows[0]!.assignments.length,
    0,
  );
});
test("workflow audit durability loss prevents new assignment disclosure and retains interrupted history", async (t) => {
  const { root } = await setup(t),
    { file } = await auditFile(t);
  const session = new ReviewWorkflowSession(root, {
    allowReviewSource: true,
    audit: { file },
  });
  const opened = await open(session);
  await chmod(file, 0o400);
  await assert.rejects(
    session.command({ operation: "next", workflowId: opened.workflowId }),
  );
  await chmod(file, 0o600);
  await assert.rejects(
    session.command({ operation: "next", workflowId: opened.workflowId }),
  );
  session.dispose();
  const inspected = inspectReviewWorkflowAudit(file);
  assert.equal(inspected.journalStatus, "interrupted");
  assert.equal(inspected.commands.started, 1);
  assert.equal(inspected.workflows[0]!.assignments.length, 0);
});
test("workflow audit rejects changed reordered replayed and forged records and treats a torn tail as incomplete", async (t) => {
  const { root } = await setup(t),
    { directory, file } = await auditFile(t);
  const session = new ReviewWorkflowSession(root, {
    allowReviewSource: true,
    audit: { file },
  });
  await open(session);
  session.dispose();
  const text = await readFile(file, "utf8"),
    lines = text.trimEnd().split("\n");
  const alteredTime = JSON.parse(lines[2]!);
  alteredTime.createdAt = "2026-01-01T00:00:00.000Z";
  await writeFile(
    path.join(directory, "bad-time.jsonl"),
    [lines[0]!, lines[1]!, JSON.stringify(alteredTime), lines[3]!].join("\n") +
      "\n",
    { mode: 0o600 },
  );
  assert.throws(() =>
    inspectReviewWorkflowAudit(path.join(directory, "bad-time.jsonl")),
  );
  const changed = JSON.parse(lines[2]!);
  changed.body.states[0].claimsVerified = true;
  for (const records of [
    [lines[0]!, lines[2]!, lines[1]!, lines[3]!],
    [...lines.slice(0, 2), lines[1]!, ...lines.slice(2)],
    [lines[0]!, lines[1]!, JSON.stringify(changed), lines[3]!],
  ]) {
    await writeFile(
      path.join(directory, "bad.jsonl"),
      records.join("\n") + "\n",
      { mode: 0o600 },
    );
    assert.throws(() =>
      inspectReviewWorkflowAudit(path.join(directory, "bad.jsonl")),
    );
  }
  // Recomputed hashes still cannot turn an unmatched finish into a valid command.
  const events = [
    JSON.parse(lines[0]!),
    JSON.parse(lines[2]!),
    JSON.parse(lines[3]!),
  ];
  let prior: string | null = null;
  for (const [i, event] of events.entries()) {
    event.sequence = i;
    event.previous = prior;
    const { digest: old, ...base } = event;
    assert.ok(old);
    event.digest = digest(JSON.stringify(base));
    prior = event.digest;
  }
  await writeFile(
    path.join(directory, "bad.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    { mode: 0o600 },
  );
  assert.throws(() =>
    inspectReviewWorkflowAudit(path.join(directory, "bad.jsonl")),
  );
  const torn = path.join(directory, "torn.jsonl");
  await writeFile(
    torn,
    lines.slice(0, 3).join("\n") + "\n" + '{"schemaVersion":',
    { mode: 0o600 },
  );
  const prefix = inspectReviewWorkflowAudit(torn);
  assert.equal(prefix.journalStatus, "interrupted");
  assert.ok(prefix.trailingBytes > 0);
  assert.equal(prefix.claimsVerified, false);
  await writeFile(path.join(directory, "bad.jsonl"), text + "x", {
    mode: 0o600,
  });
  assert.throws(() =>
    inspectReviewWorkflowAudit(path.join(directory, "bad.jsonl")),
  );
});
test("workflow audit crash leaves a durable pending native intent with unknown accounting and cannot resume it", async (t) => {
  const { root } = await setup(t),
    { file } = await auditFile(t);
  const module = fileURLToPath(
    new URL("../src/review-workflow-audit.js", import.meta.url),
  );
  const script = `import {ReviewWorkflowAudit,captureReviewWorkflowCommand} from ${JSON.stringify(module)};const audit=new ReviewWorkflowAudit(${JSON.stringify(root)},{file:${JSON.stringify(file)}},{allowReviewSource:true});const captured=captureReviewWorkflowCommand({operation:'probe',workflowId:${JSON.stringify(randomUUID())},probeId:'OriginalWorkflow'});audit.begin(captured.capture,captured.operation,[]);process.kill(process.pid,'SIGKILL');`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(child.signal, "SIGKILL", child.stderr);
  const recovered = inspectReviewWorkflowAudit(file);
  assert.equal(recovered.journalStatus, "interrupted");
  assert.equal(recovered.commands.pending, 1);
  assert.equal(recovered.commands.finished, 0);
  assert.equal(recovered.nativeAccountingComplete, false);
  assert.throws(
    () =>
      new ReviewWorkflowSession(root, {
        allowReviewSource: true,
        audit: { file },
      }),
  );
});
test("workflow audit bounds oversized and unserializable input honestly without treating truncated bodies as complete", async (t) => {
  const { root } = await setup(t),
    { file } = await auditFile(t);
  const session = new ReviewWorkflowSession(root, {
    allowReviewSource: true,
    audit: { file },
  });
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  await assert.rejects(session.command(cyclic));
  await assert.rejects(
    session.command({ operation: "open", context: "x".repeat(1048576) }),
  );
  session.dispose();
  const report = inspectReviewWorkflowAudit(file);
  assert.equal(report.commands.started, 2);
  assert.equal(report.commands.rejected, 2);
  assert.equal(report.allCommandBodiesRetained, false);
  assert.equal(report.workflows.length, 0);
  assert.ok(report.bytes < 20000);
  const events = (await readFile(file, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events[1].body.capture.kind, "unserializable");
  assert.equal(events[3].body.capture.kind, "prefix");
  assert.ok(events[3].body.capture.bytes > 1048576);
});

test("workflow audit disposal waits for native cleanup accounting before finalization", async (t) => {
  const { file, directory } = await auditFile(t),
    ready = path.join(directory, "ready");
  const code = `export async function decision(name){process.stdout.write('original-audit-ready\\n',()=>process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(ready)},'ready'));await new Promise(()=>{setInterval(()=>{},1000)});return name.startsWith('grant');}\n`;
  const { root, target } = await setup(t, code);
  const session = new ReviewWorkflowSession(root, {
    allowReviewSource: true,
    trusted: true,
    probes: [pin()],
    audit: { file },
  });
  try {
    const { id } = await prepare(session, [target]);
    let settled = false;
    const running = session
      .command({ operation: "probe", workflowId: id, probeId: recipe.id })
      .then(
        () => {
          settled = true;
          return false;
        },
        () => {
          settled = true;
          return true;
        },
      );
    let observed = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      assert.equal(settled, false);
      try {
        await stat(ready);
        observed = true;
        break;
      } catch {
        await delay(10);
      }
    }
    assert.equal(
      observed,
      true,
      "The original native function must execute before disposal",
    );
    const closing = session.dispose();
    assert.equal(closing[0]!.native.calls, null);
    assert.equal(closing[0]!.native.accountingComplete, false);
    assert.equal(inspectReviewWorkflowAudit(file).journalStatus, "interrupted");
    assert.equal(await running, true);
    const terminal = inspectReviewWorkflowAudit(file);
    assert.equal(terminal.journalStatus, "sealed");
    assert.equal(terminal.commands.pending, 0);
    assert.equal(terminal.nativeAccountingComplete, true);
    assert.equal(terminal.workflows[0]!.native.calls, 1);
    assert.ok(
      terminal.workflows[0]!.native.outputBytes! >=
        Buffer.byteLength("original-audit-ready\n"),
    );
    assert.equal(terminal.workflows[0]!.retainedBytes, 0);
  } finally {
    session.dispose();
  }
});

test("workflow audit CLI requires startup grants keeps model-selected paths inert and reports incomplete journals explicitly", async (t) => {
  const { root } = await setup(t),
    { directory, file } = await auditFile(t),
    cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const denied = spawnSync(
    process.execPath,
    [cli, "review-session", "--root", root, "--workflow-audit", file],
    { input: "", encoding: "utf8", timeout: 15000 },
  );
  assert.equal(denied.status, 2);
  await assert.rejects(stat(file));
  const input =
    JSON.stringify({ operation: "open", context: ".checktrail/context.json" }) +
    "\n";
  const run = spawnSync(
    process.execPath,
    [
      cli,
      "review-session",
      "--root",
      root,
      "--detailed",
      "--allow-review-source",
      "--workflow-audit",
      file,
    ],
    { input, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(run.status, 2);
  assert.equal(run.stdout.trimEnd().split("\n").length, 2);
  const inspected = spawnSync(
    process.execPath,
    [cli, "review-audit", "--input", file],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(inspected.status, 2);
  assert.equal(JSON.parse(inspected.stdout).journalStatus, "sealed");
  assert.equal(inspected.stdout.includes("subject.mjs"), false);
  const second = path.join(directory, "second.jsonl"),
    ungranted = path.join(directory, "ungranted.jsonl");
  const forged = spawnSync(
    process.execPath,
    [
      cli,
      "review-session",
      "--root",
      root,
      "--detailed",
      "--allow-review-source",
      "--workflow-audit",
      second,
    ],
    {
      input:
        JSON.stringify({
          operation: "open",
          context: ".checktrail/context.json",
          audit: { file: ungranted },
        }) + "\n",
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(forged.status, 2);
  assert.deepEqual(JSON.parse(forged.stdout), {
    error: "Workflow command rejected",
  });
  await assert.rejects(stat(ungranted));
  assert.equal(inspectReviewWorkflowAudit(second).commands.rejected, 1);
});

test("workflow audit MCP discovery siblings and in-place legacy fallback never spend or reopen the command journal", async (t) => {
  const { root } = await setup(t),
    { directory } = await auditFile(t),
    cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  for (const modern of [false, true]) {
    const file = path.join(directory, modern ? "modern.jsonl" : "legacy.jsonl"),
      client = new Client(
        { name: "original-audit-host", version: "fixture-1" },
        modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
      );
    try {
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
            file,
          ],
          stderr: "pipe",
        }),
      );
      await assert.rejects(stat(file));
      const opened = summary(
        (
          await client.callTool({
            name: "review_workflow",
            arguments: {
              operation: "open",
              context: ".checktrail/context.json",
            },
          })
        ).structuredContent,
      );
      const next = await client.callTool({
        name: "review_workflow",
        arguments: { operation: "next", workflowId: opened.workflowId },
      });
      assert.equal(next.isError, undefined);
      assigned(next.structuredContent);
      await client.callTool({
        name: "review_workflow",
        arguments: { operation: "close", workflowId: opened.workflowId },
      });
    } finally {
      await client.close();
    }
    const audit = inspectReviewWorkflowAudit(file);
    assert.equal(audit.journalStatus, "sealed");
    assert.equal(audit.commands.started, 3);
    assert.equal(audit.commands.pending, 0);
  }
  const file = path.join(directory, "fallback.jsonl"),
    child = spawn(process.execPath, [
      cli,
      "serve",
      "--root",
      root,
      "--detailed",
      "--allow-review-source",
      "--workflow-audit",
      file,
    ]);
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  void exit.catch(() => {});
  const reader = createInterface({ input: child.stdout }),
    iterator = reader[Symbol.asyncIterator]();
  const call = async (message: unknown) => {
    child.stdin.write(JSON.stringify(message) + "\n");
    const item = await iterator.next();
    assert.equal(item.done, false);
    return JSON.parse(item.value!);
  };
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const discovery = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    assert.equal(discovery.error, undefined);
    await assert.rejects(stat(file));
    const initialized = await call({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "original-fallback-host", version: "fixture-1" },
      },
    });
    assert.equal(initialized.error, undefined);
    await assert.rejects(stat(file));
    const opened = await call({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "review_workflow",
        arguments: { operation: "open", context: ".checktrail/context.json" },
      },
    });
    assert.equal(opened.error, undefined);
    summary(opened.result.structuredContent);
    child.stdin.end();
    assert.equal(await exit, 0);
    const audit = inspectReviewWorkflowAudit(file);
    assert.equal(audit.journalStatus, "sealed");
    assert.equal(audit.commands.started, 1);
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    reader.close();
    await exit;
  }
});
test("workflow audit reconciles serialized assignment ledgers and prevents disappearing history even with recomputed chains", async (t) => {
  const { root } = await setup(t),
    { directory, file } = await auditFile(t),
    session = new ReviewWorkflowSession(root, {
      allowReviewSource: true,
      audit: { file },
    });
  try {
    const opened = await open(session);
    await session.command({ operation: "next", workflowId: opened.workflowId });
    assert.equal(
      summary(
        await session.command({
          operation: "submit",
          workflowId: opened.workflowId,
          response: { broken: true },
        }),
      ).assignments[0]!.status,
      "malformed",
    );
  } finally {
    session.dispose();
  }
  const records = (await readFile(file, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (const change of [
    (record: (typeof records)[number]) =>
      record.body.states[0].issuedPacketBytes++,
    (record: (typeof records)[number]) => record.body.states[0].responseBytes++,
    (record: (typeof records)[number]) =>
      (record.body.states[0].assignments[0].status = "accepted"),
    (record: (typeof records)[number]) =>
      (record.body.states[0].assignments[0].responseDigest = "0".repeat(64)),
    (record: (typeof records)[number]) =>
      record.body.states[0].assignments.pop(),
    (record: (typeof records)[number]) => (record.body.states = []),
    (record: (typeof records)[number]) =>
      (record.body.states[0].contextDigest = "0".repeat(64)),
    (record: (typeof records)[number]) =>
      (record.body.states[0].native.calls = null),
  ]) {
    const altered = structuredClone(records);
    change(altered.at(-1)!);
    let previous: string | null = null;
    for (const [i, event] of altered.entries()) {
      event.sequence = i;
      event.previous = previous;
      const { digest: old, ...base } = event;
      assert.ok(old);
      event.digest = digest(JSON.stringify(base));
      previous = event.digest;
    }
    const invalid = path.join(directory, "inconsistent.jsonl");
    await writeFile(
      invalid,
      altered.map((event) => JSON.stringify(event)).join("\n") + "\n",
      { mode: 0o600 },
    );
    assert.throws(() => inspectReviewWorkflowAudit(invalid));
  }
  assert.equal(inspectReviewWorkflowAudit(file).journalStatus, "sealed");
});
