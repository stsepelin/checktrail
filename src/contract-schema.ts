import { z } from "zod";
const name = z.string().min(1).max(1024);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
export const contractBundleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.literal("contract-samples"),
  capturedAt: z.iso.datetime(),
  contracts: z
    .array(
      z.strictObject({
        id: name,
        producer: z.strictObject({ name, sourceFingerprint: hash }),
        consumer: z.strictObject({ name, sourceFingerprint: hash }),
        complete: z.boolean(),
        schema: z.record(z.string(), z.unknown()),
        samples: z
          .array(z.strictObject({ name, payload: z.unknown() }))
          .max(1000),
      }),
    )
    .min(1)
    .max(100),
});
export type ContractBundle = z.infer<typeof contractBundleSchema>;
export const contractReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  engineVersion: z.string(),
  provenance: z.literal("imported-contract-samples"),
  outcome: z.enum(["passed", "failed", "incomplete"]),
  reason: z.string(),
  artifactFingerprint: hash,
  counts: z.strictObject({
    contracts: count,
    passed: count,
    failed: count,
    unverified: count,
    samples: count,
    accepted: count,
    rejected: count,
  }),
  contracts: z.array(
    z.strictObject({
      id: name,
      outcome: z.enum(["passed", "failed", "incomplete"]),
      reason: z.string(),
      samples: z.array(
        z.strictObject({
          name,
          accepted: z.boolean(),
          errors: z.array(
            z.strictObject({
              keyword: z.string(),
              instancePath: z.string(),
              schemaPath: z.string(),
            }),
          ),
        }),
      ),
    }),
  ),
});
export type ContractReport = z.infer<typeof contractReportSchema>;
export const contractSummarySchema = contractReportSchema.omit({
  contracts: true,
});
