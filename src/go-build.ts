import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { goScopePolicySchema } from "./go-scope-policy.js";
import { readProjectFile } from "./inventory.js";
import type { Check, Inventory, Project } from "./types.js";

const legacyNativeCheck = z.enum([
  "go.vet",
  "go.test",
  "go.test-race",
  "go.staticcheck",
  "go.golangci-lint",
]);
const nativeCheck = z.enum([...legacyNativeCheck.options, "go.build"]);
const targetName = z.string().regex(/^[a-z][a-z0-9]{0,15}$/);
export const goTargetSchema = z.strictObject({
  os: targetName,
  arch: targetName,
  cgo: z.boolean(),
});
export const goTargetEvidenceSchema = goTargetSchema.extend({
  hostOs: targetName,
  hostArch: targetName,
});
export const executionIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const goRepetitionSchema = z.strictObject({
  iteration: z.number().int().min(1).max(16),
  total: z.number().int().min(1).max(16),
});
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
  repetition: goRepetitionSchema.optional(),
  target: goTargetSchema.optional(),
});
const profileShape = {
  name: goBuildSelectionSchema.shape.profile,
  tags: goBuildTagsSchema,
  excludedFiles: goScopePolicySchema.shape.excludedFiles,
};
export const goBuildPolicySchema = z.discriminatedUnion("schemaVersion", [
  z.strictObject({
    schemaVersion: z.literal(1),
    profiles: z
      .array(
        z.strictObject({
          ...profileShape,
          checks: z.array(legacyNativeCheck).min(1).max(5),
        }),
      )
      .min(1)
      .max(5),
  }),
  z.strictObject({
    schemaVersion: z.literal(2),
    profiles: z
      .array(
        z.strictObject({
          ...profileShape,
          checks: z.array(nativeCheck).min(1).max(6),
          repetitions: z.number().int().min(1).max(16),
          target: goTargetSchema.optional(),
        }),
      )
      .min(1)
      .max(16),
  }),
]);
export type GoBuildSelection = z.infer<typeof goBuildSelectionSchema>;
export type GoTargetEvidence = z.infer<typeof goTargetEvidenceSchema>;

// Keep source content out of this stable execution identity so a baseline can
// compare revisions. The enclosing report binds the actual source fingerprint.
export function goExecutionGroup(
  check: Pick<Check, "id" | "project" | "scope"> & {
    goBuild?: GoBuildSelection | undefined;
    goScope?: Check["goScope"] | undefined;
    goWorkspace?: Check["goWorkspace"] | undefined;
  },
): string {
  return JSON.stringify([
    check.project,
    check.id,
    check.scope,
    check.goBuild?.profile,
    check.goBuild?.tags,
    check.goScope,
    check.goBuild?.target ?? null,
    check.goBuild?.repetition?.total,
    ...(check.goWorkspace
      ? [
          [
            check.goWorkspace.file,
            check.goWorkspace.modules.map(({ directory, module, role }) => [
              directory,
              module,
              role,
            ]),
          ],
        ]
      : []),
  ]);
}
export function goExecutionId(
  check: Parameters<typeof goExecutionGroup>[0],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        goExecutionGroup(check),
        check.goBuild?.repetition?.iteration,
      ]),
    )
    .digest("hex");
}

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
    const names = new Set<string>();
    const assigned = new Set<string>();
    let count = 0;
    for (const profile of policy.profiles) {
      if (names.has(profile.name))
        throw new Error("Duplicate Go build profile name");
      names.add(profile.name);
      if (new Set(profile.tags).size !== profile.tags.length)
        throw new Error("Duplicate Go build tag");
      if (new Set(profile.checks).size !== profile.checks.length)
        throw new Error("Duplicate Go check within a build profile");
      const paths = profile.excludedFiles.map((item) => item.path);
      if (
        new Set(paths).size !== paths.length ||
        paths.some((p) => !project.files.includes(p))
      )
        throw new Error(
          "Go build exclusions must name unique inventoried project files",
        );
      count +=
        profile.checks.length *
        ("repetitions" in profile ? profile.repetitions : 1);
      for (const id of profile.checks) {
        if (policy.schemaVersion === 1 && assigned.has(id))
          throw new Error("A Go check can select only one build profile");
        assigned.add(id);
      }
    }
    if (count > 128)
      throw new Error(
        "Go build policy exceeds 128 required executions per module",
      );
    // Stage the complete expansion. An invalid later profile must not leave any
    // earlier check with partially rewritten arguments, targets or exclusions.
    const expanded: Check[] = [];
    for (const original of checks) {
      if (original.id === "go.format") {
        expanded.push(original);
        continue;
      }
      const profiles = policy.profiles.filter((profile) =>
        profile.checks.some((id) => id === original.id),
      );
      if (!profiles.length) {
        expanded.push({
          ...original,
          unavailableReason: "Selected Go check has no build profile",
        });
        continue;
      }
      for (const profile of profiles) {
        const total = "repetitions" in profile ? profile.repetitions : 1;
        for (let iteration = 1; iteration <= total; iteration++) {
          const check = structuredClone(original);
          const target = "target" in profile ? profile.target : undefined;
          check.goBuild = {
            profile: profile.name,
            tags: [...profile.tags],
            ...(policy.schemaVersion === 2
              ? { repetition: { iteration, total } }
              : {}),
            ...(target ? { target } : {}),
          };
          check.goScope = {
            schemaVersion: 1,
            excludedFiles: profile.excludedFiles.filter((item) =>
              check.scope.includes(item.path),
            ),
          };
          for (const command of check.commands) {
            if (
              command.executable === "go" ||
              command.executable === "staticcheck"
            ) {
              const index = command.args.indexOf("./...");
              if (index < 0) throw new Error("Unsupported Go build command");
              if (profile.tags.length)
                command.args.splice(
                  index,
                  0,
                  `-tags=${profile.tags.join(",")}`,
                );
            } else if (check.id === "go.golangci-lint")
              command.args[3] = JSON.stringify(profile.tags);
            else if (check.id === "go.build")
              command.args[1] = JSON.stringify(profile.tags);
            else throw new Error("Unsupported Go build command");
            if (target)
              command.env = {
                ...command.env,
                GOOS: target.os,
                GOARCH: target.arch,
                CGO_ENABLED: target.cgo ? "1" : "0",
              };
          }
          if (target) {
            if (check.id === "go.test-race" && !target.cgo)
              check.unavailableReason =
                "The Go race check requires a cgo-enabled target";
            const env = check.commands[0]!.env;
            check.commands.unshift(
              {
                executable: "go",
                args: [
                  "env",
                  "-json",
                  "GOOS",
                  "GOARCH",
                  "GOHOSTOS",
                  "GOHOSTARCH",
                  "CGO_ENABLED",
                ],
                cwd: project.path,
                ...(env ? { env } : {}),
              },
              {
                executable: "go",
                args: ["tool", "dist", "list", "-json"],
                cwd: project.path,
                ...(env ? { env } : {}),
              },
            );
          }
          if (policy.schemaVersion === 2)
            check.executionId = goExecutionId(check);
          expanded.push(check);
        }
      }
    }
    checks.splice(0, checks.length, ...expanded);
  } catch (error) {
    for (const check of scoped)
      check.unavailableReason =
        error instanceof Error ? error.message : "Invalid Go build policy";
  }
}
