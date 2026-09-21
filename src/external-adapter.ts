import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withinRoot } from "./inventory.js";
import type { Check, Inventory, Project } from "./types.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const relativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !path.posix.isAbsolute(value) &&
      path.posix.normalize(value) === value &&
      value !== "." &&
      value !== ".." &&
      !value.startsWith("../") &&
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 &&
          character.charCodeAt(0) !== 127 &&
          character !== "\\",
      ),
  );
export const externalReferenceSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => path.isAbsolute(value) && !value.includes("\0")),
  sha256,
});
export const externalReferencesSchema = z.array(externalReferenceSchema).max(8);
export const externalIdentitySchema = z.strictObject({
  id: z.string().regex(/^external\.[a-z][a-z0-9-]{0,63}$/),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
    .max(128),
  sha256,
});
export const externalManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: externalIdentitySchema.shape.id,
  version: externalIdentitySchema.shape.version,
  description: z.string().min(1).max(4096),
  runtime: z.enum(["node", "python3", "php", "native"]),
  entry: relativePath,
  files: z
    .array(z.strictObject({ path: relativePath, sha256 }))
    .min(1)
    .max(512),
  markers: z
    .array(
      z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,128}$/)
        .refine((value) => value !== "." && value !== ".."),
    )
    .min(1)
    .max(32),
  checks: z
    .array(
      z.strictObject({
        id: identifier,
        kind: z.enum(["analysis", "syntax", "format", "test"]),
        description: z.string().min(1).max(4096),
        failOn: z.enum(["error", "warning"]),
        scope: z.strictObject({
          extensions: z
            .array(z.string().regex(/^\.[A-Za-z0-9_.-]{1,64}$/))
            .max(32),
          names: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/)).max(32),
        }),
      }),
    )
    .min(1)
    .max(32),
});
export type ExternalReference = z.infer<typeof externalReferenceSchema>;
export type ExternalIdentity = z.infer<typeof externalIdentitySchema>;
export interface ExternalAdapter {
  reference: ExternalReference;
  identity: ExternalIdentity;
  manifest: z.infer<typeof externalManifestSchema>;
  contents: Map<string, Buffer>;
}
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

export async function loadExternalAdapter(
  input: ExternalReference,
  retainBytes = false,
): Promise<ExternalAdapter> {
  const reference = externalReferenceSchema.parse(input);
  const directory = await realpath(path.dirname(reference.path));
  const manifestFile = path.join(directory, path.basename(reference.path));
  const manifestInfo = await lstat(manifestFile);
  if (!manifestInfo.isFile() || manifestInfo.size > 256 * 1024)
    throw new Error(
      "External adapter manifest must be a regular file within 256 KiB",
    );
  const bytes = await readFile(manifestFile);
  if (bytes.length > 256 * 1024 || hash(bytes) !== reference.sha256)
    throw new Error("External adapter manifest integrity mismatch");
  const manifest = externalManifestSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (
    new Set(manifest.files.map((file) => file.path)).size !==
      manifest.files.length ||
    new Set(manifest.markers).size !== manifest.markers.length ||
    new Set(manifest.checks.map((check) => check.id)).size !==
      manifest.checks.length
  )
    throw new Error("Duplicate external adapter declarations");
  if (!manifest.files.some((file) => file.path === manifest.entry))
    throw new Error("External adapter entry must be a pinned file");
  for (const check of manifest.checks) {
    if (!check.scope.extensions.length && !check.scope.names.length)
      throw new Error(
        "External checks require an explicit nonempty scope selector",
      );
    if (
      new Set(check.scope.extensions).size !== check.scope.extensions.length ||
      new Set(check.scope.names).size !== check.scope.names.length
    )
      throw new Error("Duplicate external scope selector");
  }
  const contents = new Map<string, Buffer>();
  let total = 0;
  for (const file of manifest.files) {
    const resolved = await withinRoot(directory, file.path);
    if (
      resolved !== path.resolve(directory, file.path) ||
      resolved === manifestFile
    )
      throw new Error(
        "External adapter files must be separate regular files without symbolic links",
      );
    const info = await lstat(resolved);
    if (!info.isFile() || info.size > 32 * 1024 * 1024)
      throw new Error("External adapter file exceeds 32 MiB");
    const content = await readFile(resolved);
    total += content.length;
    if (content.length > 32 * 1024 * 1024 || total > 128 * 1024 * 1024)
      throw new Error("External adapter bundle exceeds byte limits");
    if (hash(content) !== file.sha256)
      throw new Error("External adapter file integrity mismatch");
    if (retainBytes) contents.set(file.path, content);
  }
  return {
    reference: { path: manifestFile, sha256: reference.sha256 },
    manifest,
    identity: {
      id: manifest.id,
      version: manifest.version,
      sha256: reference.sha256,
    },
    contents,
  };
}

export async function loadExternalAdapters(
  inputs: ExternalReference[] = [],
): Promise<ExternalAdapter[]> {
  const result: ExternalAdapter[] = [];
  for (const reference of externalReferencesSchema.parse(inputs)) {
    const adapter = await loadExternalAdapter(reference);
    if (result.some((item) => item.identity.id === adapter.identity.id))
      throw new Error("Duplicate external adapter identity");
    result.push(adapter);
  }
  return result;
}
export function externalPolicyFingerprint(
  policy: string,
  adapters: ExternalAdapter[],
): string {
  return adapters.length
    ? hash(
        JSON.stringify([
          policy,
          adapters
            .map((item) => item.identity)
            .sort((a, b) => a.id.localeCompare(b.id, "en")),
        ]),
      )
    : policy;
}
export function externalScope(
  project: Project,
  check: ExternalAdapter["manifest"]["checks"][number],
): string[] {
  return project.files.filter(
    (file) =>
      check.scope.names.includes(path.posix.basename(file)) ||
      check.scope.extensions.some((extension) => file.endsWith(extension)),
  );
}
export const externalInvocationSchema = z.strictObject({
  reference: externalReferenceSchema,
  identity: externalIdentitySchema,
  project: z.string(),
  runtime: z.enum(["node", "python3", "php", "native"]),
  checkId: z.string(),
  kind: z.enum(["analysis", "syntax", "format", "test"]),
  failOn: z.enum(["error", "warning"]),
  scope: z
    .array(relativePath)
    .min(1)
    .max(20_000)
    .refine((files) => new Set(files).size === files.length),
  sourceFingerprint: sha256,
});
export const externalRequestSchema = externalInvocationSchema
  .omit({ reference: true })
  .extend({ protocolVersion: z.literal(1), root: z.string() });

export function externalChecks(
  source: Inventory,
  project: Project,
  adapter: ExternalAdapter,
): Check[] {
  return adapter.manifest.checks.map((definition) => {
    const scope = externalScope(project, definition);
    const check: Check = {
      id: `${adapter.identity.id}.${definition.id}`,
      adapter: adapter.identity.id,
      project: project.path,
      scope,
      kind: definition.kind,
      parser: "external-json",
      external: adapter.identity,
      reason: definition.description,
      commands: [],
    };
    try {
      const invocation = JSON.stringify(
        externalInvocationSchema.parse({
          reference: adapter.reference,
          identity: adapter.identity,
          runtime: adapter.manifest.runtime,
          project: project.path,
          checkId: check.id,
          kind: definition.kind,
          failOn: definition.failOn,
          scope,
          sourceFingerprint: source.fingerprint,
        }),
      );
      if (Buffer.byteLength(invocation) > 100 * 1024)
        throw new Error("External adapter invocation exceeds 100 KiB");
      check.commands.push({
        temporaryDirectory: true,
        executable: process.execPath,
        args: [
          fileURLToPath(new URL("./external-runner.js", import.meta.url)),
          source.root,
          invocation,
        ],
        cwd: project.path,
        env: {
          PATH: process.env.PATH ?? "",
          NODE_OPTIONS: "",
          CHECKTRAIL_TEMP: "",
        },
      });
    } catch (error) {
      check.unavailableReason =
        error instanceof Error
          ? error.message
          : "External adapter scope could not be prepared";
    }
    return check;
  });
}

const count = z.number().int().nonnegative().max(10_000_000);
const testCounts = z.strictObject({
  total: count,
  passed: count,
  failed: count,
  skipped: count,
});
export const externalResultSchema = z.strictObject({
  protocolVersion: z.literal(1),
  identity: externalIdentitySchema,
  checkId: z.string(),
  sourceFingerprint: sha256,
  files: z
    .array(
      z.strictObject({
        path: relativePath,
        status: z.enum(["checked", "skipped", "unavailable"]),
        tests: testCounts.optional(),
      }),
    )
    .max(20_000),
  findingsComplete: z.boolean(),
  findings: z
    .array(
      z.strictObject({
        ruleId: z.string().min(1).max(256),
        level: z.enum(["error", "warning", "note"]),
        message: z.string().min(1).max(8192),
        file: relativePath.optional(),
        line: z.number().int().positive().optional(),
      }),
    )
    .max(2000),
  tools: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
        version: z
          .string()
          .min(1)
          .max(256)
          .refine((value) =>
            [...value].every(
              (character) =>
                character.charCodeAt(0) >= 32 &&
                character.charCodeAt(0) !== 127,
            ),
          ),
      }),
    )
    .min(1)
    .max(32),
});
