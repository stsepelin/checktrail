import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readProjectFile } from "./inventory.js";
import type { Check, Inventory, Project } from "./types.js";
const relative = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)
  .refine(
    (s) => s === "." || s.split("/").every((v) => v !== "." && v !== ".."),
  );
const excluded = z.strictObject({
  path: relative,
  reason: z.string().trim().min(1).max(500),
});
const selection = {
  features: z
    .array(
      z
        .string()
        .max(128)
        .regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/),
    )
    .max(64),
  defaultFeatures: z.boolean(),
  target: z
    .string()
    .max(128)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)+$/)
    .nullable(),
  excludedSources: z.array(excluded).max(1000),
};
export const rustBuildSelectionSchema = z.strictObject({
  profile: z
    .string()
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  workspaceMembers: z.array(relative).min(1).max(32),
  ...selection,
});
export const rustBuildPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceMembers: rustBuildSelectionSchema.shape.workspaceMembers,
  profiles: z
    .array(
      z.strictObject({
        name: rustBuildSelectionSchema.shape.profile,
        checks: z
          .array(
            z.enum([
              "rust.cargo-check",
              "rust.cargo-clippy",
              "rust.cargo-test",
            ]),
          )
          .min(1)
          .max(3),
        ...selection,
      }),
    )
    .min(1)
    .max(16),
});
export type RustBuildSelection = z.infer<typeof rustBuildSelectionSchema>;
export function rustExecutionId(
  check: Pick<Check, "id" | "project" | "scope"> & {
    rustBuild?: RustBuildSelection | undefined;
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([check.project, check.id, check.scope, check.rustBuild]),
    )
    .digest("hex");
}
export function rustCargoSelection(selection: RustBuildSelection): string[] {
  return [
    "--workspace",
    ...(!selection.defaultFeatures ? ["--no-default-features"] : []),
    ...(selection.features.length
      ? ["--features", selection.features.join(",")]
      : []),
    ...(selection.target ? ["--target", selection.target] : []),
  ];
}
export async function applyRustBuildPolicy(
  source: Inventory,
  project: Project,
  checks: Check[],
): Promise<void> {
  const file = path.posix.join(project.path, "checktrail.rust-build.json");
  const scoped = checks.filter((c) => c.id !== "rust.cargo-fmt");
  try {
    let entry;
    try {
      entry = await lstat(path.join(source.root, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!entry.isFile() || !source.files.includes(file))
      throw Error("Rust build policy must be an inventoried regular file");
    const policy = rustBuildPolicySchema.parse(
      JSON.parse(await readProjectFile(source.root, file)),
    );
    const prefix = project.path === "." ? "" : project.path + "/";
    const scope = source.files
      .filter((f) => f.startsWith(prefix) && f.endsWith(".rs"))
      .map((f) => f.slice(prefix.length))
      .sort();
    if (!scope.length || scope.length > 1000)
      throw Error(
        "Rust workspace profiles require one to 1000 inventoried source files",
      );
    if (
      new Set(policy.workspaceMembers).size !==
        policy.workspaceMembers.length ||
      policy.workspaceMembers.some(
        (m) =>
          !source.files.includes(
            path.posix.join(project.path, m, "Cargo.toml"),
          ),
      )
    )
      throw Error(
        "Rust workspace members must name unique inventoried manifests",
      );
    const names = new Set<string>();
    for (const profile of policy.profiles) {
      if (names.has(profile.name))
        throw Error("Duplicate Rust build profile name");
      names.add(profile.name);
      if (
        new Set(profile.features).size !== profile.features.length ||
        new Set(profile.checks).size !== profile.checks.length
      )
        throw Error("Duplicate Rust features or checks in a profile");
      const excluded = profile.excludedSources.map((e) => e.path);
      if (
        new Set(excluded).size !== excluded.length ||
        excluded.some((f) => !scope.includes(f))
      )
        throw Error(
          "Rust exclusions must name unique inventoried source files",
        );
    }
    const expanded: Check[] = [];
    for (const original of checks) {
      if (original.id === "rust.cargo-fmt") {
        expanded.push(original);
        continue;
      }
      const profiles = policy.profiles.filter((p) =>
        p.checks.some((id) => id === original.id),
      );
      if (!profiles.length) {
        expanded.push({
          ...original,
          unavailableReason: "Selected Rust check has no build profile",
        });
        continue;
      }
      for (const profile of profiles) {
        const check = structuredClone(original);
        check.scope = [...scope];
        check.rustBuild = {
          profile: profile.name,
          workspaceMembers: [...policy.workspaceMembers],
          features: [...profile.features],
          defaultFeatures: profile.defaultFeatures,
          target: profile.target,
          excludedSources: profile.excludedSources,
        };
        delete check.unavailableReason;
        if (!project.files.includes("Cargo.lock"))
          check.unavailableReason =
            "Rust workspace validation requires an existing root Cargo.lock";
        if (
          [source.root, project.path, ...scope].some((f) =>
            /[\r\n\\$#:]/.test(f),
          )
        )
          check.unavailableReason = "Unsupported Rust dep-info source path";
        check.commands[0]!.args = [
          fileURLToPath(new URL("./rust-workspace-runner.js", import.meta.url)),
          JSON.stringify({
            version: 1,
            root: source.root,
            project: project.path,
            mode:
              original.id === "rust.cargo-test"
                ? "test"
                : original.id === "rust.cargo-clippy"
                  ? "clippy"
                  : "check",
            selection: check.rustBuild,
            scope,
          }),
        ];
        check.executionId = rustExecutionId(check);
        check.reason =
          "Check every declared Cargo workspace member using the explicit feature/target profile and fresh offline locked native evidence; exact exclusions are checked for staleness.";
        expanded.push(check);
      }
    }
    checks.splice(0, checks.length, ...expanded);
  } catch (error) {
    for (const check of scoped)
      check.unavailableReason =
        error instanceof Error ? error.message : "Invalid Rust build policy";
  }
}
