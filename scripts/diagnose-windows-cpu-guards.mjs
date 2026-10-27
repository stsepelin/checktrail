// Diagnostic-only original guard script with owned unrelated CPU workers.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import process from "node:process";
import { URL } from "node:url";
assert.equal(process.platform, "win32");
const file = new URL(
  "../dist/test/windows-resource-native.test.js",
  import.meta.url,
);
const before = await readFile(file),
  children = [],
  completions = [];
try {
  for (let index = 0; index < 3; index++) {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.send('ready');let v=0;for(;;){for(let i=0;i<100000;i++)v=(v+i)>>>0;}",
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    children.push(child);
    const completion = once(child, "exit");
    void completion.catch(() => {});
    completions.push(completion);
    const [ready] = await once(child, "message", {
      signal: globalThis.AbortSignal.timeout(15000),
    });
    assert.equal(ready, "ready");
  }
  const child = spawn(
    process.execPath,
    ["scripts/verify-windows-resource-guards.mjs"],
    { stdio: "inherit" },
  );
  children.push(child);
  const done = once(child, "exit");
  void done.catch(() => {});
  completions.push(done);
  const [status, signal] = await done;
  assert.equal(signal, null);
  assert.equal(status, 0);
  assert.deepEqual(await readFile(file), before);
  process.stdout.write(
    JSON.stringify({
      diagnostic: "native-windows-cpu-guards",
      unrelatedCpuWorkers: 3,
      guardScriptUnchanged: true,
      callbackSha256: createHash("sha256").update(before).digest("hex"),
      node: process.versions.node,
      inferenceInvoked: false,
    }) + "\n",
  );
} finally {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.all(completions);
}
