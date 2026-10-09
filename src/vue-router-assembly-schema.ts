import { z } from "zod";
import { vueRouteIdentitySchema } from "./vue-router-identity.js";
export const vueHookSchema = z.strictObject({
  phase: z.enum(["beforeEach", "beforeResolve", "afterEach"]),
  name: z.string().max(256),
});
export const vueHookEventSchema = vueHookSchema.extend({
  to: z.string().max(4096),
  from: z.string().max(4096),
});
export const vueNavigationSchema = z.strictObject({
  path: z
    .string()
    .regex(/^\/(?!\/)/)
    .max(4096),
  fullPath: z.string().max(4096),
  matched: z.array(vueRouteIdentitySchema).max(32),
  meta: z.string().max(4096),
  hooks: z.array(vueHookEventSchema).max(2048),
  failure: z.union([z.literal(4), z.literal(8), z.literal(16)]).nullable(),
});
export const vueHookReceiptSchema = vueHookSchema.extend({
  reached: z.boolean(),
});
export type VueHook = z.infer<typeof vueHookSchema>;
export type VueHookEvent = z.infer<typeof vueHookEventSchema>;
