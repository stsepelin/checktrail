import { createHash } from "node:crypto";
import { z } from "zod";
import { environmentName } from "./environment.js";
import { readProjectFile } from "./inventory.js";

export const packReferenceSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const policyPackSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/)
    .max(256),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
    .max(128),
  description: z.string().min(1).max(4096),
  requiredChecks: z.array(z.string().min(1).max(256)).min(1).max(256),
  requiredEnvironment: z.array(environmentName).max(64).optional(),
});
export type PolicyPack = z.infer<typeof policyPackSchema>;
export type PackReference = z.infer<typeof packReferenceSchema>;
export interface LoadedPack {
  pack: PolicyPack;
  sha256: string;
}

export function parsePolicyPack(contents: string): PolicyPack {
  const pack = policyPackSchema.parse(JSON.parse(contents));
  if (
    new Set(pack.requiredChecks).size !== pack.requiredChecks.length ||
    new Set(pack.requiredEnvironment).size !==
      (pack.requiredEnvironment?.length ?? 0)
  )
    throw new Error("Duplicate policy pack requirement");
  return pack;
}

export async function loadPolicyPack(
  root: string,
  input: PackReference,
): Promise<LoadedPack> {
  const reference = packReferenceSchema.parse(input);
  const contents = await readProjectFile(root, reference.path);
  if (Buffer.byteLength(contents) > 64 * 1024)
    throw new Error("Policy pack exceeds 64 KiB limit");
  const sha256 = createHash("sha256").update(contents).digest("hex");
  if (sha256 !== reference.sha256)
    throw new Error("Policy pack integrity mismatch");
  const pack = parsePolicyPack(contents);
  return { pack, sha256 };
}
