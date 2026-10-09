import { z } from "zod";
import { runtimeInventorySchema } from "./runtime-inventory.js";
const label = z.string().min(1).max(1024),
  position = z.number().int().nonnegative().max(2048);
export const djangoAssemblyRouteSchema = z.strictObject({
  ordinal: z
    .string()
    .regex(/^[0-9]+(?:\.[0-9]+)*$/)
    .max(128),
  patterns: z.array(z.string().max(4096)).min(1).max(9),
  namespaces: z.array(z.string().min(1).max(256)).max(8),
  handler: label,
  name: z.string().max(256).nullable(),
  defaultsHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const djangoAssemblyMiddlewareSchema = z.strictObject({
  phase: z.enum(["registration", "view", "template", "exception"]),
  position,
  declared: z.string().min(1).max(1024).nullable(),
  callable: label,
  constructed: z.boolean(),
});
export const djangoAssemblySignalSchema = z.strictObject({
  signal: label,
  position,
  receiver: label,
  sender: label.nullable(),
  dispatchUid: z.string().max(4096).nullable(),
  weak: z.boolean(),
  async: z.boolean(),
});
export const djangoAssemblyAppSchema = z.strictObject({
  position,
  declared: label,
  name: label,
  label: label,
  config: label,
  ready: label,
  defaultAutoField: label,
  models: z.boolean(),
});
export const djangoAssemblyEventSchema = z
  .strictObject({
    signal: label,
    method: z.enum(["send", "send_robust", "asend", "asend_robust"]),
    sender: label.nullable(),
    receivers: z.array(label).max(2048),
    errors: z.array(z.boolean()).max(2048),
  })
  .refine((v) => v.receivers.length === v.errors.length);
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
const requestFields = {
  path: z
    .string()
    .regex(/^\/(?!\/)[^?\r\n\0]*$/)
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
};
export const djangoAssemblyRequestSchema = z
  .strictObject({
    ...requestFields,
    expected: z.strictObject({
      status: z.number().int().min(100).max(599),
      body: z.string().max(65536),
      events: z.array(djangoAssemblyEventSchema).max(2048),
    }),
  })
  .superRefine((v, c) => {
    const keys = v.headers.map(([n]) => n.toUpperCase().replaceAll("-", "_"));
    if (
      new Set(keys).size !== keys.length ||
      keys.some((k) => ["HOST", "CONTENT_LENGTH", "CONTENT_TYPE"].includes(k))
    )
      c.addIssue({
        code: "custom",
        message: "Colliding or reserved WSGI request header",
      });
    const port = v.host.split(":")[1];
    if (port !== undefined && (!Number(port) || Number(port) > 65535))
      c.addIssue({ code: "custom", message: "WSGI server port outside range" });
    if (Buffer.byteLength(v.body) > 32768)
      c.addIssue({ code: "custom", message: "Request byte limit" });
  });
export const djangoAssemblyResultSchema = z.strictObject({
  version: z.literal(2),
  versions: z.strictObject({
    python: z.literal("3.12.13"),
    django: z.literal("6.1.1"),
    asgiref: z.literal("3.12.1"),
  }),
  visitedNodes: position,
  resolverNodes: position,
  counts: z.tuple([position, position, position, position]),
  runtime: runtimeInventorySchema,
  requests: z
    .array(
      z.strictObject({
        ...requestFields,
        status: z.number().int().min(100).max(599),
        responseBody: z.string().max(65536),
        events: z.array(djangoAssemblyEventSchema).max(2048),
      }),
    )
    .min(1)
    .max(64),
});
