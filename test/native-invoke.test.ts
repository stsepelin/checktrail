import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { runProcess } from "../src/runner.js";
import { processSnapshot, type ProcessIdentity } from "../src/process-tree.js";
import { jvmInvoker } from "../src/jvm-invoke.js";
import { invokeNative } from "../src/native-invoke.js";
import {
  createNativeAttemptStorage,
  NativeAttemptWriter,
} from "../src/native-attempt-storage.js";
function storage(maxOutputBytes = 1024, maxNativeCalls = 16) {
  const store = createNativeAttemptStorage({
    schemaVersion: 1,
    format: "native-attempt-journal",
    journalId: randomUUID(),
    sourceFingerprint: "a".repeat(64),
    outerCommandSha256: "b".repeat(64),
    maxNativeCalls,
    maxOutputBytes,
  });
  return { store, writer: new NativeAttemptWriter(store.context) };
}
const options = (journal: NativeAttemptWriter, maxOutputBytes = 1024) => ({
  journal,
  maxOutputBytes,
  timeoutMs: 10000,
});
function gone(pid: number | null) {
  assert.ok(pid && pid > 1);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}
test("native invocation retains binary bytes and real process identities for successful and failed children in one ordered journal", async () => {
  const { store, writer } = storage();
  const root = await mkdtemp(path.join(tmpdir(), "checktrail-native-pid-"));
  try {
    const calls = [];
    for (const code of [0, 1])
      calls.push(
        await invokeNative(
          process.execPath,
          [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, String(code)))},String(process.pid));process.stdout.write(Buffer.from([0,255,195,169]));process.stderr.write(Buffer.from([255,0]));process.exitCode=${code}`,
          ],
          options(writer),
        ),
      );
    writer.close();
    for (const [i, r] of calls.entries()) {
      assert.equal(r.error, undefined);
      assert.equal(
        r.pid,
        Number(await readFile(path.join(root, String(i)), "utf8")),
      );
      assert.equal(r.status, i);
      assert.equal(r.signal, null);
      assert.deepEqual(r.stdout, Buffer.from([0, 255, 195, 169]));
      assert.deepEqual(r.stderr, Buffer.from([255, 0]));
      assert.equal(r.observedBytes, 6);
      assert.equal(r.capturedOutput.completeForObservedStreams, true);
      gone(r.pid);
    }
    assert.notEqual(calls[0]!.pid, calls[1]!.pid);
    const receipt = store.read();
    assert.equal(receipt.completeForRecordedCalls, true);
    assert.equal(receipt.attempts.length, 2);
    for (const [i, call] of receipt.attempts.entries()) {
      assert.equal(call.pid, calls[i]!.pid);
      assert.deepEqual(call.capturedOutput, calls[i]!.capturedOutput);
    }
  } finally {
    writer.close();
    store.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
test("native invocation preserves failed spawn evidence without manufacturing a PID and refuses exhausted admission before starting project code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "checktrail-native-invoke-"));
  const { store, writer } = storage(1024, 1);
  const marker = path.join(root, "must-not-exist");
  try {
    const failed = await invokeNative(
      path.join(root, "missing-executable"),
      [],
      options(writer),
    );
    assert.equal(failed.pid, null);
    assert.equal(failed.status, null);
    assert.equal(failed.signal, null);
    assert.equal(failed.error?.code, "ENOENT");
    assert.equal(failed.observedBytes, 0);
    await assert.rejects(
      invokeNative(
        process.execPath,
        [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
        ],
        options(writer),
      ),
      /call allowance/,
    );
    await assert.rejects(stat(marker), { code: "ENOENT" });
    writer.close();
    const receipt = store.read();
    assert.equal(receipt.attempts.length, 1);
    assert.equal(receipt.attempts[0]!.pid, null);
    assert.equal(receipt.attempts[0]!.state, "spawn-error");
  } finally {
    writer.close();
    store.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
test("native invocation leaves preaborted and invalid-bound calls unreached while retaining exact zero-output and exact-prefix controls", async () => {
  const { store, writer } = storage(8, 2);
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await invokeNative(
      process.execPath,
      ["-e", "throw Error('unreachable')"],
      { ...options(writer), signal: controller.signal },
    );
    assert.equal(result.pid, null);
    assert.equal(result.error?.code, "NATIVE_CANCELLED");
    for (const maxOutputBytes of [-1, 16 * 1024 * 1024 + 1, 0.5])
      await assert.rejects(
        invokeNative(process.execPath, ["-e", "throw Error('unreachable')"], {
          ...options(writer),
          maxOutputBytes,
        }),
        /bounds/,
      );
    const zero = await invokeNative(
      process.execPath,
      ["-e", ""],
      options(writer, 0),
    );
    const exact = await invokeNative(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.from([0,1,2,3,4,5,6,255]))"],
      options(writer, 8),
    );
    assert.equal(zero.error, undefined);
    assert.equal(exact.error, undefined);
    assert.equal(zero.observedBytes, 0);
    assert.equal(exact.observedBytes, 8);
    writer.close();
    const receipt = store.read();
    assert.equal(receipt.attempts.length, 2);
    assert.equal(receipt.completeForRecordedCalls, true);
  } finally {
    writer.close();
    store.destroy();
  }
});
test("native invocation distinguishes journal exhaustion from a smaller caller output cap and keeps each observed prefix on failure", async () => {
  for (const [journalCap, callerCap, state, kept] of [
    [3, 8, "output-limit", 3],
    [8, 3, "transport-error", 8],
    [0, 8, "output-limit", 0],
  ] as const) {
    const { store, writer } = storage(journalCap);
    try {
      const r = await invokeNative(
        process.execPath,
        [
          "-e",
          "process.stdout.write(Buffer.from([0,1,2,3,4,5,6,255]));setInterval(()=>{},1000)",
        ],
        options(writer, callerCap),
      );
      assert.equal(r.error?.code, "NATIVE_OUTPUT_LIMIT");
      assert.equal(r.observedBytes, 8);
      assert.deepEqual(
        r.stdout,
        Buffer.from([0, 1, 2, 3, 4, 5, 6, 255]).subarray(0, callerCap),
      );
      gone(r.pid);
      writer.close();
      const receipt = store.read();
      assert.equal(receipt.attempts.length, 1);
      assert.equal(receipt.attempts[0]!.state, state);
      assert.equal(
        receipt.attempts[0]!.capturedOutput.stdout.bytes +
          receipt.attempts[0]!.capturedOutput.stderr.bytes,
        kept,
      );
    } finally {
      writer.close();
      store.destroy();
    }
  }
});
test("native invocation retains reached child bytes and identities across actual cancellation deadlines and observer failure", async () => {
  for (const mode of ["cancel", "timeout", "observer"] as const) {
    const { store, writer } = storage();
    const controller = new AbortController();
    try {
      const r = await invokeNative(
        process.execPath,
        [
          "-e",
          "process.stdout.write(Buffer.from([0,255,1]));setInterval(()=>{},1000)",
        ],
        {
          ...options(writer),
          timeoutMs: mode === "timeout" ? 1000 : 10000,
          signal: controller.signal,
          observe: () => {
            if (mode === "cancel") controller.abort();
            if (mode === "observer") throw Error("synthetic observer failure");
          },
        },
      );
      assert.equal(
        r.error?.code,
        mode === "cancel"
          ? "NATIVE_CANCELLED"
          : mode === "timeout"
            ? "NATIVE_TIMEOUT"
            : "NATIVE_TRANSPORT_ERROR",
      );
      assert.deepEqual(r.stdout, Buffer.from([0, 255, 1]));
      assert.equal(r.observedBytes, 3);
      gone(r.pid);
      writer.close();
      const receipt = store.read();
      assert.equal(receipt.attempts[0]!.pid, r.pid);
      assert.equal(receipt.attempts[0]!.state, "transport-error");
      assert.deepEqual(receipt.attempts[0]!.capturedOutput, r.capturedOutput);
    } finally {
      writer.close();
      store.destroy();
    }
  }
});
test(
  "native invocation closes ordinary descendants retaining output pipes after root exit without inventing a successful timeout",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "checktrail-native-invoke-group-"),
    );
    const { store, writer } = storage();
    const witness = path.join(root, "child-pid");
    let childIdentity: ProcessIdentity | undefined;
    let cleanupError: unknown;
    try {
      const identityModule = pathToFileURL(
        path.resolve(import.meta.dirname, "../src/process-tree.js"),
      ).href;
      const script = `const {spawn}=require('node:child_process');(async()=>{const {processSnapshot}=await import(${JSON.stringify(identityModule)});const child=spawn(process.execPath,['-e', 'setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});const identity=(await processSnapshot()).find(row=>row.pid===child.pid);if(!identity)throw Error('missing native child identity');require('node:fs').writeFileSync(${JSON.stringify(witness)},JSON.stringify(identity));child.unref();})();`;
      const r = await invokeNative(
        process.execPath,
        ["-e", script],
        options(writer),
      );
      childIdentity = JSON.parse(
        await readFile(witness, "utf8"),
      ) as ProcessIdentity;
      assert.ok(childIdentity.pid > 1);
      gone(childIdentity.pid);
      assert.equal(r.status, 0);
      assert.equal(r.error, undefined);
      gone(r.pid);
      writer.close();
      const receipt = store.read();
      assert.equal(receipt.attempts.length, 1);
      assert.equal(receipt.completeForRecordedCalls, true);
    } finally {
      if (childIdentity) {
        try {
          const current = (await processSnapshot()).find(
            (row) => row.pid === childIdentity!.pid,
          );
          if (
            current?.identity === childIdentity.identity &&
            current.group === childIdentity.group
          )
            process.kill(current.pid, "SIGKILL");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH")
            cleanupError = cause;
        }
      }
      writer.close();
      store.destroy();
      await rm(root, { recursive: true, force: true });
    }
    assert.equal(cleanupError, undefined, "owned fixture cleanup failed");
  },
);

test("native invocation respects mirror backpressure without dropping physical chunks and deadlines release a stalled drain", async () => {
  for (const stalled of [false, true]) {
    const { store, writer } = storage(512 * 1024);
    const chunks: Buffer[] = [],
      delivered: Buffer[] = [];
    const sink = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        if (!stalled) setTimeout(callback, 5);
      },
    });
    try {
      const r = await invokeNative(
        process.execPath,
        ["-e", "process.stdout.write(Buffer.alloc(256*1024,97))"],
        {
          ...options(writer, 512 * 1024),
          timeoutMs: stalled ? 1000 : 10000,
          mirror: sink,
          observe: (chunk) => delivered.push(Buffer.from(chunk)),
        },
      );
      assert.equal(r.error?.code, stalled ? "NATIVE_TIMEOUT" : undefined);
      // A stalled sink can leave bytes in the native pipe at the deadline. Only
      // delivered chunks are observed; no unreceived suffix is manufactured.
      assert.deepEqual(r.stdout, Buffer.concat(delivered));
      assert.equal(r.observedBytes, r.stdout.length);
      assert.ok(r.observedBytes > 0 && r.observedBytes <= 256 * 1024);
      assert.ok(r.stdout.every((byte) => byte === 97));
      if (!stalled) assert.equal(r.observedBytes, 256 * 1024);
      gone(r.pid);
      if (!stalled) {
        await new Promise<void>((resolve, reject) => {
          sink.once("error", reject);
          sink.end(resolve);
        });
        assert.deepEqual(Buffer.concat(chunks), r.stdout);
      }
      assert.equal(sink.listenerCount("drain"), 0);
      writer.close();
      const receipt = store.read();
      assert.equal(
        receipt.attempts[0]!.state,
        stalled ? "transport-error" : "exited",
      );
      assert.deepEqual(receipt.attempts[0]!.capturedOutput, r.capturedOutput);
    } finally {
      sink.destroy();
      writer.close();
      store.destroy();
    }
  }
});
test("JVM invokers share one explicit native journal across quiet and observed calls and retain bytes rejected by strict decoding", async () => {
  const { store, writer } = storage();
  const observed: Buffer[] = [];
  try {
    const quiet = jvmInvoker(process.env, false, undefined, writer);
    const active = jvmInvoker(
      process.env,
      false,
      (chunk) => observed.push(Buffer.from(chunk)),
      writer,
    );
    const a = await quiet(process.execPath, [
      "-e",
      "process.stdout.write('quiet')",
    ]);
    const b = await active(process.execPath, [
      "-e",
      "process.stderr.write('observed');process.exitCode=1",
    ]);
    await assert.rejects(
      quiet(process.execPath, [
        "-e",
        "process.stdout.write(Buffer.from([255,0]))",
      ]),
      /encoded data|encoding/i,
    );
    assert.equal(a.stdout, "quiet");
    assert.equal(a.stdoutBytes, 5);
    assert.equal(b.status, 1);
    assert.equal(b.stderr, "observed");
    assert.deepEqual(Buffer.concat(observed), Buffer.from("observed"));
    writer.close();
    const receipt = store.read();
    assert.equal(receipt.attempts.length, 3);
    assert.equal(receipt.attempts[0]!.pid, a.pid);
    assert.equal(receipt.attempts[1]!.pid, b.pid);
    assert.deepEqual(
      Buffer.from(receipt.attempts[2]!.capturedOutput.stdout.base64, "base64"),
      Buffer.from([255, 0]),
    );
    assert.equal(receipt.completeForRecordedCalls, true);
  } finally {
    writer.close();
    store.destroy();
  }
});

test("native invocation journal retains the reached physical prefix after its actual wrapper is killed before any final response", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "checktrail-interrupted-native-"),
  );
  // The wrapper is the sole writer. Its header/log targets are owned by this parent.
  const journal = createNativeAttemptStorage({
    schemaVersion: 1,
    format: "native-attempt-journal",
    journalId: randomUUID(),
    sourceFingerprint: "c".repeat(64),
    outerCommandSha256: "d".repeat(64),
    maxNativeCalls: 2,
    maxOutputBytes: 1024,
  });
  const ready = path.join(root, "ready");
  const controller = new AbortController();
  const invocationModule = pathToFileURL(
    path.resolve(import.meta.dirname, "../src/native-invoke.js"),
  ).href;
  const storageModule = pathToFileURL(
    path.resolve(import.meta.dirname, "../src/native-attempt-storage.js"),
  ).href;
  const script = `import {invokeNative} from ${JSON.stringify(invocationModule)};import {NativeAttemptWriter} from ${JSON.stringify(storageModule)};import{writeFileSync}from'node:fs';const writer=new NativeAttemptWriter(JSON.parse(process.argv[1]));await invokeNative(process.execPath,['-e','process.stdout.write(Buffer.from([0,255,7]));setInterval(()=>{},1000)'],{journal:writer,maxOutputBytes:1024,timeoutMs:110000,observe:()=>writeFileSync(process.argv[2],'ready')});writer.close();`;
  const pending = runProcess(
    root,
    {
      executable: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        script,
        JSON.stringify(journal.context),
        ready,
      ],
      cwd: ".",
    },
    { timeoutMs: 10000, maxOutputBytes: 1024, signal: controller.signal },
  );
  try {
    const deadline = performance.now() + 5000;
    for (;;) {
      try {
        assert.equal(await readFile(ready, "utf8"), "ready");
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      assert.ok(
        performance.now() < deadline,
        "actual native output was not reached",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const before = journal.read();
    assert.equal(before.attempts.length, 1);
    assert.equal(before.attempts[0]!.state, "interrupted");
    assert.deepEqual(
      Buffer.from(before.attempts[0]!.capturedOutput.stdout.base64, "base64"),
      Buffer.from([0, 255, 7]),
    );
    controller.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(result.errorCode, undefined);
    const after = journal.read();
    assert.equal(after.completeForRecordedCalls, false);
    assert.equal(after.attempts[0]!.state, "interrupted");
    assert.equal(after.attempts[0]!.pid, before.attempts[0]!.pid);
    assert.deepEqual(
      after.attempts[0]!.capturedOutput,
      before.attempts[0]!.capturedOutput,
    );
    gone(after.attempts[0]!.pid);
  } finally {
    controller.abort();
    await pending;
    journal.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
