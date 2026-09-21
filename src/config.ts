import { validateWorkspace } from "./workspace.js";
import { environmentName } from "./environment.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readProjectFile } from "./inventory.js";
import type { Inventory } from "./types.js";
import {
  loadPolicyPack,
  packReferenceSchema,
  type LoadedPack,
} from "./policy-pack.js";

export const workspaceSchema = z.strictObject({
  complete: z.boolean(),
  dependencies: z
    .array(
      z.strictObject({
        consumer: z.string().min(1),
        producer: z.string().min(1),
      }),
    )
    .max(20_000),
});

export const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspace: workspaceSchema.optional(),
  projects: z
    .array(
      z.strictObject({
        path: z.string().min(1),
        checks: z.array(z.string().min(1)).max(256),
        packs: z.array(packReferenceSchema).max(32).optional(),
        environment: z.array(environmentName).max(64).optional(),
      }),
    )
    .min(1),
});

export type Config = z.infer<typeof configSchema>;

export async function loadConfig(
  source: Inventory,
  overlayPath?: string,
): Promise<{ config: Config | undefined; fingerprint: string }> {
  const legacyNames = new Set([
    "repo-verifier.json",
    ...[
      "actionlint",
      "django",
      "dotnet",
      "fastapi",
      "java",
      "laravel",
      "nuxt",
      "vue-router",
    ].map((profile) => `repo-verifier.${profile}.json`),
  ]);
  const legacy = source.files.find((file) =>
    legacyNames.has(file.split("/").at(-1)!),
  );
  if (legacy)
    throw new Error(
      `Rename legacy configuration ${legacy} to its checktrail filename before validation`,
    );
  const raw = source.files.includes("checktrail.json")
    ? await readProjectFile(source.root, "checktrail.json")
    : undefined;
  const base =
    raw === undefined ? undefined : configSchema.parse(JSON.parse(raw));
  const overlay =
    overlayPath === undefined
      ? undefined
      : configSchema.parse(
          JSON.parse(await readProjectFile(source.root, overlayPath)),
        );
  if (overlay && !base)
    throw new Error("Policy overlays require an explicit base checktrail.json");
  const loaded = new Map<string, string>();
  const cache = new Map<string, LoadedPack>();
  async function resolve(
    input: Config | undefined,
  ): Promise<Config | undefined> {
    if (!input) return undefined;
    const paths = new Set<string>();
    for (const project of input.projects) {
      if (paths.has(project.path))
        throw new Error("Duplicate configured project path");
      paths.add(project.path);
      if (new Set(project.checks).size !== project.checks.length)
        throw new Error("Duplicate check ID");
      if (
        new Set(project.environment).size !== (project.environment?.length ?? 0)
      )
        throw new Error("Duplicate environment requirement");
      const references = new Set<string>();
      for (const reference of project.packs ?? []) {
        const key = JSON.stringify(reference);
        if (!cache.has(key)) {
          if (cache.size >= 64)
            throw new Error("Policy pack reference limit exceeded");
          cache.set(key, await loadPolicyPack(source.root, reference));
        }
        const { pack, sha256 } = cache.get(key)!;
        if (references.has(pack.id))
          throw new Error("Duplicate policy pack ID for project");
        references.add(pack.id);
        if (loaded.has(pack.id) && loaded.get(pack.id) !== sha256)
          throw new Error("Conflicting policy pack versions or contents");
        loaded.set(pack.id, sha256);
        project.checks = [
          ...new Set([...project.checks, ...pack.requiredChecks]),
        ];
        const names = [
          ...new Set([
            ...(project.environment ?? []),
            ...(pack.requiredEnvironment ?? []),
          ]),
        ];
        if (names.length) project.environment = names;
      }
      if (!project.checks.length)
        throw new Error("Project policy has no required checks");
    }
    return input;
  }
  const resolvedBase = await resolve(base);
  const resolvedOverlay = await resolve(overlay);
  const config = resolvedBase ?? resolvedOverlay;
  if (resolvedBase && resolvedOverlay) {
    for (const extra of resolvedOverlay.projects) {
      const existing = resolvedBase.projects.find(
        (project) => project.path === extra.path,
      );
      if (!existing) resolvedBase.projects.push(extra);
      else {
        existing.checks = [...new Set([...existing.checks, ...extra.checks])];
        const names = [
          ...new Set([
            ...(existing.environment ?? []),
            ...(extra.environment ?? []),
          ]),
        ];
        if (names.length) existing.environment = names;
      }
    }
    if (resolvedOverlay.workspace) {
      if (
        resolvedBase.workspace &&
        JSON.stringify(resolvedBase.workspace) !==
          JSON.stringify(resolvedOverlay.workspace)
      )
        throw new Error("Conflicting workspace declarations in policy overlay");
      resolvedBase.workspace = resolvedOverlay.workspace;
    }
  }
  if (config?.workspace)
    validateWorkspace(
      config.workspace,
      config.projects.map((project) => project.path),
    );
  return {
    config: config === undefined ? undefined : configSchema.parse(config),
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          config: config ?? { defaults: 1 },
          packs: [...loaded].sort(),
          overlay: overlayPath ?? null,
        }),
      )
      .digest("hex"),
  };
}
