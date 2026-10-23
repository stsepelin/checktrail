import assert from "node:assert/strict";
import { test } from "node:test";
import { windowsResourceUsageSchema } from "../src/windows-execution.js";

const collected = {
  profile: "windows-job-resources-v1",
  state: "collected",
  cpuUnit: "100ns",
  processCpu: { user100ns: 101, kernel100ns: 29 },
  jobCpu: { user100ns: 801, kernel100ns: 129 },
  totalJobProcesses: 3,
  peakWorkingSetBytes: 102401,
  memoryScope: "direct-target-lifetime-peak",
  collectedAfterJobEmpty: true,
  summedProcessTreeRss: false,
};

test("Windows resource counters retain native CPU precision and direct working-set scope with valid zero and numeric boundaries", () => {
  assert.deepEqual(windowsResourceUsageSchema.parse(collected), collected);
  for (const n of [0, 1, Number.MAX_SAFE_INTEGER]) {
    const value = {
      ...collected,
      processCpu: { user100ns: n, kernel100ns: n },
      jobCpu: { user100ns: n, kernel100ns: n },
      peakWorkingSetBytes: n,
    };
    assert.deepEqual(windowsResourceUsageSchema.parse(value), value);
  }
  for (const field of ["user100ns", "kernel100ns"] as const) {
    for (const n of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, "100"]) {
      for (const scope of ["processCpu", "jobCpu"] as const)
        assert.equal(
          windowsResourceUsageSchema.safeParse({
            ...collected,
            [scope]: { ...collected[scope], [field]: n },
          }).success,
          false,
        );
    }
    assert.equal(
      windowsResourceUsageSchema.safeParse({
        ...collected,
        jobCpu: {
          ...collected.jobCpu,
          [field]: collected.processCpu[field] - 1,
        },
      }).success,
      false,
    );
  }
  for (const field of Object.keys(collected)) {
    const value: Record<string, unknown> = { ...collected };
    delete value[field];
    assert.equal(
      windowsResourceUsageSchema.safeParse(value).success,
      false,
      field,
    );
  }
  for (const patch of [
    { cpuUnit: "microseconds" },
    { memoryScope: "all-descendants" },
    { collectedAfterJobEmpty: false },
    { summedProcessTreeRss: true },
    { peakWorkingSetBytes: -1 },
    { peakWorkingSetBytes: 0.5 },
    { peakWorkingSetBytes: Number.MAX_SAFE_INTEGER + 1 },
    { peakJobMemory: 102401 },
    { totalJobProcesses: 0 },
    { totalJobProcesses: 4294967296 },
    { state: "complete" },
    { extra: true },
  ])
    assert.equal(
      windowsResourceUsageSchema.safeParse({ ...collected, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
});

test("Windows unavailable resource collection retains its exact API stage and error instead of successful zero counters", () => {
  for (const stage of [
    "process-times",
    "process-memory",
    "job-accounting",
    "counter-bounds",
  ]) {
    for (const nativeError of [null, 0, 1, 87, 4294967295]) {
      const value = {
        profile: "windows-job-resources-v1",
        state: "unavailable",
        stage,
        nativeError,
      };
      assert.deepEqual(windowsResourceUsageSchema.parse(value), value);
      for (const patch of [
        { nativeError: -1 },
        { nativeError: 0.5 },
        { nativeError: 4294967296 },
        { nativeError: "87" },
        { stage: "unknown" },
        { jobCpu: collected.jobCpu },
        { peakWorkingSetBytes: 0 },
      ])
        assert.equal(
          windowsResourceUsageSchema.safeParse({ ...value, ...patch }).success,
          false,
        );
    }
  }
});
