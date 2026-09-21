import { fileURLToPath } from "node:url";
import { localTool } from "./local-tool.js";
import type { Check, Inventory, Project } from "./types.js";

export async function jestCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const files = project.files.filter((file) =>
    /(?:\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$|(?:^|\/)__tests__\/.*\.(?:[cm]?[jt]s|[jt]sx)$)/.test(
      file,
    ),
  );
  const tool = await localTool(
    source.root,
    project.path,
    "jest/build/index.js",
  );
  const check: Check = {
    id: "javascript.jest",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "test",
    parser: "jest-json",
    reason:
      "Run installed Jest once and account for every planned test file; require passing non-skipped assertions and consistent native JSON evidence.",
    commands: tool
      ? [
          {
            executable: process.execPath,
            args: [
              fileURLToPath(new URL("./jest-runner.js", import.meta.url)),
              tool,
              source.root,
              ...files,
            ],
            cwd: project.path,
            env: { CI: "1" },
          },
        ]
      : [],
  };
  if (!files.length)
    check.unavailableReason = "No .test or .spec JS/TS files were inventoried.";
  else if (!tool)
    check.unavailableReason =
      "Jest is not installed within the configured root.";
  return check;
}
