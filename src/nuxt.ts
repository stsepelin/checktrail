import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { localTool } from "./local-tool.js";
import { readProjectFile, withinRoot } from "./inventory.js";
import { vueRouteIdentitySchema } from "./vue-router.js";
import type { Check, Inventory, Project } from "./types.js";

export const nuxtVersions = {
  nuxt: "4.5.2",
  "@nuxt/kit": "4.5.2",
  "@nuxt/vite-builder": "4.5.2",
  "@nuxt/nitro-server": "4.5.2",
  nitropack: "2.13.4",
  vue: "3.5.43",
  "vue-router": "5.3.1",
} as const;
export const nuxtConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  assembly: z.string().min(1).max(256),
  environment: z.literal("test"),
  probes: z
    .array(
      z.strictObject({
        path: z
          .string()
          .regex(/^\/(?!\/)[^\r\n#]*$/)
          .max(4096),
        matched: z.array(vueRouteIdentitySchema).min(1).max(32),
      }),
    )
    .min(1)
    .max(16),
});
export async function nuxtCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "javascript.nuxt-runtime",
    adapter: project.adapter,
    project: project.path,
    kind: "analysis",
    parser: "nuxt-json",
    scope: [],
    commands: [],
    reason:
      "Build an isolated Nuxt SSR testing assembly and verify declared requests against its native runtime router.",
  };
  if (!project.files.includes("checktrail.nuxt.json")) {
    check.unavailableReason =
      "Nuxt runtime checks require an explicit checktrail.nuxt.json profile.";
    return check;
  }
  const config = nuxtConfigSchema.parse(
    JSON.parse(
      await readProjectFile(
        source.root,
        path.posix.join(project.path, "checktrail.nuxt.json"),
      ),
    ),
  );
  if (
    new Set(config.probes.map((probe) => probe.path)).size !==
    config.probes.length
  )
    throw new Error("Nuxt probes require unique request paths");
  const encoded = JSON.stringify(config);
  if (Buffer.byteLength(encoded) > 64 * 1024)
    throw new Error("Nuxt profile exceeds 64 KiB");
  const configs = project.files.filter((file) =>
    /^nuxt\.config\.[cm]?[jt]s$/.test(file),
  );
  if (configs.length !== 1) {
    check.unavailableReason =
      "Nuxt runtime checks require exactly one inventoried root Nuxt configuration.";
    return check;
  }
  check.scope = configs;
  const entry = await localTool(
    source.root,
    project.path,
    "nuxt/dist/index.mjs",
  );
  if (!entry) {
    check.unavailableReason =
      "Nuxt must already be installed inside the configured root.";
    return check;
  }
  const metadata: Record<string, string> = {};
  try {
    const require = createRequire(entry);
    for (const name of Object.keys(nuxtVersions)) {
      const resolver =
        name === "nitropack"
          ? createRequire(metadata["@nuxt/nitro-server"]!)
          : require;
      const resolved = resolver.resolve(`${name}/package.json`);
      metadata[name] = await withinRoot(
        source.root,
        path.relative(source.root, resolved),
      );
    }
  } catch {
    check.unavailableReason =
      "Nuxt runtime dependencies must resolve inside the configured root.";
    return check;
  }
  check.commands = [
    {
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./nuxt-runner.js", import.meta.url)),
        entry,
        JSON.stringify(metadata),
        encoded,
        source.fingerprint,
      ],
      cwd: project.path,
      env: {
        NODE_ENV: "test",
        NODE_OPTIONS: "",
        NUXT_TELEMETRY_DISABLED: "1",
        CI: "1",
      },
      temporaryDirectory: true,
    },
  ];
  return check;
}
