import { z } from "zod";
import { externalReferencesSchema } from "./external-adapter.js";
import { operatorEnvironment } from "./environment.js";

export const validationTasksOptionsSchema = z.strictObject({
  root: z.string().min(1).max(4096),
  directory: z.string().min(1).max(4096),
  detailed: z.boolean().default(false),
  allowExecution: z.boolean(),
  timeoutMs: z.number().int().min(1).max(120000).default(30000),
  base: z.string().min(1).max(4096).optional(),
  policyOverlay: z.string().min(1).max(4096).optional(),
  environment: z
    .record(z.string(), z.string())
    .transform((value) => operatorEnvironment(value))
    .optional(),
  externalAdapters: externalReferencesSchema.optional(),
});
export type ValidationTasksOptions = z.input<
  typeof validationTasksOptionsSchema
>;
export const validationTaskRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({
    id: z.number().int().positive(),
    method: z.literal("start"),
  }),
  z.strictObject({
    id: z.number().int().positive(),
    method: z.literal("get"),
    taskId: z.string().uuid(),
  }),
  z.strictObject({
    id: z.number().int().positive(),
    method: z.literal("cancel"),
    taskId: z.string().uuid(),
  }),
  z.strictObject({
    id: z.number().int().positive(),
    method: z.literal("close"),
  }),
]);
export const storedValidationTaskSchema = z.strictObject({
  taskId: z.string().uuid(),
  status: z.enum(["working", "completed", "cancelled"]),
  createdAt: z.iso.datetime(),
  lastUpdatedAt: z.iso.datetime(),
  ttlMs: z.number().int().positive(),
  result: z.record(z.string(), z.unknown()).optional(),
});
export const validationTaskResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    id: z.number().int().nonnegative(),
    ok: z.literal(true),
    value: storedValidationTaskSchema.nullable(),
  }),
  z.strictObject({
    id: z.number().int().nonnegative(),
    ok: z.literal(false),
    error: z.enum(["unavailable", "denied", "busy", "invalid", "closed"]),
  }),
]);
