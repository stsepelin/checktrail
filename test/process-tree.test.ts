import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../src/runner.js";
import { fixture } from "./helpers.js";
import { ownedDescendants, stopDescendants } from "../src/process-tree.js";
test("process ownership includes escaped descendants and orphaned group members but excludes sibling tasks", () => {
  const rows = [
    { pid: 41, parent: 10, group: 41, identity: "first" },
    { pid: 42, parent: 41, group: 42, identity: "second" },
    { pid: 43, parent: 42, group: 43, identity: "third" },
    { pid: 44, parent: 1, group: 41, identity: "orphan" },
    { pid: 45, parent: 10, group: 45, identity: "sibling" },
    { pid: 46, parent: 45, group: 46, identity: "sibling-child" },
  ];
  assert.deepEqual(
    ownedDescendants(rows, 41).map((r) => [r.process.pid, r.depth]),
    [
      [43, 2],
      [42, 1],
      [44, 0],
    ],
  );
  assert.deepEqual(
    ownedDescendants([...rows].reverse(), 41).map((r) => [
      r.process.pid,
      r.depth,
    ]),
    [
      [43, 2],
      [42, 1],
      [44, 0],
    ],
  );
  // Membership in the original group does not erase parent/child ordering.
  assert.deepEqual(
    ownedDescendants(
      [
        { pid: 41, parent: 10, group: 41, identity: "root" },
        { pid: 42, parent: 41, group: 41, identity: "waiting-parent" },
        { pid: 43, parent: 42, group: 41, identity: "child" },
      ],
      41,
    ).map((r) => [r.process.pid, r.depth]),
    [
      [43, 2],
      [42, 1],
    ],
  );
  assert.throws(() => ownedDescendants([...rows, rows[0]!], 41));
  assert.throws(() => ownedDescendants(rows, 1));
});

test(
  "native POSIX cancellation kills a detached descendant before its waiting parent and leaves no owned process",
  { skip: process.platform === "win32" },
  async (t) => {
    const cleanupErrors: string[] = [];
    t.after(() =>
      assert.deepEqual(cleanupErrors, [], "Owned helper cleanup failed"),
    );
    const root = await fixture(t, {}),
      marker = path.join(root, "started.json"),
      controller = new AbortController();
    const body =
      'const fs=require("node:fs"),cp=require("node:child_process");const child=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});child.on("spawn",()=>fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:child.pid})));setInterval(()=>{},1000);';
    const running = runProcess(
      root,
      { executable: process.execPath, args: ["-e", body, marker], cwd: "." },
      { timeoutMs: 5000, signal: controller.signal },
    );
    let record: { parent: number; child: number } | undefined;
    try {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try {
          record = JSON.parse(await readFile(marker, "utf8"));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(record, "Detached helper actually started");
      controller.abort();
      const result = await running;
      assert.equal(result.cancelled, true);
      assert.equal(result.errorCode, undefined);
      for (const pid of [record.parent, record.child]) {
        let alive = true;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") {
              alive = false;
              break;
            }
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(alive, false, "Owned native PID still alive: " + pid);
      }
    } finally {
      controller.abort();
      await running;
      if (record)
        for (const pid of [record.child, record.parent]) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH")
              cleanupErrors.push(
                (error as NodeJS.ErrnoException).code ?? "UNKNOWN",
              );
          }
        }
    }
  },
);

test("POSIX cleanup confirms every observed descendant disappeared before killing its waiting parent and never touches unrelated siblings", async () => {
  const root = { pid: 41, parent: 10, group: 41, identity: "root" };
  const parent = { pid: 42, parent: 41, group: 42, identity: "parent" };
  const child = { pid: 43, parent: 42, group: 43, identity: "child" };
  const sibling = { pid: 44, parent: 10, group: 44, identity: "unrelated" };
  const rows = new Map([root, parent, child, sibling].map((p) => [p.pid, p]));
  const killed: number[] = [];
  const remaining = new Map<number, number>();
  let elapsed = 0;
  await stopDescendants(41, {
    snapshot: async () => {
      for (const [pid, rounds] of remaining) {
        if (rounds === 0) {
          rows.delete(pid);
          remaining.delete(pid);
        } else remaining.set(pid, rounds - 1);
      }
      return [...rows.values()];
    },
    exists: (pid) => rows.has(pid),
    kill: (pid) => {
      if (pid === parent.pid)
        assert.equal(
          rows.has(child.pid),
          false,
          "waiting parent must remain until its child exited",
        );
      killed.push(pid);
      remaining.set(pid, 2);
    },
    now: () => elapsed,
    wait: async (ms) => {
      elapsed += ms;
    },
  });
  assert.deepEqual(killed, [43, 42]);
  assert.deepEqual([...rows.keys()], [41, 44]);
  assert.ok(
    elapsed > 25,
    "signal delivery alone cannot confirm either descendant's exit",
  );
});

test("POSIX cleanup refuses surviving unreadable or changed-group identities and preserves reused PIDs instead of inventing completion", async () => {
  const root = { pid: 41, parent: 10, group: 41, identity: "root" };
  const child = { pid: 42, parent: 41, group: 42, identity: "child" };
  for (const state of [
    "survives",
    "unreadable",
    "changed-group",
    "reused",
    "reused-after-signal",
  ] as const) {
    let snapshots = 0,
      elapsed = 0;
    const killed: number[] = [];
    const control = {
      snapshot: async () => {
        snapshots++;
        if (snapshots === 1) return [root, child];
        if (state === "unreadable") return [root];
        if (state === "changed-group") return [root, { ...child, group: 90 }];
        if (
          state === "reused" ||
          (state === "reused-after-signal" && killed.length)
        )
          return [root, { ...child, identity: "unrelated-new-process" }];
        return [root, child];
      },
      exists: () => true,
      kill: (pid: number) => {
        killed.push(pid);
      },
      now: () => elapsed,
      wait: async (ms: number) => {
        elapsed += ms;
      },
    };
    if (state === "reused" || state === "reused-after-signal") {
      await assert.doesNotReject(stopDescendants(41, control));
      assert.deepEqual(killed, state === "reused" ? [] : [42]);
    } else {
      await assert.rejects(stopDescendants(41, control), /Process cleanup/);
      assert.deepEqual(killed, state === "survives" ? [42] : []);
    }
    assert.ok(elapsed <= 2000, "all depths share the cleanup bound");
  }
});
