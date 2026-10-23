import { test } from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../src/runner.js";
import { fixture } from "./helpers.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
async function reached(file: string) {
  const until = performance.now() + 7000;
  while (performance.now() < until) {
    try {
      const value = JSON.parse(await readFile(file, "utf8")) as { pid: number };
      assert.ok(value.pid > 1);
      return value;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError)
      )
        throw error;
    }
    await delay(10);
  }
  throw Error("Actual runner body was not reached");
}

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
  const root = await fixture(t, {}),
    timedMarker = path.join(root, "timed.json"),
    cancelMarker = path.join(root, "cancel.json");
  const source =
    "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);";
  const command = (file: string) => ({
    executable: process.execPath,
    args: ["-e", source, file],
    cwd: ".",
  });
  const timedOut = await runProcess(root, command(timedMarker), {
    timeoutMs: 5000,
  });
  const timedBody = await reached(timedMarker);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.signal, "SIGKILL");
  assert.throws(() => process.kill(timedBody.pid, 0), { code: "ESRCH" });
  const controller = new AbortController(),
    running = runProcess(root, command(cancelMarker), {
      timeoutMs: 15000,
      signal: controller.signal,
    });
  try {
    const body = await reached(cancelMarker);
    controller.abort();
    const cancelled = await running;
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.signal, "SIGKILL");
    assert.throws(() => process.kill(body.pid, 0), { code: "ESRCH" });
  } finally {
    controller.abort();
    await running;
  }
});
test("terminates a process group when a grandchild keeps the output pipe open", async (t) => {
  const root = await fixture(t, {}),
    marker = path.join(root, "pipe-child.json");
  const source =
    "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});child.on('spawn',()=>require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:child.pid})));child.unref();";
  const result = await runProcess(
    root,
    { executable: process.execPath, args: ["-e", source, marker], cwd: "." },
    { timeoutMs: 5000 },
  );
  const child = await reached(marker);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 8000);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
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

test("runner accounts raw combined bytes beyond retention without counting Unicode replacement characters", async (t) => {
  const root = await fixture(t, {});
  const complete = await runProcess(
    root,
    {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('é');process.stderr.write('😀');"],
      cwd: ".",
    },
    { timeoutMs: 5000 },
  );
  assert.equal(complete.outputBytes, 6);
  assert.equal(complete.stdout, "é");
  assert.equal(complete.stderr, "😀");
  const truncated = await runProcess(
    root,
    {
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write('é'.repeat(4096));setInterval(()=>{},1000);",
      ],
      cwd: ".",
    },
    { timeoutMs: 5000, maxOutputBytes: 1 },
  );
  assert.equal(truncated.truncated, true);
  assert.ok(truncated.outputBytes! >= 8192);
  assert.equal(Buffer.byteLength(truncated.stdout), 3); // UTF-8 replacement of a retained half character.
  assert.equal(truncated.signal, "SIGKILL");
});
