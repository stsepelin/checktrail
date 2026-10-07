import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { runProcess } from "../src/runner.js";
import {
  captureProcessOutput,
  parseCapturedProcessOutput,
} from "../src/process-output.js";
import { fixture } from "./helpers.js";
const command = (source: string) => ({
  executable: process.execPath,
  args: ["-e", source],
  cwd: ".",
});
test("physical process output retains exact binary stdout stderr and digests while default presentation stays unchanged", async (t) => {
  const root = await fixture(t, {});
  const source =
    "process.stdout.write(Buffer.from([0,255,195,169]));process.stderr.write(Buffer.from([255,0]));";
  const result = await runProcess(root, command(source), {
    timeoutMs: 10000,
    captureRawOutput: true,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.outputBytes, 6);
  const output = parseCapturedProcessOutput(result.capturedOutput);
  assert.deepEqual(
    Buffer.from(output.stdout.base64, "base64"),
    Buffer.from([0, 255, 195, 169]),
  );
  assert.deepEqual(
    Buffer.from(output.stderr.base64, "base64"),
    Buffer.from([255, 0]),
  );
  assert.equal(output.stdout.bytes, 4);
  assert.equal(output.stderr.bytes, 2);
  assert.equal(output.observedBytes, 6);
  assert.equal(output.completeForObservedStreams, true);
  assert.equal(result.stdout, "\0�é");
  assert.equal(result.stderr, "�\0");
  const ordinary = await runProcess(root, command(source), {
    timeoutMs: 10000,
  });
  assert.equal(ordinary.capturedOutput, undefined);
  assert.equal(ordinary.stdout, result.stdout);
  assert.equal(ordinary.stderr, result.stderr);
});
test("physical output zero exact and multibyte overrun limits distinguish delivered bytes from UTF8 replacements", async (t) => {
  const root = await fixture(t, {});
  const exact = await runProcess(root, command("process.stdout.write('é');"), {
    timeoutMs: 10000,
    maxOutputBytes: 2,
    captureRawOutput: true,
  });
  assert.equal(exact.exitCode, 0);
  assert.equal(exact.truncated, false);
  assert.equal(exact.capturedOutput!.stdout.bytes, 2);
  assert.equal(exact.capturedOutput!.completeForObservedStreams, true);
  const over = await runProcess(
    root,
    command("process.stdout.write('é');setInterval(()=>{},1000);"),
    { timeoutMs: 10000, maxOutputBytes: 1, captureRawOutput: true },
  );
  assert.equal(over.truncated, true);
  assert.equal(over.outputBytes, 2);
  assert.equal(Buffer.byteLength(over.stdout), 3);
  assert.equal(over.capturedOutput!.stdout.base64, "ww==");
  assert.equal(over.capturedOutput!.stdout.bytes, 1);
  assert.equal(over.capturedOutput!.completeForObservedStreams, false);
  for (const [source, truncated, complete] of [
    ["process.exit(0)", false, true],
    ["process.stdout.write('x');setInterval(()=>{},1000)", true, false],
  ] as const) {
    const result = await runProcess(root, command(source), {
      timeoutMs: 10000,
      maxOutputBytes: 0,
      captureRawOutput: true,
    });
    assert.equal(result.truncated, truncated);
    assert.equal(result.capturedOutput!.stdout.bytes, 0);
    assert.equal(result.capturedOutput!.stderr.bytes, 0);
    assert.equal(result.capturedOutput!.completeForObservedStreams, complete);
  }
});
test("physical output codec reconciles canonical bytes digests combined ceilings and a large valid boundary", () => {
  const bytes = Buffer.alloc(16 * 1024 * 1024, 165);
  const boundary = captureProcessOutput(
    bytes,
    Buffer.alloc(0),
    bytes.length,
    true,
  );
  assert.equal(parseCapturedProcessOutput(boundary).stdout.bytes, bytes.length);
  const original = captureProcessOutput(
    Buffer.from("f"),
    Buffer.from("z"),
    2,
    true,
  );
  for (const edit of [
    (x: typeof original) => {
      x.stdout.base64 = "Zh==";
    },
    (x: typeof original) => {
      x.stdout.bytes = 2;
    },
    (x: typeof original) => {
      x.stdout.sha256 = "0".repeat(64);
    },
    (x: typeof original) => {
      x.observedBytes = 1;
    },
  ]) {
    const changed = structuredClone(original);
    edit(changed);
    assert.throws(() => parseCapturedProcessOutput(changed));
  }
  assert.throws(() =>
    captureProcessOutput(bytes, Buffer.from([1]), bytes.length + 1, true),
  );
  assert.equal(
    original.stdout.sha256,
    createHash("sha256").update("f").digest("hex"),
  );
});
test("physical output invalid admission limits reject before a project command can execute", async (t) => {
  const root = await fixture(t, {});
  for (const maximum of [-1, 1.5, 16777217])
    await assert.rejects(
      runProcess(root, command("throw new Error('must not execute')"), {
        timeoutMs: 10000,
        maxOutputBytes: maximum,
        captureRawOutput: true,
      }),
      /Captured output limit/,
    );
});
