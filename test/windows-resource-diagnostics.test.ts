import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
const { windowsResourceFailureContext, windowsResourceWorkerFailureMessage } =
  await import(
    new URL("../../scripts/measure-windows-resources.mjs", import.meta.url).href
  );
test("Windows resource diagnostics distinguish a Go spawn failure without exposing executable paths or raw output", () => {
  const secret = "C:/private/synthetic-only/input";
  const result = windowsResourceFailureContext(
    "go-before",
    "polyglot",
    {
      status: null,
      error: { code: "ETIMEDOUT", message: secret, path: secret },
      stdout: "",
      stderr: secret,
    },
    10010.6,
  );
  assert.equal(result.stage, "go-before");
  assert.equal(result.workload, "polyglot");
  assert.equal(result.timeoutMs, 10000);
  assert.equal(result.elapsedMs, 10011);
  assert.equal(result.exitCode, null);
  assert.equal(result.errorCode, "ETIMEDOUT");
  assert.equal(
    result.timedOut,
    null,
    "A missing runProcess flag is unknown for spawnSync",
  );
  assert.equal(result.stdout.available, true);
  assert.equal(result.stdout.bytes, 0);
  assert.equal(result.stderr.bytes, Buffer.byteLength(secret));
  assert.equal(
    result.stderr.sha256,
    createHash("sha256").update(secret).digest("hex"),
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
});
test("Windows resource diagnostics retain exact worker timeout and native cleanup metadata while omitting unobserved output", () => {
  const result = windowsResourceFailureContext(
    "worker",
    "large",
    {
      exitCode: null,
      errorCode: "WINDOWS_PROCESS_TIMEOUT",
      signal: "SIGTERM",
      timedOut: true,
      cancelled: false,
      truncated: false,
      windowsExecution: {
        phase: "failed",
        nativeError: 5,
        cleanup: "confirmed",
        activeAfterCleanup: 0,
      },
    },
    120005,
  );
  assert.equal(result.timeoutMs, 120000);
  assert.equal(result.elapsedMs, 120005);
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.errorCode, "WINDOWS_PROCESS_TIMEOUT");
  assert.equal(result.signal, "SIGTERM");
  assert.deepEqual(result.native, {
    phase: "failed",
    nativeError: 5,
    cleanup: "confirmed",
    activeAfterCleanup: 0,
  });
  assert.deepEqual(result.stderr, {
    available: false,
    bytes: null,
    sha256: null,
  });
});
test("Windows resource diagnostics bound structured child failures and reject arbitrary names", () => {
  const secret = "C:/private/synthetic-only/context";
  const process = {
    exitCode: null,
    errorCode: "EPIPE",
    timedOut: true,
    cancelled: false,
    truncated: false,
    windowsNativeError: 5,
    message: secret,
    file: secret,
  };
  const record = {
    profile: "windows-workload-incomplete-diagnostic",
    workload: "large",
    outcome: "incomplete",
    message: secret,
    checks: Array.from({ length: 4 }, () => ({
      path: secret,
      processes: Array.from({ length: 5 }, () => process),
    })),
  };
  const result = windowsResourceFailureContext(
    "worker",
    "large",
    {
      stderr: Array.from({ length: 10 }, () => JSON.stringify(record)).join(
        "\n",
      ),
    },
    120001,
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnostics[0].checks.length, 4);
  assert.equal(result.diagnostics[0].checks[0].processes.length, 4);
  const validRecord = { ...record, checks: [{ processes: [process] }] };
  const valid = windowsResourceFailureContext(
    "worker",
    "large",
    { stderr: JSON.stringify(validRecord) },
    120001,
  );
  assert.equal(valid.diagnostics[0].checks[0].processes[0].errorCode, "EPIPE");
  assert.equal(valid.diagnostics[0].checks[0].processes[0].timedOut, true);
  assert.throws(() =>
    windowsResourceFailureContext("arbitrary-stage", "small", {}, 0),
  );
  assert.throws(() =>
    windowsResourceFailureContext("worker", "../private", {}, 0),
  );
});

test("Windows resource worker diagnostics preserve both original negative-case failure messages", () => {
  const context = windowsResourceFailureContext(
    "worker",
    "small",
    { exitCode: 1, stderr: "public synthetic failure" },
    7000,
  );
  for (const original of [
    "Resource workload validation did not pass",
    "Resource workload source changed",
  ]) {
    const message = windowsResourceWorkerFailureMessage(original, context);
    assert.ok(message.startsWith(original + "\n"));
    assert.deepEqual(JSON.parse(message.slice(original.length + 1)), context);
    assert.throws(
      () => assert.equal(1, 0, message),
      (error: unknown) => {
        assert.ok(error instanceof assert.AssertionError);
        assert.ok(error.message.includes(original));
        return true;
      },
    );
    assert.equal(windowsResourceWorkerFailureMessage(original, null), original);
  }
});
