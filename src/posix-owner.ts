import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { withinRoot } from "./inventory.js";
import {
  captureProcessOutput,
  parseCapturedProcessOutput,
} from "./process-output.js";
import {
  processSnapshot,
  stopDescendants,
  type ProcessIdentity,
} from "./process-tree.js";
import type { RunOptions } from "./runner.js";
import type { Command, ProcessResult } from "./types.js";
export type PosixTargetResult = ProcessResult & { outputBytes: number };
export type PosixOwnerRequest = {
  kind: "run";
  nonce: string;
  root: string;
  command: Command;
  deadlineNs: string;
  options: Omit<RunOptions, "signal">;
};
const keeper = fileURLToPath(
  new URL("./posix-owner-keeper.js", import.meta.url),
);
const empty = (command: Command): PosixTargetResult => ({
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
});
function targetResult(
  value: unknown,
  command: Command,
  options: RunOptions,
): value is PosixTargetResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([
    "command",
    "exitCode",
    "signal",
    "stdout",
    "stderr",
    "durationMs",
    "timedOut",
    "cancelled",
    "truncated",
    "outputBytes",
    "errorCode",
    "capturedOutput",
  ]);
  if (!Object.keys(value).every((key) => allowed.has(key))) return false;
  const r = value as PosixTargetResult;
  const basic =
    JSON.stringify(r.command) === JSON.stringify(command) &&
    (r.exitCode === null || Number.isSafeInteger(r.exitCode)) &&
    (r.signal === null ||
      (typeof r.signal === "string" && /^SIG[A-Z0-9]+$/.test(r.signal))) &&
    typeof r.stdout === "string" &&
    typeof r.stderr === "string" &&
    Number.isFinite(r.durationMs) &&
    r.durationMs >= 0 &&
    Number.isSafeInteger(r.outputBytes) &&
    r.outputBytes >= 0 &&
    [r.timedOut, r.cancelled, r.truncated].every((v) => typeof v === "boolean");
  if (!basic || (r.errorCode !== undefined && typeof r.errorCode !== "string"))
    return false;
  if (r.capturedOutput !== undefined) {
    if (!options.captureRawOutput) return false;
    try {
      const output = parseCapturedProcessOutput(r.capturedOutput);
      if (
        output.observedBytes !== r.outputBytes ||
        output.completeForObservedStreams !== !r.truncated ||
        output.stdout.bytes + output.stderr.bytes >
          (options.maxOutputBytes ?? 1048576)
      )
        return false;
      if (
        Buffer.from(output.stdout.base64, "base64").toString("utf8") !==
          r.stdout ||
        Buffer.from(output.stderr.base64, "base64").toString("utf8") !==
          r.stderr
      )
        return false;
    } catch {
      return false;
    }
  } else if (
    options.captureRawOutput &&
    !r.cancelled &&
    !r.timedOut &&
    r.errorCode === undefined
  )
    return false;
  return true;
}
/** A fixed trusted owner, not an execution sandbox or an authorization grant. */
export async function runSupervisedPosixProcess(
  root: string,
  command: Command,
  options: RunOptions,
): Promise<PosixTargetResult> {
  const start = performance.now(),
    deadline = process.hrtime.bigint() + BigInt(options.timeoutMs) * 1000000n;
  const cwd = await withinRoot(root, command.cwd);
  if (options.signal?.aborted) return { ...empty(command), cancelled: true };
  if (!["darwin", "linux"].includes(process.platform))
    return { ...empty(command), errorCode: "POSIX_OWNER_PLATFORM_UNAVAILABLE" };
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  const nonce = randomUUID();
  return await new Promise((resolve) => {
    const child = fork(keeper, [nonce], {
      cwd,
      env,
      execPath: process.execPath,
      execArgv: [],
      detached: true,
      serialization: "advanced",
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    let launched = false,
      received: PosixTargetResult | undefined,
      identity: ProcessIdentity | undefined,
      ended = false,
      cleanup: Promise<void> | undefined,
      failure: string | undefined,
      deadlinePassed = false,
      fallback: NodeJS.Timeout;
    const stop = () => {
      if (cleanup) return cleanup;
      cleanup = (async () => {
        if (!child.pid) return;
        if (launched) {
          const current = (await processSnapshot()).find(
            (row) => row.pid === child.pid,
          );
          if (
            current &&
            identity &&
            (current.identity !== identity.identity ||
              current.group !== identity.group)
          )
            throw Error("POSIX owner identity changed");
          child.kill("SIGSTOP");
          try {
            await stopDescendants(child.pid, undefined, () => {
              child.kill("SIGKILL");
            });
          } finally {
            child.kill("SIGKILL");
          }
        } else child.kill("SIGKILL");
      })().catch((error) => {
        process.stderr.write(
          JSON.stringify({
            event: "temporary-cleanup-diagnostic",
            phase: "owner-fallback",
            reason:
              error instanceof Error &&
              error.message === "POSIX owner identity changed"
                ? "owner-identity-changed"
                : "owner-cleanup-unavailable",
          }) + "\n",
        );
        failure = "PROCESS_TREE_CLEANUP_UNAVAILABLE";
      });
      return cleanup;
    };
    const boundCleanup = () => {
      clearTimeout(fallback);
      fallback = setTimeout(() => {
        failure ??= "POSIX_OWNER_UNAVAILABLE";
        void stop();
      }, 5000);
    };
    const send = (
      message: PosixOwnerRequest | { kind: "cancel"; nonce: string },
    ) => {
      if (!child.connected) return;
      child.send(message, (error) => {
        if (error) {
          failure ??= "POSIX_OWNER_UNAVAILABLE";
          void stop();
        }
      });
    };
    const cancel = () => {
      if (launched) send({ kind: "cancel", nonce });
      else if (child.connected) child.disconnect();
      boundCleanup();
    };
    const timer = setTimeout(
      () => {
        deadlinePassed = true;
        if (!launched && child.connected) child.disconnect();
        boundCleanup();
      },
      Math.max(1, options.timeoutMs - (performance.now() - start)),
    );
    fallback = setTimeout(() => {
      failure = "POSIX_OWNER_UNAVAILABLE";
      void stop();
    }, options.timeoutMs + 5000);
    options.signal?.addEventListener("abort", cancel, { once: true });
    child.on("message", (message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        failure = "POSIX_OWNER_PROTOCOL_INVALID";
        void stop();
        return;
      }
      const m = message as {
        kind?: unknown;
        nonce?: unknown;
        identity?: ProcessIdentity;
        result?: unknown;
      };
      if (m.nonce !== nonce) {
        failure = "POSIX_OWNER_PROTOCOL_INVALID";
        void stop();
        return;
      }
      if (m.kind === "ready" && !identity && !launched) {
        const observed = m.identity;
        if (
          !observed ||
          observed.pid !== child.pid ||
          observed.parent !== process.pid ||
          observed.group !== child.pid ||
          typeof observed.identity !== "string" ||
          !observed.identity ||
          observed.identity.length > 128
        ) {
          failure = "POSIX_OWNER_PROTOCOL_INVALID";
          void stop();
          return;
        }
        identity = observed;
        if (options.signal?.aborted || deadlinePassed) {
          if (child.connected) child.disconnect();
          return;
        }
        launched = true;
        const { signal, ...limits } = options;
        void signal;
        send({
          kind: "run",
          nonce,
          root,
          command,
          deadlineNs: deadline.toString(),
          options: limits,
        } satisfies PosixOwnerRequest);
      } else if (
        m.kind === "result" &&
        launched &&
        !received &&
        targetResult(m.result, command, options)
      )
        received = m.result;
      else {
        failure = "POSIX_OWNER_PROTOCOL_INVALID";
        void stop();
      }
    });
    child.on("error", () => {
      failure ??= "POSIX_OWNER_UNAVAILABLE";
      if (!child.pid) void complete(null, null);
      else void stop();
    });
    const complete = async (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      if (ended) return;
      ended = true;
      if (!child.pid && child.connected) child.disconnect();
      clearTimeout(timer);
      clearTimeout(fallback);
      options.signal?.removeEventListener("abort", cancel);
      if ((code !== 0 || signal !== null || !received) && launched)
        await stop();
      await cleanup;
      const result = received ?? empty(command);
      result.cancelled ||= options.signal?.aborted ?? false;
      result.durationMs = Math.round(performance.now() - start);
      if (!received) {
        result.cancelled = options.signal?.aborted ?? false;
        result.timedOut = deadlinePassed;
      }
      if (
        failure ||
        (!received && (launched || (!result.cancelled && !result.timedOut))) ||
        (received && (code !== 0 || signal !== null))
      )
        result.errorCode = failure ?? "POSIX_OWNER_UNAVAILABLE";
      if (options.captureRawOutput && !received)
        result.capturedOutput = captureProcessOutput(
          Buffer.alloc(0),
          Buffer.alloc(0),
          0,
          !launched,
        );
      resolve(result);
    };
    // A fork disconnected before its bootstrap may emit exit without close.
    // All stdio is ignored; wait for kernel exit and drained private IPC, then
    // one event-loop turn for already queued message delivery.
    let exited:
      { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const afterExitAndDisconnect = () => {
      if (exited && !child.connected) {
        const value = exited;
        setImmediate(() => {
          void complete(value.code, value.signal);
        });
      }
    };
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      afterExitAndDisconnect();
    });
    child.on("disconnect", afterExitAndDisconnect);
    child.on("close", (code, signal) => {
      void complete(code, signal);
    });
    if (options.signal?.aborted) cancel();
  });
}
