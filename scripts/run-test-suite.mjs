import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const files = (await readdir(new URL("../dist/test/", import.meta.url)))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => "dist/test/" + name);
assert.ok(files.length > 0, "Compiled full suite is empty");
// Keep native process-tree controls responsive when many test files spawn their own tools.
const workers = Math.max(1, Math.min(4, availableParallelism()));
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=" + workers, ...files],
  { cwd: repository, env: process.env, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
