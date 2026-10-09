import { z } from "zod";
import { runtimeInventorySchema } from "./runtime-inventory.js";
import { vueRouteAttributesSchema } from "./vue-router-protocol.js";
import { vueRouteIdentitySchema } from "./vue-router-identity.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().min(1).max(256);
const route = z.string().max(4096);
const count = z.number().int().nonnegative().max(2048);
export const nuxtHandlerSchema = z.strictObject({
  position: count,
  route,
  method: z
    .enum(["get", "post", "put", "patch", "delete", "head", "options", "all"])
    .nullable(),
  source: z.string().min(1).max(1024),
  lazy: z.boolean(),
  middleware: z.boolean(),
});
export const nuxtMiddlewareSchema = z.strictObject({
  phase: z.enum(["h3", "global", "named"]),
  position: count,
  route,
  source: z.string().min(1).max(1024),
  name: z.string().max(256),
});
export const nuxtConfigBoundarySchema = z.strictObject({
  visibility: z.enum(["private", "public", "internal"]),
  key: label,
  sha256: digest,
});
export const nuxtApiTypeSchema = z.strictObject({
  route: route.min(1),
  method: label,
  type: z.string().min(1).max(4096),
});
export const nuxtMiddlewareEventSchema = z.discriminatedUnion("phase", [
  z.strictObject({
    phase: z.literal("h3"),
    position: count,
    path: route,
    method: z.enum([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
      "CONNECT",
      "TRACE",
    ]),
  }),
  z.strictObject({
    phase: z.literal("global"),
    position: count,
    path: route,
    method: z.literal("NAVIGATE"),
  }),
  z.strictObject({
    phase: z.literal("named"),
    position: count,
    path: route,
    method: z.literal("NAVIGATE"),
  }),
]);
const requestInput = z.strictObject({
  path: z
    .string()
    .regex(/^\/(?!\/)[^\r\n#]*$/)
    .max(4096),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
});
const response = z.strictObject({
  status: z.number().int().min(100).max(599),
  serverRoute: route.nullable(),
  matched: z.array(vueRouteIdentitySchema).max(32).nullable(),
  // Full HTML contains native build/timestamp fields; operators select literal markers.
  body: z.string().max(65536).nullable(),
  includes: z.array(z.string().min(1).max(4096)).max(32),
  excludes: z.array(z.string().min(1).max(4096)).max(32),
  events: z.array(nuxtMiddlewareEventSchema).max(2048),
});
export const nuxtAssemblyConfigSchema = z.strictObject({
  schemaVersion: z.literal(2),
  assembly: label,
  environment: z.literal("test"),
  expectedPages: z.array(vueRouteAttributesSchema).min(1).max(2048),
  expectedHandlers: z.array(nuxtHandlerSchema).min(1).max(2048),
  expectedMiddleware: z.array(nuxtMiddlewareSchema).min(1).max(2048),
  expectedRuntimeConfig: z.array(nuxtConfigBoundarySchema).max(128),
  consumers: z
    .array(
      z
        .string()
        .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+\.[cm]?ts$/)
        .max(256),
    )
    .min(1)
    .max(16),
  expectedApis: z.array(nuxtApiTypeSchema).min(1).max(64),
  requests: z
    .array(requestInput.extend({ expected: response }))
    .min(1)
    .max(32),
});
export const nuxtAssemblyResultSchema = z.strictObject({
  schemaVersion: z.literal(2),
  versions: z.record(z.string(), z.string()),
  runtime: runtimeInventorySchema,
  counts: z.tuple([count, count, count, count, count, count]),
  handlers: z.array(nuxtHandlerSchema).max(2048),
  middleware: z.array(nuxtMiddlewareSchema).max(2048),
  runtimeConfig: z.array(nuxtConfigBoundarySchema).max(128),
  types: z.strictObject({
    compilerVersion: z.literal("6.0.3"),
    consumers: z.array(z.string()).min(1).max(16),
    generated: z.literal(true),
    supported: z.boolean(),
    apis: z.array(nuxtApiTypeSchema).max(64),
    diagnostics: z.array(z.number().int().positive()).max(256),
    sourceFiles: z.number().int().positive().max(8192),
  }),
  requests: z
    .array(
      requestInput.extend({
        status: response.shape.status,
        serverRoute: response.shape.serverRoute,
        matched: response.shape.matched,
        responseBody: z.string().max(65536),
        completion: z.enum(["after-response", "error-response"]),
        events: response.shape.events,
      }),
    )
    .max(32),
});
export type NuxtAssemblyConfig = z.infer<typeof nuxtAssemblyConfigSchema>;
export type NuxtHandler = z.infer<typeof nuxtHandlerSchema>;
export type NuxtMiddleware = z.infer<typeof nuxtMiddlewareSchema>;
export type NuxtMiddlewareEvent = z.infer<typeof nuxtMiddlewareEventSchema>;
