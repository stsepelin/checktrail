import { captureProcessOutput } from "./process-output.js";
import {
  nativeJournalContextEnvironment,
  withoutNativeJournalContext,
} from "./native-journal-channel.js";
import { spawn, spawnSync } from "node:child_process";
import { stopDescendants } from "./process-tree.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withinRoot } from "./inventory.js";
import { realpath } from "node:fs/promises";
import { isGitMetadataCommand } from "./git-metadata-policy.js";
import type { Command, ProcessResult } from "./types.js";

import type { RunOptions } from "./runner.js";

async function collectPosixTarget(
  root: string,
  command: Command,
  options: RunOptions,
  ownsGroup: boolean,
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
  const cwd = await withinRoot(root, command.cwd);
  if (options.signal?.aborted) return { ...result, cancelled: true };
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
  Object.assign(
    env,
    withoutNativeJournalContext({ ...options.environment, ...command.env }),
  );
  if (options.nativeJournalContext)
    Object.assign(
      env,
      nativeJournalContextEnvironment(options.nativeJournalContext),
    );
  const temporary = command.temporaryDirectory
    ? await mkdtemp(path.join(tmpdir(), "checktrail-command-"))
    : undefined;
  if (temporary) env.CHECKTRAIL_TEMP = temporary;
  try {
    if (options.signal?.aborted) return { ...result, cancelled: true };
    return await new Promise((resolve) => {
      const child = spawn(command.executable, command.args, {
        cwd,
        env,
        shell: false,
        // The keeper owns this process group until every ordinary member is gone.
        detached: !ownsGroup,
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
              if (!ownsGroup) {
                try {
                  process.kill(-child.pid!, "SIGKILL");
                  return;
                } catch {
                  /* The target may already be gone. */
                }
              }
              child.kill("SIGKILL");
            };
            try {
              // The fixed keeper retains its group even after the target exits.
              // Stop the target first, then quiesce all observed group members
              // and escaped descendants before signalling children and parents.
              child.kill("SIGSTOP");
              await stopDescendants(
                ownsGroup ? process.pid : child.pid!,
                undefined,
                stopRoot,
              );
            } catch {
              result.errorCode = "PROCESS_TREE_CLEANUP_UNAVAILABLE";
            } finally {
              stopRoot();
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

export async function runOwnedPosixTarget(
  root: string,
  command: Command,
  options: RunOptions,
) {
  return collectPosixTarget(root, command, options, true);
}
/** Internal fixed Git metadata path; no MCP argument can select this collector. */
export async function runHostGitMetadata(
  root: string,
  command: Command,
  options: Pick<RunOptions, "timeoutMs" | "maxOutputBytes">,
) {
  if (
    !["darwin", "linux", "win32"].includes(process.platform) ||
    !isGitMetadataCommand(command) ||
    !path.isAbsolute(command.executable)
  )
    throw Error("Unsupported host Git metadata command");
  const canonicalRoot = await realpath(root),
    executable = await realpath(command.executable),
    relative = path.relative(canonicalRoot, executable);
  if (
    executable !== command.executable ||
    !(
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    )
  )
    throw Error("Host Git metadata executable must be outside the project");
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 5000 ||
    (options.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(options.maxOutputBytes) ||
        options.maxOutputBytes < 1 ||
        options.maxOutputBytes > 4 * 1048576))
  )
    throw Error("Host Git metadata limits are invalid");
  if (process.platform === "win32") {
    if (path.extname(executable).toLowerCase() !== ".exe")
      throw Error("Host Git metadata requires a native executable");
    const { windowsEnvironment } = await import("./windows-process.js"),
      maximum = options.maxOutputBytes ?? 1024 * 1024,
      started = performance.now();
    // This fixed read-only command family disables hooks, filters, monitors,
    // paging and lazy fetch. It does not execute project-controlled programs.
    // A native synchronous call avoids a PowerShell/SDK bootstrap per Git read.
    const result = spawnSync(executable, command.args, {
      cwd: canonicalRoot,
      env: windowsEnvironment(process.env, undefined, command.env),
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: maximum,
    });
    const stdout = result.stdout ?? Buffer.alloc(0),
      stderr = result.stderr ?? Buffer.alloc(0),
      bytes = stdout.length + stderr.length,
      code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    return {
      command,
      exitCode: result.status,
      signal: result.signal,
      stdout: stdout.subarray(0, maximum).toString("utf8"),
      stderr: stderr
        .subarray(0, Math.max(0, maximum - stdout.length))
        .toString("utf8"),
      durationMs: performance.now() - started,
      timedOut: code === "ETIMEDOUT",
      cancelled: false,
      truncated: code === "ENOBUFS" || bytes > maximum,
      outputBytes: bytes,
      ...(code ? { errorCode: code } : {}),
    };
  }
  return collectPosixTarget(
    root,
    command,
    {
      timeoutMs: options.timeoutMs,
      ...(options.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: options.maxOutputBytes }),
    },
    false,
  );
}
