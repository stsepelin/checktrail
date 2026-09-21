import { localTool } from "./local-tool.js";
import type { Check, Inventory, Project } from "./types.js";

export async function phpstanCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const files = project.files.filter((file) => file.endsWith(".php"));
  const tool = await localTool(
    source.root,
    project.path,
    "phpstan/phpstan/phpstan",
    "vendor",
  );
  const config = [
    "phpstan.neon",
    "phpstan.neon.dist",
    "phpstan.dist.neon",
  ].find((file) => project.files.includes(file));
  const check: Check = {
    id: "php.phpstan",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "analysis",
    parser: "phpstan-json",
    commands:
      tool && config
        ? [
            {
              executable: "php",
              args: [
                tool,
                "analyse",
                "--configuration",
                `./${config}`,
                "--error-format=json",
                "--no-progress",
                "--no-ansi",
                "--debug",
                "--",
                ...files.map((file) => `./${file}`),
              ],
              cwd: project.path,
            },
          ]
        : [],
    reason:
      "Run local PHPStan with native per-file debug accounting, no result-cache reuse and JSON diagnostic totals.",
  };
  if (!files.length) check.unavailableReason = "No PHP files were inventoried.";
  else if (!tool)
    check.unavailableReason =
      "PHPStan is not installed in vendor within the configured root.";
  else if (!config)
    check.unavailableReason =
      "A project-local PHPStan NEON configuration is required.";
  else if (files.some((file) => /[\r\n]/.test(file)))
    check.unavailableReason =
      "PHPStan debug evidence cannot account for filenames containing newlines.";
  return check;
}
