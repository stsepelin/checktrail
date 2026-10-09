import path from "node:path";
import { z } from "zod";
import { readProjectFile } from "./inventory.js";
import { djangoRunner } from "./django-runner.js";
import { djangoAssemblyRunner } from "./django-assembly-runner.js";
import {
  djangoAssemblyRouteSchema,
  djangoAssemblyMiddlewareSchema,
  djangoAssemblySignalSchema,
  djangoAssemblyAppSchema,
  djangoAssemblyRequestSchema,
} from "./django-assembly-schema.js";
import type { Check, Inventory, Project } from "./types.js";
const legacyConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  settings: z
    .string()
    .regex(/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/)
    .max(256),
  assembly: z.string().min(1).max(256),
  environment: z.string().min(1).max(256),
});
export const djangoConfigSchema = z.discriminatedUnion("schemaVersion", [
  legacyConfigSchema,
  legacyConfigSchema.extend({
    schemaVersion: z.literal(2),
    signals: z
      .array(
        z.strictObject({
          module: legacyConfigSchema.shape.settings,
          attribute: z
            .string()
            .regex(/^[A-Za-z_]\w*$/)
            .max(256),
        }),
      )
      .min(1)
      .max(32),
    expectedRoutes: z.array(djangoAssemblyRouteSchema).min(1).max(2048),
    expectedMiddleware: z.array(djangoAssemblyMiddlewareSchema).max(2048),
    expectedSignals: z.array(djangoAssemblySignalSchema).max(2048),
    expectedApps: z.array(djangoAssemblyAppSchema).min(1).max(256),
    requests: z.array(djangoAssemblyRequestSchema).min(1).max(64),
  }),
]);
export async function djangoCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "python.django-routes",
    adapter: project.adapter,
    project: project.path,
    scope: [],
    commands: [],
    kind: "analysis",
    parser: "django-json",
    reason:
      "Load explicit Django test settings, run native application setup, and inventory supported URL patterns including nested resolvers.",
  };
  if (!project.files.includes("checktrail.django.json")) {
    check.unavailableReason =
      "Django route validation requires an explicit checktrail.django.json profile.";
    return check;
  }
  const contents = await readProjectFile(
    source.root,
    path.posix.join(project.path, "checktrail.django.json"),
  );
  if (Buffer.byteLength(contents) > 65536)
    throw new Error("Django config exceeds 64 KiB");
  const config = djangoConfigSchema.parse(JSON.parse(contents));
  const modulePath = config.settings.replaceAll(".", "/");
  check.scope = [`${modulePath}.py`, `${modulePath}/__init__.py`].filter(
    (file) => project.files.includes(file),
  );
  if (check.scope.length !== 1) {
    check.unavailableReason =
      "Django settings must resolve to one inventoried local Python module or package.";
    return check;
  }
  check.commands = [
    {
      executable: "python3",
      args:
        config.schemaVersion === 2
          ? [
              "-I",
              "-c",
              djangoAssemblyRunner,
              JSON.stringify(config),
              source.fingerprint,
              path.resolve(source.root, project.path),
            ]
          : ["-c", djangoRunner, JSON.stringify(config), source.fingerprint],
      cwd: project.path,
      env: {
        PYTHONDONTWRITEBYTECODE: "1",
        DJANGO_SETTINGS_MODULE: config.settings,
      },
    },
  ];
  return check;
}
