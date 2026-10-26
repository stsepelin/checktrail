// Temporary manual diagnostic; these modified engine bytes qualify no runtime.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
const name = "^lifecycle-platforms lifecycle acceptance$";
let sequence = 0,
  failed = false;
async function cohort(repetitions, workers) {
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (!failed) {
        const index = next++;
        if (index >= repetitions) return;
        const id = sequence++;
        const child = spawn(
          process.execPath,
          [
            "--test",
            "--test-name-pattern",
            name,
            "dist/test/gate-lifecycle-platforms.test.js",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        for (const stream of [child.stdout, child.stderr])
          stream.on("data", (bytes) => process.stdout.write(bytes));
        const result = await new Promise((resolve, reject) => {
          child.on("error", reject);
          child.on("exit", (code, signal) => resolve({ code, signal }));
        });
        process.stdout.write(
          JSON.stringify({
            diagnosticIteration: id,
            workers,
            ...result,
            qualificationClaimed: false,
          }) + "\n",
        );
        if (result.code !== 0 || result.signal !== null) failed = true;
      }
    }),
  );
}
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
assert.equal(process.versions.node, "26.10.0");
// Exercise native procfs reads while real short-lived processes exit. No
// command lines, environments or process names are retained in diagnostics.
const { processSnapshot } = await import("../dist/src/process-tree.js");
let snapshotCount = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let index = 0; index < 500 && !failed; index++) {
      const child = spawn("/bin/true", [], { stdio: "ignore" });
      const exited = new Promise((resolve, reject) => {
        child.on("exit", resolve);
        child.on("error", reject);
      });
      try {
        await processSnapshot();
        snapshotCount++;
      } catch (error) {
        failed = true;
        process.stdout.write(
          JSON.stringify({
            diagnosticSnapshotFailure: true,
            reason:
              error.message === "Process identity invalid"
                ? error.message
                : "unclassified",
            qualificationClaimed: false,
          }) + "\n",
        );
      } finally {
        await exited;
      }
    }
  }),
);
process.stdout.write(
  JSON.stringify({
    diagnosticSnapshotCount: snapshotCount,
    failed,
    qualificationClaimed: false,
  }) + "\n",
);
if (!failed) await cohort(20, 1);
if (!failed) await cohort(80, 4);
process.stdout.write(
  JSON.stringify({
    diagnosticEngineOnly: true,
    iterations: sequence,
    failed,
    qualificationClaimed: false,
  }) + "\n",
);
process.exitCode = failed ? 1 : 0;
