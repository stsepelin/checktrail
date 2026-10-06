import { captureProcessOutput } from "./process-output.js";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withinRoot } from "./inventory.js";
import { windowsLauncherScript } from "./windows-native.js";
import {
  windowsReceiptSchema,
  windowsExecutionSchema,
} from "./windows-execution.js";
import type { Command, ProcessResult } from "./types.js";
import type { RunOptions } from "./runner.js";

export const windowsSupervisorSha256 = createHash("sha256")
  .update(windowsLauncherScript)
  .digest("hex");
export const windowsEncodedSupervisor = Buffer.from(
  windowsLauncherScript,
  "utf16le",
).toString("base64");
const invalid = (code: string) => Object.assign(new Error(code), { code });
const localDrive = (value: string) => /^[A-Za-z]:\\/.test(value);
export function quoteWindowsArgument(value: string): string {
  if (value.includes("\0")) throw invalid("INVALID_WINDOWS_ARGUMENT");
  let result = '"',
    slashes = 0;
  for (const character of value) {
    if (character === "\\") {
      slashes++;
      continue;
    }
    if (character === '"') result += "\\".repeat(2 * slashes + 1) + '"';
    else result += "\\".repeat(slashes) + character;
    slashes = 0;
  }
  return result + "\\".repeat(2 * slashes) + '"';
}
export function windowsCommandLine(executable: string, args: string[]): string {
  const line = [executable, ...args].map(quoteWindowsArgument).join(" ");
  if (line.length > 32766) throw invalid("WINDOWS_COMMAND_LINE_LIMIT");
  return line;
}
export function windowsEnvironment(
  source: NodeJS.ProcessEnv,
  operator: Record<string, string> = {},
  command: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
  ]) {
    const matches = Object.keys(source).filter(
      (item) => item.toUpperCase() === key && source[item] !== undefined,
    );
    if (matches.length > 1) throw invalid("AMBIGUOUS_WINDOWS_ENVIRONMENT");
    if (matches.length) {
      const value = source[matches[0]!]!;
      if (value.includes("\0") || value.length > 16384)
        throw invalid("INVALID_WINDOWS_ENVIRONMENT");
      result[key] = value;
    }
  }
  for (const supplied of [operator, command]) {
    const names = new Set<string>();
    for (const [name, value] of Object.entries(supplied)) {
      const canonical = name.toUpperCase();
      if (
        !/^[A-Z_][A-Z0-9_]*$/.test(canonical) ||
        name.length > 128 ||
        value.includes("\0") ||
        value.length > 16384
      )
        throw invalid("INVALID_WINDOWS_ENVIRONMENT");
      if (names.has(canonical)) throw invalid("AMBIGUOUS_WINDOWS_ENVIRONMENT");
      names.add(canonical);
      if (canonical === "SYSTEMROOT")
        throw invalid("PROTECTED_WINDOWS_ENVIRONMENT");
      result[canonical] = value;
    }
  }
  if (Object.keys(result).length > 72)
    throw invalid("WINDOWS_ENVIRONMENT_LIMIT");
  return result;
}
export async function resolveWindowsExecutable(
  executable: string,
  cwd: string,
  environment: Record<string, string>,
): Promise<string> {
  if (!executable || executable.includes("\0") || executable.includes('"'))
    throw invalid("INVALID_WINDOWS_EXECUTABLE");
  const extension = path.win32.extname(executable).toLowerCase();
  if (extension && extension !== ".exe")
    throw invalid("WINDOWS_SCRIPT_WRAPPER_UNSUPPORTED");
  if (/^[A-Za-z]:[^\\/]/.test(executable))
    throw invalid("INVALID_WINDOWS_EXECUTABLE");
  const absolute = path.win32.isAbsolute(executable);
  const relative =
    executable.includes("/") ||
    executable.includes("\\") ||
    executable.includes(":");
  const name = extension ? executable : executable + ".exe";
  const candidates = absolute
    ? [name]
    : relative
      ? [path.win32.resolve(cwd, name)]
      : (environment.PATH ?? "")
          .split(";")
          .filter(localDrive)
          .map((directory) => path.win32.join(directory, name));
  const found = new Map<string, string>();
  for (const candidate of candidates) {
    if (!localDrive(candidate)) throw invalid("WINDOWS_LOCAL_DRIVE_REQUIRED");
    try {
      const resolved = await realpath(candidate);
      if (
        !localDrive(resolved) ||
        path.win32.extname(resolved).toLowerCase() !== ".exe"
      )
        throw invalid("WINDOWS_SCRIPT_WRAPPER_UNSUPPORTED");
      if (!(await lstat(resolved)).isFile())
        throw invalid("INVALID_WINDOWS_EXECUTABLE");
      found.set(resolved.toLowerCase(), resolved);
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
  if (found.size > 1) throw invalid("AMBIGUOUS_WINDOWS_EXECUTABLE");
  if (!found.size) throw invalid("ENOENT");
  return [...found.values()][0]!;
}
async function cleanup(directory: string): Promise<void> {
  for (const milliseconds of [0, 50, 100, 250]) {
    if (milliseconds) await delay(milliseconds);
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        !["EBUSY", "EPERM", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
  throw invalid("TEMP_DIRECTORY_CLEANUP_UNAVAILABLE");
}

export async function runWindowsProcess(
  root: string,
  command: Command,
  options: RunOptions,
): Promise<ProcessResult & { outputBytes: number }> {
  if (process.platform !== "win32") throw invalid("UNSUPPORTED_PLATFORM");
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 120000
  )
    throw new Error("Timeout must be between 1 and 120000 milliseconds");
  const maximum = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 16 * 1024 * 1024)
    throw invalid("WINDOWS_OUTPUT_LIMIT");
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
  let directory: string | undefined;
  let controlServer: ReturnType<typeof createServer> | undefined;
  let controlSocket: Socket | undefined;
  let controlClosed = false;
  let stopRequested = false;
  try {
    if (!localDrive(cwd)) throw invalid("WINDOWS_LOCAL_DRIVE_REQUIRED");
    const env = windowsEnvironment(
      process.env,
      options.environment,
      command.env,
    );
    const executable = await resolveWindowsExecutable(
      command.executable,
      cwd,
      env,
    );
    const systemRoot = env.SYSTEMROOT;
    if (!systemRoot || !localDrive(systemRoot))
      throw invalid("WINDOWS_SUPERVISOR_UNAVAILABLE");
    const supervisor = await realpath(
      path.win32.join(
        systemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
    );
    directory = await realpath(
      await mkdtemp(path.join(tmpdir(), "checktrail-windows-")),
    );
    const receiptFile = path.join(directory, "receipt.json");
    const requestId = randomUUID();
    const controlPipe = "checktrail-" + requestId;
    await writeFile(path.join(directory, "owner-id"), requestId, {
      flag: "wx",
    });
    if (command.temporaryDirectory) {
      const temporary = await mkdtemp(path.join(directory, "command-"));
      env.CHECKTRAIL_TEMP = temporary;
    }
    const request = JSON.stringify({
      requestId,
      controlPipe,
      executable,
      commandLine: windowsCommandLine(executable, command.args),
      cwd,
      environment: Object.entries(env)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => key + "=" + value),
      receipt: receiptFile,
    });
    if (Buffer.byteLength(request) > 1024 * 1024)
      throw invalid("WINDOWS_REQUEST_LIMIT");
    if (options.signal?.aborted) {
      result.cancelled = true;
      return result;
    }
    await writeFile(path.join(directory, "request.json"), request, {
      flag: "wx",
    });
    // PowerShell's redirected-input reader must never compete for this channel.
    // One fixed byte requests graceful stop; EOF means the parent is absent.
    controlServer = createServer((socket) => {
      if (controlClosed || controlSocket) socket.destroy();
      else {
        controlSocket = socket;
        socket.on("error", () => {});
        if (stopRequested) socket.write(Buffer.from([1]));
      }
    });
    await new Promise<void>((resolve, reject) => {
      controlServer!.once("error", reject);
      controlServer!.listen("\\\\.\\pipe\\" + controlPipe, () => {
        controlServer!.removeListener("error", reject);
        resolve();
      });
    });
    const supervisorArguments = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      windowsEncodedSupervisor,
    ];
    windowsCommandLine(supervisor, supervisorArguments);
    return await new Promise((resolve) => {
      const child = spawn(supervisor, supervisorArguments, {
        cwd: directory,
        env: {
          SYSTEMROOT: systemRoot,
          PATH: process.env.PATH ?? "",
          TEMP: directory,
          TMP: directory,
        },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let bytes = 0,
        stopping = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      let drain: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        // Keep the connection and directory until the completion receipt is read.
        // A late bootstrap connection must receive the same stop request.
        stopRequested = true;
        controlSocket?.write(Buffer.from([1]));
        force = setTimeout(() => {
          result.errorCode = "PROCESS_TREE_CLEANUP_UNAVAILABLE";
          child.kill("SIGKILL");
        }, 2000);
      };
      const collect = (chunks: Buffer[], chunk: Buffer) => {
        const available = Math.max(0, maximum - bytes);
        if (available) chunks.push(chunk.subarray(0, available));
        bytes += chunk.length;
        result.outputBytes = bytes;
        if (bytes > maximum) {
          result.truncated = true;
          stop();
        }
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        result.errorCode = error.code ?? "WINDOWS_SUPERVISOR_UNAVAILABLE";
      });
      child.on("exit", () => {
        // An exited guardian cannot hold the call open through inherited pipes.
        drain = setTimeout(() => {
          result.errorCode ??= "WINDOWS_OUTPUT_INCOMPLETE";
          child.stdout.destroy();
          child.stderr.destroy();
        }, 500);
      });
      const cancel = () => {
        result.cancelled = true;
        stop();
      };
      const timer = setTimeout(
        () => {
          result.timedOut = true;
          stop();
        },
        Math.max(1, options.timeoutMs - (performance.now() - started)),
      );
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      child.on("close", async () => {
        clearTimeout(timer);
        if (force) clearTimeout(force);
        if (drain) clearTimeout(drain);
        options.signal?.removeEventListener("abort", cancel);
        const out = Buffer.concat(stdout),
          err = Buffer.concat(stderr);
        result.stdout = out.toString("utf8");
        result.stderr = err.toString("utf8");
        if (options.captureRawOutput)
          result.capturedOutput = captureProcessOutput(
            out,
            err,
            result.outputBytes,
            !result.truncated &&
              result.errorCode !== "WINDOWS_OUTPUT_INCOMPLETE",
          );
        try {
          const entry = await lstat(receiptFile);
          if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4096)
            throw invalid("INVALID_WINDOWS_RECEIPT");
          const receipt = windowsReceiptSchema.parse(
            JSON.parse(await readFile(receiptFile, "utf8")),
          );
          if (
            receipt.requestId !== requestId ||
            receipt.supervisorPid !== child.pid
          )
            throw invalid("INVALID_WINDOWS_RECEIPT");
          result.windowsExecution = windowsExecutionSchema.parse({
            ...receipt,
            supervisorSha256: windowsSupervisorSha256,
            ownership: "creation-job-list",
            executionSandboxed: false,
          });
          if (receipt.phase === "failed")
            result.errorCode = "WINDOWS_NATIVE_ERROR_" + receipt.nativeError;
          else if (
            receipt.phase !== "completed" ||
            receipt.activeAfterCleanup !== 0 ||
            !["confirmed", "not-started"].includes(receipt.cleanup)
          )
            result.errorCode = "PROCESS_TREE_CLEANUP_UNAVAILABLE";
          else if (receipt.cleanup === "not-started") {
            if (!stopping) result.errorCode = "WINDOWS_SOURCE_NOT_EXECUTED";
          } else if (
            !receipt.jobAssigned ||
            receipt.childPid === null ||
            (receipt.childExitCode !== null && !receipt.resumed)
          )
            result.errorCode = "INVALID_WINDOWS_RECEIPT";
          else {
            result.exitCode = receipt.childExitCode;
            if (!stopping && result.exitCode === null)
              result.errorCode = "WINDOWS_EXECUTION_INCOMPLETE";
          }
        } catch {
          result.errorCode ??= "WINDOWS_SUPERVISOR_UNAVAILABLE";
        }
        result.durationMs = Math.round(performance.now() - started);
        resolve(result);
      });
    });
  } catch (error) {
    result.errorCode =
      (error as NodeJS.ErrnoException).code ?? "WINDOWS_PREPARATION_ERROR";
    result.durationMs = Math.round(performance.now() - started);
    return result;
  } finally {
    controlClosed = true;
    controlSocket?.destroy();
    controlServer?.close();
    if (directory) {
      try {
        await cleanup(directory);
      } catch {
        result.errorCode = "TEMP_DIRECTORY_CLEANUP_UNAVAILABLE";
      }
    }
  }
}
