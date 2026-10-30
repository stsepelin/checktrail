import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { ProcessIdentity } from "../src/process-tree.js";

export async function fixture(
  t: Pick<TestContext, "after">,
  files: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "checktrail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
  return root;
}

export const nodeManifest = JSON.stringify({
  private: true,
  type: "module",
  scripts: { test: "node --test" },
});
export const passingTest =
  "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('adds integers', () => assert.equal(2 + 3, 5));";

export interface FixtureProcessGroup {
  owner: ProcessIdentity;
  members: ProcessIdentity[];
}
export async function captureFixtureProcessGroup(
  pid: number,
  parent: number,
): Promise<FixtureProcessGroup> {
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    !Number.isSafeInteger(parent) ||
    parent <= 0
  )
    throw Error("Invalid fixture process identity");
  const { processSnapshot, ownedDescendants } =
    await import("../src/process-tree.js");
  const rows = await processSnapshot();
  const body = rows.find((row) => row.pid === pid);
  if (!body || body.parent !== parent)
    throw Error("Fixture process parent differs");
  const owner = rows.find((row) => row.pid === body.group);
  if (!owner || owner.group !== owner.pid || owner.pid === process.pid)
    throw Error("Process group is outside this fixture");
  let ancestor = owner.parent;
  const seen = new Set<number>();
  while (ancestor !== process.pid && !seen.has(ancestor) && seen.size < 64) {
    seen.add(ancestor);
    const row = rows.find((row) => row.pid === ancestor);
    if (!row) break;
    ancestor = row.parent;
  }
  if (ancestor !== process.pid)
    throw Error("Process group is outside this fixture");
  return {
    owner,
    members: ownedDescendants(rows, owner.pid).map((row) => row.process),
  };
}
export interface FixtureCleanupControl {
  snapshot(
    pids: readonly number[],
    timeoutMs: number,
  ): Promise<ProcessIdentity[]>;
  exists(pid: number): boolean;
  kill(pid: number): void;
  now(): number;
  wait(ms: number): Promise<void>;
}
export async function cleanupFixtureProcessGroup(
  group: FixtureProcessGroup,
  provided?: FixtureCleanupControl,
): Promise<void> {
  const { processSnapshot } = await import("../src/process-tree.js");
  const io: FixtureCleanupControl = provided ?? {
    snapshot: processSnapshot,
    exists: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    },
    kill: (pid) => {
      process.kill(pid, "SIGKILL");
    },
    now: () => performance.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const captured = [...group.members, group.owner],
    deadline = io.now() + 5000;
  const checkDeadline = () => {
    if (io.now() >= deadline)
      throw Error("Observed fixture process group survived cleanup");
  };
  const snapshot = async (pids: number[]) => {
    checkDeadline();
    const rows = await io.snapshot(
      pids,
      Math.max(1, Math.min(1000, Math.floor(deadline - io.now()))),
    );
    checkDeadline();
    return new Map(rows.map((row) => [row.pid, row]));
  };
  const same = (row: ProcessIdentity, rows: Map<number, ProcessIdentity>) => {
    const current = rows.get(row.pid);
    if (!current) {
      if (io.exists(row.pid))
        throw Error("Fixture process identity unavailable");
      return false;
    }
    if (current.identity !== row.identity) return false;
    const exiting =
      current.state === "exited" &&
      current.parent === 0 &&
      current.group === -1;
    if (current.group !== row.group && !exiting)
      throw Error("Fixture process identity changed group");
    return true;
  };
  for (const row of captured) {
    checkDeadline();
    // ESRCH is physical disappearance. A dead family needs no host enumeration.
    if (!io.exists(row.pid)) continue;
    const rows = await snapshot([row.pid]);
    if (!same(row, rows) || rows.get(row.pid)!.state === "exited") continue;
    try {
      io.kill(row.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  for (;;) {
    checkDeadline();
    const remaining = captured.filter((row) => io.exists(row.pid));
    if (!remaining.length) return;
    const rows = await snapshot(remaining.map((row) => row.pid));
    if (!remaining.some((row) => same(row, rows))) return;
    await io.wait(Math.min(25, deadline - io.now()));
  }
}
