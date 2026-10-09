import { z } from "zod";
export const vueRouteIdentitySchema = z.strictObject({
  path: z.string().regex(/^\//).max(4096),
  name: z.string().max(256).nullable(),
});
