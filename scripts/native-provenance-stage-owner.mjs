// First-party provenance harness ownership only; never a project execution API.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
const self = fileURLToPath(import.meta.url);
const supported = ["darwin", "linux", "win32"].includes(process.platform);
const scripts = new Set([
  "verify-native-provenance-runtime-package.mjs",
  "verify-native-provenance-runtime.mjs",
]);
const tree = async () => import("../dist/src/process-tree.js");

export async function runProvenanceNodeStage(program, args, options) {
  assert.ok(supported, "Provenance stage ownership unavailable");
  assert.equal(program, process.execPath);
  assert.ok(Array.isArray(args) && args.length === 2);
  const script = path.resolve(options.cwd, args[0]);
  assert.ok(scripts.has(path.basename(script)));
  assert.ok(typeof args[1] === "string" && args[1].length <= 128);
  const { timeout, maxBuffer } = options;
  assert.ok(
    Number.isSafeInteger(timeout) && timeout >= 100 && timeout <= 720000,
  );
  assert.ok(
    Number.isSafeInteger(maxBuffer) &&
      maxBuffer > 0 &&
      maxBuffer <= 4 * 1048576,
  );
  const nonce = randomUUID();
  return new Promise((resolve, reject) => {
    const child = fork(self, ["--keeper", nonce], {
      cwd: options.cwd,
      env: options.env,
      execArgv: [],
      detached: process.platform !== "win32",
      windowsHide: true,
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let ready,
      result,
      failure,
      stopping = false;
    let bytes = 0;
    const stdout = [],
      stderr = [];
    const reserve = Math.min(5000, Math.floor(timeout / 4));
    const stop = (error) => {
      failure ??= error;
      if (stopping) return;
      stopping = true;
      if (child.connected) child.send({ kind: "stop", nonce }, () => {});
    };
    const deadline = setTimeout(
      () =>
        stop(
          Object.assign(Error("Provenance stage deadline"), {
            code: "ETIMEDOUT",
            killed: true,
          }),
        ),
      timeout - reserve,
    );
    const fallback = setTimeout(
      async () => {
        failure ??= Error("Provenance stage cleanup unavailable");
        if (process.platform !== "win32" && ready) {
          try {
            const api = await tree();
            const current = (await api.processSnapshot(child.pid)).find(
              (row) => row.pid === child.pid,
            );
            assert.ok(
              current &&
                current.identity === ready.identity &&
                current.group === child.pid,
              "Stage owner identity changed",
            );
            child.kill("SIGSTOP");
            await api.stopDescendants(child.pid, undefined, () =>
              child.kill("SIGKILL"),
            );
          } catch {
            failure = Error("Provenance stage cleanup unavailable");
          }
        }
        child.kill("SIGKILL");
      },
      timeout - Math.min(2000, Math.floor(reserve / 2)),
    );
    const hard = setTimeout(() => {
      failure = Error("Provenance stage cleanup unavailable");
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.connected) child.disconnect();
    }, timeout);
    const capture = (output, chunk) => {
      const room = Math.max(0, maxBuffer - bytes);
      if (room) output.push(chunk.subarray(0, room));
      bytes += chunk.length;
      if (bytes > maxBuffer)
        stop(
          Object.assign(Error("Provenance stage output bound"), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
        );
    };
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.on("error", (error) => stop(error));
    child.on("message", (message) => {
      if (!message || message.nonce !== nonce)
        return stop(Error("Invalid provenance stage owner"));
      if (message.kind === "ready" && !ready && !result) {
        if (message.pid !== child.pid)
          return stop(Error("Invalid provenance stage identity"));
        ready = message;
        if (stopping) return;
        child.send({ kind: "run", nonce, script, slot: args[1] }, (error) => {
          if (error) stop(error);
        });
      } else if (message.kind === "result" && ready && !result)
        result = message;
      else stop(Error("Invalid provenance stage protocol"));
    });
    child.on("close", () => {
      clearTimeout(deadline);
      clearTimeout(fallback);
      clearTimeout(hard);
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (
        failure ||
        !result ||
        result.cleanup !== true ||
        result.code !== 0 ||
        result.signal !== null
      ) {
        const error =
          failure ??
          Object.assign(Error("Provenance stage failed"), {
            code: result?.code ?? "STAGE_OWNER_INCOMPLETE",
          });
        reject(Object.assign(error, output));
      } else resolve(output);
    });
  });
}

async function keeper(nonce) {
  assert.ok(supported && process.send && /^[a-f0-9-]{36}$/u.test(nonce ?? ""));
  let child,
    finished = false,
    stopping,
    code = null,
    childSignal = null;
  const complete = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      let cleanup = true;
      try {
        if (process.platform === "win32") {
          // Windows support is separately required to pass the real nested
          // timeout and parent-loss controls. Keep every harness child ordinary:
          // Node/libuv jobs close on parent loss; detached ownership is refused.
          if (child && child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
        } else await (await tree()).stopDescendants(process.pid);
        if (child?.pid)
          await new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) resolve();
            else child.once("exit", resolve);
          });
      } catch {
        cleanup = false;
        child?.kill("SIGKILL");
      }
      finished = true;
      if (process.connected)
        await new Promise((resolve) =>
          process.send(
            { kind: "result", nonce, code, signal: childSignal, cleanup },
            () => resolve(),
          ),
        );
      if (process.connected) process.disconnect();
    })();
    return stopping;
  };
  process.once("disconnect", () => {
    void complete();
  });
  process.on("message", (message) => {
    if (!message || message.nonce !== nonce || finished) {
      void complete();
      return;
    }
    if (message.kind === "stop") {
      void complete();
      return;
    }
    if (
      message.kind !== "run" ||
      child ||
      stopping ||
      !path.isAbsolute(message.script) ||
      !scripts.has(path.basename(message.script)) ||
      typeof message.slot !== "string" ||
      message.slot.length > 128
    ) {
      void complete();
      return;
    }
    child = spawn(process.execPath, [message.script, message.slot], {
      cwd: process.cwd(),
      env: process.env,
      detached: false,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", () => {
      code = null;
      void complete();
    });
    child.once("exit", (status, signal) => {
      code = status;
      childSignal = signal;
      void complete();
    });
  });
  const identity =
    process.platform === "win32"
      ? null
      : (await (await tree()).processSnapshot(process.pid)).find(
          (row) => row.pid === process.pid,
        );
  if (process.platform !== "win32") assert.equal(identity?.group, process.pid);
  if (process.connected)
    process.send({
      kind: "ready",
      nonce,
      pid: process.pid,
      identity: identity?.identity ?? null,
    });
  else await complete();
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === self &&
  process.argv[2] === "--keeper"
)
  await keeper(process.argv[3]);
