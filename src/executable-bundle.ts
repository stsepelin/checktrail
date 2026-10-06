import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  externalManifestSchema,
  externalPathSchema,
} from "./external-schema.js";
export const EXECUTABLE_BUNDLE_MAX_BYTES = 192 * 1024 * 1024;
export const executableBundleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("checktrail-executable-bundle"),
  manifestBase64: z
    .string()
    .min(1)
    .max(Math.ceil((256 * 1024) / 3) * 4),
  files: z
    .array(
      z.strictObject({
        path: externalPathSchema,
        base64: z.string().max(Math.ceil((32 * 1024 * 1024) / 3) * 4),
      }),
    )
    .min(1)
    .max(512),
});
function parseBundle(bytes: Buffer, retainBytes = false) {
  if (bytes.length > EXECUTABLE_BUNDLE_MAX_BYTES)
    throw Error("Executable bundle exceeds its byte limit");
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
    throw Error("Executable bundle must not contain a byte order mark");
  const data = executableBundleSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  const decode = (value: string, maxBytes: number) => {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length > maxBytes || bytes.toString("base64") !== value)
      throw Error("Executable bundle has noncanonical or oversized base64");
    return bytes;
  };
  const manifestBytes = decode(data.manifestBase64, 256 * 1024);
  const manifest = externalManifestSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
  );
  const paths = manifest.files.map((f) => f.path);
  if (
    new Set(paths).size !== paths.length ||
    new Set(manifest.markers).size !== manifest.markers.length ||
    new Set(manifest.checks.map((c) => c.id)).size !== manifest.checks.length
  )
    throw Error("Duplicate executable bundle declarations");
  if (!paths.includes(manifest.entry))
    throw Error("Executable bundle entry must be pinned");
  for (const check of manifest.checks) {
    if (
      (!check.scope.extensions.length && !check.scope.names.length) ||
      new Set(check.scope.extensions).size !== check.scope.extensions.length ||
      new Set(check.scope.names).size !== check.scope.names.length
    )
      throw Error("Invalid executable bundle scope selectors");
  }
  const names = new Set(paths);
  for (const file of paths) {
    let parent = path.posix.dirname(file);
    while (parent !== ".") {
      if (names.has(parent))
        throw Error("Executable bundle file/directory collision");
      parent = path.posix.dirname(parent);
    }
  }
  if (
    data.files.length !== paths.length ||
    new Set(data.files.map((f) => f.path)).size !== data.files.length ||
    data.files.some((f) => !names.has(f.path))
  )
    throw Error(
      "Executable bundle does not contain every declared artifact exactly once",
    );
  const contents = new Map<string, Buffer>();
  let total = 0;
  for (const file of data.files) {
    const decoded = decode(file.base64, 32 * 1024 * 1024);
    total += decoded.length;
    if (total > 128 * 1024 * 1024)
      throw Error("Executable bundle decoded byte limit");
    const declaration = manifest.files.find((f) => f.path === file.path)!;
    if (
      createHash("sha256").update(decoded).digest("hex") !== declaration.sha256
    )
      throw Error("Executable bundle artifact integrity mismatch");
    if (retainBytes) contents.set(file.path, decoded);
  }
  return {
    manifest,
    contents,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    decodedBytes: total,
  };
}

export function parseExecutableBundle(bytes: Buffer, retainBytes = false) {
  try {
    return parseBundle(bytes, retainBytes);
  } catch {
    throw Error(
      "Executable bundle has invalid encoding, manifest, declarations or artifact integrity.",
    );
  }
}
