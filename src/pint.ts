import { localTool } from "./local-tool.js";
import { pintRunner } from "./pint-runner.js";
import type { Check, Inventory, Project } from "./types.js";

export async function pintCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const files = project.files.filter(
    (file) => file.endsWith(".php") && !file.endsWith(".blade.php"),
  );
  const tool = await localTool(
    source.root,
    project.path,
    "laravel/pint/builds/pint",
    "vendor",
  );
  const check: Check = {
    id: "php.pint",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "format",
    parser: "pint-json",
    commands: tool
      ? [
          {
            executable: "php",
            args: [
              "-r",
              pintRunner,
              "--",
              tool,
              ...files.map((file) => `./${file}`),
            ],
            cwd: project.path,
            temporaryDirectory: true,
          },
        ]
      : [],
    reason:
      "Run Pint on non-Blade PHP files in test mode with native file and active-rule evidence and no reusable cache.",
  };
  if (!files.length)
    check.unavailableReason = "No non-Blade PHP files were inventoried.";
  else if (!tool)
    check.unavailableReason =
      "Pint is not installed in vendor within the configured root.";
  return check;
}
