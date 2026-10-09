import { captureProcessOutput } from "./process-output.js";
import { spawn } from "node:child_process";
import { stopDescendants } from "./process-tree.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withinRoot } from "./inventory.js";
import type { Command, ProcessResult } from "./types.js";

export interface RunOptions {
  /** Engine/operator-selected evidence capture; grants no execution authority. */
  captureRawOutput?: boolean;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  environment?: Record<string, string>;
}

export async function runProcess(
  root: string,
  command: Command,
  options: RunOptions,
): Promise<ProcessResult & { outputBytes: number }> {
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 120_000
  ) {
    throw new Error("Timeout must be between 1 and 120000 milliseconds");
  }
  if (
    options.captureRawOutput &&
    (!Number.isInteger(options.maxOutputBytes ?? 1024 * 1024) ||
      (options.maxOutputBytes ?? 1024 * 1024) < 0 ||
      (options.maxOutputBytes ?? 1024 * 1024) > 16 * 1024 * 1024)
  )
    throw new Error(
      "Captured output limit must be between 0 and 16777216 bytes",
    );
  const started = performance.now();
  const result: ProcessResult & { outputBytes: number } = {
    command,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    truncated: false,
    outputBytes: 0,
  };
  if (options.signal?.aborted) return { ...result, cancelled: true };
  if (process.platform === "win32")
    return (await import("./windows-process.js")).runWindowsProcess(
      root,
      command,
      options,
    );
  const cwd = await withinRoot(root, command.cwd);
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, options.environment, command.env);
  const temporary = command.temporaryDirectory
    ? await mkdtemp(path.join(tmpdir(), "checktrail-command-"))
    : undefined;
  if (temporary) env.CHECKTRAIL_TEMP = temporary;
  try {
    return await new Promise((resolve) => {
      const child = spawn(command.executable, command.args, {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let stopping = false;
      const maximum = options.maxOutputBytes ?? 1024 * 1024;
      let termination: Promise<void> | undefined;
      const terminate = (): void => {
        if (stopping) return;
        stopping = true;
        if (child.pid)
          termination = (async () => {
            const stopRoot = () => {
              try {
                process.kill(-child.pid!, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            };
            try {
              // Keep the owned root from starting more work when a waiting child
              // is stopped. Descendant capture still precedes root termination.
              child.kill("SIGSTOP");
              await stopDescendants(child.pid!, undefined, stopRoot);
            } catch {
              result.errorCode = "PROCESS_TREE_CLEANUP_UNAVAILABLE";
            } finally {
              try {
                process.kill(-child.pid!, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          })();
      };
      const collect = (chunks: Buffer[], chunk: Buffer): void => {
        const available = Math.max(0, maximum - bytes);
        if (available) chunks.push(chunk.subarray(0, available));
        bytes += chunk.length;
        result.outputBytes = bytes;
        if (bytes > maximum) {
          result.truncated = true;
          terminate();
        }
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        result.errorCode = error.code ?? "SPAWN_ERROR";
      });
      const timer = setTimeout(() => {
        result.timedOut = true;
        terminate();
      }, options.timeoutMs);
      const cancel = (): void => {
        result.cancelled = true;
        terminate();
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      child.on("close", async (code, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
        await termination;
        result.exitCode = code;
        result.signal = signal;
        const out = Buffer.concat(stdout),
          err = Buffer.concat(stderr);
        result.stdout = out.toString("utf8");
        result.stderr = err.toString("utf8");
        if (options.captureRawOutput)
          result.capturedOutput = captureProcessOutput(
            out,
            err,
            result.outputBytes,
            !result.truncated,
          );
        result.durationMs = Math.round(performance.now() - started);
        resolve(result);
      });
    });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
