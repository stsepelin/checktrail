import path from "node:path";
import type { Workspace } from "./types.js";

export function validateWorkspace(
  workspace: Workspace,
  projects: string[],
): void {
  const nodes = new Set(projects);
  const seen = new Set<string>();
  for (const edge of workspace.dependencies) {
    if (!nodes.has(edge.consumer) || !nodes.has(edge.producer))
      throw new Error("Workspace dependency names an unconfigured project");
    if (edge.consumer === edge.producer)
      throw new Error("Workspace dependency cannot reference itself");
    const key = JSON.stringify([edge.consumer, edge.producer]);
    if (seen.has(key)) throw new Error("Duplicate workspace dependency");
    seen.add(key);
  }
}

export function affectedProjects(
  projects: string[],
  files: string[],
  workspace?: Workspace,
): { projects: string[]; reason: string; affected: boolean } {
  const all = [...new Set(projects)].sort();
  const fallback = (reason: string) => ({
    projects: all,
    reason,
    affected: false,
  });
  if (!workspace?.complete)
    return fallback("Workspace dependency completeness is not declared.");
  if (!files.length)
    return fallback("No changed paths were found; retaining full validation.");
  const selected = new Set<string>();
  for (const file of files) {
    if (
      path.posix.dirname(file) === "." ||
      file.split("/").some((part) => part.startsWith("."))
    )
      return fallback(
        "Root or hidden configuration changed; impact is global.",
      );
    const owner = all
      .filter((project) => project === "." || file.startsWith(`${project}/`))
      .sort(
        (a, b) => (b === "." ? 0 : b.length) - (a === "." ? 0 : a.length),
      )[0];
    if (!owner)
      return fallback("A changed path has no configured project owner.");
    if (owner === ".")
      return fallback("A root-project change may affect nested projects.");
    selected.add(owner);
  }
  let previous = -1;
  while (previous !== selected.size) {
    previous = selected.size;
    for (const edge of workspace.dependencies)
      if (selected.has(edge.producer)) selected.add(edge.consumer);
  }
  return {
    projects: [...selected].sort(),
    reason:
      "Changed projects and their declared transitive consumers were selected.",
    affected: true,
  };
}
