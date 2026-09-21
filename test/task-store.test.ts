import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  link,
  mkdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openTaskStore } from "../src/task-store.js";
import { createPlan, validate } from "../src/engine.js";
import { projectReport } from "../src/output.js";
import type { Report } from "../src/types.js";
import { fixture, nodeManifest, passingTest } from "./helpers.js";

const fingerprint = "a".repeat(64);
const moduleURL = new URL("../src/task-store.js", import.meta.url).href;
async function options(t: TestContext, detailed = false) {
  const root = await realpath(
    await fixture(t, {
      "package.json": nodeManifest,
      "check.test.js": passingTest,
    }),
  );
  const parent = await realpath(await fixture(t, {}));
  return { root, directory: path.join(parent, "tasks"), detailed };
}
function report(): Report {
  return {
    schemaVersion: 1,
    engineVersion: "test",
    runId: "86519a2b-eaaf-4d1f-b4c4-8395e8a9f9fe",
    startedAt: "2026-09-19T00:00:00Z",
    durationMs: 1,
    sourceFingerprint: fingerprint,
    finalSourceFingerprint: fingerprint,
    policyFingerprint: "b".repeat(64),
    sourceChanged: false,
    sourceError: false,
    excluded: ["synthetic-private-path"],
    outcome: "incomplete",
    checks: [],
  };
}
async function child(
  t: TestContext,
  source: string,
): Promise<{ process: ChildProcess; message: unknown }> {
  const process = spawn(
    globalThis.process.execPath,
    ["--input-type=module", "-e", source],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  process.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  t.after(async () => {
    if (process.exitCode === null && process.signalCode === null) {
      const exited = once(process, "exit");
      process.kill("SIGKILL");
      await exited;
    }
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const [message] = await once(process, "message", {
      signal: controller.signal,
    });
    return { process, message };
  } catch (error) {
    throw new Error(`Task-store child did not become ready: ${stderr}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}
async function kill(process: ChildProcess) {
  const exited = once(process, "exit");
  assert.ok(process.kill("SIGKILL"));
  await exited;
}

test("task store retains native validation results through reopening without retaining summary source", async (t) => {
  const opt = await options(t);
  const { plan } = await createPlan(opt.root);
  const store = await openTaskStore(opt);
  t.after(() => store.close());
  const task = store.create(plan.sourceFingerprint);
  assert.equal(store.get(task.taskId).status, "working");
  const result = await validate(opt.root, { trusted: true });
  assert.equal(result.outcome, "passed");
  assert.equal(store.complete(task.taskId, result), "updated");
  const completed = store.get(task.taskId);
  assert.deepEqual(
    completed.result!.structuredContent,
    projectReport(result, false),
  );
  assert.equal(completed.status, "completed");
  assert.ok(!JSON.stringify(completed).includes(opt.root));
  assert.ok(!JSON.stringify(completed).includes("check.test.js"));
  store.close();
  assert.throws(() => store.get(task.taskId), /closed/);
  const reopened = await openTaskStore(opt);
  try {
    assert.deepEqual(reopened.get(task.taskId), completed);
    assert.equal(reopened.requestCancellation(task.taskId), "terminal");
    assert.equal(reopened.complete(task.taskId, result), "terminal");
    assert.deepEqual(reopened.get(task.taskId), completed);
  } finally {
    reopened.close();
  }
  const bytes = await readFile(path.join(opt.directory, "tasks.sqlite"));
  assert.ok(!bytes.includes(Buffer.from(opt.root)));
  assert.ok(!bytes.includes(Buffer.from("check.test.js")));
});

test("task stores reject root and disclosure changes and retain detailed results only when configured", async (t) => {
  const opt = await options(t, true);
  const store = await openTaskStore(opt);
  const task = store.create(fingerprint);
  store.complete(task.taskId, report());
  assert.deepEqual(store.get(task.taskId).result!.structuredContent, report());
  store.close();
  const other = await options(t);
  await assert.rejects(async () => {
    const unexpected = await openTaskStore({ ...opt, root: other.root });
    unexpected.close();
  }, /does not match/);
  await assert.rejects(
    openTaskStore({ ...opt, detailed: false }),
    /does not match/,
  );
  const reopened = await openTaskStore(opt);
  try {
    assert.equal(reopened.get(task.taskId).status, "completed");
  } finally {
    reopened.close();
  }
});

test("task cancellation reserves the transition and cannot be overwritten by late completion", async (t) => {
  const store = await openTaskStore(await options(t));
  t.after(() => store.close());
  const task = store.create(fingerprint);
  assert.throws(() => store.finishCancellation(task.taskId), /not requested/);
  assert.equal(store.get(task.taskId).status, "working");
  assert.equal(store.requestCancellation(task.taskId), "updated");
  assert.equal(
    store.requestCancellation(task.taskId),
    "cancellation-requested",
  );
  assert.equal(store.complete(task.taskId, report()), "cancellation-requested");
  assert.equal(store.get(task.taskId).status, "working");
  assert.equal(store.finishCancellation(task.taskId), "updated");
  const cancelled = store.get(task.taskId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.result, undefined);
  assert.equal(store.complete(task.taskId, report()), "terminal");
  assert.equal(store.requestCancellation(task.taskId), "terminal");
  assert.equal(store.finishCancellation(task.taskId), "terminal");
  assert.deepEqual(store.get(task.taskId), cancelled);
  const completed = store.create(fingerprint);
  assert.equal(store.complete(completed.taskId, report()), "updated");
  assert.equal(store.requestCancellation(completed.taskId), "terminal");
  assert.equal(store.get(completed.taskId).result!.isError, undefined);
  assert.equal(
    (store.get(completed.taskId).result!.structuredContent as Report).outcome,
    "incomplete",
  );
});

test("task store rejects concurrent owners in this process and another process without disrupting work", async (t) => {
  const opt = await options(t);
  const store = await openTaskStore(opt);
  t.after(() => store.close());
  const task = store.create(fingerprint);
  await assert.rejects(openTaskStore(opt), /locked/);
  const other = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {openTaskStore} from ${JSON.stringify(moduleURL)}; await openTaskStore(${JSON.stringify(opt)});`,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(other.status, 1, other.stderr);
  assert.match(other.stderr, /locked/);
  assert.equal(store.get(task.taskId).status, "working");
  assert.equal(store.complete(task.taskId, report()), "updated");
});

test("task store recovers after a real owner SIGKILL and never resumes or passes unfinished tasks", async (t) => {
  const opt = await options(t);
  const source = `import {openTaskStore} from ${JSON.stringify(moduleURL)};
    const store = await openTaskStore(${JSON.stringify(opt)});
    const completed = store.create(${JSON.stringify(fingerprint)}); store.complete(completed.taskId, ${JSON.stringify(report())});
    const active = store.create(${JSON.stringify(fingerprint)});
    const cancelling = store.create(${JSON.stringify(fingerprint)}); store.requestCancellation(cancelling.taskId);
    const cancelled = store.create(${JSON.stringify(fingerprint)}); store.requestCancellation(cancelled.taskId); store.finishCancellation(cancelled.taskId);
    process.send({completed, active, cancelling, cancelled}); setInterval(() => {}, 1000);`;
  const worker = await child(t, source);
  const ids = worker.message as Record<string, { taskId: string }>;
  await assert.rejects(openTaskStore(opt), /locked/);
  await kill(worker.process);
  const store = await openTaskStore(opt);
  try {
    assert.equal(
      (store.get(ids.completed!.taskId).result!.structuredContent as Report)
        .outcome,
      "incomplete",
    );
    assert.equal(store.get(ids.cancelled!.taskId).status, "cancelled");
    for (const id of [ids.active!.taskId, ids.cancelling!.taskId]) {
      const task = store.get(id);
      assert.equal(task.status, "completed");
      assert.equal(task.result!.isError, true);
      assert.equal(task.result!.structuredContent, undefined);
      assert.match(JSON.stringify(task.result), /interrupted/);
      assert.equal(store.complete(id, report()), "terminal");
    }
  } finally {
    store.close();
  }
});

test("SQLite rolls back an interrupted write before task-store recovery", async (t) => {
  const opt = await options(t);
  const store = await openTaskStore(opt);
  const task = store.create(fingerprint);
  store.complete(task.taskId, report());
  const previous = store.get(task.taskId);
  store.close();
  const worker = await child(
    t,
    `import {DatabaseSync} from 'node:sqlite'; import {statSync} from 'node:fs';
    const db = new DatabaseSync(${JSON.stringify(path.join(opt.directory, "tasks.sqlite"))});
    const filename = ${JSON.stringify(path.join(opt.directory, "tasks.sqlite"))};
    const before = statSync(filename).size;
    db.exec("PRAGMA cache_size = 1; PRAGMA cache_spill = ON; BEGIN IMMEDIATE; DELETE FROM tasks; CREATE TABLE spill (value BLOB)");
    for (let n = 0; n < 16; n++) db.exec("INSERT INTO spill VALUES (zeroblob(65536))");
    process.send({before,after:statSync(filename).size}); setInterval(() => {}, 1000);`,
  );
  const sizes = worker.message as { before: number; after: number };
  assert.ok(
    sizes.after > sizes.before + 512 * 1024,
    "Dirty transaction must spill to disk before the crash",
  );
  await kill(worker.process);
  const reopened = await openTaskStore(opt);
  try {
    assert.deepEqual(reopened.get(task.taskId), previous);
  } finally {
    reopened.close();
  }
});

test("task retention enforces capacity, expiry, result bytes and source identity", async (t) => {
  const opt = await options(t, true);
  const store = await openTaskStore(opt);
  t.after(() => store.close());
  for (const ttl of [0, -1, 1.5, 604800001, Infinity])
    assert.throws(() => store.create(fingerprint, ttl));
  assert.throws(() => store.create("not-a-fingerprint"));
  const task = store.create(fingerprint);
  assert.throws(
    () =>
      store.complete(task.taskId, {
        ...report(),
        sourceFingerprint: "b".repeat(64),
      }),
    /fingerprints differ/,
  );
  assert.throws(
    () =>
      store.complete(task.taskId, {
        ...report(),
        excluded: ["x".repeat(256 * 1024)],
      }),
    /byte limit/,
  );
  assert.equal(store.get(task.taskId).status, "working");
  assert.equal(store.complete(task.taskId, report()), "updated");
  const expiring = store.create(fingerprint, 2000);
  for (let n = 0; n < 30; n++) store.create(fingerprint);
  assert.throws(() => store.create(fingerprint), /capacity/);
  await delay(
    Math.max(
      0,
      Date.parse(expiring.createdAt) + expiring.ttlMs - Date.now() + 10,
    ),
  );
  assert.throws(() => store.get(expiring.taskId), /expired/);
  assert.throws(() => store.complete(expiring.taskId, report()), /expired/);
  assert.throws(() => store.requestCancellation(expiring.taskId), /expired/);
  assert.equal(store.create(fingerprint).status, "working");
  assert.throws(() => store.create(fingerprint), /capacity/);
  assert.ok(
    (await stat(path.join(opt.directory, "tasks.sqlite"))).size <=
      16 * 1024 * 1024,
  );
});

test("task store refuses unsafe directories, links, foreign databases and damaged results", async (t) => {
  const opt = await options(t);
  await mkdir(opt.directory, { mode: 0o755 });
  await assert.rejects(openTaskStore(opt), /private/);
  await chmod(opt.directory, 0o700);
  const foreign = path.join(path.dirname(opt.directory), "foreign.sqlite");
  await writeFile(foreign, "synthetic unrelated bytes", { mode: 0o600 });
  await symlink(foreign, path.join(opt.directory, "tasks.sqlite"));
  await assert.rejects(openTaskStore(opt));
  assert.equal(await readFile(foreign, "utf8"), "synthetic unrelated bytes");
  const linked = await options(t);
  await mkdir(linked.directory, { mode: 0o700 });
  await link(foreign, path.join(linked.directory, "tasks.sqlite"));
  await assert.rejects(openTaskStore(linked), /singly linked/);
  const corrupt = await options(t);
  const store = await openTaskStore(corrupt);
  const task = store.create(fingerprint);
  store.complete(task.taskId, report());
  store.close();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(corrupt.directory, "tasks.sqlite"));
  db.prepare("UPDATE tasks SET result = ?").run(
    '{"arbitrary":"synthetic-source"}',
  );
  db.close();
  await assert.rejects(openTaskStore(corrupt));
  const unrelated = await options(t);
  await mkdir(unrelated.directory, { mode: 0o700 });
  const unrelatedFile = path.join(unrelated.directory, "tasks.sqlite");
  await writeFile(unrelatedFile, "", { mode: 0o600 });
  const other = new DatabaseSync(unrelatedFile);
  other.exec(
    "CREATE TABLE important (value TEXT); INSERT INTO important VALUES ('preserve')",
  );
  other.close();
  await assert.rejects(openTaskStore(unrelated), /Unrecognized/);
  const unchanged = new DatabaseSync(unrelatedFile);
  try {
    assert.equal(
      unchanged.prepare("SELECT value FROM important").get()!.value,
      "preserve",
    );
  } finally {
    unchanged.close();
  }
});

test("task store bounds UTF-8 results and total retained data with private file modes", async (t) => {
  const opt = await options(t, true);
  const store = await openTaskStore(opt);
  try {
    const large = { ...report(), excluded: ["λ".repeat(62000)] };
    for (let n = 0; n < 32; n++) {
      const task = store.create(fingerprint);
      if (n === 0) {
        assert.throws(
          () =>
            store.complete(task.taskId, {
              ...large,
              excluded: ["λ".repeat(70000)],
            }),
          /byte limit/,
        );
        assert.equal(store.get(task.taskId).status, "working");
      }
      assert.equal(store.complete(task.taskId, large), "updated");
      assert.deepEqual(store.get(task.taskId).result!.structuredContent, large);
    }
    assert.throws(() => store.create(fingerprint), /capacity/);
  } finally {
    store.close();
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(opt.directory, "tasks.sqlite"));
  try {
    assert.equal(
      db.prepare("SELECT count(*) AS total FROM tasks").get()!.total,
      32,
    );
    assert.ok(
      Number(db.prepare("PRAGMA page_count").get()!.page_count) <= 4096,
    );
  } finally {
    db.close();
  }
  assert.equal((await stat(opt.directory)).mode & 0o777, 0o700);
  for (const name of ["owner.sqlite", "tasks.sqlite"]) {
    const file = await stat(path.join(opt.directory, name));
    assert.equal(file.mode & 0o777, 0o600);
    assert.ok(file.size <= 16 * 1024 * 1024);
  }
  const reopened = await openTaskStore(opt);
  reopened.close();
});
