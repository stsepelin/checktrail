import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readProjectFile, withinRoot } from "./inventory.js";
import { localTool } from "./local-tool.js";
import type { Check, Inventory, Project } from "./types.js";

const routePath = z.string().regex(/^\//).max(4096);
export const vueRouteIdentitySchema = z.strictObject({
  path: routePath,
  name: z.string().max(256).nullable(),
});
export const vueRouterConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  module: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) =>
        path.posix.normalize(value) === value &&
        !path.posix.isAbsolute(value) &&
        !value.startsWith("../") &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        /\.[cm]?js$/.test(value),
    ),
  attribute: z
    .string()
    .regex(/^[A-Za-z_$][\w$]*$/)
    .max(128),
  assembly: z.string().min(1).max(256),
  environment: z.literal("test"),
  strict: z.boolean(),
  sensitive: z.boolean(),
  probes: z
    .array(
      z.strictObject({
        path: z
          .string()
          .regex(/^\/(?!\/)/)
          .max(4096),
        matched: z.array(vueRouteIdentitySchema).max(32),
      }),
    )
    .min(1)
    .max(256),
});
export async function vueRouterCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "javascript.vue-router",
    adapter: project.adapter,
    project: project.path,
    kind: "analysis",
    parser: "vue-router-json",
    scope: [],
    commands: [],
    reason:
      "Capture native Vue Router records after configured startup and verify declared route probes with complete record participation.",
  };
  if (!project.files.includes("repo-verifier.vue-router.json")) {
    check.unavailableReason =
      "Vue Router checks require an explicit repo-verifier.vue-router.json profile.";
    return check;
  }
  const config = vueRouterConfigSchema.parse(
    JSON.parse(
      await readProjectFile(
        source.root,
        path.posix.join(project.path, "repo-verifier.vue-router.json"),
      ),
    ),
  );
  if (
    new Set(config.probes.map((probe) => probe.path)).size !==
      config.probes.length ||
    !config.probes.some((probe) => probe.matched.length)
  )
    throw new Error(
      "Vue Router probes require unique paths and at least one expected route match",
    );
  if (!project.files.includes(config.module)) {
    check.unavailableReason =
      "Vue Router startup must be an inventoried Node-compatible module in this project.";
    return check;
  }
  check.scope = [config.module];
  const router = await localTool(
    source.root,
    project.path,
    "vue-router/vue-router.node.mjs",
  );
  let vue: string | undefined;
  if (router) {
    try {
      const resolved = createRequire(router).resolve("vue/package.json");
      vue = await withinRoot(source.root, path.relative(source.root, resolved));
    } catch {
      vue = undefined;
    }
  }
  if (!router || !vue) {
    check.unavailableReason =
      "Vue Router and Vue must be installed inside the configured root.";
    return check;
  }
  const entry = await withinRoot(
    source.root,
    path.posix.join(project.path, config.module),
  );
  if (entry !== path.resolve(source.root, project.path, config.module))
    throw new Error("Vue Router startup cannot traverse symbolic links");
  const encoded = JSON.stringify(config);
  if (Buffer.byteLength(encoded) > 64 * 1024)
    throw new Error("Vue Router profile exceeds 64 KiB");
  check.commands = [
    {
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./vue-router-runner.js", import.meta.url)),
        router,
        vue,
        entry,
        encoded,
        source.fingerprint,
      ],
      cwd: project.path,
      env: { NODE_ENV: "test", NODE_OPTIONS: "" },
    },
  ];
  return check;
}
