// Diagnostic-only branch. This observation is not an acceptance controller.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { runProcess } from "../dist/src/runner.js";
assert.equal(process.platform, "win32");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "checktrail-counter-observe-")),
);
const observations = [];
process.env.CHECKTRAIL_WINDOWS_COUNTER_OBSERVE = "1";
try {
  for (let sample = 0; sample < 32; sample++) {
    process.env.CHECKTRAIL_WINDOWS_COUNTER_SAMPLE = String(sample);
    const result = await runProcess(
      root,
      {
        executable: process.execPath,
        args: [
          "-e",
          "const b=Buffer.alloc(16*1024*1024,7);const end=performance.now()+100;while(performance.now()<end){};process.stdout.write(String(b.length));process.exit(7);",
        ],
        cwd: ".",
      },
      { timeoutMs: 30000, maxOutputBytes: 8192 },
    );
    assert.equal(result.errorCode, undefined, result.stderr);
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, String(16 * 1024 * 1024));
    observations.push({
      sample,
      exitCode: result.exitCode,
      resources: result.windowsExecution.resources,
      diagnostics: result.stderr.trim()
        ? result.stderr
            .trim()
            .split(/\r?\n/)
            .map((line) => JSON.parse(line))
        : [],
    });
  }
  process.stdout.write(
    JSON.stringify({
      profile: "diagnostic-windows-failed-target-counter-observations-v1",
      observations,
      nativeAcceptanceAssessed: false,
      inferenceInvoked: false,
      gateAComplete: false,
    }) + "\n",
  );
} finally {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
