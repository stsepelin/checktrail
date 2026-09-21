import path from "node:path";
import { z } from "zod";
import { readProjectFile } from "./inventory.js";
import { djangoRunner } from "./django-runner.js";
import type { Check, Inventory, Project } from "./types.js";
export const djangoConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  settings: z
    .string()
    .regex(/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/)
    .max(256),
  assembly: z.string().min(1).max(256),
  environment: z.string().min(1).max(256),
});
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
  const config = djangoConfigSchema.parse(
    JSON.parse(
      await readProjectFile(
        source.root,
        path.posix.join(project.path, "checktrail.django.json"),
      ),
    ),
  );
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
      args: ["-c", djangoRunner, JSON.stringify(config), source.fingerprint],
      cwd: project.path,
      env: {
        PYTHONDONTWRITEBYTECODE: "1",
        DJANGO_SETTINGS_MODULE: config.settings,
      },
    },
  ];
  return check;
}
