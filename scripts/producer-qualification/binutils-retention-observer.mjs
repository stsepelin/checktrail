// Independent immutable-image observer. Producer mounts are read-only here.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { constants, openSync, writeSync, closeSync } from "node:fs";
import path from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
const roots = ["bundle", "controls", "work"];
const maximumLog = 16 * 1024 ** 2;
export function validateRetentionMessage(value, sequence) {
  if (sequence === 0) {
    assert.deepEqual(value, {
      schemaVersion: 1,
      kind: "ready",
      roots: roots.map((root) => "/observed/" + root),
    });
    return value;
  }
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      "schemaVersion",
      "kind",
      "sequence",
      "bytes",
      "files",
      "directories",
    ].sort(),
  );
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, "sample");
  assert.equal(value.sequence, sequence);
  for (const key of ["bytes", "files", "directories"])
    assert.ok(
      Number.isSafeInteger(value[key]) && value[key] >= 0,
      "Invalid retention counter",
    );
  assert.ok(
    value.directories >= 3 && value.files + value.directories <= 1000000,
  );
  return value;
}
export function retentionObserverArguments({
  destination,
  image,
  platform,
  attempt,
}) {
  assert.match(image, /^docker\.io\/coqorg\/coq@sha256:[a-f0-9]{64}$/u);
  assert.equal(platform, "linux/amd64");
  assert.match(attempt, /^[a-f0-9-]{36}$/u);
  assert.equal(path.resolve(destination), destination);
  assert.ok(!/[\r\n,]/u.test(destination));
  return [
    "run",
    "--rm",
    "--init",
    "--interactive",
    "--pull=never",
    "--platform",
    platform,
    "--name",
    "checktrail-retention-" + attempt,
    "--label",
    "io.checktrail.producer-attempt=" + attempt,
    "--label",
    "io.checktrail.producer-role=retention-observer",
    "--network",
    "none",
    "--read-only",
    "--user",
    "0:0",
    "--cap-drop=ALL",
    "--cap-add=DAC_READ_SEARCH",
    "--security-opt=no-new-privileges",
    "--cpus",
    "0.25",
    "--memory",
    "128m",
    "--pids-limit",
    "16",
    ...roots.flatMap((root) => [
      "--mount",
      `type=bind,src=${path.join(destination, root)},target=/observed/${root},readonly`,
    ]),
    "--entrypoint",
    "/usr/bin/python3",
    "--workdir",
    "/",
    image,
    "-I",
    "-S",
    "-B",
    "/observed/controls/binutils-retention-observer.py",
  ];
}
export async function startRetentionObserver({
  destination,
  image,
  platform,
  attempt,
  environment,
  onFailure,
}) {
  const argv = retentionObserverArguments({
    destination,
    image,
    platform,
    attempt,
  });
  const fd = openSync(
    path.join(destination, "retention-observer.jsonl"),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let logBytes = 0,
    buffer = "",
    pending,
    terminalError,
    closing = false,
    sequence = 0;
  let child,
    closed,
    resolveClosed,
    logOpen = true;
  const closeLog = () => {
    if (logOpen) {
      logOpen = false;
      closeSync(fd);
    }
  };
  const fail = (error) => {
    terminalError ??= error instanceof Error ? error : Error(String(error));
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(terminalError);
      pending = undefined;
    }
    if (!closing) onFailure(terminalError);
  };
  const record = (stream, chunk) => {
    assert.ok(logOpen, "Retention log already closed");
    const line =
      JSON.stringify({ stream, base64: chunk.toString("base64") }) + "\n";
    const raw = Buffer.from(line);
    assert.ok(
      logBytes + raw.length <= maximumLog,
      "Retention observer log bound exceeded",
    );
    let written = 0;
    while (written < raw.length) {
      const progress = writeSync(fd, raw, written, raw.length - written);
      assert.ok(progress > 0, "Retention log made no write progress");
      written += progress;
    }
    logBytes += raw.length;
  };
  const wait = (number) => {
    assert.ok(!pending, "Concurrent retention request refused");
    if (terminalError) throw terminalError;
    return new Promise((resolve, reject) => {
      pending = {
        number,
        resolve,
        reject,
        timer: setTimeout(
          () => fail(Error("Retention observer response deadline")),
          35000,
        ),
      };
    });
  };
  const waitForClose = async (milliseconds) => {
    let timer;
    try {
      return await Promise.race([
        closed,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("Retention observer client close deadline")),
            milliseconds,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const finishClient = async (graceful) => {
    if (!child || !closed) return;
    if (graceful) child.stdin.end();
    else child.stdin.destroy();
    if (graceful) {
      try {
        return await waitForClose(5000);
      } catch {
        /* Escalate only the owned foreground client. */
      }
    }
    child.kill("SIGTERM");
    try {
      return await waitForClose(2000);
    } catch {
      child.kill("SIGKILL");
    }
    return await waitForClose(2000);
  };
  const ready = wait(0);
  try {
    child = spawn("docker", argv, {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stderr.on("data", (chunk) => {
      try {
        record("stderr", chunk);
      } catch (error) {
        fail(error);
      }
    });
    child.stdout.on("data", (chunk) => {
      try {
        record("stdout", chunk);
        buffer += chunk.toString("utf8");
        assert.ok(
          buffer.length <= 8192,
          "Retention observer message bound exceeded",
        );
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n");
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          assert.ok(pending, "Unsolicited retention response");
          const value = validateRetentionMessage(
            JSON.parse(line),
            pending.number,
          );
          const result = pending;
          pending = undefined;
          clearTimeout(result.timer);
          result.resolve(value);
        }
      } catch (error) {
        fail(error);
      }
    });
    child.on("close", (code, signal) => {
      if (buffer || !closing || code !== 0 || signal !== null)
        fail(
          Error(
            `Retention observer terminal: exit=${code}; signal=${signal}; partial=${buffer.length}`,
          ),
        );
      resolveClosed({ exitCode: code, signal });
    });
    await ready;
  } catch (error) {
    // Cleanup uses the independently inspected owner label, including failed starts.
    closing = true;
    fail(error);
    await ready.catch(() => undefined); // Also consume rejection when spawn throws synchronously.
    // The caller also removes the independently label-checked container.
    try {
      await finishClient(false);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Retention observer startup and client cleanup failed",
        { cause: cleanupError },
      );
    } finally {
      closeLog();
    }
    throw error;
  }
  let samples = 0,
    lastSample = null,
    closedOnce = false;
  return {
    async sample() {
      assert.ok(!closing, "Retention observer already closing");
      assert.ok(!pending, "Concurrent retention request refused");
      if (terminalError) throw terminalError;
      const reply = wait(++sequence);
      const request =
        JSON.stringify({ schemaVersion: 1, kind: "sample", sequence }) + "\n";
      try {
        record("stdin", Buffer.from(request));
        child.stdin.write(request);
      } catch (error) {
        fail(error);
      }
      lastSample = await reply;
      samples++;
      return lastSample;
    },
    async close() {
      assert.ok(!closedOnce, "Retention observer already closed");
      closedOnce = true;
      closing = true;
      if (pending)
        fail(Error("Retention observer closed with a pending sample"));

      try {
        const terminal = await finishClient(true);
        if (terminalError) throw terminalError;
        assert.deepEqual(terminal, { exitCode: 0, signal: null });
        return {
          state: "completed",
          samples,
          lastSample,
          retainedLogBytes: logBytes,
          terminal,
          independentImage: image,
          readOnly: true,
          network: "none",
          capability: "DAC_READ_SEARCH",
          nativeFilesystemQuotaEnforced: false,
        };
      } finally {
        closeLog();
      }
    },
  };
}

// Reconcile the durable transport, including requests, before accepting its counters.
export function reconcileRetentionLog(bytes, receipt) {
  assert.ok(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximumLog,
  );
  assert.equal(bytes.length, receipt.retainedLogBytes);
  const text = bytes.toString("utf8");
  assert.ok(text.endsWith("\n"));
  let ready = false,
    waiting = false,
    sequence = 0,
    samples = 0,
    buffer = "",
    lastSample;
  for (const line of text.slice(0, -1).split("\n")) {
    const row = JSON.parse(line);
    assert.deepEqual(Object.keys(row).sort(), ["base64", "stream"]);
    assert.ok(["stdin", "stdout", "stderr"].includes(row.stream));
    assert.equal(typeof row.base64, "string");
    const raw = Buffer.from(row.base64, "base64");
    assert.equal(raw.toString("base64"), row.base64);
    if (row.stream === "stderr") continue;
    if (row.stream === "stdin") {
      assert.ok(
        ready && !waiting && buffer === "",
        "Invalid durable request ordering",
      );
      assert.equal(
        raw.toString("utf8"),
        JSON.stringify({
          schemaVersion: 1,
          kind: "sample",
          sequence: ++sequence,
        }) + "\n",
      );
      waiting = true;
      continue;
    }
    buffer += raw.toString("utf8");
    assert.ok(buffer.length <= 8192);
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"),
        message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (!ready) {
        validateRetentionMessage(message, 0);
        ready = true;
      } else {
        assert.ok(waiting, "Unsolicited durable retention response");
        lastSample = validateRetentionMessage(message, sequence);
        samples++;
        waiting = false;
      }
    }
  }
  assert.ok(
    ready && samples > 0 && !waiting && buffer === "",
    "Incomplete retention transport",
  );
  assert.equal(receipt.samples, samples);
  assert.deepEqual(receipt.lastSample, lastSample);
  return { samples, lastSample };
}
