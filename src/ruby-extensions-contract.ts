import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";

const identifier = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
  .max(128);
const gemName = z
  .string()
  .regex(/^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/)
  .max(128);
export const rubyExtensionsPolicySchema = z.strictObject({
  profile: z.literal("declared-manifests-shared-and-inherited-v1"),
  manifests: z.array(externalPathSchema).min(1).max(64),
  rspecHooks: z
    .array(
      z.strictObject({
        kind: z.enum(["before", "after", "around"]),
        scope: z.enum(["example", "context"]),
        file: externalPathSchema,
        line: z.number().int().positive().max(1000000),
        registrations: z.number().int().positive().max(20000),
        invocations: z.number().int().positive().max(100000),
      }),
    )
    .max(512),
  dependencies: z
    .array(
      z.strictObject({
        name: gemName,
        version: z.string().regex(/^[0-9]+(?:\.[0-9]+){1,3}$/),
        groups: z.array(identifier).min(1).max(32),
        platforms: z
          .array(z.enum(["ruby", "mri", "jruby", "windows", "truffleruby"]))
          .max(16),
        included: z.boolean(),
        platformMatches: z.boolean(),
      }),
    )
    .min(1)
    .max(512),
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const location = z.strictObject({
  file: externalPathSchema,
  line: z.number().int().positive().max(1000000),
});
export const rubyExtensionsManifestWitnessSchema = z.strictObject({
  sources: z.array(z.string().min(1).max(8192)).min(1).max(64),
  manifests: z
    .array(z.strictObject({ file: externalPathSchema, sha256: digest }))
    .min(1)
    .max(64),
  dependencies: z
    .array(
      z.strictObject({
        name: gemName,
        requirement: z.string().max(256),
        groups: z.array(identifier).min(1).max(32),
        platforms: z.array(identifier).max(16),
        included: z.boolean(),
        platformMatches: z.boolean(),
        source: z.string().max(8192).nullable(),
      }),
    )
    .min(1)
    .max(512),
});
export const rubyExtensionsCaseWitnessSchema = z.strictObject({
  id: z.string().min(1).max(8192),
  receiverFile: externalPathSchema,
  receiver: z.string().min(1).max(8192),
  declaring: z.string().min(1).max(8192),
  method: z.string().min(1).max(8192),
  source: location,
  ancestors: z.array(z.string().min(1).max(8192)).min(1).max(64),
  shared: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(8192),
        inclusion: location,
      }),
    )
    .max(64),
});
export const rubyExtensionsHookWitnessSchema = z.strictObject({
  caseId: z.string().min(1).max(8192),
  kind: z.enum(["before", "after", "around"]),
  source: location,
  entered: z.boolean(),
  returned: z.boolean(),
});
export const rubyExtensionsRuntimeWitnessSchema = z.strictObject({
  manifest: rubyExtensionsManifestWitnessSchema,
  cases: z.array(rubyExtensionsCaseWitnessSchema).max(20000),
  registeredHooks: z
    .array(
      z.strictObject({
        kind: z.enum(["before", "after", "around"]),
        scope: z.enum(["example", "context"]),
        source: location,
      }),
    )
    .max(512),
  hooks: z.array(rubyExtensionsHookWitnessSchema).max(100000),
});
