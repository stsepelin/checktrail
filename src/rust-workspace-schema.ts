import { z } from "zod";
import { rustBuildSelectionSchema } from "./rust-build.js";
import {
  rustTestNativeSchema,
  rustTestTargetSchema,
} from "./rust-test-native.js";
import { rustTestProcessSchema } from "./rust-test-events.js";
export const rustWorkspaceTargetSchema = rustTestTargetSchema.extend({
  "required-features": z.array(z.string()).optional(),
});
export const rustWorkspaceMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  manifest_path: z.string(),
  targets: z.array(rustWorkspaceTargetSchema).min(1).max(100),
  features: z.record(z.string(), z.array(z.string())),
});
export const rustWorkspaceMetadataSchema = z.object({
  version: z.literal(1),
  workspace_root: z.string(),
  target_directory: z.string(),
  build_directory: z.string(),
  workspace_members: z.array(z.string()).min(1).max(32),
  packages: z.array(rustWorkspaceMemberSchema).max(1000),
  resolve: z.object({
    nodes: z
      .array(z.object({ id: z.string(), features: z.array(z.string()) }))
      .max(1000),
  }),
});
export const rustWorkspaceInputSchema = z.strictObject({
  version: z.literal(1),
  root: z.string(),
  project: z.string(),
  mode: z.enum(["check", "clippy", "test"]),
  selection: rustBuildSelectionSchema,
  scope: z.array(z.string()).min(1).max(1000),
});
export const rustWorkspacePacketSchema = z.strictObject({
  version: z.literal(4),
  mode: z.enum(["check", "clippy", "test"]),
  selection: rustBuildSelectionSchema,
  cargoVersion: z.literal("1.98.1"),
  rustcVersion: z.literal("1.98.1"),
  clippyVersion: z.literal("0.1.98").nullable(),
  rustdocVersion: z.literal("1.98.1").nullable(),
  project: z.string(),
  hostTarget: z.string(),
  metadata: rustWorkspaceMetadataSchema,
  execution: rustTestProcessSchema,
  observedSources: z.array(z.string()).max(20000),
  depInfoCount: z.number().int().nonnegative().max(20000),
  scopeError: z.boolean(),
  tests: rustTestNativeSchema.nullable(),
  documentation: z
    .strictObject({
      listed: rustTestProcessSchema,
      ignoredListed: rustTestProcessSchema,
      execution: rustTestProcessSchema,
    })
    .nullable(),
});
