import { processSnapshot, stopDescendants } from "./process-tree.js";
import { runOwnedPosixTarget } from "./posix-target.js";
import type { PosixOwnerRequest, PosixTargetResult } from "./posix-owner.js";
const nonce = process.argv[2];
if (
  !["darwin", "linux"].includes(process.platform) ||
  !/^[a-f0-9-]{36}$/.test(nonce ?? "") ||
  !process.send
)
  throw Error("POSIX owner requires its private parent channel");
const controller = new AbortController();
let started = false,
  finished = false;
async function complete(result?: PosixTargetResult) {
  if (finished) return;
  finished = true;
  try {
    await stopDescendants(process.pid);
  } catch {
    if (result) result.errorCode = "PROCESS_TREE_CLEANUP_UNAVAILABLE";
  }
  if (result && process.connected) {
    await new Promise<void>((resolve) => {
      process.send!({ kind: "result", nonce, result }, () => resolve());
    });
  }
  if (process.connected) process.disconnect?.();
}
process.once("disconnect", () => {
  controller.abort();
  if (!started) void complete();
});
process.on("message", (message) => {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    controller.abort();
    if (!started) void complete();
    return;
  }
  const m = message as Partial<PosixOwnerRequest>;
  if (m.nonce !== nonce) {
    controller.abort();
    if (!started) void complete();
    return;
  }
  if (m.kind === ("cancel" as string)) {
    controller.abort();
    return;
  }
  if (
    m.kind !== "run" ||
    started ||
    controller.signal.aborted ||
    !process.connected
  ) {
    controller.abort();
    if (!started) void complete();
    return;
  }
  started = true;
  void (async () => {
    const input = m as PosixOwnerRequest;
    let result: PosixTargetResult | undefined;
    try {
      if (!/^[0-9]{1,24}$/.test(input.deadlineNs))
        throw Error("Invalid owner deadline");
      const remaining = Number(
        (BigInt(input.deadlineNs) - process.hrtime.bigint()) / 1000000n,
      );
      if (remaining < 1) {
        result = {
          command: input.command,
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 0,
          timedOut: true,
          cancelled: false,
          truncated: false,
          outputBytes: 0,
        };
      } else
        result = await runOwnedPosixTarget(input.root, input.command, {
          ...input.options,
          timeoutMs: Math.min(input.options.timeoutMs, remaining),
          signal: controller.signal,
        });
    } catch {
      result = {
        command: input.command,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        timedOut: false,
        cancelled: controller.signal.aborted,
        truncated: false,
        outputBytes: 0,
        errorCode: "POSIX_OWNER_UNAVAILABLE",
      };
    }
    await complete(result);
  })();
});
if (!process.connected) await complete();
else {
  const identity = (await processSnapshot(process.pid)).find(
    (row) => row.pid === process.pid,
  );
  if (!identity || identity.group !== process.pid)
    throw Error("POSIX owner requires a private process group");
  if (process.connected && !controller.signal.aborted)
    process.send({ kind: "ready", nonce, identity });
  else await complete();
}
