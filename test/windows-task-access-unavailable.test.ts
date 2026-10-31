import assert from "node:assert/strict";
import { test } from "node:test";
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
