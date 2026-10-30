import assert from "node:assert/strict";
import fs from "node:fs";
import { rename, lstat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import type { createNativeAttemptStorage } from "../src/native-attempt-storage.js";

/** Exercise replacement after a refused cleanup releases Windows-held files. */
export async function renameNativeStorageDirectory(
  storage: ReturnType<typeof createNativeAttemptStorage>,
  moved: string,
): Promise<void> {
  const root = storage.context.directory;
  try {
    await rename(root, moved);
    return;
  } catch (error) {
    if (
      process.platform !== "win32" ||
      (error as NodeJS.ErrnoException).code !== "EPERM"
    )
      throw error;
  }
  const before = await lstat(root);
  const originalRemove = fs.rmSync;
  const refusal = Object.assign(
    Error("Synthetic native journal cleanup refusal"),
    { code: "EBUSY" },
  );
  const replaced = mock.method(
    fs,
    "rmSync",
    (...args: Parameters<typeof fs.rmSync>) => {
      if (String(args[0]) === root) throw refusal;
      return originalRemove(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => storage.destroy(),
      (error) => error === refusal,
    );
    assert.equal(
      replaced.mock.calls.filter((call) => String(call.arguments[0]) === root)
        .length,
      1,
    );
  } finally {
    replaced.mock.restore();
    syncBuiltinESMExports();
  }
  const after = await lstat(root);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  await rename(root, moved);
}
