import { z } from "zod";
import path from "node:path";
import { readProjectFile } from "./inventory.js";
import { viteLibraryConfigSchema } from "./vite-library-contract.js";
import { nodeLoaderSchema } from "./node-loader-contract.js";
import type { Inventory, Project } from "./types.js";
const eslintProfile = z.strictObject({ sourceParticipation: z.literal(true) });
const nodeProfile = z.strictObject({
  loaders: z.array(nodeLoaderSchema).min(1).max(16),
});
const optionalProfiles = z.strictObject({
  schemaVersion: z.literal(1),
  eslint: eslintProfile.optional(),
  nodeTest: nodeProfile.optional(),
  library: viteLibraryConfigSchema.optional(),
});
export const javascriptConfigSchema = z.union([
  optionalProfiles.extend({ eslint: eslintProfile }),
  optionalProfiles.extend({ nodeTest: nodeProfile }),
  optionalProfiles.extend({ library: viteLibraryConfigSchema }),
]);
export async function javascriptConfiguration(
  source: Inventory,
  project: Project,
) {
  if (!project.files.includes("checktrail.javascript.json")) return undefined;
  return javascriptConfigSchema.parse(
    JSON.parse(
      await readProjectFile(
        source.root,
        path.posix.join(project.path, "checktrail.javascript.json"),
      ),
    ),
  );
}
