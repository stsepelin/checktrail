import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withinRoot } from "./inventory.js";
import type { Command, ProcessResult } from "./types.js";

export interface RunOptions {
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  environment?: Record<string, string>;
}

export async function runProcess(
  root: string,
  command: Command,
  options: RunOptions,
): Promise<ProcessResult> {
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 120_000
  ) {
    throw new Error("Timeout must be between 1 and 120000 milliseconds");
  }
  const started = performance.now();
  const result: ProcessResult = {
    command,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    truncated: false,
  };
  if (options.signal?.aborted) return { ...result, cancelled: true };
  if (process.platform === "win32")
    return { ...result, errorCode: "UNSUPPORTED_PLATFORM" };
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
    ? await mkdtemp(path.join(tmpdir(), "repo-verifier-command-"))
    : undefined;
  if (temporary) env.REPO_VERIFIER_TEMP = temporary;
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
      const terminate = (): void => {
        if (stopping) return;
        stopping = true;
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };
      const collect = (chunks: Buffer[], chunk: Buffer): void => {
        const available = Math.max(0, maximum - bytes);
        if (available) chunks.push(chunk.subarray(0, available));
        bytes += chunk.length;
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
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
        result.exitCode = code;
        result.signal = signal;
        result.stdout = Buffer.concat(stdout).toString("utf8");
        result.stderr = Buffer.concat(stderr).toString("utf8");
        result.durationMs = Math.round(performance.now() - started);
        resolve(result);
      });
    });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
