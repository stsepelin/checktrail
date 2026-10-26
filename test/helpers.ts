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
export async function cleanupFixtureProcessGroup(
  group: FixtureProcessGroup,
): Promise<void> {
  const { processSnapshot } = await import("../src/process-tree.js");
  const captured = [...group.members, group.owner];
  for (const row of captured) {
    const current = (await processSnapshot()).find(
      (current) => current.pid === row.pid,
    );
    if (current?.identity !== row.identity || current.group !== row.group)
      continue;
    try {
      process.kill(row.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const until = performance.now() + 5000;
  while (performance.now() < until) {
    const rows = await processSnapshot();
    if (
      captured.every(
        (row) =>
          !rows.some(
            (current) =>
              current.pid === row.pid && current.identity === row.identity,
          ),
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error("Observed fixture process group survived cleanup");
}
