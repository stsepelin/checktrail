import { fileURLToPath } from "node:url";
import { localTool } from "./local-tool.js";
import type { Check, Inventory, Project } from "./types.js";

export async function eslintCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const files = project.files.filter((file) =>
    /\.(?:[cm]?[jt]s|[jt]sx|vue)$/.test(file),
  );
  const configs = project.files.filter((file) =>
    /^eslint\.config\.(?:js|mjs|cjs)$/.test(file),
  );
  const tool = await localTool(source.root, project.path, "eslint/lib/api.js");
  const check: Check = {
    id: "javascript.eslint",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "analysis",
    parser: "eslint-json",
    reason:
      "Lint each inventoried JS/TS/Vue file with the project's flat config; require matching configuration and enabled rules for every file.",
    commands:
      tool && configs.length === 1
        ? [
            {
              executable: process.execPath,
              args: [
                fileURLToPath(new URL("./eslint-runner.js", import.meta.url)),
                tool,
                source.root,
                configs[0]!,
                ...files,
              ],
              cwd: project.path,
            },
          ]
        : [],
  };
  if (configs.length !== 1)
    check.unavailableReason =
      "Exactly one project-local eslint.config.js, .mjs or .cjs is required.";
  else if (!files.length)
    check.unavailableReason = "No supported source files were inventoried.";
  else if (!tool)
    check.unavailableReason =
      "No project-local or root-hoisted ESLint installation is available within the configured root.";
  return check;
}
