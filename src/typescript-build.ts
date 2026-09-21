import path from "node:path";
import { fileURLToPath } from "node:url";
import { localTool } from "./local-tool.js";
import type { Check, Inventory, Project } from "./types.js";

export async function typescriptBuildCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const files = source.files
    .filter(
      (file) =>
        (project.path === "." || file.startsWith(project.path + "/")) &&
        /\.(?:[cm]?ts|tsx)$/.test(file),
    )
    .map((file) => path.posix.relative(project.path, file));
  const tool = await localTool(
    source.root,
    project.path,
    "typescript/lib/typescript.js",
  );
  const check: Check = {
    id: "javascript.typescript-build",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "analysis",
    parser: "typescript-build-json",
    reason:
      "Type-check the complete TypeScript solution with fresh in-memory declaration outputs and native source accounting.",
    commands: tool
      ? [
          {
            executable: process.execPath,
            args: [
              fileURLToPath(
                new URL("./typescript-build-runner.js", import.meta.url),
              ),
              tool,
              source.root,
            ],
            cwd: project.path,
          },
        ]
      : [],
  };
  if (!project.files.includes("tsconfig.json"))
    check.unavailableReason = "A project-local tsconfig.json is required.";
  else if (!files.length)
    check.unavailableReason =
      "No TypeScript source was inventoried under the solution root.";
  else if (!tool)
    check.unavailableReason =
      "TypeScript is not installed within the configured root.";
  return check;
}
