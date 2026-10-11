import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { helmProtectedEnvironment, helmRequire } from "./helm.js";
import { helmExtensionsCurrent } from "./helm-extensions-physical.js";
import type { Check, Inventory, Project } from "./types.js";
export async function helmExtensionsCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "infrastructure.helm-extensions",
    adapter: "infrastructure",
    project: project.path,
    scope: project.files,
    kind: "analysis",
    parser: "helm-extensions-json",
    commands: [],
    reason:
      "Native local application/subchart alias graphs, values constraints and physical/rendered Go-template diagnostics; no dependency fetching or cluster access.",
  };
  try {
    const current = helmExtensionsCurrent(path.join(source.root, project.path)),
      prefix = project.path === "." ? "" : project.path + "/";
    helmRequire(
      isDeepStrictEqual(
        current.files,
        source.files
          .filter((f) => f.startsWith(prefix))
          .map((f) => f.slice(prefix.length)),
      ),
      "Planning inventory and current physical chart differ",
    );
    const invocation = JSON.stringify(current.invocation);
    helmRequire(Buffer.byteLength(invocation) <= 96 * 1024, "Invocation bound");
    check.scope = current.files;
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./helm-extensions-runner.js", import.meta.url)),
        source.root,
        invocation,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: {
        ...Object.fromEntries(helmProtectedEnvironment.map((k) => [k, ""])),
        NODE_OPTIONS: "",
        NODE_PATH: "",
        PATH: process.env.PATH ?? "",
      },
    });
  } catch {
    check.unavailableReason =
      "Helm extension source is invalid incomplete or outside the declared local application/subchart and line-preserving template profile.";
  }
  return check;
}
