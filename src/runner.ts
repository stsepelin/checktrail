import { runSupervisedPosixProcess } from "./posix-owner.js";
import type { NativeJournalContext } from "./native-attempt-storage.js";
import type { Command, ProcessResult } from "./types.js";

export interface RunOptions {
  /** Engine/operator-selected evidence capture; grants no execution authority. */
  captureRawOutput?: boolean;
  /** Internal engine evidence channel; never a tool argument or execution grant. */
  nativeJournalContext?: NativeJournalContext;
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
  return runSupervisedPosixProcess(root, command, options);
}
