import { fileURLToPath } from "node:url";
import { localTool } from "./local-tool.js";
import type { Check, Inventory, Project } from "./types.js";

export async function playwrightCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const files = project.files.filter((file) =>
    /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/.test(file),
  );
  const tool = await localTool(
    source.root,
    project.path,
    "playwright/package.json",
  );
  const check: Check = {
    id: "javascript.playwright",
    adapter: project.adapter,
    project: project.path,
    kind: "test",
    parser: "playwright-json",
    scope: files,
    reason:
      "Run installed Playwright with complete native test evidence, focused-test rejection and snapshot updates disabled.",
    commands: tool
      ? [
          {
            executable: process.execPath,
            cwd: project.path,
            args: [
              fileURLToPath(new URL("./playwright-runner.js", import.meta.url)),
              tool,
              source.root,
            ],
            env: { CI: "1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
          },
        ]
      : [],
  };
  if (!files.length)
    check.unavailableReason = "No .test or .spec JS/TS files were inventoried.";
  else if (!tool)
    check.unavailableReason =
      "Playwright is not installed within the configured root.";
  return check;
}
