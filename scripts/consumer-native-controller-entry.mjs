import assert from "node:assert/strict";
import process from "node:process";
import { Buffer } from "node:buffer";
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  consumerNativeProfiles,
  consumerNativeEntrypoint,
} from "./consumer-native-entrypoints.mjs";
import { ensureWindowsTaskAccess } from "../dist/src/windows-task-access.js";
import {
  requireConsumerPrivateDirectory,
  writeConsumerPrivateFile,
} from "./consumer-native-host-storage.mjs";
const controllerFiles = new Set(
  consumerNativeProfiles
    .map(
      (profile) =>
        consumerNativeEntrypoint(profile, "native-linux-arm64-node22")[0],
    )
    .concat(consumerNativeEntrypoint("consumer-impact", "ci-linux-node22")[0]),
);
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
  assert.ok(
    controllerFiles.has(command.args[0]),
    "Selected fixed native controller filename is required",
  );
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

/** Bounded metadata only. Never publish native messages, raw output or absolute stack paths. */
export function consumerNativeFailureDiagnostic({
  stage,
  scopeId,
  attemptId,
  error,
  entry,
  repository,
  sourceBeforeSha256,
}) {
  const stages = new Set([
    "admission",
    "source-before",
    "registry",
    "controller-entry",
    "host-capture",
    "controller-result",
    "docker-capture",
    "source-after",
    "normalize-capsule",
    "persist-capsule",
    "release-captures",
    "publish-capsule",
  ]);
  const names = new Set([
    "AssertionError",
    "Error",
    "TypeError",
    "SyntaxError",
    "RangeError",
    "AggregateError",
  ]);
  const codes = new Set([
    "ERR_ASSERTION",
    "ENOENT",
    "ENOTDIR",
    "EACCES",
    "EPERM",
    "EIO",
    "ENOSPC",
    "EEXIST",
    "EMFILE",
    "ENFILE",
    "ETIMEDOUT",
    "ERR_MODULE_NOT_FOUND",
    "ERR_UNKNOWN_FILE_EXTENSION",
  ]);
  const number = (value) =>
    Number.isSafeInteger(value) && Math.abs(value) <= 2 ** 40 ? value : null;
  const boolean = (value) => (typeof value === "boolean" ? value : null);
  function locations(stack) {
    if (typeof stack !== "string") return [];
    const selected = [];
    for (const line of stack.slice(0, 32768).split("\n").slice(0, 64)) {
      if (!/^\s+at /.test(line) || line.length > 4096) continue;
      const match = line.match(
        /(?:\()?(file:\/\/[^\s()]+|[A-Za-z]:[^\r\n()]+|\/[^\r\n()]+):(\d+):(\d+)\)?$/,
      );
      if (!match) continue;
      let filename;
      try {
        filename = match[1].startsWith("file:")
          ? fileURLToPath(match[1])
          : match[1];
      } catch {
        continue;
      }
      const relative = path
        .relative(repository, filename)
        .split(path.sep)
        .join("/");
      if (
        !/^(?:scripts|dist\/(?:src|test))\/[A-Za-z0-9_/-]+\.(?:mjs|js)$/.test(
          relative,
        )
      )
        continue;
      const row = {
        file: relative,
        line: Number(match[2]),
        column: Number(match[3]),
      };
      if (
        !Number.isSafeInteger(row.line) ||
        row.line < 1 ||
        row.line > 10000000 ||
        !Number.isSafeInteger(row.column) ||
        row.column < 1 ||
        row.column > 10000000
      )
        continue;
      if (
        !selected.some(
          (value) =>
            value.file === row.file &&
            value.line === row.line &&
            value.column === row.column,
        )
      )
        selected.push(row);
      if (selected.length === 8) break;
    }
    return selected;
  }
  let errorName = "other",
    errorCode = null,
    errorLocations = [];
  try {
    if (names.has(error?.name)) errorName = error.name;
    if (codes.has(error?.code)) errorCode = error.code;
    errorLocations = locations(error?.stack);
  } catch {
    /* A diagnostic getter cannot replace the original failure. */
  }
  return {
    schemaVersion: 1,
    profile: "native-consumer-incomplete-diagnostic-v1",
    state: "incomplete",
    scope:
      typeof scopeId === "string" && /^[a-z-]+:[a-z0-9-]{1,64}$/.test(scopeId)
        ? scopeId
        : null,
    attemptId:
      typeof attemptId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        attemptId,
      )
        ? attemptId
        : null,
    stage: stages.has(stage) ? stage : "unknown",
    errorName,
    errorCode,
    errorLocations,
    sourceBeforeSha256:
      typeof sourceBeforeSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(sourceBeforeSha256)
        ? sourceBeforeSha256
        : null,
    controller: entry
      ? {
          complete: boolean(entry.complete),
          moduleCompleted: boolean(entry.moduleCompleted),
          exitRequested: number(entry.exitRequested),
          exitCodeRequested: number(entry.exitCodeRequested),
          truncated: boolean(entry.truncated),
          captureErrorPresent:
            typeof entry.captureError === "string"
              ? true
              : entry.captureError === null
                ? false
                : null,
          errorLocations: locations(entry.error),
          stdoutBytes: number(entry.stdout?.bytes),
          stderrBytes: number(entry.stderr?.bytes),
        }
      : null,
    sourceOrRawOutputIncluded: false,
    qualifiesNativeAcceptance: false,
    gateAComplete: false,
  };
}
