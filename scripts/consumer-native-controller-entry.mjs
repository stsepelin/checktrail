import assert from "node:assert/strict";
import process from "node:process";
import { Buffer } from "node:buffer";
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";
import { ensureWindowsTaskAccess } from "../dist/src/windows-task-access.js";
import {
  requireConsumerPrivateDirectory,
  writeConsumerPrivateFile,
} from "./consumer-native-host-storage.mjs";
let active = false;
/** Await one existing entrypoint in this fresh operator CLI. Its own native fences/timeouts remain authoritative. */
export async function captureConsumerControllerEntry(
  root,
  command,
  directory,
  maximum = 32 * 1048576,
) {
  assert.equal(
    active,
    false,
    "Nested controller entrypoint capture is unsupported",
  );
  assert.equal(command.executable, process.execPath);
  assert.ok(
    Array.isArray(command.args) &&
      command.args.length > 0 &&
      command.args.every(
        (arg) => typeof arg === "string" && !arg.includes("\0"),
      ),
  );
  assert.match(command.args[0], /^scripts\/verify-[a-z-]+\.mjs$/);
  assert.ok(
    Number.isSafeInteger(maximum) && maximum >= 0 && maximum <= 32 * 1048576,
  );
  assert.equal(await realpath(root), root);
  const target = path.join(root, command.args[0]);
  assert.equal(await realpath(target), target);
  await requireConsumerPrivateDirectory(directory);
  const streams = {};
  try {
    for (const name of ["stdout", "stderr"]) {
      const filename = path.join(directory, "controller." + name),
        fd = openSync(filename, "wx", 0o600);
      streams[name] = {
        filename,
        fd,
        bytes: 0,
        observedBytes: 0,
        digest: createHash("sha256"),
      };
      if (process.platform === "win32")
        ensureWindowsTaskAccess(filename, "file", true);
    }
    await writeConsumerPrivateFile(
      path.join(directory, "controller-running.json"),
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          state: "running",
          command,
          processExitObserved: false,
          nativeProcessStartAcknowledgementRetained: false,
          gateAComplete: false,
        }) + "\n",
      ),
    );
  } catch (error) {
    for (const stream of Object.values(streams)) closeSync(stream.fd);
    throw error;
  }
  const previous = {
    argv: process.argv,
    cwd: process.cwd(),
    out: process.stdout.write,
    err: process.stderr.write,
    exit: process.exit,
    exitCode: process.exitCode,
  };
  let moduleCompleted = false,
    error = null,
    captureError = null,
    exitRequested = null,
    exitCodeRequested = null,
    truncated = false;
  function writer(name) {
    return function (chunk, encoding, callback) {
      const value =
        typeof chunk === "string"
          ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
          : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : null;
      assert.ok(value, "Controller output must be bytes or text");
      const stream = streams[name];
      stream.observedBytes += value.length;
      if (captureError) throw Error(captureError);
      const remaining = Math.max(
          0,
          maximum - streams.stdout.bytes - streams.stderr.bytes,
        ),
        selected = value.subarray(0, remaining);
      try {
        let offset = 0;
        while (offset < selected.length) {
          const n = writeSync(
            stream.fd,
            selected,
            offset,
            selected.length - offset,
          );
          assert.ok(n > 0);
          stream.digest.update(selected.subarray(offset, offset + n));
          stream.bytes += n;
          offset += n;
        }
        fsyncSync(stream.fd);
        if (selected.length !== value.length) {
          truncated = true;
          throw Error("Controller output byte bound exceeded");
        }
      } catch (failure) {
        captureError = String(failure);
        throw failure;
      }
      const done = typeof encoding === "function" ? encoding : callback;
      if (done !== undefined) {
        assert.equal(typeof done, "function");
        globalThis.queueMicrotask(() => done());
      }
      return true;
    };
  }
  active = true;
  try {
    process.chdir(root);
    process.argv = [process.execPath, target, ...command.args.slice(1)];
    process.stdout.write = writer("stdout");
    process.stderr.write = writer("stderr");
    process.exit = function (code) {
      exitRequested =
        code === undefined ? (process.exitCode ?? 0) : Number(code);
      throw Error(
        "Controller requested process.exit before operator reconciliation",
      );
    };
    await import(pathToFileURL(target).href);
    moduleCompleted = true;
    exitCodeRequested = process.exitCode ?? 0;
  } catch (failure) {
    error = String(failure?.stack ?? failure);
  } finally {
    process.stdout.write = previous.out;
    process.stderr.write = previous.err;
    process.exit = previous.exit;
    process.argv = previous.argv;
    process.exitCode = previous.exitCode;
    process.chdir(previous.cwd);
    active = false;
    for (const stream of Object.values(streams)) {
      try {
        fsyncSync(stream.fd);
      } catch (failure) {
        captureError ??= String(failure);
      } finally {
        closeSync(stream.fd);
      }
    }
  }
  const record = {
    schemaVersion: 1,
    profile: "captured-operator-controller-entrypoint-v1",
    command,
    moduleCompleted,
    exitRequested,
    exitCodeRequested,
    error,
    captureError,
    truncated,
    stdout: {
      path: streams.stdout.filename,
      bytes: streams.stdout.bytes,
      observedBytes: streams.stdout.observedBytes,
      sha256: streams.stdout.digest.digest("hex"),
    },
    stderr: {
      path: streams.stderr.filename,
      bytes: streams.stderr.bytes,
      observedBytes: streams.stderr.observedBytes,
      sha256: streams.stderr.digest.digest("hex"),
    },
    complete:
      moduleCompleted &&
      exitRequested === null &&
      exitCodeRequested === 0 &&
      error === null &&
      captureError === null &&
      !truncated,
    processExitObserved: false,
    nativeProcessStartAcknowledgementRetained: false,
    hostAttestationPerformed: false,
    gateAComplete: false,
  };
  await writeConsumerPrivateFile(
    path.join(directory, "controller-terminal.json"),
    Buffer.from(JSON.stringify(record) + "\n"),
  );
  return record;
}
