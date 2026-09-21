import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z
  .string()
  .min(1)
  .max(4096)
  .regex(
    /^(?![A-Za-z]:)(?:(?!\.{1,2}\/)[^/\\\0]+\/)*(?!\.{1,2}$)[^/\\\0]+$/,
    "Expected a normalized relative file path",
  );
export const findingKeySchema = z.strictObject({
  checkId: z.string().min(1).max(256),
  project: z.union([z.literal("."), relative]),
  ruleId: z.string().min(1).max(256),
  file: relative,
  line: z.number().int().positive(),
  level: z.enum(["error", "warning", "note"]),
  messageHash: hash,
});
export const findingBaselineEntrySchema = findingKeySchema.extend({
  id: hash,
  occurrences: z.number().int().positive().max(100_000),
  kind: z.enum(["baseline", "exception"]),
  owner: z.string().trim().min(1).max(256),
  reason: z.string().trim().min(1).max(4096),
  expiresAt: z.iso.datetime().optional(),
});
export const findingBaselineSchema = z.strictObject({
  schemaVersion: z.literal(1),
  createdFrom: z.strictObject({
    runId: z.string(),
    sourceFingerprint: z.string(),
    policyFingerprint: z.string(),
  }),
  limits: z.strictObject({
    maxEntries: z.number().int().nonnegative().max(10_000),
    maxExceptions: z.number().int().nonnegative().max(10_000),
  }),
  entries: z.array(findingBaselineEntrySchema).max(10_000),
});
export type FindingBaseline = z.infer<typeof findingBaselineSchema>;
export const findingComparisonSchema = z.strictObject({
  schemaVersion: z.literal(1),
  engineVersion: z.string(),
  provenance: z.literal("finding-comparison"),
  outcome: z.enum(["passed", "failed", "incomplete"]),
  validationOutcome: z.enum(["passed", "failed", "incomplete"]),
  reason: z.string(),
  sourceVerified: z.boolean(),
  baselineFingerprint: hash,
  counts: z.strictObject({
    current: z.number().int().nonnegative(),
    new: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    unverified: z.number().int().nonnegative(),
    expanded: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
  }),
  limitExceeded: z.boolean(),
  unaccountedFailures: z.number().int().nonnegative(),
  entries: z.array(
    z.strictObject({
      id: hash,
      status: z.enum(["matched", "stale", "expired", "changed", "unverified"]),
      occurrences: z.number().int().nonnegative(),
    }),
  ),
  newFindingIds: z.array(hash),
});
export type FindingComparison = z.infer<typeof findingComparisonSchema>;
export const findingComparisonSummarySchema = findingComparisonSchema.omit({
  entries: true,
  newFindingIds: true,
});
