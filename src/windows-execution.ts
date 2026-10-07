import { z } from "zod";
const count = z.number().int().nonnegative().max(4294967295);
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
});
export const windowsExecutionSchema = windowsReceiptSchema.extend({
  launcherPid: count.min(1),
  launcherSha256: z.string().regex(/^[a-f0-9]{64}$/),
  supervisorSha256: z.string().regex(/^[a-f0-9]{64}$/),
  ownership: z.literal("creation-job-list"),
  executionSandboxed: z.literal(false),
});
export type WindowsExecution = z.infer<typeof windowsExecutionSchema>;
