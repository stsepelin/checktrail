import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const file of [
  "gcc-sdk-material-cases.py",
  "gcc-sdk-hosted-cases.py",
  "gcc-sdk-derived-cases.py",
  "gcc-sdk-derived-run-cases.py",
]) {
  test("GCC SDK reconstruction synthetic controls: " + file, (t) => {
    if (process.platform === "win32") {
      t.skip("The selected original hosted GCC SDK requires POSIX");
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
    assert.equal(counts.dockerCompilerOrUpstreamExecuted, false);
  });
}
