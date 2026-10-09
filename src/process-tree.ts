import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
export interface ProcessIdentity {
  pid: number;
  parent: number;
  group: number;
  identity: string;
}
export function ownedDescendants(rows: ProcessIdentity[], root: number) {
  if (
    !Number.isSafeInteger(root) ||
    root <= 1 ||
    rows.length > 65536 ||
    new Set(rows.map((r) => r.pid)).size !== rows.length
  )
    throw Error("Process tree snapshot invalid");
  const owned = new Map<number, { process: ProcessIdentity; depth: number }>();
  for (const row of rows)
    if (row.pid === root || row.group === root)
      owned.set(row.pid, { process: row, depth: 0 });
  for (let round = 0; round < 64; round++) {
    let changed = false;
    for (const row of rows)
      if (!owned.has(row.pid) && owned.has(row.parent)) {
        const depth = owned.get(row.parent)!.depth + 1;
        if (depth > 64) throw Error("Process tree depth exceeds bound");
        owned.set(row.pid, { process: row, depth });
        changed = true;
      }
    if (!changed) {
      // Group membership finds orphaned members; ancestry supplies actual ordering.
      for (const item of owned.values()) {
        let parent = item.process.parent;
        item.depth = 0;
        while (owned.has(parent)) {
          item.depth++;
          if (item.depth > 64) throw Error("Process tree depth exceeds bound");
          parent = owned.get(parent)!.process.parent;
        }
      }
      return [...owned.values()]
        .filter((r) => r.process.pid !== root)
        .sort((a, b) => b.depth - a.depth);
    }
  }
  throw Error("Process tree depth exceeds bound");
}
function linuxIdentity(pid: number, text: string): ProcessIdentity {
  const end = text.lastIndexOf(") "),
    fields = text
      .slice(end + 2)
      .trim()
      .split(/\s+/);
  if (
    text.length > 4096 ||
    !text.startsWith(pid + " (") ||
    end < 0 ||
    fields.length < 20 ||
    !/^[0-9]+$/.test(fields[1]!) ||
    !/^[0-9]+$/.test(fields[2]!) ||
    !/^[0-9]+$/.test(fields[19]!)
  )
    throw Error("Process identity invalid");
  return {
    pid,
    parent: Number(fields[1]),
    group: Number(fields[2]),
    identity: fields[19]!,
  };
}
export async function processSnapshot(): Promise<ProcessIdentity[]> {
  if (process.platform === "linux") {
    const ids = (await readdir("/proc")).filter((p) =>
      /^[1-9][0-9]{0,8}$/.test(p),
    );
    if (ids.length > 65536) throw Error("Process snapshot exceeds bound");
    const rows: ProcessIdentity[] = [];
    // Batch reads; processes can exit during collection. No command lines or environments are read.
    for (let i = 0; i < ids.length; i += 64) {
      const batch = await Promise.all(
        ids.slice(i, i + 64).map(async (id) => {
          try {
            return linuxIdentity(
              Number(id),
              await readFile("/proc/" + id + "/stat", "utf8"),
            );
          } catch (error) {
            if (
              ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(
                (error as NodeJS.ErrnoException).code ?? "",
              )
            )
              return undefined;
            throw error;
          }
        }),
      );
      rows.push(...batch.filter((r) => r !== undefined));
    }
    return rows;
  }
  if (process.platform !== "darwin")
    throw Error("Process snapshot platform unsupported");
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 1000,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  });
  if (
    result.status !== 0 ||
    result.error ||
    result.signal ||
    result.stderr.trim()
  )
    throw Error("Process snapshot unavailable");
  const rows = result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+(.+)$/.exec(line);
      if (!match) throw Error("Process snapshot malformed");
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        identity: match[4]!,
      };
    });
  if (rows.length > 65536) throw Error("Process snapshot exceeds bound");
  return rows;
}
interface StopDescendantIo {
  snapshot(): Promise<ProcessIdentity[]>;
  kill(pid: number): void;
  exists(pid: number): boolean;
  now(): number;
  wait(ms: number): Promise<void>;
}
const nativeControl: StopDescendantIo = {
  snapshot: processSnapshot,
  kill: (pid) => {
    process.kill(pid, "SIGKILL");
  },
  exists: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  },
  now: () => performance.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
/** Stop observed descendants before their waiting parents, including separate groups.
 * Confirm their observed identities disappeared before advancing; sending SIGKILL
 * is not proof of exit or reaping. All depths share a bounded cleanup deadline.
 */
export async function stopDescendants(
  root: number,
  io = nativeControl,
  stopRoot?: () => void,
) {
  let rootStopped = false;
  const finishRoot = () => {
    if (!rootStopped) {
      rootStopped = true;
      stopRoot?.();
    }
  };
  const deadline = io.now() + 2000;
  const selected = ownedDescendants(await io.snapshot(), root);
  const sameProcess = (
    child: ProcessIdentity,
    current: Map<number, ProcessIdentity>,
  ) => {
    const identity = current.get(child.pid);
    if (!identity) {
      if (io.exists(child.pid))
        throw Error("Process cleanup identity unavailable");
      return false;
    }
    if (identity.identity !== child.identity) return false;
    if (identity.group !== child.group)
      throw Error("Process cleanup identity changed group");
    return true;
  };
  for (const depth of [...new Set(selected.map((r) => r.depth))].sort(
    (a, b) => b - a,
  )) {
    const children = selected
      .filter((r) => r.depth === depth)
      .map((r) => r.process);
    const current = new Map((await io.snapshot()).map((p) => [p.pid, p]));
    for (const child of children) {
      if (!sameProcess(child, current)) continue;
      if (io.now() >= deadline)
        throw Error("Process cleanup deadline exceeded");
      try {
        io.kill(child.pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    // A quiesced root cannot reap direct children. Stop it after those children
    // are signalled so the system reaper can finish them without resuming work.
    if (depth <= 1) finishRoot();
    while (true) {
      const remaining = new Map((await io.snapshot()).map((p) => [p.pid, p]));
      if (!children.some((child) => sameProcess(child, remaining))) break;
      if (io.now() >= deadline)
        throw Error("Process cleanup deadline exceeded");
      await io.wait(25);
    }
  }
  finishRoot();
}
