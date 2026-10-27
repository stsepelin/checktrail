// Diagnostic-only tracing of the unchanged original synthetic upgrade body.
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
assert.equal(process.platform, "win32");
const cp = createRequire(import.meta.url)("node:child_process"),
  originalExec = cp.execFileSync,
  originalSpawn = cp.spawnSync;
let serial = 0;
function label(executable, args = []) {
  if (args[0]?.endsWith("cli.js")) return "cli:" + args[1];
  if (args[0]?.endsWith("npm-cli.js")) return "npm:" + args[1];
  if (args[0] === "--input-type=module") return "library-process";
  return (
    path.basename(executable) +
    ":" +
    (args[0]?.startsWith("--") ? args[0] : "helper")
  );
}
function event(id, operation, stage, extra = {}) {
  process.stderr.write(
    JSON.stringify({
      diagnostic: "windows-upgrade",
      id,
      operation,
      stage,
      ...extra,
    }) + "\n",
  );
}
for (const [name, original] of [
  ["execFileSync", originalExec],
  ["spawnSync", originalSpawn],
]) {
  cp[name] = function (executable, args, options) {
    const id = ++serial,
      operation = label(executable, args),
      started = performance.now();
    event(id, operation, "start", { timeoutMs: options?.timeout ?? null });
    try {
      const result = original.call(this, executable, args, options);
      if (result?.error)
        result.error.message = operation + ": " + result.error.message;
      event(id, operation, "finished", {
        durationMs: performance.now() - started,
        status: result?.status ?? null,
        errorCode: result?.error?.code ?? null,
      });
      return result;
    } catch (error) {
      event(id, operation, "failed", {
        durationMs: performance.now() - started,
        status: error.status ?? null,
        code: error.code ?? null,
      });
      error.message = operation + ": " + error.message;
      throw error;
    }
  };
}
syncBuiltinESMExports();
const cleanups = [];
try {
  const { resourceNearMissControl } =
    await import("../dist/test/resource-release-fixture.js");
  await resourceNearMissControl({
    after: (callback) => cleanups.push(callback),
  });
  process.stdout.write(
    JSON.stringify({
      diagnostic: "original-windows-upgrade-body",
      completed: true,
      wholeResourceProfileQualified: false,
      gateAComplete: false,
      inferenceInvoked: false,
    }) + "\n",
  );
} finally {
  cp.execFileSync = originalExec;
  cp.spawnSync = originalSpawn;
  syncBuiltinESMExports();
  for (const cleanup of cleanups.reverse()) await cleanup();
}
