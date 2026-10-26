import { z } from "zod";
const count = z.number().int().nonnegative().max(4294967295);
// CPU counters retain Windows' native 100 ns ticks. The memory value is the
// direct target's lifetime peak working set, never job commit or a tree sum.
// Process and job CPU are independent API observations; do not infer exact
// conservation between GetProcessTimes and QueryInformationJobObject.
const ticks = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cpu = z.strictObject({ user100ns: ticks, kernel100ns: ticks });
export const windowsResourceUsageSchema = z.discriminatedUnion("state", [
  z.strictObject({
    profile: z.literal("windows-job-resources-v1"),
    state: z.literal("collected"),
    cpuUnit: z.literal("100ns"),
    processCpu: cpu,
    jobCpu: cpu,
    totalJobProcesses: count.min(1),
    peakWorkingSetBytes: ticks,
    memoryScope: z.literal("direct-target-lifetime-peak"),
    collectedAfterJobEmpty: z.literal(true),
    summedProcessTreeRss: z.literal(false),
  }),
  z.strictObject({
    profile: z.literal("windows-job-resources-v1"),
    state: z.literal("unavailable"),
    stage: z.enum([
      "process-times",
      "process-memory",
      "job-accounting",
      "counter-bounds",
    ]),
    nativeError: count.nullable(),
  }),
]);
export const windowsReceiptSchema = z.strictObject({
  profile: z.literal("windows-job-v1"),
  requestId: z.string().uuid(),
  phase: z.enum(["assigned", "running", "completed", "failed"]),
  supervisorPid: count.min(1),
  childPid: count.min(1).nullable(),
  jobAssigned: z.boolean(),
  resumed: z.boolean(),
  childExitCode: count.nullable(),
  activeBeforeCleanup: count.nullable(),
  activeAfterCleanup: count.nullable(),
  cleanup: z.enum(["confirmed", "unavailable", "not-started"]),
  nativeError: count.nullable(),
  resources: windowsResourceUsageSchema.nullable().optional(),
});
export const windowsExecutionSchema = windowsReceiptSchema.extend({
  launcherPid: count.min(1),
  launcherSha256: z.string().regex(/^[a-f0-9]{64}$/),
  supervisorSha256: z.string().regex(/^[a-f0-9]{64}$/),
  ownership: z.literal("creation-job-list"),
  executionSandboxed: z.literal(false),
});
export type WindowsExecution = z.infer<typeof windowsExecutionSchema>;
