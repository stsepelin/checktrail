import { fileURLToPath } from "node:url";
import { localTool } from "./local-tool.js";
import type { Check, Inventory, Project } from "./types.js";

export async function pyrightCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const files = project.files.filter((file) => /\.pyi?$/.test(file));
  const compiler = await localTool(
    source.root,
    project.path,
    "pyright/index.js",
  );
  const config = ["pyrightconfig.json", "pyproject.toml"].find((file) =>
    project.files.includes(file),
  );
  const check: Check = {
    id: "python.pyright",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "analysis",
    parser: "pyright-json",
    reason:
      "Run a pinned local Pyright with native file-selection and diagnostic reconciliation; refuse clean completion for suppressed or unaccounted source.",
    commands:
      compiler && config
        ? [
            {
              executable: process.execPath,
              args: [
                fileURLToPath(new URL("./pyright-runner.js", import.meta.url)),
                compiler,
                source.root,
                config,
                ...files,
              ],
              cwd: project.path,
              env: { PYTHONDONTWRITEBYTECODE: "1" },
            },
          ]
        : [],
  };
  if (!files.length)
    check.unavailableReason =
      "No Python source or stub files were inventoried.";
  else if (!config)
    check.unavailableReason =
      "A project-local pyrightconfig.json or pyproject.toml is required.";
  else if (!compiler)
    check.unavailableReason =
      "Pyright is not installed within the configured root.";
  else if (files.some((file) => /[\r\n*?[\]]/.test(file)))
    check.unavailableReason =
      "Pyright's native file specifications cannot account for filenames containing newlines or glob characters.";
  return check;
}
