import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { test } from "node:test";
const { summarizeWindowsResources } = await import(
  new URL("../../scripts/windows-resource-workloads.mjs", import.meta.url).href
);
function observation() {
  const stream = (text: string) => ({
    base64: Buffer.from(text).toString("base64"),
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
  });
  const invocation = (index: number) => ({
    exitCode: 0,
    signal: null,
    outputBytes: 2,
    capturedOutput: {
      profile: "bounded-physical-process-output-v1",
      completeForObservedStreams: true,
      observedBytes: 2,
      stdout: stream("x\n"),
      stderr: stream(""),
    },
    windowsExecution: {
      profile: "windows-job-v1",
      requestId: randomUUID(),
      phase: "completed",
      supervisorPid: index + 10,
      launcherPid: index + 20,
      childPid: index + 30,
      launcherSha256: "a".repeat(64),
      supervisorSha256: "b".repeat(64),
      ownership: "creation-job-list",
      executionSandboxed: false,
      jobAssigned: true,
      resumed: true,
      childExitCode: 0,
      activeBeforeCleanup: 0,
      activeAfterCleanup: 0,
      cleanup: "confirmed",
      nativeError: null,
      resources: {
        profile: "windows-job-resources-v1",
        state: "collected",
        cpuUnit: "100ns",
        processCpu: { user100ns: index, kernel100ns: index * 2 },
        jobCpu: { user100ns: index * 3, kernel100ns: index * 4 },
        totalJobProcesses: 2,
        peakWorkingSetBytes: index * 1024,
        memoryScope: "direct-target-lifetime-peak",
        collectedAfterJobEmpty: true,
        summedProcessTreeRss: false,
      },
    },
  });
  const first = invocation(1),
    second = invocation(2);
  const report = {
    outcome: "passed",
    sourceChanged: false,
    sourceError: false,
    checks: [
      {
        status: "passed",
        tests: { passed: 1, failed: 0, skipped: 0 },
        processes: [first, second],
        tools: [{ process: first }],
      },
    ],
  };
  return { report, expected: { checks: 1, executedTests: 1 } };
}
test("Windows workload accounting sums distinct job CPU retains direct peaks and counts identical tool aliases once", () => {
  const { report, expected } = observation();
  const summary = summarizeWindowsResources(report, expected);
  assert.equal(summary.nativeJobs, 2);
  assert.deepEqual(summary.processCpu, { user100ns: 3, kernel100ns: 6 });
  assert.deepEqual(summary.jobCpu, { user100ns: 9, kernel100ns: 12 });
  assert.equal(summary.directPeakWorkingSetBytes, 2048);
  assert.equal(summary.memoryScope, "maximum-direct-target-lifetime-peak");
  assert.equal(summary.summedProcessTreeRss, false);
  assert.equal(summary.cpuUnit, "100ns");
  assert.equal(summary.validationJobCpuExcludesLauncherAndSupervisor, true);
  for (const process of report.checks[0]!.processes) {
    process.windowsExecution.resources.processCpu = {
      user100ns: 0,
      kernel100ns: 0,
    };
    process.windowsExecution.resources.jobCpu = {
      user100ns: 0,
      kernel100ns: 0,
    };
    process.windowsExecution.resources.peakWorkingSetBytes = 0;
  }
  const zero = summarizeWindowsResources(report, expected);
  assert.deepEqual(zero.jobCpu, { user100ns: 0, kernel100ns: 0 });
  assert.equal(zero.directPeakWorkingSetBytes, 0);
});
test("Windows workload accounting rejects unavailable incomplete contradictory and reused native resource evidence", () => {
  const { report, expected } = observation();
  for (const edit of [
    (r: typeof report) => {
      r.outcome = "incomplete";
    },
    (r: typeof report) => {
      r.sourceChanged = true;
    },
    (r: typeof report) => {
      r.checks[0]!.tests.skipped = 1;
    },
    (r: typeof report) => {
      r.checks[0]!.processes[0]!.exitCode = 1;
    },
    (r: typeof report) => {
      r.checks[0]!.processes[0]!.windowsExecution.phase = "running";
    },
    (r: typeof report) => {
      r.checks[0]!.processes[0]!.windowsExecution.childPid =
        r.checks[0]!.processes[0]!.windowsExecution.supervisorPid;
    },
    (r: typeof report) => {
      r.checks[0]!.processes[0]!.windowsExecution.activeAfterCleanup = 1;
    },
    (r: typeof report) => {
      r.checks[0]!.processes[0]!.windowsExecution.jobAssigned = false;
    },
    (r: typeof report) => {
      r.checks[0]!.processes[0]!.windowsExecution.resumed = false;
    },
    (r: typeof report) => {
      r.checks[0]!.processes[0]!.windowsExecution.cleanup = "unavailable";
    },
    (r: typeof report) => {
      r.checks[0]!.processes[0]!.windowsExecution.childExitCode = 1;
    },
    (r: typeof report) => {
      Reflect.set(
        r.checks[0]!.processes[0]!.windowsExecution,
        "childPid",
        null,
      );
    },
    (r: typeof report) => {
      Reflect.set(
        r.checks[0]!.processes[0]!.windowsExecution,
        "nativeError",
        5,
      );
    },
    (r: typeof report) => {
      Reflect.set(r.checks[0]!.processes[0]!.windowsExecution, "resources", {
        profile: "windows-job-resources-v1",
        state: "unavailable",
        stage: "process-times",
        nativeError: 0,
      });
    },
    (r: typeof report) => {
      r.checks[0]!.processes[0]!.windowsExecution.resources.jobCpu.user100ns = 0;
    },
    (r: typeof report) => {
      r.checks[0]!.processes[1]!.windowsExecution.requestId =
        r.checks[0]!.processes[0]!.windowsExecution.requestId;
    },
    (r: typeof report) => {
      r.checks[0]!.tools[0]!.process = structuredClone(
        r.checks[0]!.tools[0]!.process,
      );
      r.checks[0]!.tools[0]!.process.windowsExecution.resources.jobCpu
        .user100ns++;
    },
  ]) {
    const changed = structuredClone(report);
    edit(changed);
    assert.throws(() => summarizeWindowsResources(changed, expected));
  }
  const unavailable = structuredClone(report);
  Reflect.set(
    unavailable.checks[0]!.processes[0]!.windowsExecution,
    "resources",
    {
      profile: "windows-job-resources-v1",
      state: "unavailable",
      stage: "process-times",
      nativeError: 0,
    },
  );
  assert.throws(
    () => summarizeWindowsResources(unavailable, expected),
    /Windows resource collection is unavailable/,
  );
});
test("Windows workload accounting includes distinct version commands and refuses their unverified physical output", () => {
  const { report, expected } = observation(),
    version = structuredClone(report.checks[0]!.processes[0]!);
  version.windowsExecution.requestId = randomUUID();
  version.windowsExecution.childPid = 51;
  version.capturedOutput.stdout.base64 = Buffer.from("v\n").toString("base64");
  version.capturedOutput.stdout.sha256 = createHash("sha256")
    .update("v\n")
    .digest("hex");
  version.outputBytes = 3;
  version.capturedOutput.observedBytes = 3;
  version.capturedOutput.stderr = {
    base64: Buffer.from("e").toString("base64"),
    bytes: 1,
    sha256: createHash("sha256").update("e").digest("hex"),
  };
  report.checks[0]!.tools.push({ process: version });
  const value = summarizeWindowsResources(report, expected);
  assert.equal(value.nativeJobs, 3);
  assert.equal(value.checkProcessOutputBytes, 4);
  assert.equal(value.observedOutputBytes, 7);
  assert.equal(value.stderrBytes, 1);
  assert.equal(value.stdoutBytes, 6);
  for (const [field, failure] of [
    ["exitCode", 1],
    ["timedOut", true],
    ["cancelled", true],
    ["truncated", true],
    ["errorCode", "EIO"],
    ["signal", "SIGTERM"],
  ] as const) {
    const changed = structuredClone(report);
    Reflect.set(changed.checks[0]!.tools.at(-1)!.process, field, failure);
    assert.throws(
      () => summarizeWindowsResources(changed, expected),
      /Windows resource invocation did not complete successfully/,
    );
  }
  for (const stream of ["stdout", "stderr"] as const) {
    const changed = structuredClone(report);
    changed.checks[0]!.tools.at(-1)!.process.capturedOutput[stream].sha256 =
      "f".repeat(64);
    assert.throws(() => summarizeWindowsResources(changed, expected));
  }
});
test("Windows workload CPU aggregation preserves exact safe boundaries and refuses overflow across otherwise valid jobs", () => {
  const { report, expected } = observation();
  for (const process of report.checks[0]!.processes) {
    process.windowsExecution.resources.processCpu = {
      user100ns: 0,
      kernel100ns: 0,
    };
    process.windowsExecution.resources.jobCpu = {
      user100ns: 0,
      kernel100ns: 0,
    };
  }
  report.checks[0]!.processes[0]!.windowsExecution.resources.jobCpu.user100ns =
    Number.MAX_SAFE_INTEGER;
  assert.equal(
    summarizeWindowsResources(report, expected).jobCpu.user100ns,
    Number.MAX_SAFE_INTEGER,
  );
  report.checks[0]!.processes[1]!.windowsExecution.resources.jobCpu.user100ns = 1;
  assert.throws(
    () => summarizeWindowsResources(report, expected),
    /aggregate CPU exceeds/,
  );
});
