import { stat } from "node:fs/promises";
import path from "node:path";
import { withinRoot } from "./inventory.js";

export async function localTool(
  root: string,
  project: string,
  entry: string,
  installationDirectory = "node_modules",
): Promise<string | undefined> {
  let directory = project;
  for (;;) {
    try {
      const tool = await withinRoot(
        root,
        path.posix.join(directory, installationDirectory, entry),
      );
      if ((await stat(tool)).isFile()) return tool;
    } catch {
      // Only installed tools contained in the configured root are eligible.
    }
    if (directory === ".") return undefined;
    directory = path.posix.dirname(directory);
  }
}
