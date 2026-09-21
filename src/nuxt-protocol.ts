import { z } from "zod";
import { runtimeInventorySchema } from "./runtime-inventory.js";
import { vueRouteIdentitySchema } from "./vue-router.js";
const count = z.number().int().nonnegative().max(2048);
const signature = z.string().regex(/^[a-f0-9]{64}$/);
export const nuxtResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  versions: z.record(z.string(), z.string()),
  sourceFingerprint: signature,
  runtime: runtimeInventorySchema.nullable(),
  totalRoutes: count,
  indices: z.array(count).max(2048),
  signature: signature.nullable(),
  probes: z
    .array(
      z.strictObject({
        path: z.string(),
        status: z.number().int().min(100).max(599),
        capture: z
          .strictObject({
            signature,
            totalRoutes: count,
            supportedRoutes: count,
            matched: z.array(vueRouteIdentitySchema).max(32),
            indices: z.array(count.nullable()).max(32),
          })
          .nullable(),
      }),
    )
    .max(16),
});
