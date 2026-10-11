import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { stopDescendants } from "./process-tree.js";
import {
  currentNativeJournalWriter,
  withoutNativeJournalContext,
} from "./native-journal-channel.js";
import { captureProcessOutput } from "./process-output.js";
import type { NativeAttemptWriter } from "./native-attempt-storage.js";

export interface NativeInvocationOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  journal?: NativeAttemptWriter;
  /** Actual delivered bytes, before decoding; callback failure is incomplete. */
  observe?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
  mirror?: NodeJS.WritableStream;
}
export interface NativeInvocationResult {
  pid: number | null;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
  stdout: Buffer;
  stderr: Buffer;
  observedBytes: number;
  capturedOutput: ReturnType<typeof captureProcessOutput>;
}
const digest = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");
function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error("Native invocation incomplete"), { code });
}
function errorCode(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
    ? code
    : "NATIVE_TRANSPORT_ERROR";
}
/** One native process, with physical bytes retained on success and failure alike.
 * Execution authority belongs to the caller. This helper is not a sandbox.
 */
export async function invokeNative(
  executable: string,
  args: string[],
  options: NativeInvocationOptions,
): Promise<NativeInvocationResult> {
  if (
    typeof executable !== "string" ||
    !executable ||
    executable.includes("\0") ||
    !Array.isArray(args) ||
    args.length > 4096 ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    !Number.isSafeInteger(options.maxOutputBytes) ||
    options.maxOutputBytes < 0 ||
    options.maxOutputBytes > 16 * 1024 * 1024 ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 120000
  )
    throw new Error("Invalid native invocation bounds or arguments");
  const empty = () => ({
    pid: null,
    status: null,
    signal: null,
    error: failure("NATIVE_CANCELLED"),
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    observedBytes: 0,
    capturedOutput: captureProcessOutput(
      Buffer.alloc(0),
      Buffer.alloc(0),
      0,
      true,
    ),
  });
  // A preaborted request does not claim that a native call was admitted or reached.
  if (options.signal?.aborted) return empty();
  const configuredJournal = currentNativeJournalWriter();
  if (
    configuredJournal &&
    options.journal &&
    configuredJournal !== options.journal
  )
    throw Error("Native journal context conflicts with a caller writer");
  const journal = configuredJournal ?? options.journal;
  const childEnvironment = withoutNativeJournalContext(
    options.env ?? process.env,
  );
  const commandSha256 = digest(
    JSON.stringify({
      executable,
      args,
      cwd: options.cwd ?? process.cwd(),
      environmentSha256: digest(
        JSON.stringify(
          Object.entries(childEnvironment)
            .filter((entry) => entry[1] !== undefined)
            .sort(([a], [b]) => a.localeCompare(b, "en")),
        ),
      ),
    }),
  );
  // Admission writes must succeed before project-controlled code can start.
  const attemptId = journal?.admit(commandSha256);
  return await new Promise((resolve) => {
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let pid: number | null = null,
      observedBytes = 0,
      retainedBytes = 0;
    let error: NodeJS.ErrnoException | undefined,
      cut = false,
      journalCut = false,
      stopping = false;
    let termination: Promise<void> | undefined;
    const child = spawn(executable, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: childEnvironment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let waitingForDrain = false;
    const resume = () => {
      options.mirror?.removeListener("drain", resume);
      waitingForDrain = false;
      child.stdout.resume();
      child.stderr.resume();
    };
    const terminate = () => {
      if (error) resume();
      if (stopping || !child.pid) return;
      stopping = true;
      termination = (async () => {
        const stopRoot = () => {
          try {
            if (process.platform === "win32") child.kill("SIGKILL");
            else process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };
        try {
          if (process.platform === "win32") stopRoot();
          else {
            try {
              child.kill("SIGSTOP");
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== "ESRCH")
                throw cause;
            }
            await stopDescendants(child.pid!, undefined, stopRoot);
          }
        } catch {
          error = failure("PROCESS_TREE_CLEANUP_UNAVAILABLE");
        } finally {
          stopRoot();
        }
      })();
    };
    child.once("spawn", () => {
      pid = child.pid ?? null;
      try {
        if (!pid) throw failure("NATIVE_IDENTITY_UNAVAILABLE");
        if (attemptId) journal!.started(attemptId, pid);
      } catch (cause) {
        error = failure(errorCode(cause));
        terminate();
      }
    });
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      observedBytes += chunk.length;
      const keep = Math.min(
        chunk.length,
        Math.max(0, options.maxOutputBytes - retainedBytes),
      );
      (stream === "stdout" ? stdout : stderr).push(
        Buffer.from(chunk.subarray(0, keep)),
      );
      retainedBytes += keep;
      cut ||= keep !== chunk.length;
      try {
        if (attemptId && journal!.output(attemptId, stream, chunk)) {
          journalCut = true;
          cut = true;
        }
        options.observe?.(chunk, stream);
        if (
          options.mirror &&
          !error &&
          !options.mirror.write(chunk) &&
          !waitingForDrain
        ) {
          waitingForDrain = true;
          child.stdout.pause();
          child.stderr.pause();
          options.mirror.once("drain", resume);
        }
      } catch (cause) {
        error = failure(errorCode(cause));
        terminate();
      }
      if (cut) {
        error ??= failure("NATIVE_OUTPUT_LIMIT");
        terminate();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", (cause: NodeJS.ErrnoException) => {
      error ??= failure(errorCode(cause));
    });
    // Also close ordinary group descendants which retain output pipes after root exit.
    child.once("exit", terminate);
    const timer = setTimeout(() => {
      error ??= failure("NATIVE_TIMEOUT");
      terminate();
    }, options.timeoutMs);
    const cancel = () => {
      error ??= failure("NATIVE_CANCELLED");
      terminate();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.once("close", async (status, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      options.mirror?.removeListener("drain", resume);
      await termination;
      const out = Buffer.concat(stdout),
        err = Buffer.concat(stderr);
      try {
        if (attemptId)
          journal!.terminal({
            type: "terminal",
            attemptId,
            state:
              pid === null
                ? "spawn-error"
                : journalCut
                  ? "output-limit"
                  : error
                    ? "transport-error"
                    : "exited",
            exitCode: pid === null ? null : status,
            signal: pid === null ? null : signal,
            errorCode: error?.code ?? null,
          });
      } catch (cause) {
        error = failure(errorCode(cause));
      }
      resolve({
        pid,
        status: pid === null ? null : status,
        signal,
        ...(error ? { error } : {}),
        stdout: out,
        stderr: err,
        observedBytes,
        capturedOutput: captureProcessOutput(
          out,
          err,
          observedBytes,
          !cut && !error,
        ),
      });
    });
  });
}
