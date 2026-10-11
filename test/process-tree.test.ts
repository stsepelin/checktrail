import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { runProcess } from "../src/runner.js";
import { fixture } from "./helpers.js";
import {
  darwinProcessIdentities,
  ownedDescendants,
  processSnapshot,
  stopDescendants,
} from "../src/process-tree.js";
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

test("POSIX cleanup quiesces parents before children, signals children first, and waits for all identities to disappear without touching siblings", async () => {
  const root = { pid: 41, parent: 10, group: 41, identity: "root" };
  const parent = {
    pid: 42,
    parent: 41,
    group: 42,
    identity: "parent",
    state: "running" as "running" | "stopped" | "exited",
  };
  const child = {
    pid: 43,
    parent: 42,
    group: 43,
    identity: "child",
    state: "running" as "running" | "stopped" | "exited",
  };
  const sibling = { pid: 44, parent: 10, group: 44, identity: "unrelated" };
  const rows = new Map([root, parent, child, sibling].map((p) => [p.pid, p]));
  const events: string[] = [];
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
    stop: (pid) => {
      assert.notEqual(pid, sibling.pid);
      events.push("stop-" + pid);
      (rows.get(pid)! as typeof parent).state = "stopped";
    },
    kill: (pid) => {
      assert.equal(
        parent.state,
        "stopped",
        "A waiting parent cannot start replacement work",
      );
      if (pid === child.pid) {
        assert.equal(child.state, "stopped");
        child.state = "exited";
      }
      if (pid === parent.pid)
        assert.ok(
          remaining.has(child.pid),
          "Child signal precedes the parent signal",
        );
      events.push("kill-" + pid);
      remaining.set(pid, 2);
    },
    now: () => elapsed,
    wait: async (ms) => {
      elapsed += ms;
    },
  });
  assert.deepEqual(events, ["stop-42", "stop-43", "kill-43", "kill-42"]);
  assert.deepEqual([...rows.keys()], [41, 44]);
  assert.ok(
    elapsed > 25,
    "Signal delivery alone cannot confirm either descendant's exit",
  );
  for (const reaps of [true, false]) {
    const exited = {
      pid: 52,
      parent: 51,
      group: 52,
      identity: "unreaped-child",
      state: "stopped" as "stopped" | "exited",
    };
    const rows = new Map([exited].map((p) => [p.pid, p]));
    let elapsed = 0,
      signalled = false,
      rootStopped = false;
    const running = stopDescendants(
      51,
      {
        snapshot: async () => {
          if (reaps && rootStopped && elapsed >= 50) rows.delete(exited.pid);
          return [
            { pid: 51, parent: 10, group: 51, identity: "root" },
            ...rows.values(),
          ];
        },
        exists: (pid) => rows.has(pid),
        stop: () => assert.fail("The child was already observed stopped"),
        kill: (pid) => {
          assert.equal(pid, exited.pid);
          assert.equal(signalled, false);
          signalled = true;
          exited.state = "exited";
        },
        now: () => elapsed,
        wait: async (ms) => {
          elapsed += ms;
        },
      },
      () => {
        rootStopped = true;
      },
    );
    if (reaps) {
      await running;
      assert.equal(rows.size, 0);
    } else {
      await assert.rejects(running, /cleanup deadline/);
      assert.equal(rows.size, 1);
    }
    assert.equal(signalled, true);
    assert.equal(rootStopped, true);
    assert.ok(
      elapsed <= 2000,
      "An exited but unreaped process still shares the cleanup deadline",
    );
  }
});

test("POSIX cleanup confirms every observed descendant disappeared before killing its waiting parent and never touches unrelated siblings", async () => {
  const root = { pid: 41, parent: 10, group: 41, identity: "root" };
  const parent = {
    pid: 42,
    parent: 41,
    group: 42,
    identity: "parent",
    state: "running" as "running" | "stopped",
  };
  const child = {
    pid: 43,
    parent: 42,
    group: 43,
    identity: "child",
    state: "running" as "running" | "stopped",
  };
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
    stop: (pid) => {
      (rows.get(pid)! as typeof parent).state = "stopped";
    },
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
      elapsed = 0,
      stopped = false;
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
        return [
          root,
          {
            ...child,
            state: stopped ? ("stopped" as const) : ("running" as const),
          },
        ];
      },
      stop: (pid: number) => {
        assert.equal(pid, child.pid);
        stopped = true;
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

test("POSIX cleanup stops a quiesced root after direct children are signalled and before requiring their reaping", async () => {
  const root = { pid: 41, parent: 10, group: 41, identity: "root" },
    child = { pid: 42, parent: 41, group: 42, identity: "child" };
  const rows = new Map([root, child].map((p) => [p.pid, p]));
  const events: string[] = [];
  let signalled = false,
    stopped = false;
  await stopDescendants(
    41,
    {
      snapshot: async () =>
        [...rows.values()].map((p) =>
          p.pid === child.pid
            ? {
                ...p,
                state: stopped ? ("stopped" as const) : ("running" as const),
              }
            : p,
        ),
      stop: (pid) => {
        assert.equal(pid, child.pid);
        stopped = true;
      },
      kill: (pid) => {
        assert.equal(stopped, true);
        assert.equal(pid, 42);
        signalled = true;
        events.push("child-signalled");
      },
      exists: (pid) => rows.has(pid),
      now: () => 0,
      wait: async () => {
        assert.equal(
          rows.has(root.pid),
          true,
          "No reaping wait after root termination",
        );
        assert.equal(
          signalled,
          false,
          "Release the stopped root before waiting to reap signalled direct children",
        );
      },
    },
    () => {
      assert.equal(signalled, true);
      events.push("root-stopped");
      rows.delete(41);
      rows.delete(42);
    },
  );
  assert.deepEqual(events, ["child-signalled", "root-stopped"]);
  let noChildrenStopped = 0;
  await stopDescendants(
    41,
    {
      snapshot: async () => [root],
      stop: () => assert.fail("No descendant"),
      kill: () => assert.fail("No descendant"),
      exists: () => false,
      now: () => 0,
      wait: async () => assert.fail("No waiting"),
    },
    () => {
      noChildrenStopped++;
    },
  );
  assert.equal(noChildrenStopped, 1);
});

test(
  "native POSIX cancellation prevents a detached waiting parent from replacing its killed child",
  { skip: process.platform === "win32" },
  async (t) => {
    const cleanupErrors: string[] = [];
    t.after(() =>
      assert.deepEqual(
        cleanupErrors,
        [],
        "Owned replacement helper cleanup failed",
      ),
    );
    for (let iteration = 0; iteration < 3; iteration++) {
      const root = await fixture(t, {}),
        ready = path.join(root, "ready.json"),
        replaced = path.join(root, "replacement.json"),
        started = path.join(root, "root.json"),
        controller = new AbortController();
      const middle =
        'const fs=require("node:fs"),cp=require("node:child_process");const leaf=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});leaf.on("spawn",()=>fs.writeFileSync(process.argv[1],JSON.stringify({middle:process.pid,leaf:leaf.pid})));leaf.on("exit",()=>{const replacement=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});replacement.on("spawn",()=>fs.writeFileSync(process.argv[2],JSON.stringify({replacement:replacement.pid})));});setInterval(()=>{},1000);';
      const outer =
        'const fs=require("node:fs"),cp=require("node:child_process");cp.spawn(process.execPath,["-e",process.argv[1],process.argv[2],process.argv[3]],{detached:true,stdio:"ignore"});fs.writeFileSync(process.argv[4],JSON.stringify({root:process.pid}));setInterval(()=>{},1000);';
      const running = runProcess(
        root,
        {
          executable: process.execPath,
          args: ["-e", outer, middle, ready, replaced, started],
          cwd: ".",
        },
        { timeoutMs: 10000, signal: controller.signal },
      );
      const owned = new Map<
        number,
        Awaited<ReturnType<typeof processSnapshot>>[number]
      >();
      const witness = async (
        filename: string,
      ): Promise<Record<string, number>> => {
        for (let count = 0; count < 500; count++) {
          try {
            return JSON.parse(await readFile(filename, "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await delay(10);
        }
        assert.fail("Native process witness was not reached");
      };
      try {
        const initial = {
          ...(await witness(started)),
          ...(await witness(ready)),
        };
        for (const row of await processSnapshot())
          if (Object.values(initial).includes(row.pid)) owned.set(row.pid, row);
        assert.equal(
          owned.size,
          3,
          "All three actual family members are alive before cancellation",
        );
        controller.abort();
        const stopped = await running;
        assert.equal(stopped.cancelled, true);
        assert.equal(stopped.errorCode, undefined);
        await delay(50);
        let replacement: number | undefined;
        try {
          replacement = JSON.parse(
            await readFile(replaced, "utf8"),
          ).replacement;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const after = new Map(
          (await processSnapshot()).map((row) => [row.pid, row]),
        );
        if (replacement !== undefined && after.has(replacement))
          owned.set(replacement, after.get(replacement)!);
        assert.equal(
          replacement,
          undefined,
          "A waiting descendant must not spawn new work during cleanup",
        );
        for (const observed of owned.values())
          assert.notEqual(
            after.get(observed.pid)?.identity,
            observed.identity,
            "An observed native family member survived cleanup",
          );
      } finally {
        controller.abort();
        await running;
        const after = new Map(
          (await processSnapshot()).map((row) => [row.pid, row]),
        );
        for (const before of owned.values())
          if (after.get(before.pid)?.identity === before.identity)
            try {
              process.kill(before.pid, "SIGKILL");
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

test("POSIX cleanup captures a child forked before its parent's stop acknowledgement and never accepts an unacknowledged stop", async () => {
  for (const acknowledges of [true, false]) {
    const root = { pid: 41, parent: 10, group: 41, identity: "root" },
      parent = {
        pid: 42,
        parent: 41,
        group: 42,
        identity: "parent",
        state: "running" as "running" | "stopped",
      },
      lateChild = {
        pid: 43,
        parent: 42,
        group: 43,
        identity: "late-child",
        state: "running" as "running" | "stopped",
      };
    const rows = new Map([root, parent].map((p) => [p.pid, p]));
    const killed: number[] = [],
      stopped: number[] = [];
    let elapsed = 0;
    const running = stopDescendants(41, {
      snapshot: async () => [...rows.values()],
      exists: (pid) => rows.has(pid),
      stop: (pid) => {
        stopped.push(pid);
        if (pid === parent.pid) rows.set(lateChild.pid, lateChild);
        if (acknowledges) (rows.get(pid)! as typeof parent).state = "stopped";
      },
      kill: (pid) => {
        killed.push(pid);
        rows.delete(pid);
      },
      now: () => elapsed,
      wait: async (ms) => {
        elapsed += ms;
      },
    });
    if (acknowledges) {
      await running;
      assert.deepEqual(stopped, [42, 43]);
      assert.deepEqual(killed, [43, 42]);
    } else {
      await assert.rejects(running, /cleanup deadline/);
      assert.ok(elapsed <= 2000);
      assert.ok(stopped.includes(43));
    }
    assert.deepEqual(
      [...rows.keys()],
      [41],
      "Recovery also releases safely identified family members after an incomplete stop",
    );
  }
});

test("Darwin process status parser retains unknown status without inventing quiescence and canonicalises physical start identities", () => {
  const rows = darwinProcessIdentities(
    "42 41 42 ? Mon Jan 5 12:00:00 2026    \n43 42 43 T Mon Jan 5 12:00:00 2026\n44 41 44 Z+ Mon Jan 5 12:00:00 2026\n45 41 45 ST Mon Jan 5 12:00:00 2026\n",
  );
  assert.deepEqual(
    rows.map((p) => p.state),
    ["running", "stopped", "exited", "running"],
  );
  assert.equal(
    rows[0]!.identity,
    rows[1]!.identity,
    "ps column padding is not part of the start identity",
  );
  for (const bad of [
    "",
    "42 41 42 T",
    "42 invalid 42 T Mon Jan 5 12:00:00 2026",
  ])
    assert.throws(() => darwinProcessIdentities(bad), /snapshot/);
});
