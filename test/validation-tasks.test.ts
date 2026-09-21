import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  openValidationTasks,
  type ValidationTasks,
} from "../src/validation-tasks.js";
import { openTaskStore, type StoredValidationTask } from "../src/task-store.js";
import { fixture, nodeManifest, passingTest } from "./helpers.js";

async function setup(t: TestContext, source = passingTest, detailed = false) {
  const root = await realpath(
    await fixture(t, {
      "package.json": nodeManifest,
      "check.test.js": source,
      ".repo-verifier/keep": "",
    }),
  );
  const directory = path.join(await realpath(await fixture(t, {})), "store");
  return { root, directory, allowExecution: true, detailed, timeoutMs: 5000 };
}
async function completed(
  tasks: ValidationTasks,
  id: string,
): Promise<StoredValidationTask> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = await tasks.get(id);
    if (task.status !== "working") return task;
    await delay(25);
  }
  throw new Error("Native validation task did not finish");
}
const slow = `import {test} from 'node:test'; import fs from 'node:fs'; import {spawn} from 'node:child_process';
test('waits for cancellation', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'});
  fs.writeFileSync('.repo-verifier/started.json', JSON.stringify({pid:process.pid,group:process.ppid,child:child.pid}));
  await new Promise(resolve=>setTimeout(resolve,60000));
});`;
type Pids = { pid: number; group: number; child: number };
async function live(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      return !/\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return false;
    }
  }
  return true;
}
async function started(t: TestContext, root: string): Promise<Pids> {
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      const pids = JSON.parse(
        await readFile(path.join(root, ".repo-verifier/started.json"), "utf8"),
      ) as Pids;
      t.after(() => {
        try {
          process.kill(-pids.group, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      });
      assert.ok(await live(pids.pid));
      assert.ok(await live(pids.child));
      return pids;
    } catch {
      await delay(25);
    }
  }
  throw new Error("Native task test and descendant did not start");
}
async function stopped(pids: Pids): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await live(pids.pid)) && !(await live(pids.child))) return;
    await delay(25);
  }
  assert.fail("Native task test or descendant survived cancellation");
}

test("durable validation tasks preserve native passed, failed and incomplete outcomes through reopening", async (t) => {
  const opt = await setup(t);
  const tasks = await openValidationTasks(opt);
  t.after(() => tasks.close());
  const retained: StoredValidationTask[] = [];
  for (const [source, outcome] of [
    [passingTest, "passed"],
    [passingTest.replace("2 + 3, 5", "2 + 3, 6"), "failed"],
    ["", "incomplete"],
  ] as const) {
    await writeFile(path.join(opt.root, "check.test.js"), source);
    const task = await tasks.start();
    assert.equal(task.status, "working");
    const result = await completed(tasks, task.taskId);
    assert.equal(result.status, "completed");
    assert.equal(
      (result.result!.structuredContent as { outcome: string }).outcome,
      outcome,
    );
    assert.ok(!JSON.stringify(result).includes(opt.root));
    assert.ok(!JSON.stringify(result).includes("check.test.js"));
    retained.push(result);
  }
  await tasks.close();
  const reopened = await openValidationTasks({ ...opt, allowExecution: false });
  try {
    for (const result of retained)
      assert.deepEqual(await reopened.get(result.taskId), result);
    await assert.rejects(reopened.start(), /denied/);
    assert.deepEqual(await reopened.cancel(retained[0]!.taskId), retained[0]);
  } finally {
    await reopened.close();
  }
});

test("durable task startup does not grant execution, load project code or inherit Node preloads", async (t) => {
  const opt = await setup(
    t,
    "throw new Error('must not execute during startup');",
  );
  const marker = path.join(opt.root, ".repo-verifier/preloaded");
  const preload = path.join(opt.root, ".repo-verifier/preload.mjs");
  await writeFile(
    preload,
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'loaded');`,
  );
  const previous = process.env.NODE_OPTIONS;
  let tasks: ValidationTasks | undefined;
  try {
    process.env.NODE_OPTIONS = `--import=${preload}`;
    tasks = await openValidationTasks({ ...opt, allowExecution: false });
    await assert.rejects(tasks.start(), /denied/);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    await tasks?.close();
  }
  for (const timeoutMs of [0, -1, 120001, 1.1])
    await assert.rejects(openValidationTasks({ ...opt, timeoutMs }));
  await assert.rejects(
    openValidationTasks({ ...opt, root: path.join(opt.root, "missing") }),
  );
});

for (const method of ["cancel", "close"] as const)
  test(
    `durable task ${method} stops a live process group before recording cancellation or releasing ownership`,
    { timeout: 10000 },
    async (t) => {
      const opt = await setup(t, slow);
      const tasks = await openValidationTasks(opt);
      t.after(() => tasks.close());
      const task = await tasks.start();
      const pids = await started(t, opt.root);
      await assert.rejects(tasks.start(), /busy/);
      assert.equal((await tasks.get(task.taskId)).status, "working");
      await assert.rejects(openTaskStore(opt), /locked/);
      await assert.rejects(openValidationTasks(opt), /unavailable/);
      if (method === "cancel") {
        const cancelled = await tasks.cancel(task.taskId);
        assert.equal(cancelled.status, "cancelled");
        assert.equal(cancelled.result, undefined);
        assert.deepEqual(await tasks.cancel(task.taskId), cancelled);
        assert.equal((await tasks.get(task.taskId)).status, "cancelled");
        await stopped(pids);
        await writeFile(path.join(opt.root, "check.test.js"), passingTest);
        const next = await tasks.start();
        assert.equal((await completed(tasks, next.taskId)).status, "completed");
      }
      await tasks.close();
      await stopped(pids);
      const store = await openTaskStore(opt);
      try {
        assert.equal(store.get(task.taskId).status, "cancelled");
      } finally {
        store.close();
      }
    },
  );

test(
  "durable task parent SIGKILL triggers worker cleanup and retains cancellation across restart",
  { timeout: 15000 },
  async (t) => {
    const opt = await setup(t, slow);
    const moduleURL = new URL("../src/validation-tasks.js", import.meta.url)
      .href;
    const parent = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {openValidationTasks} from ${JSON.stringify(moduleURL)}; const tasks=await openValidationTasks(${JSON.stringify(opt)}); process.send(await tasks.start());`,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    t.after(() => {
      parent.kill("SIGKILL");
    });
    const [task] = (await once(parent, "message", {
      signal: AbortSignal.timeout(5000),
    })) as [StoredValidationTask];
    const pids = await started(t, opt.root);
    await assert.rejects(openTaskStore(opt), /locked/);
    const exited = once(parent, "exit");
    assert.ok(parent.kill("SIGKILL"));
    await exited;
    await stopped(pids);
    let store;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        store = await openTaskStore(opt);
        break;
      } catch (error) {
        assert.match(String(error), /locked/);
        await delay(25);
      }
    }
    assert.ok(
      store,
      "Disconnected worker must release ownership after cleanup",
    );
    try {
      assert.equal(store.get(task.taskId).status, "cancelled");
    } finally {
      store.close();
    }
  },
);

test("durable task timeout retains incomplete native evidence rather than a passing result", async (t) => {
  const opt = await setup(t, slow, true);
  const tasks = await openValidationTasks({ ...opt, timeoutMs: 700 });
  t.after(() => tasks.close());
  const task = await tasks.start();
  const pids = await started(t, opt.root);
  const result = await completed(tasks, task.taskId);
  assert.equal(
    (result.result!.structuredContent as { outcome: string }).outcome,
    "incomplete",
  );
  assert.match(JSON.stringify(result.result), /"timedOut":true/);
  await stopped(pids);
});

test("oversized durable detail becomes an explicit tool error while the same native run fits summary mode", async (t) => {
  const source = passingTest + "\nconsole.log('x'.repeat(300000));";
  for (const detailed of [false, true]) {
    const opt = await setup(t, source, detailed);
    const tasks = await openValidationTasks(opt);
    try {
      const task = await tasks.start();
      const result = await completed(tasks, task.taskId);
      assert.equal(result.status, "completed");
      if (detailed) {
        assert.equal(result.result!.isError, true);
        assert.equal(result.result!.structuredContent, undefined);
      } else
        assert.equal(
          (result.result!.structuredContent as { outcome: string }).outcome,
          "passed",
        );
    } finally {
      await tasks.close();
    }
  }
});

test("durable task close during planning rejects new work and releases the store", async (t) => {
  const opt = await setup(t);
  const tasks = await openValidationTasks(opt);
  const started = assert.rejects(tasks.start(), /invalid|unavailable/);
  await tasks.close();
  await started;
  await tasks.close();
  await assert.rejects(tasks.start(), /closing/);
  const store = await openTaskStore(opt);
  store.close();
});
