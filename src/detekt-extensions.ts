import path from "node:path";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
import { kotlinArtifacts } from "./kotlin-artifacts.js";
import { kotlinConfigSchema } from "./kotlin.js";
export const detektFullPrerequisitesSchema = z.strictObject({
  profile: z.literal("linux-arm64-full-types-v1"),
  kotlinArchive: externalPathSchema,
  kotlinSha256: z.literal(kotlinArtifacts.archiveSha256),
  jvmTarget: z.enum(["17", "21", "25"]),
  classPath: kotlinConfigSchema.shape.classPath,
});
export type DetektFullPrerequisites = z.infer<
  typeof detektFullPrerequisitesSchema
>;
export function validateDetektFullScope(scope: string[]) {
  if (
    !scope.length ||
    scope.length > 2000 ||
    new Set(scope).size !== scope.length ||
    scope.some((file) => !file.endsWith(".kt") || /[:;\r\n\0]/.test(file))
  )
    throw Error(
      "Full detekt type analysis requires unique selected Kotlin sources; scripts need a separate profile",
    );
}
export function detektFullCompilerConfig(p: DetektFullPrerequisites) {
  return {
    schemaVersion: 1 as const,
    archive: p.kotlinArchive,
    sha256: p.kotlinSha256,
    profile: kotlinArtifacts.profile,
    jvmTarget: p.jvmTarget,
    warningsAsErrors: false,
    classPath: p.classPath,
  };
}
export const detektFullConfigFile = (root: string, project: string) =>
  path.resolve(root, project, "checktrail.detekt.json");
