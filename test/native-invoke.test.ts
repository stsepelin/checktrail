import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
test("native invocation retains mirror failures before and after native exit and bounds pending writes without removing caller listeners", async () => {
  for (const mode of [
    "live-error",
    "exited-error",
    "exited-success",
    "exited-stall",
    "late-error",
    "sync-error",
  ] as const) {
    const { store, writer } = storage();
    let sinkPid = 0;
    let callbackObservedExit = false;
    const delivered: Buffer[] = [];
    const callerErrors: Error[] = [];
    let lateErrorObserved: (() => void) | undefined;
    const lateError = new Promise<void>((resolve) => {
      lateErrorObserved = resolve;
    });
    const callerError = (cause: Error) => {
      callerErrors.push(cause);
      lateErrorObserved?.();
    };
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        delivered.push(Buffer.from(chunk));
        sinkPid = Number(chunk.toString());
        if (mode === "sync-error")
          throw Object.assign(Error("synthetic"), { code: "EPIPE" });
        if (mode === "exited-stall") return;
        if (mode === "late-error") {
          setTimeout(
            () =>
              callback(Object.assign(Error("synthetic"), { code: "EPIPE" })),
            2500,
          );
          return;
        }
        const finish = () => {
          if (mode.startsWith("exited-")) {
            try {
              process.kill(sinkPid, 0);
              setTimeout(finish, 5);
              return;
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== "ESRCH")
                throw cause;
            }
            callbackObservedExit = true;
          }
          callback(
            mode === "exited-success"
              ? undefined
              : Object.assign(Error("synthetic"), { code: "EPIPE" }),
          );
        };
        setImmediate(finish);
      },
    });
    sink.on("error", callerError);
    try {
      const result = await invokeNative(
        process.execPath,
        [
          "-e",
          `process.stdout.write(String(process.pid));${mode === "live-error" || mode === "sync-error" || mode === "late-error" ? "setInterval(()=>{},1000)" : ""}`,
        ],
        {
          ...options(writer),
          timeoutMs: 2000,
          mirror: sink,
        },
      );
      assert.equal(result.pid, sinkPid);
      gone(result.pid);
      assert.equal(
        result.error?.code,
        mode === "exited-success"
          ? undefined
          : mode === "exited-stall" || mode === "late-error"
            ? "NATIVE_TIMEOUT"
            : "EPIPE",
      );
      assert.deepEqual(result.stdout, Buffer.concat(delivered));
      assert.equal(result.observedBytes, result.stdout.length);
      assert.equal(
        result.capturedOutput.completeForObservedStreams,
        mode === "exited-success",
      );
      if (mode === "exited-error" || mode === "exited-success")
        assert.equal(callbackObservedExit, true);
      if (mode === "late-error") {
        assert.deepEqual(sink.listeners("error"), [callerError]);
        assert.deepEqual(callerErrors, []);
        await lateError;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.deepEqual(sink.listeners("error"), [callerError]);
      assert.equal(sink.listenerCount("drain"), 0);
      assert.deepEqual(
        callerErrors.map((cause) => (cause as NodeJS.ErrnoException).code),
        mode === "live-error" ||
          mode === "exited-error" ||
          mode === "late-error"
          ? ["EPIPE"]
          : [],
      );
      writer.close();
      const receipt = store.read();
      assert.equal(
        receipt.attempts[0]!.state,
        mode === "exited-success" ? "exited" : "transport-error",
      );
      assert.equal(receipt.attempts[0]!.errorCode, result.error?.code ?? null);
      assert.deepEqual(
        receipt.attempts[0]!.capturedOutput,
        result.capturedOutput,
      );
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
  const script = `import {invokeNative} from ${JSON.stringify(invocationModule)};import {NativeAttemptWriter} from ${JSON.stringify(storageModule)};import{writeFileSync,existsSync}from'node:fs';const writer=new NativeAttemptWriter(JSON.parse(process.argv[1]));let published=false;await invokeNative(process.execPath,['-e','process.stdout.write(Buffer.from([0,255,7]));setInterval(()=>{},1000)'],{journal:writer,maxOutputBytes:1024,timeoutMs:110000,observe:()=>{if(published)return;published=true;writeFileSync(process.argv[2],'');while(!existsSync(process.argv[2]+'.release'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);writeFileSync(process.argv[2],'ready')}});writer.close();`;
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
    let observedEmptyPublication = false;
    for (;;) {
      try {
        const publication = await readFile(ready, "utf8");
        if (publication === "ready") break;
        // Hold the real writer between file creation and its complete marker.
        // Existence alone cannot attest that its native output was published.
        assert.equal(publication, "");
        observedEmptyPublication = true;
        await writeFile(ready + ".release", "release");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      assert.ok(
        performance.now() < deadline,
        "actual native output was not reached",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(observedEmptyPublication, true);
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

test("native wrapper output adapter keeps binary evidence before parser decoding and preserves failed exit receipts", async () => {
  const { invokeNativeOutput } = await import("../src/native-invoke-output.js");
  const { store, writer } = storage();
  try {
    const script =
      "process.stdout.write(Buffer.from([0,255,195,169]));process.stderr.write(Buffer.from([255,0]));process.exitCode=1";
    const raw = await invokeNativeOutput(process.execPath, ["-e", script], {
      journal: writer,
      maxBuffer: 64,
      timeout: 10000,
    });
    const text = await invokeNativeOutput(process.execPath, ["-e", script], {
      journal: writer,
      maxBuffer: 64,
      timeout: 10000,
      encoding: "utf8",
    });
    assert.equal(raw.error, undefined);
    assert.equal(text.error, undefined);
    assert.equal(raw.status, 1);
    assert.equal(text.status, 1);
    assert.equal(raw.nativeExitCode, 1);
    assert.equal(text.nativeExitCode, 1);
    assert.deepEqual(raw.stdout, Buffer.from([0, 255, 195, 169]));
    assert.deepEqual(raw.stderr, Buffer.from([255, 0]));
    assert.equal(text.stdout, raw.stdout.toString("utf8"));
    assert.equal(text.stderr, raw.stderr.toString("utf8"));
    assert.deepEqual(text.capturedOutput, raw.capturedOutput);
    writer.close();
    const journal = store.read();
    assert.equal(journal.completeForRecordedCalls, true);
    assert.equal(journal.attempts.length, 2);
    assert.deepEqual(
      journal.attempts.map((a) => a.pid),
      [raw.pid, text.pid],
    );
    assert.deepEqual(
      journal.attempts.map((a) => a.capturedOutput),
      [raw.capturedOutput, text.capturedOutput],
    );
    assert.equal(new Set([raw.pid, text.pid]).size, 2);
  } finally {
    writer.close();
    store.destroy();
  }
});

test("native wrapper output adapter rejects invalid modes before admission and keeps reached prefixes on bounded failure", async () => {
  const { invokeNativeOutput } = await import("../src/native-invoke-output.js");
  const { store, writer } = storage();
  try {
    for (const mode of [
      { encoding: "base64" },
      { stdio: ["inherit", "pipe", "pipe"] },
    ]) {
      await assert.rejects(
        invokeNativeOutput(
          process.execPath,
          ["-e", "throw Error('must remain unreached')"],
          {
            journal: writer,
            maxBuffer: 64,
            timeout: 10000,
            ...mode,
          } as unknown as Parameters<typeof invokeNativeOutput>[2],
        ),
        /Invalid native output mode/,
      );
    }
    assert.equal(store.read().attempts.length, 0);
    for (const [kind, bound, timeout] of [
      ["output", 3, 10000],
      ["deadline", 64, 200],
    ] as const) {
      const value = await invokeNativeOutput(
        process.execPath,
        [
          "-e",
          kind === "output"
            ? "process.stdout.write(Buffer.from([0,255,1,2,3,4]));setInterval(()=>{},1000)"
            : "process.stdout.write(Buffer.from([0,255,1]));setInterval(()=>{},1000)",
        ],
        {
          journal: writer,
          maxBuffer: bound,
          timeout,
          encoding: "utf8",
        },
      );
      assert.equal(
        value.error?.code,
        kind === "output" ? "NATIVE_OUTPUT_LIMIT" : "NATIVE_TIMEOUT",
      );
      assert.equal(
        value.status,
        null,
        "Incomplete capture cannot authorize a parser successful exit",
      );
      assert.equal(value.pid! > 0, true);
      assert.deepEqual(
        Buffer.from(value.capturedOutput.stdout.base64, "base64"),
        Buffer.from([0, 255, 1]),
      );
      assert.equal(value.stdout, Buffer.from([0, 255, 1]).toString("utf8"));
      assert.equal(value.capturedOutput.completeForObservedStreams, false);
      assert.throws(() => process.kill(value.pid!, 0), { code: "ESRCH" });
    }
    writer.close();
    const journal = store.read();
    assert.equal(journal.attempts.length, 2);
    assert.deepEqual(
      journal.attempts.map((a) => a.state),
      ["transport-error", "transport-error"],
    );
    assert.equal(journal.completeForRecordedCalls, false);
    assert.deepEqual(
      Buffer.from(journal.attempts[0]!.capturedOutput.stdout.base64, "base64"),
      Buffer.from([0, 255, 1, 2, 3, 4]),
    );
  } finally {
    writer.close();
    store.destroy();
  }
});

test("shipped native wrapper inventory awaits every migrated invocation and downstream collector without asynchronous predicate shortcuts", async () => {
  const { createRequire } = await import("node:module");
  const { realpath } = await import("node:fs/promises");
  const ts = createRequire(
    await realpath(new URL("../src/native-invoke-output.js", import.meta.url)),
  )("typescript") as typeof import("typescript");
  const inventory: Record<string, number> = {
    "actionlint-runner": 1,
    "checkstyle-runner": 1,
    "clang-runner": 1,
    "cpp-extensions-runner": 1,
    "cpp-tools-runner": 1,
    "detekt-runner": 1,
    "dotnet-build-runner": 1,
    "dotnet-runner": 1,
    "external-runner": 1,
    "go-build-runner": 2,
    "golangci-runner": 2,
    "helm-extensions-runner": 1,
    "helm-runner": 1,
    "java-runner": 1,
    "kotlin-runner": 1,
    "kubeconform-runner": 1,
    "kustomize-runner": 1,
    "pyright-runner": 2,
    "ruby-extensions-prerequisite": 1,
    "ruby-tools-runner": 1,
    "rust-runner": 1,
    "rustfmt-runner": 1,
    "scala-runner": 1,
    "spotbugs-runner": 1,
    "swift-extensions-runner": 2,
    "swift-tools-runner": 1,
    "swift-version-runner": 1,
    "terraform-extensions-runner": 1,
    "terraform-runner": 1,
    "dotnet-test-collect": 0,
    "dotnet-format-collect": 0,
    "dotnet-generator-extensions-collect": 0,
  };
  let total = 0;
  for (const [file, expected] of Object.entries(inventory)) {
    const text = await readFile(
      new URL("../src/" + file + ".js", import.meta.url),
      "utf8",
    );
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    assert.equal(
      (
        source as typeof source & {
          parseDiagnostics: readonly import("typescript").Diagnostic[];
        }
      ).parseDiagnostics.length,
      0,
      file,
    );
    let calls = 0;
    const scan = (node: import("typescript").Node) => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
          const name = node.expression.text;
          assert.notEqual(name, "spawnSync", file);
          if (
            [
              "invokeNativeOutput",
              "invoke",
              "native",
              "java",
              "rubyExtensionsPrerequisite",
            ].includes(name)
          ) {
            assert.equal(
              ts.isAwaitExpression(node.parent),
              true,
              file + " must await " + name,
            );
            if (name === "invokeNativeOutput") calls++;
          }
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ["every", "some", "filter", "find"].includes(
            node.expression.name.text,
          )
        ) {
          for (const arg of node.arguments)
            if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
              assert.equal(
                arg.modifiers?.some(
                  (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
                ) ?? false,
                false,
                file + " has an asynchronous predicate",
              );
        }
      }
      ts.forEachChild(node, scan);
    };
    scan(source);
    assert.equal(calls, expected, file);
    total += calls;
  }
  assert.equal(Object.values(inventory).filter((n) => n > 0).length, 29);
  assert.equal(Object.values(inventory).filter((n) => n === 0).length, 3);
  assert.equal(total, 33);
});

test("native output receipt keeps physical exit codes separate from parser completion for zero nonzero and absent exits", async () => {
  const { nativeOutputReceipt } =
    await import("../src/native-invoke-output.js");
  const { captureProcessOutput } = await import("../src/process-output.js");
  const stdout = Buffer.from([0, 255, 1]),
    stderr = Buffer.from([255, 0]);
  // Synthetic transport receipts exercise parser policy; they do not claim a native observation.
  for (const status of [0, 1, null])
    for (const incomplete of [false, true]) {
      const input = {
        pid: 1234,
        status,
        signal: null,
        stdout,
        stderr,
        observedBytes: 5,
        capturedOutput: captureProcessOutput(stdout, stderr, 5, !incomplete),
        ...(incomplete
          ? {
              error: Object.assign(
                new Error("original synthetic output limit"),
                { code: "NATIVE_OUTPUT_LIMIT" },
              ),
            }
          : {}),
      };
      const result = nativeOutputReceipt(input);
      assert.equal(result.nativeExitCode, status);
      assert.equal(result.status, incomplete ? null : status);
      assert.equal(result.error, input.error);
      assert.deepEqual(result.stdout, stdout);
      assert.deepEqual(result.stderr, stderr);
      assert.deepEqual(result.capturedOutput, input.capturedOutput);
      assert.equal(
        input.status,
        status,
        "Rendering must not rewrite physical evidence",
      );
    }
});
