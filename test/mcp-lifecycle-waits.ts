import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

function phase<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000)
    throw new Error("Invalid lifecycle phase bound");
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
export function waitForMcpStartup<T>(
  ready: Promise<T>,
  closed: Promise<unknown>,
  timeoutMs = 30_000,
): Promise<T> {
  return phase(
    Promise.race([
      ready,
      closed.then(() => {
        throw new Error("MCP closed before startup evidence");
      }),
    ]),
    timeoutMs,
    "MCP startup evidence deadline exceeded",
  );
}
export function waitForMcpShutdown(
  closed: Promise<unknown>,
  timeoutMs = 5_000,
): Promise<unknown> {
  return phase(closed, timeoutMs, "MCP shutdown deadline exceeded");
}
export async function waitForValidationPid(
  root: string,
  child: Pick<ChildProcess, "exitCode" | "signalCode">,
  timeoutMs = 30_000,
): Promise<{ pid: number; group: number }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000)
    throw new Error("Invalid lifecycle startup bound");
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("MCP closed before validation startup evidence");
    try {
      const marker: unknown = JSON.parse(
        await readFile(path.join(root, ".checktrail", "started.json"), "utf8"),
      );
      if (
        !marker ||
        typeof marker !== "object" ||
        !("pid" in marker) ||
        !("group" in marker) ||
        !Number.isSafeInteger(marker.pid) ||
        !Number.isSafeInteger(marker.group) ||
        Number(marker.pid) <= 0 ||
        Number(marker.group) <= 0
      )
        throw new Error("Invalid validation startup marker");
      return { pid: Number(marker.pid), group: Number(marker.group) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(Math.min(25, Math.max(1, deadline - performance.now())));
  }
  throw new Error("Synthetic validation startup evidence deadline exceeded");
}
