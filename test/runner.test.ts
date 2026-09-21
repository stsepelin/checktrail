import { test } from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../src/runner.js";
import { fixture } from "./helpers.js";

test("passes arguments literally, strips unlisted environment values, and captures streams", async (t) => {
  const root = await fixture(t, {});
  const previous = process.env.CHECKTRAIL_SYNTHETIC_SECRET;
  process.env.CHECKTRAIL_SYNTHETIC_SECRET = "not-for-child";
  t.after(() => {
    if (previous === undefined) delete process.env.CHECKTRAIL_SYNTHETIC_SECRET;
    else process.env.CHECKTRAIL_SYNTHETIC_SECRET = previous;
  });
  const command = {
    executable: process.execPath,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1))); process.stderr.write(String(process.env.CHECKTRAIL_SYNTHETIC_SECRET))",
      "$(not-a-command); quoted value",
    ],
    cwd: ".",
  };
  const result = await runProcess(root, command, { timeoutMs: 5000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '["$(not-a-command); quoted value"]');
  assert.equal(result.stderr, "undefined");
});

test("reports missing executables separately from code failures", async (t) => {
  const root = await fixture(t, {});
  const result = await runProcess(
    root,
    { executable: "checktrail-definitely-missing-tool", args: [], cwd: "." },
    { timeoutMs: 1000 },
  );
  assert.equal(result.errorCode, "ENOENT");
  assert.notEqual(result.exitCode, 0);
});

test("kills long-running processes on deadline and cancellation", async (t) => {
  const root = await fixture(t, {});
  const command = {
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: ".",
  };
  const timedOut = await runProcess(root, command, { timeoutMs: 100 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.signal, "SIGKILL");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const cancelled = await runProcess(root, command, {
      timeoutMs: 5000,
      signal: controller.signal,
    });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.signal, "SIGKILL");
  } finally {
    clearTimeout(timer);
  }
});

test("terminates a process group when a grandchild keeps the output pipe open", async (t) => {
  const root = await fixture(t, {});
  const source =
    "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'inherit'});";
  const result = await runProcess(
    root,
    { executable: process.execPath, args: ["-e", source], cwd: "." },
    { timeoutMs: 150 },
  );
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 3000);
});

test("bounds combined output and marks truncated evidence", async (t) => {
  const root = await fixture(t, {});
  const result = await runProcess(
    root,
    {
      executable: process.execPath,
      args: [
        "-e",
        'process.stdout.write("x".repeat(1000000)); setInterval(() => {}, 1000)',
      ],
      cwd: ".",
    },
    { timeoutMs: 5000, maxOutputBytes: 100 },
  );
  assert.equal(result.truncated, true);
  assert.equal(
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    100,
  );
  assert.notEqual(result.exitCode, 0);
});
