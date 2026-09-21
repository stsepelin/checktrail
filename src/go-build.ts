import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { goScopePolicySchema } from "./go-scope-policy.js";
import { readProjectFile } from "./inventory.js";
import type { Check, Inventory, Project } from "./types.js";

const nativeCheck = z.enum([
  "go.vet",
  "go.test",
  "go.test-race",
  "go.staticcheck",
  "go.golangci-lint",
]);
export const goBuildTagsSchema = z
  .array(
    z
      .string()
      .max(64)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  )
  .max(32);
export const goBuildSelectionSchema = z.strictObject({
  profile: z
    .string()
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  tags: goBuildTagsSchema,
});
export const goBuildPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  profiles: z
    .array(
      z.strictObject({
        name: goBuildSelectionSchema.shape.profile,
        tags: goBuildTagsSchema,
        checks: z.array(nativeCheck).min(1).max(5),
        excludedFiles: goScopePolicySchema.shape.excludedFiles,
      }),
    )
    .min(1)
    .max(5),
});
export type GoBuildSelection = z.infer<typeof goBuildSelectionSchema>;

export async function applyGoBuildPolicy(
  source: Inventory,
  project: Project,
  checks: Check[],
): Promise<void> {
  const file = path.posix.join(project.path, "checktrail.go-build.json");
  const scoped = checks.filter((check) => check.id !== "go.format");
  try {
    let entry;
    try {
      entry = await lstat(path.join(source.root, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!entry.isFile() || !source.files.includes(file))
      throw new Error("Go build policy must be an inventoried regular file");
    try {
      await lstat(
        path.join(source.root, project.path, "checktrail.go-scope.json"),
      );
      throw new Error(
        "Use either Go build profiles or the module scope policy, not both",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const policy = goBuildPolicySchema.parse(
      JSON.parse(await readProjectFile(source.root, file)),
    );
    const profiles = new Map<string, (typeof policy.profiles)[number]>();
    const names = new Set<string>();
    for (const profile of policy.profiles) {
      if (names.has(profile.name))
        throw new Error("Duplicate Go build profile name");
      names.add(profile.name);
      if (new Set(profile.tags).size !== profile.tags.length)
        throw new Error("Duplicate Go build tag");
      const paths = profile.excludedFiles.map((item) => item.path);
      if (
        new Set(paths).size !== paths.length ||
        paths.some((p) => !project.files.includes(p))
      )
        throw new Error(
          "Go build exclusions must name unique inventoried project files",
        );
      for (const id of profile.checks) {
        if (profiles.has(id))
          throw new Error("A Go check can select only one build profile");
        profiles.set(id, profile);
      }
    }
    for (const check of scoped) {
      const profile = profiles.get(check.id);
      if (!profile) {
        check.unavailableReason = "Selected Go check has no build profile";
        continue;
      }
      check.goBuild = { profile: profile.name, tags: [...profile.tags] };
      check.goScope = {
        schemaVersion: 1,
        excludedFiles: profile.excludedFiles,
      };
      for (const command of check.commands) {
        if (
          command.executable === "go" ||
          command.executable === "staticcheck"
        ) {
          const index = command.args.indexOf("./...");
          if (index < 0) throw new Error("Unsupported Go build command");
          if (profile.tags.length)
            command.args.splice(index, 0, `-tags=${profile.tags.join(",")}`);
        } else if (check.id === "go.golangci-lint") {
          command.args[3] = JSON.stringify(profile.tags);
        } else throw new Error("Unsupported Go build command");
      }
    }
  } catch (error) {
    for (const check of scoped)
      check.unavailableReason =
        error instanceof Error ? error.message : "Invalid Go build policy";
  }
}
