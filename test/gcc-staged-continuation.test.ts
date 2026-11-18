import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("GCC staged continuation preserves full target selection, failed attempts and physical checkpoint identity", (t) => {
  if (process.platform === "win32") {
    t.skip(
      "The selected GCC producer and checkpoint metadata contract require POSIX",
    );
    return;
  }
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    "python3",
    ["-I", "-B", "test/gcc-staged-cases.py"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const counts = JSON.parse(result.stdout);
  assert.ok(counts.tests > 0);
  assert.equal(counts.failures + counts.errors + counts.skips, 0);
  assert.equal(counts.projectOrCompilerExecuted, false);
});
