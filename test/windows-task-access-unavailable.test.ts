import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { inspect } from "node:util";
import {
  ensureWindowsTaskAccess,
  ensureWindowsTaskAccessBatch,
} from "../src/windows-task-access.js";
const native = process.platform === "win32";
const batch = [
  { filename: "C:\\original-'[literal]-🧪", kind: "directory" },
  { filename: "C:\\original-'[literal]-🧪\\input.blob", kind: "file" },
] as const;

test(
  "Windows task ACL inspection remains unavailable on a non-Windows host",
  { skip: process.platform === "win32" },
  () => {
    assert.throws(
      () =>
        ensureWindowsTaskAccess("C:\\original-synthetic", "directory", false),
      /requires Windows/,
    );
  },
);

test(
  "Windows private ACL batches remain unavailable on a non-Windows host",
  { skip: native },
  () => {
    assert.throws(
      () => ensureWindowsTaskAccessBatch(batch),
      /requires Windows/,
    );
  },
);

test("Windows ACL inspectors retain bounded process and JSON failure identities without disclosing output or changing admission", (t) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  )!;
  const originalEnvironment = process.env;
  const userSid = "S-1-5-21-10-20-30-1001";
  const access = {
    userSid,
    tokenOwnerSid: userSid,
    ownerSid: userSid,
    protected: true,
    canonical: true,
    rules: [
      {
        sid: userSid,
        rights: 2032127,
        inheritance: 3,
        propagation: 0,
        type: "Allow",
      },
    ],
  };
  const evidence = (bytes: string | Buffer) => ({
    bytes: Buffer.byteLength(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  let reply: () => string;
  let calls = 0;
  let batchMode = false;
  t.after(() => {
    t.mock.restoreAll();
    Object.defineProperty(process, "platform", originalPlatform);
    process.env = originalEnvironment;
    syncBuiltinESMExports();
  });
  t.mock.method(fs, "realpathSync", (value: unknown) => String(value));
  t.mock.method(fs, "lstatSync", () => ({
    isSymbolicLink: () => false,
    isFile: () => true,
    isDirectory: () => true,
  }));
  t.mock.method(
    childProcess,
    "execFileSync",
    (
      executable: unknown,
      args: string[],
      options: {
        input: string;
        env: object;
        timeout: number;
        maxBuffer: number;
        cwd?: string;
      },
    ) => {
      calls++;
      assert.equal(
        executable,
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      assert.deepEqual(args.slice(0, 3), [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
      ]);
      assert.equal(args.length, 4);
      assert.equal(
        Buffer.from(args[3]!, "base64")
          .toString("utf16le")
          .includes(batch[0].filename),
        false,
      );
      assert.deepEqual(options.env, { SYSTEMROOT: "C:\\Windows" });
      assert.equal(options.timeout, batchMode ? 60000 : 15000);
      assert.equal(options.maxBuffer, batchMode ? 8388608 : 32768);
      if (batchMode) {
        assert.equal(
          options.cwd,
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
        );
        assert.deepEqual(JSON.parse(options.input), [batch[0]]);
      } else {
        assert.equal(options.cwd, undefined);
        assert.deepEqual(JSON.parse(options.input), {
          path: batch[0].filename,
          kind: "directory",
          created: true,
        });
      }
      return reply();
    },
  );
  Object.defineProperty(process, "platform", { value: "win32" });
  process.env = { SYSTEMROOT: "C:\\Windows" };
  syncBuiltinESMExports();
  for (const isBatch of [false, true]) {
    batchMode = isBatch;
    const invoke = () =>
      isBatch
        ? ensureWindowsTaskAccessBatch([batch[0]])
        : ensureWindowsTaskAccess(batch[0].filename, "directory", true);
    const validOutput = JSON.stringify(
      isBatch ? [{ index: 0, ...batch[0], access }] : access,
    );
    const maximum = isBatch ? 8388608 : 32768;
    const originalText = "C:\\original-synthetic-output\\private.txt";
    for (const entry of [
      {
        phase: "process",
        error: {
          code: "ETIMEDOUT",
          status: null,
          signal: "SIGTERM",
          stdout: originalText,
          stderr: Buffer.from("Original synthetic stderr"),
        },
        expected: {
          phase: "process",
          code: "ETIMEDOUT",
          status: null,
          signal: "SIGTERM",
          stdout: evidence(originalText),
          stderr: evidence("Original synthetic stderr"),
        },
      },
      {
        phase: "process",
        error: {
          status: 17,
          stdout: validOutput,
          stderr: "Original failed native process",
        },
        expected: {
          phase: "process",
          code: null,
          status: 17,
          signal: null,
          stdout: evidence(validOutput),
          stderr: evidence("Original failed native process"),
        },
      },
      {
        phase: "process",
        error: {
          code: "ETIMEDOUT-original-synthetic",
          status: "17",
          signal: "SIGTERM-original-synthetic",
          stdout: {},
          stderr: 17,
        },
        expected: {
          phase: "process",
          code: null,
          status: null,
          signal: null,
          stdout: null,
          stderr: null,
        },
      },
      {
        phase: "process",
        error: {
          status: Number.MAX_SAFE_INTEGER,
          stdout: Buffer.alloc(maximum + 1, 120),
        },
        expected: {
          phase: "process",
          code: null,
          status: null,
          signal: null,
          stdout: { bytes: maximum + 1, sha256: null },
          stderr: null,
        },
      },
      {
        phase: "json",
        error: null,
        expected: {
          phase: "json",
          code: null,
          status: null,
          signal: null,
          stdout: evidence(originalText),
          stderr: null,
        },
      },
    ]) {
      reply = () => {
        if (entry.phase === "json") return originalText;
        throw Object.assign(new Error(originalText), entry.error);
      };
      const before = calls;
      assert.throws(invoke, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          isBatch
            ? "Windows private ACL batch inspection unavailable"
            : "Windows task ACL inspection unavailable",
        );
        assert.deepEqual(error.cause, { schemaVersion: 1, ...entry.expected });
        assert.equal(JSON.stringify(error.cause).includes(originalText), false);
        assert.equal(JSON.stringify(error.cause).includes("Original"), false);
        const formatted = inspect(error);
        assert.match(formatted, /\[cause\]:/);
        assert.ok(formatted.includes("phase: '" + entry.phase + "'"));
        assert.equal(formatted.includes(originalText), false);
        assert.equal(formatted.includes("Original synthetic stderr"), false);
        return true;
      });
      assert.equal(
        calls,
        before + 1,
        "No retry or fallback bypasses unavailable inspection",
      );
    }
    reply = () => validOutput;
    invoke();
    const invalid = {
      ...access,
      rules: [{ ...access.rules[0], sid: "S-1-1-0" }],
    };
    reply = () =>
      JSON.stringify(
        isBatch ? [{ index: 0, ...batch[0], access: invalid }] : invalid,
      );
    assert.throws(invoke, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "Windows task storage requires a private caller-only ACL",
      );
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.equal(calls, 14);
});
