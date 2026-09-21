import path from "node:path";
import { z } from "zod";
import { readProjectFile } from "./inventory.js";
import { localTool } from "./local-tool.js";
import { laravelRunner } from "./laravel-runner.js";
import type { Check, Inventory, Project } from "./types.js";

export const laravelConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  assembly: z.string().min(1).max(256),
  environment: z.literal("testing"),
});

export async function laravelCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "php.laravel-runtime",
    adapter: project.adapter,
    project: project.path,
    scope: [],
    commands: [],
    kind: "analysis",
    parser: "laravel-json",
    reason:
      "Bootstrap the explicit Laravel testing profile and capture native assembly registrations without dispatching requests or scheduled work.",
  };
  if (!project.files.includes("repo-verifier.laravel.json")) {
    check.unavailableReason =
      "Laravel runtime capture requires an explicit repo-verifier.laravel.json profile.";
    return check;
  }
  const config = laravelConfigSchema.parse(
    JSON.parse(
      await readProjectFile(
        source.root,
        path.posix.join(project.path, "repo-verifier.laravel.json"),
      ),
    ),
  );
  const autoload = await localTool(
    source.root,
    project.path,
    "autoload.php",
    "vendor",
  );
  if (!autoload || !project.files.includes("bootstrap/app.php")) {
    check.unavailableReason =
      "Laravel requires local vendor/autoload.php within the operator root and inventoried bootstrap/app.php.";
    return check;
  }
  check.scope = ["bootstrap/app.php"];
  check.commands = [
    {
      executable: "php",
      args: [
        "-r",
        laravelRunner,
        autoload,
        JSON.stringify(config),
        source.fingerprint,
      ],
      cwd: project.path,
      env: { APP_ENV: "testing", APP_DEBUG: "false" },
    },
  ];
  return check;
}
