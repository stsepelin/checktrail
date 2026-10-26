import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

function cleanupDiagnostic(phase: string, error: unknown, detail: object = {}) {
  const known = [
    "Process tree snapshot invalid",
    "Process tree depth exceeds bound",
    "Process identity invalid",
    "Process snapshot exceeds bound",
    "Process snapshot unavailable",
    "Process snapshot platform unsupported",
    "Process snapshot is empty",
    "Process snapshot malformed",
    "Process cleanup identity unavailable",
    "Process cleanup identity changed group",
    "Process cleanup deadline exceeded",
    "Process cleanup root identity changed",
  ];
  const message = error instanceof Error ? error.message : "";
  const code = (error as NodeJS.ErrnoException | null)?.code;
  process.stderr.write(
    JSON.stringify({
      event: "temporary-cleanup-diagnostic",
      phase,
      platform: process.platform,
      pid: process.pid,
      reason: known.includes(message) ? message : "unclassified",
      code:
        typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)
          ? code
          : null,
      ...detail,
    }) + "\n",
  );
}

export interface ProcessIdentity {
  pid: number;
  parent: number;
  group: number;
  identity: string;
  state?: "running" | "stopped" | "exited";
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
    !/^[A-Za-z]$/.test(fields[0]!) ||
    !/^[0-9]+$/.test(fields[1]!) ||
    !/^[0-9]+$/.test(fields[2]!) ||
    !/^[0-9]+$/.test(fields[19]!)
  ) {
    cleanupDiagnostic("linux-stat-shape", Error("Process identity invalid"), {
      observedPid: pid,
      textBytes: Buffer.byteLength(text),
      prefixMatches: text.startsWith(pid + " ("),
      delimiterPresent: end >= 0,
      fieldCount: fields.length,
      stateValid: /^[A-Za-z]$/.test(fields[0]!),
      parentValid: /^[0-9]+$/.test(fields[1]!),
      groupValid: /^[0-9]+$/.test(fields[2]!),
      startTimeValid: /^[0-9]+$/.test(fields[19]!),
    });
    throw Error("Process identity invalid");
  }
  return {
    pid,
    parent: Number(fields[1]),
    group: Number(fields[2]),
    identity: fields[19]!,
    state: /^[Tt]$/.test(fields[0]!)
      ? "stopped"
      : /^[ZX]$/.test(fields[0]!)
        ? "exited"
        : "running",
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
  const snapshotStarted = performance.now();
  const result = spawnSync(
    "/bin/ps",
    ["-axo", "pid=,ppid=,pgid=,stat=,lstart="],
    {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 1000,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    },
  );
  if (
    result.status !== 0 ||
    result.error ||
    result.signal ||
    result.stderr.trim()
  ) {
    cleanupDiagnostic("snapshot-command", result.error, {
      status: result.status,
      signal: result.signal,
      elapsedMs: performance.now() - snapshotStarted,
      stderrBytes: Buffer.byteLength(result.stderr),
    });
    throw Error("Process snapshot unavailable");
  }
  return darwinProcessIdentities(result.stdout).filter(
    (row) => row.pid !== result.pid,
  );
}
/** Unknown Darwin status is never evidence of quiescence. */
export function darwinProcessIdentities(text: string): ProcessIdentity[] {
  if (!text.trim()) throw Error("Process snapshot is empty");
  const rows = text
    .trim()
    .split("\n")
    .map((line) => {
      const match =
        /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([A-Za-z?][A-Za-z0-9+<>?-]{0,15})\s+(.+)$/.exec(
          line,
        );
      if (!match) throw Error("Process snapshot malformed");
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        identity: match[5]!.trim(),
        state: match[4]!.startsWith("T")
          ? ("stopped" as const)
          : match[4]!.startsWith("Z")
            ? ("exited" as const)
            : ("running" as const),
      };
    });
  if (rows.length > 65536) throw Error("Process snapshot exceeds bound");
  return rows;
}
interface StopDescendantIo {
  snapshot(): Promise<ProcessIdentity[]>;
  stop(pid: number): void;
  kill(pid: number): void;
  exists(pid: number): boolean;
  now(): number;
  wait(ms: number): Promise<void>;
}
const nativeControl: StopDescendantIo = {
  snapshot: processSnapshot,
  stop: (pid) => {
    process.kill(pid, "SIGSTOP");
  },
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
/** Quiesce the observed family before any child can trigger replacement work.
 * Signal deepest children before their stopped parents, then confirm every observed
 * identity disappeared. Stopped parents cannot reap children, so reaping is checked
 * after the family and root are terminated. One deadline bounds the entire cleanup.
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
  let diagnosticPhase = "initial",
    diagnosticCurrent: ProcessIdentity[] = [];
  const observed = new Map<
    number,
    { process: ProcessIdentity; depth: number }
  >();
  const signalled = new Set<number>();
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
  const checkDeadline = () => {
    if (io.now() >= deadline) throw Error("Process cleanup deadline exceeded");
  };
  const signal = (pid: number, kind: "stop" | "kill") => {
    try {
      io[kind](pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const first = await io.snapshot().catch((error) => {
      cleanupDiagnostic("first-snapshot", error, { root });
      throw error;
    }),
    initialRoot = first.find((p) => p.pid === root);
  let rows = first;
  try {
    // A parent can fork between the initial snapshot and its SIGSTOP. Capture again
    // until every discovered identity is observed stopped or already exited.
    diagnosticPhase = "quiesce";
    for (;;) {
      checkDeadline();
      const current = new Map(rows.map((p) => [p.pid, p]));
      diagnosticCurrent = [...current.values()];
      if (
        initialRoot &&
        current.get(root) &&
        current.get(root)!.identity !== initialRoot.identity
      )
        throw Error("Process cleanup root identity changed");
      const selected = ownedDescendants(rows, root);
      let added = false;
      for (const entry of selected) {
        if (!observed.has(entry.process.pid)) {
          observed.set(entry.process.pid, entry);
          added = true;
        }
      }
      let pending = false;
      for (const child of [...observed.values()].sort(
        (a, b) => a.depth - b.depth,
      )) {
        if (!sameProcess(child.process, current)) continue;
        const state = current.get(child.process.pid)!.state;
        if (state !== "stopped" && state !== "exited") {
          pending = true;
          signal(child.process.pid, "stop");
        }
      }
      if (!added && !pending) break;
      await io.wait(Math.min(10, deadline - io.now()));
      rows = await io.snapshot();
    }
    diagnosticPhase = "signal";
    for (const depth of [
      ...new Set([...observed.values()].map((entry) => entry.depth)),
    ].sort((a, b) => b - a)) {
      const children = [...observed.values()].filter(
        (entry) => entry.depth === depth,
      );
      const current = new Map((await io.snapshot()).map((p) => [p.pid, p]));
      diagnosticCurrent = [...current.values()];
      for (const entry of children) {
        checkDeadline();
        if (!sameProcess(entry.process, current)) continue;
        signal(entry.process.pid, "kill");
        signalled.add(entry.process.pid);
      }
      if (depth <= 1) finishRoot();
      // A stopped parent cannot reap a zombie. Confirm physical exit (or complete
      // disappearance) before signalling the next parent, then require final reaping.
      for (;;) {
        const current = new Map((await io.snapshot()).map((p) => [p.pid, p]));
        diagnosticCurrent = [...current.values()];
        if (
          !children.some(
            (entry) =>
              sameProcess(entry.process, current) &&
              current.get(entry.process.pid)!.state !== "exited",
          )
        )
          break;
        checkDeadline();
        await io.wait(Math.min(25, deadline - io.now()));
      }
    }
    finishRoot();
    diagnosticPhase = "reap";
    for (;;) {
      const current = new Map((await io.snapshot()).map((p) => [p.pid, p]));
      diagnosticCurrent = [...current.values()];
      if (
        ![...observed.values()].some((child) =>
          sameProcess(child.process, current),
        )
      )
        break;
      checkDeadline();
      await io.wait(Math.min(25, deadline - io.now()));
    }
  } catch (error) {
    cleanupDiagnostic(diagnosticPhase, error, {
      root,
      elapsedMs: io.now() - (deadline - 2000),
      observedCount: observed.size,
      signalled: [...signalled],
      current: diagnosticCurrent
        .filter((p) => observed.has(p.pid))
        .slice(0, 16)
        .map(({ pid, parent, group, state }) => ({
          pid,
          parent,
          group,
          state,
        })),
    });
    // An incomplete cleanup must still try to release each safely identified stopped
    // process. Never signal a reused or unreadable identity as a recovery shortcut.
    const current = new Map((await io.snapshot()).map((p) => [p.pid, p]));
    for (const child of observed.values()) {
      try {
        if (
          !signalled.has(child.process.pid) &&
          sameProcess(child.process, current)
        )
          signal(child.process.pid, "kill");
      } catch {
        /* The original cleanup error remains incomplete. */
      }
    }
    throw error;
  } finally {
    finishRoot();
  }
}
