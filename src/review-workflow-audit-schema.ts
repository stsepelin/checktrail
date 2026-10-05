import { z } from "zod";
import { reviewWorkflowSummarySchema } from "./review-workflow-schema.js";
export const reviewWorkflowAuditOptionsSchema = z.strictObject({
  file: z.string().min(1).max(4096),
  maxBytes: z.number().int().min(0).max(134217728).default(67108864),
  maxEvents: z.number().int().min(0).max(4096).default(1024),
});
export const reviewWorkflowAuditSummarySchema = z.strictObject({
  schemaVersion: z.literal(2),
  journalVersion: z.union([z.literal(1), z.literal(2)]),
  format: z.literal("review-workflow-audit-summary"),
  epochId: z.string().uuid(),
  engineVersion: z.string().min(1).max(128),
  journalStatus: z.enum(["sealed", "interrupted"]),
  prefixIntegrityVerified: z.literal(true),
  externallyAnchored: z.literal(false),
  claimsVerified: z.literal(false),
  hostIsolationVerified: z.literal(false),
  sourceIncluded: z.literal(false),
  events: z.number().int().nonnegative().max(4096),
  bytes: z.number().int().nonnegative().max(134217728),
  trailingBytes: z.number().int().nonnegative().max(134217728),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  allCommandBodiesRetained: z.boolean(),
  nativeAccountingComplete: z.boolean(),
  nativeReceipts: z.strictObject({
    retained: z.number().int().nonnegative().max(16),
    complete: z.boolean(),
    rawOutputIncluded: z.literal(false),
  }),
  commands: z.strictObject({
    started: z.number().int().nonnegative().max(2048),
    finished: z.number().int().nonnegative().max(2048),
    rejected: z.number().int().nonnegative().max(2048),
    pending: z.number().int().nonnegative().max(16),
  }),
  workflows: z.array(reviewWorkflowSummarySchema).max(16),
});
export type ReviewWorkflowAuditOptions = z.input<
  typeof reviewWorkflowAuditOptionsSchema
>;
export type ReviewWorkflowAuditSummary = z.infer<
  typeof reviewWorkflowAuditSummarySchema
>;
