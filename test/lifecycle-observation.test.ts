import assert from "node:assert/strict";
import childProcesses, { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { processSnapshot, type ProcessIdentity } from "../src/process-tree.js";
import {
  cleanupLifecycleIdentities,
  lifecycleAlive,
  lifecycleProject,
} from "./lifecycle-platforms-fixture.js";

const posix = ["darwin", "linux"].includes(process.platform);
async function withChildren(
  t: TestContext,
  inspect: (
    pids: number[],
    rows: ProcessIdentity[],
    queries: number[][],
    closed: Promise<void>[],
  ) => Promise<void>,
) {
  const children: ChildProcess[] = [],
    closed: Promise<void>[] = [];
  try {
    for (let i = 0; i < 6; i++) {
      const child = spawn(
        process.execPath,
        ["-e", "process.send('ready');setInterval(()=>{},1000);"],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      children.push(child);
      closed.push(
        new Promise<void>((resolve) => child.once("close", () => resolve())),
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("Owned observation child did not become ready")),
          10000,
        );
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("message", (message) => {
          clearTimeout(timer);
          try {
            assert.equal(message, "ready");
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
    }
    const pids = children.map((child) => child.pid!),
      rows = await processSnapshot(pids),
      queries: number[][] = [];
    assert.equal(rows.length, pids.length);
    const originalSpawn = childProcesses.spawnSync,
      originalReadDir = fs.readdir,
      originalRead = fs.readFile;
    t.mock.method(
      childProcesses,
      "spawnSync",
      (...args: Parameters<typeof childProcesses.spawnSync>) => {
        if (args[0] === "/bin/ps") {
          const selection = args[1] as string[];
          assert.notEqual(
            selection[0],
            "-axo",
            "Global observation is deliberately unavailable for these known identities",
          );
          assert.equal(selection[0], "-p");
          queries.push(selection[1]!.split(",").map(Number));
        }
        return Reflect.apply(originalSpawn, childProcesses, args);
      },
    );
    t.mock.method(fs, "readdir", (...args: Parameters<typeof fs.readdir>) => {
      assert.notEqual(
        String(args[0]),
        "/proc",
        "Global observation is deliberately unavailable for these known identities",
      );
      return Reflect.apply(originalReadDir, fs, args);
    });
    t.mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
      const match = /^\/proc\/([1-9][0-9]*)\/stat$/.exec(String(args[0]));
      if (match) queries.push([Number(match[1])]);
      return Reflect.apply(originalRead, fs, args);
    });
    syncBuiltinESMExports();
    await inspect(pids, rows, queries, closed);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    await Promise.all(closed);
  }
}

test(
  "lifecycle fixture captures every reached identity without enumerating unrelated processes",
  { skip: !posix, timeout: 30000 },
  async (t) => {
    const project = await lifecycleProject(t);
    await withChildren(t, async (pids, rows, queries) => {
      const selected = [pids[0]!, pids[1]!, pids[2]!, pids[3]!];
      const actual = await project.identities({
        children: [selected[0]!, selected[1]!],
        body: selected[2]!,
        driver: selected[3]!,
      });
      assert.deepEqual(
        actual,
        selected.map((pid) => rows.find((row) => row.pid === pid)),
      );
      assert.deepEqual(queries.flat(), selected);
      assert.equal(lifecycleAlive(pids[4]!), true);
      assert.equal(lifecycleAlive(pids[5]!), true);
    });
  },
);

test(
  "lifecycle fallback cleanup uses fresh selected identities and preserves changed identity and group controls",
  { skip: !posix, timeout: 30000 },
  async (t) => {
    await withChildren(t, async (pids, rows, queries, closed) => {
      const row = (i: number) => rows.find((entry) => entry.pid === pids[i])!;
      await cleanupLifecycleIdentities([
        row(0),
        row(1),
        row(2),
        row(3),
        { ...row(4), identity: row(4).identity + "-control" },
        { ...row(5), group: row(5).group + 1 },
      ]);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(closed.slice(0, 4)),
          new Promise((_, reject) => {
            deadline = setTimeout(
              () =>
                reject(
                  Error("Selected owned children survived fallback cleanup"),
                ),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      assert.deepEqual(
        queries,
        pids.map((pid) => [pid]),
      );
      for (const pid of pids.slice(0, 4))
        assert.equal(lifecycleAlive(pid), false);
      for (const pid of pids.slice(4)) assert.equal(lifecycleAlive(pid), true);
    });
  },
);
