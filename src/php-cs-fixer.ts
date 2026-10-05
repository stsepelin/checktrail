import { localTool } from "./local-tool.js";
import { phpCsFixerRunner } from "./php-cs-fixer-runner.js";
import type { Check, Inventory, Project } from "./types.js";

export async function phpCsFixerCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const configurations = [".php-cs-fixer.php", ".php-cs-fixer.dist.php"];
  const files = project.files.filter(
    (file) =>
      file.endsWith(".php") &&
      !file.endsWith(".blade.php") &&
      !configurations.includes(file),
  );
  const config = configurations.find((file) => project.files.includes(file));
  const autoload = await localTool(
    source.root,
    project.path,
    "autoload.php",
    "vendor",
  );
  const installed = await localTool(
    source.root,
    project.path,
    "friendsofphp/php-cs-fixer/src/Console/Application.php",
    "vendor",
  );
  const check: Check = {
    id: "php.php-cs-fixer",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "format",
    parser: "php-cs-fixer-json",
    commands:
      autoload && installed && config
        ? [
            {
              executable: "php",
              args: [
                "-r",
                phpCsFixerRunner,
                "--",
                autoload,
                `./${config}`,
                ...files.map((file) => `./${file}`),
              ],
              cwd: project.path,
            },
          ]
        : [],
    reason:
      "Run pinned local PHP-CS-Fixer in sequential dry-run mode with no cache; configuration and Blade files are outside formatting scope, and excluded or skipped native files remain incomplete.",
  };
  if (!files.length)
    check.unavailableReason =
      "No non-Blade, non-configuration PHP files were inventoried.";
  else if (!autoload || !installed)
    check.unavailableReason =
      "PHP-CS-Fixer and its Composer autoloader are not installed within the configured root.";
  else if (!config)
    check.unavailableReason =
      "A project-local PHP-CS-Fixer configuration is required.";
  return check;
}
