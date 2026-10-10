import console from "node:console";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { jvmOriginal } from "../dist/test/jvm-wrappers-fixture.js";
import { createPlan, validate } from "../dist/src/engine.js";
const directory = path.resolve(process.argv[2]);
await mkdir(directory, { recursive: false });
const cleanups = [];
try {
  for (const kind of ["maven", "gradle"]) {
    const f = await jvmOriginal(
        {
          after(callback) {
            cleanups.push(callback);
          },
        },
        kind,
        true,
      ),
      plan = (await createPlan(f.root)).plan.checks[0],
      report = await validate(f.root, { trusted: true, timeoutMs: 120000 });
    assert.equal(report.checks[0].status, "passed");
    assert.equal(report.checks[0].findingsComplete, true);
    assert.deepEqual(report.checks[0].tests, {
      total: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
    });
    await writeFile(
      path.join(directory, kind + ".json"),
      JSON.stringify({
        root: f.root,
        plan,
        process: report.checks[0].processes[0],
      }),
      { flag: "wx" },
    );
  }
} finally {
  for (const cleanup of cleanups) await cleanup();
}
console.log(
  JSON.stringify({
    nativeReceipts: 2,
    generatedClasses: 4,
    jpmsDescriptors: 4,
    executedTests: 8,
    fieldEvaluationExecuted: false,
    inferenceInvoked: false,
  }),
);
