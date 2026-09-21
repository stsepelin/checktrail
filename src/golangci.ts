import { fileURLToPath } from "node:url";
import { goEnvironment, goScopeCommand } from "./go-scope.js";
import type { Check, Inventory, Project } from "./types.js";

export async function golangciCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const configs = project.files.filter((file) =>
    /^\.golangci\.(?:ya?ml|json)$/.test(file),
  );
  const files = project.files.filter((file) => file.endsWith(".go"));
  const check: Check = {
    id: "go.golangci-lint",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "analysis",
    parser: "golangci-json",
    reason:
      "Run configured supported golangci-lint checks with native Go scope, unfiltered JSON evidence and fixes disabled.",
    commands: [
      goScopeCommand(project.path),
      {
        executable: process.execPath,
        args: [
          fileURLToPath(new URL("./golangci-runner.js", import.meta.url)),
          source.root,
          configs[0] ?? "",
          "[]",
          ...files,
        ],
        cwd: project.path,
        env: goEnvironment,
      },
    ],
  };
  if (configs.length !== 1)
    check.unavailableReason =
      "Exactly one project-local .golangci.yml, .yaml or .json is required.";
  else if (!files.length)
    check.unavailableReason = "No Go source was inventoried.";
  return check;
}
