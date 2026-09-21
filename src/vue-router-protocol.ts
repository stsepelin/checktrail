import { z } from "zod";
import { runtimeInventorySchema } from "./runtime-inventory.js";
import { vueRouteIdentitySchema } from "./vue-router.js";

const count = z.number().int().nonnegative().max(2048);
export const vueRouteAttributesSchema = z.strictObject({
  path: z.string().regex(/^\//).max(4096),
  name: z.string().max(256).nullable(),
  aliasPath: z.string().max(4096).nullable(),
  aliasName: z.string().max(256).nullable(),
  views: z.array(z.string().max(256)).max(32),
  meta: z.string().max(4096),
  redirect: z.string().max(4096),
  beforeEnter: z.array(z.string().max(256)).max(32),
  children: count,
  globalStrict: z.boolean(),
  globalSensitive: z.boolean(),
});
export const vueRouterResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  versions: z.strictObject({
    router: z.literal("5.3.1"),
    vue: z.literal("3.5.43"),
  }),
  totalRoutes: count,
  supportedRoutes: count,
  indices: z.array(count).max(2048),
  coveredIndices: z.array(count).max(2048),
  runtime: runtimeInventorySchema,
  probes: z
    .array(
      z.strictObject({
        path: z.string(),
        matched: z.array(vueRouteIdentitySchema).max(32),
        indices: z.array(count.nullable()).max(32),
      }),
    )
    .max(256),
});
export function vueRouteKey(
  attributes: z.infer<typeof vueRouteAttributesSchema>,
): string {
  return JSON.stringify([
    attributes.path,
    attributes.name,
    attributes.aliasPath,
    attributes.aliasName,
  ]);
}
