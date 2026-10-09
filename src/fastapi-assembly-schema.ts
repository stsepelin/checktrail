import { z } from "zod";
import { runtimeInventorySchema } from "./runtime-inventory.js";
const label = z.string().min(1).max(1024);
export const fastapiAssemblyRouteSchema = z.strictObject({
  scope: z.string().max(4096),
  ordinal: z
    .string()
    .regex(/^[0-9]+(?:\.[0-9]+)*$/)
    .max(128),
  protocol: z.enum(["http", "websocket"]),
  method: z
    .string()
    .regex(/^[A-Z]+$/)
    .max(32),
  path: z.string().regex(/^\//).max(4096),
  handler: label,
  name: z.string().max(256),
  dependencies: z.array(z.string().max(4096)).max(256),
  responseModel: z.string().max(4096).nullable(),
  responseClass: label.nullable(),
  responseOptions: z.string().max(4096),
  statusCode: z.number().int().min(100).max(599).nullable(),
  includeInSchema: z.boolean(),
  application: z.boolean(),
});
export const fastapiAssemblyMiddlewareSchema = z.strictObject({
  scope: z.string().max(4096),
  position: z.number().int().nonnegative().max(255),
  kind: z.enum(["user", "native", "native-unbuilt"]),
  name: label,
  arguments: z.string().max(4096).nullable(),
  options: z.string().max(4096).nullable(),
  constructed: z.boolean(),
});
export const fastapiAssemblyLifespanSchema = z.strictObject({
  scope: z.string().max(4096),
  position: z.number().int().nonnegative().max(255),
  kind: z.enum(["context", "startup", "shutdown"]),
  callable: label,
  branch: z.string().max(256),
});
export const fastapiAssemblyBindingSchema = z.strictObject({
  scope: z.string().max(4096),
  position: z.number().int().nonnegative().max(255),
  original: label,
  replacement: label,
});
const header = z.tuple([
  z
    .string()
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
    .max(256),
  z
    .string()
    .regex(/^[^\r\n\0]*$/)
    .max(4096),
]);
export const fastapiAssemblyRequestSchema = z.strictObject({
  protocol: z.enum(["http", "websocket"]),
  path: z
    .string()
    .regex(/^\/(?!\/)/)
    .max(4096),
  host: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?$/)
    .max(256),
  method: z
    .string()
    .regex(/^[A-Z]+$/)
    .max(32),
  headers: z.array(header).max(32),
  body: z.string().max(32768),
  expected: z.strictObject({
    status: z.number().int().min(100).max(599).nullable(),
    body: z.string().max(65536).nullable(),
    messages: z.array(z.string().max(4096)).max(64),
  }),
});
export const fastapiAssemblyResponseSchema = fastapiAssemblyRequestSchema
  .omit({ expected: true })
  .extend({
    status: z.number().int().min(100).max(599).nullable(),
    responseBody: z.string().max(65536).nullable(),
    messages: z.array(z.string().max(4096)).max(64),
  });
export const fastapiAssemblyResultSchema = z.strictObject({
  version: z.literal(2),
  versions: z.strictObject({
    python: z.literal("3.12.13"),
    fastapi: z.literal("0.141.1"),
    starlette: z.literal("1.6.0"),
    pydantic: z.literal("2.13.5"),
  }),
  applicationRoutes: z.number().int().nonnegative().max(2048),
  applicationCount: z.number().int().min(1).max(256),
  routeCount: z.number().int().nonnegative().max(2048),
  middlewareCount: z.number().int().nonnegative().max(2048),
  lifespanCount: z.number().int().nonnegative().max(2048),
  bindingCount: z.number().int().nonnegative().max(2048),
  runtime: runtimeInventorySchema,
  requests: z.array(fastapiAssemblyResponseSchema).min(1).max(64),
});
