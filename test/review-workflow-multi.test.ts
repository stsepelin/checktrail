import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ReviewWorkflowEngine } from "../src/review-workflow.js";
import { ReviewWorkflowSession } from "../src/review-workflow-session.js";
import { parseReviewWorkflowAuditArtifact } from "../src/review-workflow-audit.js";
import {
  reviewWorkflowAssignmentSchema,
  reviewWorkflowAllSummarySchema,
  reviewWorkflowSummarySchema,
  reviewWorkflowCommandSchema,
  type ReviewWorkflowNativeReceipt,
} from "../src/review-workflow-schema.js";
import {
  setup,
  pin,
  recipe,
  response,
  limits,
} from "./review-workflow-fixture.js";
const allLimits = {
  ...limits,
  maxAssignments: 65,
  maxNativeCalls: 96,
  maxNativeOutputBytes: 65536,
};
const options = {
  allowReviewSource: true,
  candidateScope: "all" as const,
  trusted: true,
  probes: [pin()],
  limits: allLimits,
};
const assigned = (value: unknown) =>
  reviewWorkflowAssignmentSchema.parse(value);
const summary = (value: unknown) => reviewWorkflowAllSummarySchema.parse(value);
type Call = (command: unknown) => Promise<unknown>;
async function start(call: Call, targets: Parameters<typeof response>[1]) {
  const opened = summary(
    await call({ operation: "open", context: ".checktrail/context.json" }),
  );
  const reviewer = assigned(
    await call({ operation: "next", workflowId: opened.workflowId }),
  );
  return summary(
    await call({
      operation: "submit",
      workflowId: opened.workflowId,
      response: response(reviewer, targets),
    }),
  );
}
async function refute(
  call: Call,
  state: ReturnType<typeof summary>,
  i: number,
  candidates: Parameters<typeof response>[1] = [],
) {
  const assignment = assigned(
    await call({
      operation: "next",
      workflowId: state.workflowId,
      target: state.candidateHandles[i],
    }),
  );
  await call({
    operation: "submit",
    workflowId: state.workflowId,
    response: response(assignment, candidates),
  });
  return assignment;
}
async function probe(call: Call, state: ReturnType<typeof summary>) {
  return summary(
    await call({
      operation: "probe",
      workflowId: state.workflowId,
      probeId: recipe.id,
    }),
  );
}
async function judge(call: Call, state: ReturnType<typeof summary>) {
  const assignment = assigned(
    await call({ operation: "next", workflowId: state.workflowId }),
  );
  const done = summary(
    await call({
      operation: "submit",
      workflowId: state.workflowId,
      response: response(assignment),
    }),
  );
  return { assignment, done };
}
const records = (contents: Buffer) =>
  contents
    .toString()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
function rechain(events: ReturnType<typeof records>) {
  let previous: string | null = null;
  return Buffer.from(
    events
      .map((event, index) => {
        event.sequence = index;
        event.previous = previous;
        const { digest: old, ...base } = event;
        assert.ok(old);
        event.digest = createHash("sha256")
          .update(JSON.stringify(base))
          .digest("hex");
        previous = event.digest;
        return JSON.stringify(event);
      })
      .join("\n") + "\n",
  );
}
async function journal(t: Parameters<typeof setup>[0]) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "checktrail-original-multi-"),
  );
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "epoch.jsonl");
}
test("all-candidate workflow processes broken fixed and near-miss targets independently without upgrading claim truth", async (t) => {
  for (const content of [
    undefined,
    "export function decision(name){return name === 'grant:read';}\n",
  ]) {
    const { root, target } = await setup(t, content);
    const engine = new ReviewWorkflowEngine(root, options);
    t.after(() => engine.dispose());
    const call: Call = (command) => engine.command(command);
    const second = {
      ...target,
      id: "OriginalSecondTarget",
      claim: "Original second boundary concern.",
    };
    const state = await start(call, [target, second]);
    const counterclaim = {
      ...target,
      id: "OriginalFirstCounterclaim",
      claim: "Original first counterclaim must stay in its own stage.",
    };
    await refute(call, state, 0, [counterclaim]);
    assert.equal((await probe(call, state)).native.calls, 3);
    const first = await judge(call, state);
    assert.equal(first.done.status, "ready");
    assert.equal(first.done.disposition, "not-complete");
    assert.equal(first.done.nextStage, "refuter");
    assert.deepEqual(first.done.completedTargets, [state.candidateHandles[0]]);
    const next = await refute(call, state, 1);
    for (const secret of [
      target.claim,
      counterclaim.claim,
      target.id,
      counterclaim.id,
      first.assignment.assignmentId,
      first.assignment.assignmentDigest,
    ])
      assert.equal(next.packet.includes(secret), false, secret);
    const native = await probe(call, state);
    assert.equal(native.native.calls, 6);
    const final = await judge(call, state);
    assert.equal(final.assignment.packet.includes(counterclaim.claim), false);
    const actual = JSON.parse(final.assignment.packet).nativeObservations
      .cases[1].actual;
    assert.equal(actual, content === undefined);
    assert.ok(first.done.retainedBytes > state.retainedBytes);
    assert.ok(final.done.retainedBytes > first.done.retainedBytes);
    assert.equal(final.done.status, "completed");
    assert.equal(final.done.disposition, "advisory-stages-completed");
    assert.deepEqual(final.done.completedTargets, state.candidateHandles);
    assert.equal(final.done.assignments.length, 5);
    assert.equal(final.done.unverifiedCandidates, 2);
    assert.equal(final.done.claimsVerified, false);
    assert.equal(final.done.hostIsolationVerified, false);
    assert.equal(final.done.resolution, "unresolved");
    assert.equal(final.done.severity, "unassigned");
    const closed = summary(
      await call({ operation: "close", workflowId: state.workflowId }),
    );
    assert.equal(closed.retainedBytes, 0);
    assert.equal(closed.native.rawEvidenceRetained, false);
    assert.deepEqual(closed.completedTargets, state.candidateHandles);
  }
});
test("all-candidate workflow rejects skipping switching or repeating targets and operator grants in commands", async (t) => {
  const { root, target, context } = await setup(t);
  const engine = new ReviewWorkflowEngine(root, options);
  t.after(() => engine.dispose());
  const call: Call = (command) => engine.command(command);
  const state = await start(call, [
    target,
    { ...target, id: "OriginalSecondTarget" },
  ]);
  await assert.rejects(
    call({
      operation: "next",
      workflowId: state.workflowId,
      target: randomUUID(),
    }),
  );
  await refute(call, state, 0);
  await assert.rejects(
    call({
      operation: "next",
      workflowId: state.workflowId,
      target: state.candidateHandles[1],
    }),
  );
  await probe(call, state);
  await judge(call, state);
  await assert.rejects(
    call({
      operation: "next",
      workflowId: state.workflowId,
      target: state.candidateHandles[0],
    }),
  );
  assert.equal(engine.status(state.workflowId).assignments.length, 3);
  assert.equal(
    reviewWorkflowCommandSchema.safeParse({
      operation: "next",
      workflowId: state.workflowId,
      candidateScope: "all",
      trusted: true,
    }).success,
    false,
  );
  assert.throws(() => new ReviewWorkflowEngine(root, { ...options, limits }));
  assert.throws(
    () =>
      new ReviewWorkflowEngine(root, {
        ...options,
        candidateScope: "selected",
      }),
  );
  const denied = new ReviewWorkflowEngine(root, {
    ...options,
    allowReviewSource: false,
    trusted: false,
  });
  t.after(() => denied.dispose());
  const opened = await denied.open(context);
  await assert.rejects(denied.next(opened.workflowId), /startup disclosure/);
});
test("all-candidate workflow shares exact zero and exhausted native call budgets across targets", async (t) => {
  const { root, target } = await setup(t);
  for (const maxNativeCalls of [0, 3, 5, 6]) {
    const receipts: ReviewWorkflowNativeReceipt[] = [];
    const engine = new ReviewWorkflowEngine(root, {
      ...options,
      limits: { ...allLimits, maxNativeCalls },
    });
    t.after(() => engine.dispose());
    const call: Call = (command) => engine.command(command);
    const state = await start(call, [
      target,
      { ...target, id: "OriginalSecondTarget" },
    ]);
    await refute(call, state, 0);
    let native = summary(
      await engine.probe(state.workflowId, recipe.id, undefined, (receipt) =>
        receipts.push(receipt),
      ),
    );
    if (maxNativeCalls === 0) {
      assert.equal(native.status, "incomplete");
      assert.equal(native.native.calls, 0);
      assert.deepEqual(native.completedTargets, []);
    } else {
      await judge(call, state);
      await refute(call, state, 1);
      native = summary(
        await engine.probe(state.workflowId, recipe.id, undefined, (receipt) =>
          receipts.push(receipt),
        ),
      );
      assert.equal(native.native.calls, maxNativeCalls);
      assert.equal(native.native.accountingComplete, true);
      assert.equal(
        native.native.status,
        maxNativeCalls === 6 ? "completed" : "incomplete",
      );
      const secondRun = receipts[1]!.run;
      assert.notEqual(secondRun.schemaVersion, 1);
      if (secondRun.schemaVersion !== 1)
        assert.equal(
          secondRun.nativeBudget.limits.maxCalls,
          maxNativeCalls - 3,
        );
      if (maxNativeCalls === 6)
        assert.equal(
          (await judge(call, state)).done.completedTargets.length,
          2,
        );
      else {
        assert.deepEqual(native.completedTargets, [state.candidateHandles[0]]);
        await assert.rejects(
          call({ operation: "next", workflowId: state.workflowId }),
        );
      }
    }
    assert.equal(native.claimsVerified, false);
    assert.equal(native.unverifiedCandidates, 2);
  }
});
test("all-candidate workflow shrinks the remaining native output allowance and records reached bytes", async (t) => {
  const { root, target } = await setup(t);
  for (const maxNativeOutputBytes of [0, 65536]) {
    const receipts: ReviewWorkflowNativeReceipt[] = [];
    const engine = new ReviewWorkflowEngine(root, {
      ...options,
      limits: { ...allLimits, maxNativeOutputBytes },
    });
    t.after(() => engine.dispose());
    const call: Call = (command) => engine.command(command);
    const state = await start(call, [
      target,
      { ...target, id: "OriginalSecondTarget" },
    ]);
    await refute(call, state, 0);
    const first = summary(
      await engine.probe(state.workflowId, recipe.id, undefined, (receipt) =>
        receipts.push(receipt),
      ),
    );
    if (maxNativeOutputBytes === 0) {
      assert.equal(first.native.outputBytes, 0);
      assert.equal(first.native.calls, 0);
      assert.equal(first.status, "incomplete");
      continue;
    }
    assert.ok(first.native.outputBytes! > 0);
    await judge(call, state);
    await refute(call, state, 1);
    const second = summary(
      await engine.probe(state.workflowId, recipe.id, undefined, (receipt) =>
        receipts.push(receipt),
      ),
    );
    const run = receipts[1]!.run;
    assert.notEqual(run.schemaVersion, 1);
    if (run.schemaVersion !== 1) {
      assert.equal(
        run.nativeBudget.limits.maxOutputBytes,
        maxNativeOutputBytes - first.native.outputBytes!,
      );
      assert.equal(
        second.native.outputBytes,
        first.native.outputBytes! + run.nativeBudget.outputBytes,
      );
    }
    assert.equal((await judge(call, state)).done.completedTargets.length, 2);
  }
});
test("all-candidate workflow counts retries against shared assignment limits and rejects reused host sessions", async (t) => {
  const { root, target } = await setup(t);
  const engine = new ReviewWorkflowEngine(root, {
    ...options,
    limits: { ...allLimits, maxAssignments: 4 },
  });
  t.after(() => engine.dispose());
  const call: Call = (command) => engine.command(command);
  const state = await start(call, [
    target,
    { ...target, id: "OriginalSecondTarget" },
  ]);
  const firstRefuter = await refute(call, state, 0);
  await probe(call, state);
  const first = await judge(call, state);
  const next = assigned(
    await call({
      operation: "next",
      workflowId: state.workflowId,
      target: state.candidateHandles[1],
    }),
  );
  const reused = response(next);
  reused.host.sessionId = first.done.assignments[1]!.host!.sessionId;
  const rejected = summary(
    await call({
      operation: "submit",
      workflowId: state.workflowId,
      response: reused,
    }),
  );
  assert.equal(rejected.assignments.at(-1)!.status, "host-session-reused");
  assert.equal(rejected.nextStage, "refuter");
  assert.equal(rejected.completedTargets.length, 1);
  const exhausted = summary(
    await call({
      operation: "next",
      workflowId: state.workflowId,
      target: state.candidateHandles[1],
    }),
  );
  assert.equal(exhausted.stopReason, "assignments-exhausted");
  assert.equal(exhausted.assignments.length, 4);
  assert.equal(exhausted.native.calls, 3);
  assert.equal(exhausted.retainedBytes, 0);
  assert.notEqual(next.assignmentId, firstRefuter.assignmentId);
});
test("all-candidate workflow retains completed coverage when later source becomes stale and empty reviews abstain", async (t) => {
  const { root, target } = await setup(t);
  const engine = new ReviewWorkflowEngine(root, options);
  t.after(() => engine.dispose());
  const call: Call = (command) => engine.command(command);
  const empty = await start(call, []);
  assert.equal(empty.disposition, "no-candidates-declared");
  assert.deepEqual(empty.completedTargets, []);
  assert.equal(empty.claimsVerified, false);
  const state = await start(call, [
    target,
    { ...target, id: "OriginalSecondTarget" },
  ]);
  await refute(call, state, 0);
  await probe(call, state);
  await judge(call, state);
  await writeFile(
    path.join(root, "subject.mjs"),
    "export function decision(){return false;}\n",
  );
  const stale = summary(
    await call({
      operation: "next",
      workflowId: state.workflowId,
      target: state.candidateHandles[1],
    }),
  );
  assert.equal(stale.status, "stale");
  assert.equal(stale.disposition, "not-complete");
  assert.deepEqual(stale.completedTargets, [state.candidateHandles[0]]);
  assert.equal(stale.native.calls, 3);
  assert.equal(stale.retainedBytes, 0);
  assert.equal(stale.unverifiedCandidates, 2);
});
test("all-candidate audit replays every native receipt and rejects altered coverage receipts limits and totals", async (t) => {
  const { root, target } = await setup(t);
  const file = await journal(t);
  const session = new ReviewWorkflowSession(root, {
    ...options,
    limits: { ...allLimits, maxNativeCalls: 6 },
    audit: { file },
  });
  t.after(() => session.dispose());
  const call: Call = (command) => session.command(command);
  const state = await start(call, [
    target,
    { ...target, id: "OriginalSecondTarget" },
  ]);
  for (let i = 0; i < 2; i++) {
    await refute(call, state, i);
    await probe(call, state);
    await judge(call, state);
  }
  session.dispose();
  const contents = await readFile(file);
  const artifact = parseReviewWorkflowAuditArtifact(contents);
  assert.equal(artifact.summary.nativeReceipts.retained, 2);
  assert.equal(artifact.summary.nativeReceipts.complete, true);
  assert.equal(artifact.summary.nativeAccountingComplete, true);
  assert.equal(summary(artifact.summary.workflows[0]).native.calls, 6);
  assert.equal(
    summary(artifact.summary.workflows[0]).completedTargets.length,
    2,
  );
  const original = records(contents);
  const receiptEvents = original.filter((event) => event.body.nativeReceipt);
  assert.equal(receiptEvents.length, 2);
  const secondSeq = receiptEvents[1].sequence;
  const variants: Array<(events: ReturnType<typeof records>) => void> = [
    (events) => {
      events[secondSeq]!.body.nativeReceipt = null;
    },
    (events) => {
      events[secondSeq]!.body.nativeReceipt = structuredClone(
        receiptEvents[0].body.nativeReceipt,
      );
    },
    (events) => {
      events[secondSeq]!.body.nativeReceipt.targetHandle = randomUUID();
    },
    (events) => {
      events[secondSeq]!.body.nativeReceipt.run.nativeBudget.limits.maxCalls =
        16;
    },
    (events) => {
      events[secondSeq]!.body.states[0].native.calls = 3;
    },
    (events) => {
      events[secondSeq]!.body.states[0].completedTargets = [];
    },
    (events) => {
      events[secondSeq]!.body.states[0].completedTargets = [
        ...state.candidateHandles,
      ];
    },
    (events) => {
      events[0]!.body.settings.candidateScope = undefined;
    },
    (events) => {
      events[0]!.body.settings.workflowLimits = null;
    },
  ];
  for (const [i, mutate] of variants.entries()) {
    const events = structuredClone(original);
    mutate(events);
    assert.throws(
      () => parseReviewWorkflowAuditArtifact(rechain(events)),
      `Original tamper variant ${i}`,
    );
  }
});
test("all-candidate CLI and MCP share the bounded workflow and keep startup grants outside tool input", async (t) => {
  const { root, target } = await setup(t);
  const pinned = pin();
  const probeFile = path.join(root, ".checktrail/probe.json");
  await writeFile(probeFile, pinned.contents);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const flags = [
    "--root",
    root,
    "--detailed",
    "--allow-review-source",
    "--workflow-candidates",
    "all",
    "--probe",
    probeFile + "#sha256=" + pinned.sha256,
  ];
  async function exchange(call: Call) {
    const state = await start(call, [
      target,
      { ...target, id: "OriginalSecondTarget" },
    ]);
    for (let i = 0; i < 2; i++) {
      await refute(call, state, i);
      await probe(call, state);
      await judge(call, state);
    }
    const done = summary(
      await call({ operation: "status", workflowId: state.workflowId }),
    );
    assert.equal(done.completedTargets.length, 2);
    assert.equal(done.native.calls, 6);
    assert.equal(done.claimsVerified, false);
    await call({ operation: "close", workflowId: state.workflowId });
  }
  const child = spawn(process.execPath, [
    cli,
    "review-session",
    ...flags,
    "--trust-project",
  ]);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const reader = createInterface({ input: child.stdout });
  const iterator = reader[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  async function read() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const line = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Original multi CLI deadline")),
            15000,
          );
        }),
      ]);
      assert.equal(line.done, false, stderr);
      return JSON.parse(line.value!);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    await exchange(async (command) => {
      child.stdin.write(JSON.stringify(command) + "\n");
      return read();
    });
    child.stdin.end();
    assert.equal(
      reviewWorkflowSummarySchema.parse(await read()).status,
      "closed",
    );
    assert.equal(await exited, 0, stderr);
  } finally {
    child.kill("SIGKILL");
    reader.close();
    await exited;
  }
  const client = new Client(
    { name: "original-multi-host", version: "fixture-1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "serve", ...flags, "--allow-execution"],
        stderr: "pipe",
      }),
    );
    const call: Call = async (command) => {
      const result = await client.callTool({
        name: "review_workflow",
        arguments: command as Record<string, unknown>,
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      return result.structuredContent;
    };
    await exchange(call);
    const denied = await client.callTool({
      name: "review_workflow",
      arguments: {
        operation: "open",
        context: ".checktrail/context.json",
        candidateScope: "all",
        trusted: true,
      },
    });
    assert.equal(denied.isError, true);
  } finally {
    await client.close();
  }
});

test("all-candidate audit accounts zero-call later attempts without treating unfinished targets as completed", async (t) => {
  const { root, target } = await setup(t);
  const file = await journal(t);
  const session = new ReviewWorkflowSession(root, {
    ...options,
    limits: { ...allLimits, maxNativeCalls: 3 },
    audit: { file },
  });
  t.after(() => session.dispose());
  const call: Call = (command) => session.command(command);
  const state = await start(call, [
    target,
    { ...target, id: "OriginalSecondTarget" },
  ]);
  await refute(call, state, 0);
  await probe(call, state);
  await judge(call, state);
  await refute(call, state, 1);
  const incomplete = await probe(call, state);
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.stopReason, "native-incomplete");
  assert.equal(incomplete.native.calls, 3);
  assert.equal(incomplete.completedTargets.length, 1);
  session.dispose();
  const contents = await readFile(file);
  const artifact = parseReviewWorkflowAuditArtifact(contents);
  assert.equal(artifact.summary.nativeReceipts.retained, 2);
  assert.equal(artifact.summary.nativeReceipts.complete, true);
  assert.equal(
    summary(artifact.summary.workflows[0]).disposition,
    "not-complete",
  );
  const events = records(contents);
  const reached = events.filter((event) => event.body.nativeReceipt);
  assert.equal(reached[1].body.nativeReceipt.run.nativeBudget.calls, 0);
  reached[1].body.nativeReceipt = null;
  assert.throws(
    () => parseReviewWorkflowAuditArtifact(rechain(events)),
    /missing/,
  );
});

test("all-candidate closure during later native execution retains prior coverage and final cleanup accounting", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "checktrail-original-multi-marker-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "started");
  const source = `export function decision(name){process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(marker)},name);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);return name.startsWith('grant');}\n`;
  const { root, target } = await setup(t, source);
  const file = await journal(t);
  const session = new ReviewWorkflowSession(root, {
    ...options,
    audit: { file },
  });
  t.after(() => session.dispose());
  const call: Call = (command) => session.command(command);
  const state = await start(call, [
    target,
    { ...target, id: "OriginalSecondTarget" },
  ]);
  await refute(call, state, 0);
  await probe(call, state);
  await judge(call, state);
  await rm(marker);
  await refute(call, state, 1);
  const running = probe(call, state);
  const deadline = performance.now() + 10000;
  while (true) {
    try {
      await readFile(marker);
      break;
    } catch {
      if (performance.now() >= deadline)
        throw new Error("Original later native process did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const closing = summary(
    await call({ operation: "close", workflowId: state.workflowId }),
  );
  assert.equal(closing.status, "closed");
  assert.equal(closing.native.accountingComplete, false);
  assert.equal(closing.native.calls, null);
  assert.deepEqual(closing.completedTargets, [state.candidateHandles[0]]);
  const stopped = await running;
  assert.equal(stopped.status, "closed");
  assert.equal(stopped.native.accountingComplete, true);
  assert.equal(stopped.native.calls, 4);
  assert.equal(stopped.retainedBytes, 0);
  assert.equal(stopped.native.rawEvidenceRetained, false);
  assert.equal(stopped.disposition, "not-complete");
  session.dispose();
  const artifact = parseReviewWorkflowAuditArtifact(await readFile(file));
  assert.equal(artifact.summary.nativeReceipts.retained, 2);
  assert.equal(artifact.summary.nativeReceipts.complete, true);
  assert.equal(
    summary(artifact.summary.workflows[0]).completedTargets.length,
    1,
  );
});

test("all-candidate audit tolerates concurrent status snapshots while the later native receipt is pending", async (t) => {
  const { root, target } = await setup(t);
  const file = await journal(t);
  const session = new ReviewWorkflowSession(root, {
    ...options,
    audit: { file, maxEvents: 4096 },
  });
  t.after(() => session.dispose());
  const call: Call = (command) => session.command(command);
  const state = await start(call, [
    target,
    { ...target, id: "OriginalSecondTarget" },
  ]);
  await refute(call, state, 0);
  await probe(call, state);
  await judge(call, state);
  await refute(call, state, 1);
  let finished = false;
  const running = probe(call, state).finally(() => {
    finished = true;
  });
  let polls = 0;
  while (!finished && polls < 1000) {
    await call({ operation: "status", workflowId: state.workflowId });
    polls++;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(polls > 0);
  assert.equal((await running).native.calls, 6);
  await judge(call, state);
  session.dispose();
  const contents = await readFile(file);
  const artifact = parseReviewWorkflowAuditArtifact(contents);
  assert.equal(artifact.summary.nativeReceipts.retained, 2);
  assert.equal(artifact.summary.nativeReceipts.complete, true);
  assert.equal(artifact.summary.commands.pending, 0);
  // Also model this legal ordering deterministically, rather than depending on a polling race.
  const events = records(contents);
  const secondReceipt = events.filter((event) => event.body.nativeReceipt)[1];
  const index = secondReceipt.sequence;
  const template = events.find(
    (event) => event.body.kind === "begin" && event.body.operation === "status",
  );
  const begin = structuredClone(template);
  const finish = structuredClone(
    events.find(
      (event) =>
        event.body.kind === "finish" &&
        event.body.commandId === template.body.commandId,
    ),
  );
  const id = randomUUID();
  for (const event of [begin, finish]) {
    event.body.commandId = id;
    event.createdAt = secondReceipt.createdAt;
    event.body.states = structuredClone(secondReceipt.body.states);
  }
  finish.body.result = structuredClone(secondReceipt.body.states[0]);
  events.splice(index, 0, begin, finish);
  assert.doesNotThrow(() => parseReviewWorkflowAuditArtifact(rechain(events)));
  const interrupted = parseReviewWorkflowAuditArtifact(
    rechain(events.slice(0, index + 2)),
  ).summary;
  assert.equal(interrupted.journalStatus, "interrupted");
  assert.equal(interrupted.nativeReceipts.retained, 1);
  assert.equal(interrupted.nativeReceipts.complete, false);
  assert.equal(interrupted.nativeAccountingComplete, false);
  assert.equal(interrupted.commands.pending, 1);
});
