import { fileURLToPath } from "node:url";
import { localTool } from "./local-tool.js";
import type { Check, Inventory, Project } from "./types.js";

export async function typescriptCheck(
  source: Inventory,
  project: Project,
  vue = false,
): Promise<Check> {
  const files = project.files.filter(
    (file) => /\.(?:[cm]?ts|tsx)$/.test(file) || (vue && file.endsWith(".vue")),
  );
  const compiler = await localTool(
    source.root,
    project.path,
    vue ? "vue-tsc/index.js" : "typescript/bin/tsc",
  );
  const check: Check = {
    id: vue ? "javascript.vue-tsc" : "javascript.typescript",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "analysis",
    parser: "tsc-files",
    reason:
      "Type-check tsconfig.json without emitting code or incremental state; require every inventoried TypeScript file in the compiler file list.",
    commands: compiler
      ? [
          {
            executable: process.execPath,
            args: [
              fileURLToPath(
                new URL(
                  vue ? "./vue-tsc-runner.js" : "./typescript-runner.js",
                  import.meta.url,
                ),
              ),
              compiler,
              source.root,
              "--project",
              "./tsconfig.json",
              "--noEmit",
              "--pretty",
              "false",
              "--incremental",
              "false",
              "--listFiles",
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
      "No supported TypeScript or Vue source files were inventoried.";
  else if (files.some((file) => /[\r\n]/.test(file)))
    check.unavailableReason =
      "The compiler file-list format cannot account for filenames containing newlines.";
  else if (!compiler)
    check.unavailableReason =
      "The selected compiler is not installed within the configured root.";
  return check;
}
