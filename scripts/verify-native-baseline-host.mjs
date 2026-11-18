import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { completeFreshBaseline } from "./preserved-baseline-fresh-coordinator.mjs";
import {
  captureControllerSourceScope,
  captureOriginalControllerSource,
} from "./preserved-baseline-source-worker.mjs";

assert.equal(
  process.argv.length,
  3,
  "Pass one registered host baseline cohort",
);
const cohort = process.argv[2];
assert.ok(
  ["swift", "gradle-preparation", "maven-preparation"].includes(cohort),
  "Unknown host baseline cohort",
);
const repository = fileURLToPath(new URL("../", import.meta.url));
const selection = [cohort];
const { sourceScope } = await captureControllerSourceScope(
  repository,
  cohort,
  selection,
);
const sourceCapture = await captureOriginalControllerSource(
  repository,
  cohort,
  selection,
);
process.stdout.write(JSON.stringify(sourceCapture.originalReport) + "\n");
const report = await completeFreshBaseline({
  repository,
  sourceCapture,
  expectedSourceScope: sourceScope,
  launchWorker: ({ harness, worker, inputFile }) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return execFileSync(process.execPath, [worker, inputFile], {
      cwd: harness,
      env,
      encoding: "utf8",
      timeout: 660000,
      maxBuffer: 32 * 1024 * 1024,
    });
  },
});
process.stdout.write(
  JSON.stringify({
    ...report,
    cohort,
    originalSourceCommandsRetained: true,
    operatorPreparationScriptsRemainExternalToInstalledProduct:
      cohort === "gradle-preparation" || cohort === "maven-preparation",
  }) + "\n",
);
