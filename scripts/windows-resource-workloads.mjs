import assert from "node:assert/strict";
import { windowsExecutionSchema } from "../dist/src/windows-execution.js";
import { parseCapturedProcessOutput } from "../dist/src/process-output.js";
import { summarizeResourceReport } from "./native-resource-workloads.mjs";

/** Distinct native jobs cover disjoint outer invocations. An identical tool
 * identity alias may repeat an existing receipt; a contradictory reuse may not.
 * Working-set peaks are direct-target lifetime observations, never tree sums.
 */
export function summarizeWindowsResources(report, expected) {
  const accounting = summarizeResourceReport(report, expected);
  const jobs = new Map();
  for (const check of report.checks) {
    for (const invocation of [
      ...check.processes,
      ...(check.tools ?? []).flatMap((tool) =>
        tool.process ? [tool.process] : [],
      ),
    ]) {
      assert.ok(
        invocation.exitCode === 0 &&
          !invocation.signal &&
          !invocation.errorCode &&
          !invocation.timedOut &&
          !invocation.cancelled &&
          !invocation.truncated,
        "Windows resource invocation did not complete successfully",
      );
      const receipt = windowsExecutionSchema.parse(invocation.windowsExecution);
      assert.equal(receipt.phase, "completed");
      assert.equal(receipt.jobAssigned, true);
      assert.equal(receipt.resumed, true);
      assert.ok(receipt.childPid !== null);
      assert.equal(
        new Set([receipt.launcherPid, receipt.supervisorPid, receipt.childPid])
          .size,
        3,
        "Windows resource process roles are inconsistent",
      );
      assert.equal(receipt.childExitCode, invocation.exitCode);
      assert.equal(receipt.cleanup, "confirmed");
      assert.equal(receipt.activeAfterCleanup, 0);
      assert.equal(receipt.nativeError, null);
      assert.equal(
        receipt.resources?.state,
        "collected",
        "Windows resource collection is unavailable",
      );
      if (jobs.has(receipt.requestId)) {
        assert.deepEqual(
          invocation,
          jobs.get(receipt.requestId),
          "Windows resource job identity was reused inconsistently",
        );
      } else jobs.set(receipt.requestId, invocation);
    }
  }
  assert.ok(jobs.size > 0, "Windows resource job inventory is empty");
  const total = {
    processCpu: { user100ns: 0, kernel100ns: 0 },
    jobCpu: { user100ns: 0, kernel100ns: 0 },
  };
  let directPeakWorkingSetBytes = 0;
  let observedOutputBytes = 0,
    stdoutBytes = 0,
    stderrBytes = 0;
  for (const invocation of jobs.values()) {
    const resources = invocation.windowsExecution.resources;
    const physical = parseCapturedProcessOutput(invocation.capturedOutput);
    assert.equal(
      physical.completeForObservedStreams,
      true,
      "Windows resource raw output is incomplete",
    );
    assert.equal(
      physical.observedBytes,
      invocation.outputBytes,
      "Windows resource physical output differs",
    );
    observedOutputBytes += physical.observedBytes;
    stdoutBytes += physical.stdout.bytes;
    stderrBytes += physical.stderr.bytes;
    for (const scope of ["processCpu", "jobCpu"])
      for (const field of ["user100ns", "kernel100ns"]) {
        const next =
          BigInt(total[scope][field]) + BigInt(resources[scope][field]);
        assert.ok(
          next <= BigInt(Number.MAX_SAFE_INTEGER),
          "Windows aggregate CPU exceeds its numeric bound",
        );
        total[scope][field] = Number(next);
      }
    directPeakWorkingSetBytes = Math.max(
      directPeakWorkingSetBytes,
      resources.peakWorkingSetBytes,
    );
  }
  return {
    ...accounting,
    checkProcessOutputBytes: accounting.observedOutputBytes,
    observedOutputBytes,
    stdoutBytes,
    stderrBytes,
    resourceProfile: "windows-validation-jobs-v1",
    nativeJobs: jobs.size,
    cpuUnit: "100ns",
    ...total,
    directPeakWorkingSetBytes,
    memoryScope: "maximum-direct-target-lifetime-peak",
    summedProcessTreeRss: false,
    validationJobCpuExcludesLauncherAndSupervisor: true,
  };
}
