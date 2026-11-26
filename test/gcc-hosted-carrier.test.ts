import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const controls = [
  ["gcc-hosted-capacity-cases.py", "sourceOrCompilerExecuted"],
  ["gcc-hosted-phase0-capacity-cases.py", "sourceOrCompilerExecuted"],
  ["gcc-hosted-carrier-cases.py", "dockerOrUpstreamExecuted"],
  ["gcc-phase0-transport-cases.py", "sourceOrCompilerExecuted"],
  ["gcc-staged-retention-cases.py", "sourceOrCompilerExecuted"],
] as const;

for (const [file, executionFlag] of controls) {
  test("GCC hosted continuation synthetic controls: " + file, (t) => {
    if (process.platform === "win32") {
      t.skip(
        "The selected original GCC carrier and metadata contract require POSIX",
      );
      return;
    }
    const result = spawnSync("python3", ["-I", "-B", "test/" + file], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    const counts = JSON.parse(result.stdout);
    assert.ok(counts.tests > 0);
    assert.equal(counts.failures + counts.errors + counts.skips, 0);
    assert.equal(counts[executionFlag], false);
  });
}
