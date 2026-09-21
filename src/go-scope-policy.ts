import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readProjectFile } from "./inventory.js";
import type { Check, Inventory, Project } from "./types.js";

export const goScopePolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  excludedFiles: z
    .array(
      z.strictObject({
        path: z
          .string()
          .max(4096)
          .regex(
            /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*[\\*?[\]{}])[\u0020-\u007e\u0080-\uffff]+\.go$/,
          ),
        reason: z.string().min(1).max(1000).regex(/\S/),
      }),
    )
    .max(1000),
});

export type GoScopePolicy = z.infer<typeof goScopePolicySchema>;

export async function applyGoScopePolicy(
  source: Inventory,
  project: Project,
  checks: Check[],
): Promise<void> {
  const file = path.posix.join(project.path, "checktrail.go-scope.json");
  const scoped = checks.filter((check) => check.id !== "go.format");
  try {
    let entry;
    try {
      entry = await lstat(path.join(source.root, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      source.excluded.includes(file)
    )
      throw new Error("Go scope policy must be an inventoried regular file");
    if (!source.files.includes(file))
      throw new Error("Go scope policy is not inventoried");
    const policy = goScopePolicySchema.parse(
      JSON.parse(await readProjectFile(source.root, file)),
    );
    const paths = policy.excludedFiles.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length)
      throw new Error("Duplicate Go scope exclusion");
    if (paths.some((file) => !project.files.includes(file)))
      throw new Error(
        "Go scope exclusions must name inventoried project files",
      );
    for (const check of scoped) check.goScope = policy;
  } catch (error) {
    for (const check of scoped)
      check.unavailableReason =
        error instanceof Error ? error.message : "Invalid Go scope policy";
  }
}
