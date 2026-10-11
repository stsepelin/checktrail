import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  createNativeAttemptStorage,
  NativeAttemptWriter,
} from "../src/native-attempt-storage.js";
import type { NativeJournalHeader } from "../src/native-attempt-frames.js";
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const header = (maxOutputBytes = 1024): NativeJournalHeader => ({
  schemaVersion: 1,
  format: "native-attempt-journal",
  journalId: randomUUID(),
  sourceFingerprint: hash("original storage source"),
  outerCommandSha256: hash("original outer storage command"),
  maxNativeCalls: 2,
  maxOutputBytes,
});
test("native journal private storage preserves two distinct records and canonical physical data with closed and interrupted accounting", async () => {
  const storage = createNativeAttemptStorage(header());
  let writer: NativeAttemptWriter | undefined;
  try {
    if (process.platform !== "win32")
      for (const [f, mode] of [
        [storage.context.directory, 0o700],
        [path.join(storage.context.directory, "header.json"), 0o600],
        [path.join(storage.context.directory, "frames.jsonl"), 0o600],
      ] as const)
        assert.equal((await lstat(f)).mode & 0o777, mode);
    writer = new NativeAttemptWriter(storage.context);
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const id = writer.admit(hash("original-command-" + i));
      ids.push(id);
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          "process.stdout.write(Buffer.from([0,255,195,169]));process.exitCode=" +
            i,
        ],
        { timeout: 10000, maxBuffer: 65536 },
      );
      assert.equal(child.error, undefined);
      assert.equal(child.signal, null);
      assert.equal(child.status, i);
      writer.started(id, child.pid);
      assert.equal(writer.output(id, "stdout", child.stdout), false);
      writer.terminal({
        type: "terminal",
        attemptId: id,
        state: "exited",
        exitCode: i,
        signal: null,
        errorCode: null,
      });
    }
    assert.equal(
      storage.read().completeForRecordedCalls,
      false,
      "An omitted journal-end remains incomplete even when calls ended",
    );
    writer.close();
    writer = undefined;
    const value = storage.read();
    assert.equal(value.completeForRecordedCalls, true);
    assert.deepEqual(
      value.attempts.map((a) => a.id),
      ids,
    );
    assert.deepEqual(
      value.attempts.map((a) => a.exitCode),
      [0, 1],
    );
    assert.equal(value.observedBytes, 8);
    const physical = await readFile(
      path.join(storage.context.directory, "frames.jsonl"),
    );
    assert.equal(value.journalBytes, physical.length);
    assert.equal(value.journalSha256, hash(physical));
    for (const call of value.attempts)
      assert.deepEqual(
        Buffer.from(call.capturedOutput.stdout.base64, "base64"),
        Buffer.from([0, 255, 195, 169]),
      );
  } finally {
    writer?.close();
    storage.destroy();
  }
  await assert.rejects(access(storage.context.directory));
  assert.doesNotThrow(
    () => storage.destroy(),
    "Repeated cleanup is idempotent after the owned directory is gone",
  );
});
test("native journal physical file/header changes hard links and a foreign context reject before writes resume", async () => {
  for (const kind of [
    "header",
    "partial",
    "empty-frame",
    "append",
    "hardlink",
    "foreign",
  ] as const) {
    const storage = createNativeAttemptStorage(header());
    let writer: NativeAttemptWriter | undefined;
    const log = path.join(storage.context.directory, "frames.jsonl");
    try {
      if (kind === "foreign")
        assert.throws(
          () =>
            new NativeAttemptWriter({
              ...storage.context,
              headerSha256: "0".repeat(64),
            }),
          /foreign/,
        );
      else if (kind === "header") {
        await writeFile(
          path.join(storage.context.directory, "header.json"),
          "{}\n",
        );
        assert.throws(() => storage.read(), /header changed/);
      } else if (kind === "partial") {
        await writeFile(log, '{"type":');
        assert.throws(() => storage.read(), /partial frame/);
        assert.throws(
          () => new NativeAttemptWriter(storage.context),
          /cannot resume/,
        );
      } else if (kind === "empty-frame") {
        await writeFile(log, "\n");
        assert.throws(() => storage.read(), /empty frame/);
      } else if (kind === "hardlink") {
        await link(log, path.join(storage.context.directory, "linked.jsonl"));
        assert.throws(
          () => new NativeAttemptWriter(storage.context),
          /singly linked/,
        );
        assert.throws(() => storage.read(), /singly linked/);
      } else {
        writer = new NativeAttemptWriter(storage.context);
        await appendFile(log, "\n");
        const before = await readFile(log);
        assert.throws(
          () => writer!.admit(hash("blocked")),
          /descriptor changed/,
        );
        assert.deepEqual(await readFile(log), before);
      }
    } finally {
      try {
        writer?.close();
      } catch {
        /* The deliberate descriptor mutation remains an error. */
      }
      storage.destroy();
    }
  }
});
test("native journal zero and exact prefixes bound disk data and cannot turn overrun into complete output", () => {
  for (const maximum of [0, 3, 4]) {
    const storage = createNativeAttemptStorage(header(maximum));
    let writer: NativeAttemptWriter | undefined;
    try {
      writer = new NativeAttemptWriter(storage.context);
      const id = writer.admit(hash("original-prefix"));
      writer.started(id, process.pid);
      const cut = writer.output(id, "stderr", Buffer.from([0, 255, 195, 169]));
      assert.equal(cut, maximum < 4);
      writer.terminal({
        type: "terminal",
        attemptId: id,
        state: cut ? "output-limit" : "exited",
        exitCode: cut ? null : 0,
        signal: cut ? "SIGKILL" : null,
        errorCode: cut ? "NATIVE_OUTPUT_LIMIT" : null,
      });
      writer.close();
      writer = undefined;
      const value = storage.read();
      assert.equal(value.retainedBytes, maximum);
      assert.equal(value.observedBytes, 4);
      assert.equal(value.completeForRecordedCalls, maximum === 4);
      assert.deepEqual(
        Buffer.from(value.attempts[0]!.capturedOutput.stderr.base64, "base64"),
        Buffer.from([0, 255, 195, 169]).subarray(0, maximum),
      );
    } finally {
      writer?.close();
      storage.destroy();
    }
  }
});
test("native journal directory replacement cannot redirect cleanup and weak POSIX access cannot be repaired silently", async () => {
  const storage = createNativeAttemptStorage(header()),
    root = storage.context.directory,
    moved = root + "-original";
  try {
    await rename(root, moved);
    await mkdir(root, { mode: 0o700 });
    const marker = path.join(root, "original-replacement.txt");
    await writeFile(marker, "replacement must survive rejected cleanup");
    assert.throws(() => storage.destroy(), /directory changed before cleanup/);
    assert.equal(
      await readFile(marker, "utf8"),
      "replacement must survive rejected cleanup",
    );
    await rm(root, { recursive: true });
    await rename(moved, root);
    if (process.platform !== "win32") {
      const log = path.join(root, "frames.jsonl");
      await chmod(log, 0o644);
      assert.throws(() => new NativeAttemptWriter(storage.context), /private/);
      assert.equal((await lstat(log)).mode & 0o777, 0o644);
      await chmod(log, 0o600);
    }
  } finally {
    try {
      await access(moved);
      await rename(moved, root);
    } catch {
      /* Already restored. */
    }
    storage.destroy();
  }
});
